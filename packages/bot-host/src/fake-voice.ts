import { execFileSync } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto'
import { createSocket, type RemoteInfo } from 'node:dgram'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { DAVESession } from '@snazzah/davey'
import { type WebSocket, WebSocketServer } from 'ws'

/** The voice channel the fake serves. Its ID names the DAVE group, so the bot must join it. */
export const FAKE_VOICE_CHANNEL_ID = '927310423890473011'
/** The person already in the channel when the bot joins, unless a test says otherwise. */
export const FAKE_VOICE_MEMBER_ID = '158533742254751744'

const Op = {
  Identify: 0,
  SelectProtocol: 1,
  Ready: 2,
  Heartbeat: 3,
  SessionDescription: 4,
  Speaking: 5,
  HeartbeatAck: 6,
  Hello: 8,
  ClientsConnect: 11,
  ClientDisconnect: 13,
  DaveExecuteTransition: 22,
  DaveTransitionReady: 23,
  DaveExternalSender: 25,
  DaveKeyPackage: 26,
  DaveProposals: 27,
  DaveCommitWelcome: 28,
  DaveAnnounceCommit: 29,
} as const
const SSRC = 42
const ENCRYPTION_MODE = 'aead_aes256_gcm_rtpsize'
const RTP_OPUS = 120
const PROPOSALS_APPEND = 0
/** The DAVE frame trailer marking an end-to-end encrypted payload. */
export const DAVE_MAGIC_MARKER = Buffer.from([0xfa, 0xfa])

let certificate: { readonly cert: string; readonly key: string } | undefined

/**
 * `@discordjs/voice` always dials `wss://`, so the fake serves TLS under a throwaway self-signed
 * certificate for 127.0.0.1, which this process then trusts.
 */
const trustedCertificate = () => {
  if (certificate !== undefined) return certificate
  const dir = mkdtempSync(join(tmpdir(), 'fake-voice-'))
  try {
    const [keyFile, certFile] = [join(dir, 'key.pem'), join(dir, 'cert.pem')]
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']
        .concat(['-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'])
        .concat(['-addext', 'subjectAltName=IP:127.0.0.1']),
      { stdio: 'ignore' },
    )
    certificate = { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), certificate.cert])
  return certificate
}

/** An MLS variable-length vector: a QUIC-style length prefix, then the bytes. */
const vector = (bytes: Buffer) => {
  const length = bytes.length
  if (length < 0x40) return Buffer.concat([Buffer.from([length]), bytes])
  const prefix = Buffer.alloc(length < 0x4000 ? 2 : 4)
  if (length < 0x4000) prefix.writeUInt16BE(0x4000 | length)
  else prefix.writeUInt32BE(0x80000000 | length)
  return Buffer.concat([prefix, bytes])
}
const uint16 = (value: number) => Buffer.from([value >> 8, value & 0xff])
const uint64 = (value: bigint) => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(value)
  return bytes
}

/**
 * The voice gateway's part in DAVE: the MLS external sender that proposes adding each person who
 * connects. Real Discord signs with a key nobody else holds, so the fake makes its own.
 */
const externalSender = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  // The uncompressed P-256 point ends the SPKI encoding.
  const point = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65)
  // A basic credential (type 1) with a one-byte identity.
  return {
    data: Buffer.concat([vector(point), uint16(1), vector(Buffer.from([0]))]),
    key: privateKey,
  }
}

/** An MLS PublicMessage from the external sender, proposing to add `keyPackage` at `epoch`. */
const addProposal = (key: KeyObject, epoch: bigint, keyPackage: Buffer) => {
  const MLS_10 = uint16(1)
  const PUBLIC_MESSAGE = uint16(1)
  const content = Buffer.concat([
    vector(uint64(BigInt(FAKE_VOICE_CHANNEL_ID))), // group ID
    uint64(epoch),
    Buffer.from([2]), // sender type: external
    Buffer.alloc(4), // external sender index 0
    vector(Buffer.alloc(0)), // authenticated data
    Buffer.from([2]), // content type: proposal
    uint16(1), // proposal type: add
    keyPackage,
  ])
  const signed = Buffer.concat([
    vector(Buffer.from('MLS 1.0 FramedContentTBS')),
    vector(Buffer.concat([MLS_10, PUBLIC_MESSAGE, content])),
  ])
  return Buffer.concat([MLS_10, PUBLIC_MESSAGE, content, vector(sign('sha256', signed, key))])
}

/**
 * The length of the commit at the start of an `op 28` payload, which the bot sends as commit then
 * welcome. Parses an MLS PublicMessage commit from a member, without an update path.
 */
const commitLength = (payload: Buffer) => {
  let at = 4 // version, wire format
  const skipVector = () => {
    const prefix = (payload[at] ?? 0) >> 6
    const length =
      prefix === 0
        ? (payload[at] ?? 0) & 0x3f
        : prefix === 1
          ? payload.readUInt16BE(at) & 0x3fff
          : payload.readUInt32BE(at) & 0x3fffffff
    at += (1 << prefix) + length
  }
  skipVector() // group ID
  at += 8 + 1 + 4 // epoch, sender type, leaf index
  skipVector() // authenticated data
  at += 1 // content type
  skipVector() // proposals
  if (payload[at++] !== 0) throw new Error('The fake voice server cannot parse an update path.')
  skipVector() // signature
  skipVector() // confirmation tag
  skipVector() // membership tag
  return at
}

export interface FakeVoiceServer {
  /** What `VOICE_SERVER_UPDATE` names as the endpoint. */
  readonly endpoint: string
  /** JSON payloads and binary opcodes the bot sent on the voice WebSocket, oldest first. */
  readonly received: Array<{ readonly op: number; readonly d?: unknown }>
  /** Audio payloads the bot sent over UDP, with transport encryption removed, oldest first. */
  readonly packets: Buffer[]
  /**
   * People connect to the channel: the bot hears of them, and once it has committed their
   * addition to the DAVE group, they can speak.
   */
  readonly connect: (userIds: ReadonlyArray<string>) => void
  /** A person leaves the channel. */
  readonly disconnectMember: (userId: string) => void
  /**
   * A connected person speaks: Discord names their SSRC with opcode 5, unless `announce` is false,
   * then sends each Opus packet end-to-end encrypted as them.
   */
  readonly speak: (
    userId: string,
    packets: ReadonlyArray<Buffer>,
    options?: { readonly announce?: boolean },
  ) => Promise<void>
  /** Close the bot's voice WebSocket, as Discord does with 4014 when the bot is disconnected. */
  readonly disconnect: (code: number) => void
  readonly close: () => Promise<void>
}

/**
 * A local stand-in for a Discord voice server: the voice WebSocket, UDP IP discovery, transport
 * encryption both ways, and DAVE. The bot creates the group and commits each person who connects,
 * starting with `members`, and those people speak with real per-sender DAVE encryption. Audio the
 * bot sends counts as end-to-end encrypted when it ends in `DAVE_MAGIC_MARKER`.
 */
export const fakeVoiceServer = async ({
  members: initialMembers = [FAKE_VOICE_MEMBER_ID],
}: {
  readonly members?: ReadonlyArray<string>
} = {}): Promise<FakeVoiceServer> => {
  const { cert, key } = trustedCertificate()
  const secretKey = randomBytes(32)
  const sender = externalSender()
  const received: FakeVoiceServer['received'] = []
  const packets: Buffer[] = []
  /** People in the DAVE group, besides the bot, by user ID. */
  const members = new Map<string, DAVESession>()
  const ssrcs = new Map<string, number>()
  let botUserId = ''
  let botAddress: RemoteInfo | undefined
  let epoch = 0n
  let transitionId = 0
  /** The additions awaiting the bot's commit, and the proposals that carried them. */
  let joining:
    | { readonly sessions: Map<string, DAVESession>; readonly proposals: Buffer }
    | undefined
  let rtp = { sequence: 0, timestamp: 0, nonce: 0 }

  const udp = createSocket('udp4')
  udp.bind(0, '127.0.0.1')
  await once(udp, 'listening')
  udp.on('message', (message, from) => {
    if (message.length === 74 && message.readUInt16BE(0) === 1) {
      botAddress = from
      const reply = Buffer.alloc(74)
      reply.writeUInt16BE(2, 0)
      reply.writeUInt16BE(70, 2)
      reply.writeUInt32BE(SSRC, 4)
      reply.write(from.address, 8)
      reply.writeUInt16BE(from.port, 72)
      udp.send(reply, from.port, from.address)
      return
    }
    // Keepalives are 8 bytes; RTP needs a 12-byte header, a 16-byte tag, and a 4-byte nonce.
    if (message.length < 32) return
    const header = message.subarray(0, 12)
    const nonce = Buffer.alloc(12)
    message.copy(nonce, 0, message.length - 4)
    const decipher = createDecipheriv('aes-256-gcm', secretKey, nonce)
      .setAAD(header)
      .setAuthTag(message.subarray(message.length - 20, message.length - 4))
    packets.push(
      Buffer.concat([decipher.update(message.subarray(12, message.length - 20)), decipher.final()]),
    )
  })

  const https = createServer({ cert, key })
  https.listen(0, '127.0.0.1')
  await once(https, 'listening')
  const server = new WebSocketServer({ server: https })
  let bot: WebSocket | undefined
  let sequence = 0
  const send = (op: number, d: unknown) => bot?.send(JSON.stringify({ op, d, seq: ++sequence }))
  const sendBinary = (op: number, payload: Buffer) => {
    const header = Buffer.alloc(3)
    header.writeUInt16BE(++sequence, 0)
    header[2] = op
    bot?.send(Buffer.concat([header, payload]))
  }

  const connect = (userIds: ReadonlyArray<string>) => {
    const sessions = new Map(
      userIds.map((userId) => {
        const session = new DAVESession(1, userId, FAKE_VOICE_CHANNEL_ID)
        session.setExternalSender(sender.data)
        return [userId, session] as const
      }),
    )
    const proposals = vector(
      Buffer.concat(
        [...sessions.values()].map((session) =>
          addProposal(sender.key, epoch, session.getSerializedKeyPackage()),
        ),
      ),
    )
    joining = { sessions, proposals }
    send(Op.ClientsConnect, { user_ids: userIds })
    sendBinary(Op.DaveProposals, Buffer.concat([Buffer.from([PROPOSALS_APPEND]), proposals]))
  }

  /** The bot committed the pending additions: everyone moves to the next epoch. */
  const committed = (commit: Buffer, welcome: Buffer) => {
    if (joining === undefined) return
    const recognized = [botUserId, ...members.keys(), ...joining.sessions.keys()]
    for (const session of members.values()) {
      session.processProposals(PROPOSALS_APPEND, joining.proposals, recognized)
      session.processCommit(commit)
    }
    for (const [userId, session] of joining.sessions) {
      session.processWelcome(welcome)
      members.set(userId, session)
    }
    joining = undefined
    epoch += 1n
    transitionId += 1
    const transition = uint16(transitionId)
    sendBinary(Op.DaveAnnounceCommit, Buffer.concat([transition, commit]))
  }

  server.on('connection', (socket) => {
    // Each voice connection starts a fresh DAVE group.
    bot = socket
    members.clear()
    epoch = 0n
    joining = undefined
    socket.on('message', (data: Buffer, isBinary) => {
      if (isBinary) {
        const op = data[0] ?? -1
        received.push({ op })
        if (op === Op.DaveKeyPackage) connect(initialMembers)
        if (op === Op.DaveCommitWelcome) {
          const length = commitLength(data.subarray(1))
          committed(data.subarray(1, 1 + length), data.subarray(1 + length))
        }
        return
      }
      const payload: {
        op: number
        d: { data?: { mode?: string }; t?: number; user_id?: string }
      } = JSON.parse(String(data))
      received.push(payload)
      switch (payload.op) {
        case Op.Identify:
          botUserId = payload.d.user_id ?? ''
          return send(Op.Ready, {
            ssrc: SSRC,
            ip: '127.0.0.1',
            port: (udp.address() as AddressInfo).port,
            modes: [ENCRYPTION_MODE],
          })
        case Op.SelectProtocol:
          send(Op.SessionDescription, {
            mode: payload.d.data?.mode,
            secret_key: [...secretKey],
            dave_protocol_version: 1,
          })
          return sendBinary(Op.DaveExternalSender, sender.data)
        case Op.Heartbeat:
          return send(Op.HeartbeatAck, { t: payload.d.t })
        case Op.DaveTransitionReady:
          return send(Op.DaveExecuteTransition, { transition_id: transitionId })
      }
    })
    send(Op.Hello, { heartbeat_interval: 13_750 })
  })

  /** One RTP packet carrying `payload` from `ssrc`, transport-encrypted as Discord does. */
  const rtpPacket = (ssrc: number, payload: Buffer) => {
    rtp = {
      sequence: (rtp.sequence + 1) & 0xffff,
      timestamp: (rtp.timestamp + 960) >>> 0,
      nonce: rtp.nonce + 1,
    }
    const header = Buffer.alloc(12)
    header[0] = 0x80
    header[1] = RTP_OPUS
    header.writeUInt16BE(rtp.sequence, 2)
    header.writeUInt32BE(rtp.timestamp, 4)
    header.writeUInt32BE(ssrc, 8)
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(rtp.nonce)
    const cipher = createCipheriv('aes-256-gcm', secretKey, nonce).setAAD(header)
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
    return Buffer.concat([header, encrypted, cipher.getAuthTag(), nonce.subarray(0, 4)])
  }

  return {
    endpoint: `127.0.0.1:${(https.address() as AddressInfo).port}`,
    received,
    packets,
    connect,
    disconnectMember: (userId) => send(Op.ClientDisconnect, { user_id: userId }),
    speak: async (userId, opus, { announce = true } = {}) => {
      const member = members.get(userId)
      if (member === undefined || botAddress === undefined) {
        throw new Error(`${userId} is not in the fake voice channel's DAVE group.`)
      }
      const ssrc = ssrcs.get(userId) ?? SSRC + 1 + ssrcs.size
      ssrcs.set(userId, ssrc)
      if (announce) {
        send(Op.Speaking, { user_id: userId, ssrc, speaking: 1 })
        // UDP could overtake the WebSocket message that names the SSRC.
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const { address, port } = botAddress
      for (const packet of opus)
        udp.send(rtpPacket(ssrc, member.encryptOpus(packet)), port, address)
    },
    disconnect: (code) => bot?.close(code),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        udp.close()
        server.close(() => https.close(() => resolve()))
      }),
  }
}
