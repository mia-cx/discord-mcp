import { execFileSync } from 'node:child_process'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { type WebSocket, WebSocketServer } from 'ws'

/**
 * A real Discord DAVE session captured by `@snazzah/davey`'s test suite (MIT): the voice
 * gateway's MLS external sender, and its proposal adding user 158533742254751744 to the group of
 * channel 927310423890473011. The proposal names that group, so the bot must join that channel.
 */
export const FAKE_VOICE_CHANNEL_ID = '927310423890473011'
const OTHER_MEMBER_ID = '158533742254751744'
const EXTERNAL_SENDER = Buffer.from(
  'QEEEyhorECUB0Gcr1F7XT/uD4HiyulsSw/afrVbwg7ajX8mJxnNrWFK1rs383yBuFW09HbqOPlsvifwMFvEWFOhOSgABAQA=',
  'base64',
)
const ADD_PROPOSAL = Buffer.from(
  'QfAAAQABCAzed+rcgjAzAAAAAAAAAAACAAAAAAACAAEAAQACQEEEphrNNP8FSOb3Z8xN+WGbUbpYFNUu5VgoT8VUQFdo6edBujInZBSUG3wBkNy138M0mhaPEkfsvfb8afPuyrN2XUBBBPRNok5aqfc3lvo4vhFVVua31Pa6VdLsw/G50ZivYjfj/I/GNZlrbHbne0rKzjP1z9dFrQ1UDdbwPw2oXILhRxRAQQTneTmF7QdK9JVotTzy45dGiCefAu6NfH3wmc48ehoo50f1mnx8I+nvT3gV+zRp856hJPi3ZxLEG3Y6Vbhn5rSLAAEIAjM5mUACAAACAAECAAIAAAIAAQEAAAAAAAAAAP//////////AEBIMEYCIQDYdNx3fU7efm0zdPc3vBOUrA/9BjWr3J0Cs+NZ4FlGagIhAOYul679XGsy/wrFxRWdvpT29aAb0N0UqdzE0eYkiXKsAEBHMEUCIFFoq9+Ng6SNr41ZYK+zBQIt5wfHSWCH/rQwBMn9K+XoAiEAgxKm9t8f9ZNnGjn5lm9tHK70PgxtU8dDALoInO7s+/RARzBFAiEAzb6AS6Bqm+F2Ff48f5BV8xptDqlALdn9ptEJ6aPLYysCIGdAnln2t/Cj7d0zCgkqbBPZnRKrrr4NbUCg2uQ1wqei',
  'base64',
)

const Op = {
  Identify: 0,
  SelectProtocol: 1,
  Ready: 2,
  Heartbeat: 3,
  SessionDescription: 4,
  HeartbeatAck: 6,
  Hello: 8,
  ClientsConnect: 11,
  DaveExecuteTransition: 22,
  DaveTransitionReady: 23,
  DaveExternalSender: 25,
  DaveKeyPackage: 26,
  DaveProposals: 27,
  DaveCommitWelcome: 28,
  DaveAnnounceCommit: 29,
} as const
const TRANSITION_ID = 1
const SSRC = 42
const ENCRYPTION_MODE = 'aead_aes256_gcm_rtpsize'
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
  /** Close the bot's voice WebSocket, as Discord does with 4014 when the bot is disconnected. */
  readonly disconnect: (code: number) => void
  readonly close: () => Promise<void>
}

/**
 * A local stand-in for a Discord voice server: the voice WebSocket, UDP IP discovery, transport
 * encryption, and a DAVE handshake in which the bot creates the group and commits another
 * member's addition. Audio counts as end-to-end encrypted when it ends in `DAVE_MAGIC_MARKER`.
 */
export const fakeVoiceServer = async (): Promise<FakeVoiceServer> => {
  const { cert, key } = trustedCertificate()
  const secretKey = randomBytes(32)
  const received: FakeVoiceServer['received'] = []
  const packets: Buffer[] = []

  const udp = createSocket('udp4')
  udp.bind(0, '127.0.0.1')
  await once(udp, 'listening')
  udp.on('message', (message, from) => {
    if (message.length === 74 && message.readUInt16BE(0) === 1) {
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
  server.on('connection', (socket) => {
    bot = socket
    let sequence = 0
    const send = (op: number, d: unknown) => socket.send(JSON.stringify({ op, d, seq: ++sequence }))
    const sendBinary = (op: number, payload: Buffer) => {
      const header = Buffer.alloc(3)
      header.writeUInt16BE(++sequence, 0)
      header[2] = op
      socket.send(Buffer.concat([header, payload]))
    }
    socket.on('message', (data: Buffer, isBinary) => {
      if (isBinary) {
        const op = data[0] ?? -1
        received.push({ op })
        if (op === Op.DaveKeyPackage) {
          send(Op.ClientsConnect, { user_ids: [OTHER_MEMBER_ID] })
          sendBinary(Op.DaveProposals, Buffer.concat([Buffer.from([0]), ADD_PROPOSAL]))
        }
        if (op === Op.DaveCommitWelcome) {
          const commit = data.subarray(1, 1 + commitLength(data.subarray(1)))
          const transition = Buffer.alloc(2)
          transition.writeUInt16BE(TRANSITION_ID, 0)
          sendBinary(Op.DaveAnnounceCommit, Buffer.concat([transition, commit]))
        }
        return
      }
      const payload: { op: number; d: { data?: { mode?: string }; t?: number } } = JSON.parse(
        String(data),
      )
      received.push(payload)
      switch (payload.op) {
        case Op.Identify:
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
          return sendBinary(Op.DaveExternalSender, EXTERNAL_SENDER)
        case Op.Heartbeat:
          return send(Op.HeartbeatAck, { t: payload.d.t })
        case Op.DaveTransitionReady:
          return send(Op.DaveExecuteTransition, { transition_id: TRANSITION_ID })
      }
    })
    send(Op.Hello, { heartbeat_interval: 13_750 })
  })

  return {
    endpoint: `127.0.0.1:${(https.address() as AddressInfo).port}`,
    received,
    packets,
    disconnect: (code) => bot?.close(code),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        udp.close()
        server.close(() => https.close(() => resolve()))
      }),
  }
}
