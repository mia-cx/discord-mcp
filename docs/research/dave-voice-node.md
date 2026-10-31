# DAVE voice support in Node libraries

Research for [#17](https://github.com/mia-cx/discord-mcp/issues/17), feeding the "Voice bridge" module of the PRD ([#15](https://github.com/mia-cx/discord-mcp/issues/15)). Researched 2026-10-31.

**Question.** Which Node libraries can send and receive Discord voice under DAVE end-to-end encryption today, and what does a linux/amd64 + arm64 bot host need for Opus encode and decode?

**Short answer.** Only one stack: `@discordjs/voice` (transport, send, per-speaker receive) on `@snazzah/davey` (DAVE, Rust/OpenMLS). Nothing else maintained exists in Node. DAVE needs no compiler: davey ships prebuilt binaries for linux x64 and arm64. Opus is the weak spot: `@discordjs/opus` has no prebuilt for Node 24 and compiles from source.

## Legend

- **Verified**: observed first-hand in this research (command, file, or API response named).
- **Inference**: reasoned from verified facts, not observed.

## Protocol facts (Discord)

All verified from Discord's docs and the DAVE whitepaper.

- Voice close code 4017 is "E2EE/DAVE protocol required": "This channel requires a client supporting E2EE via the DAVE Protocol." The code is on the [opcodes and status codes page](https://docs.discord.com/developers/topics/opcodes-and-status-codes), not on the voice connections page.
- Discord supports only E2EE calls "starting on March 1st, 2026", across DMs, group DMs, voice channels, and Go Live ([voice connections](https://docs.discord.com/developers/topics/voice-connections)).
- Version negotiation: the client sends `max_dave_protocol_version` in Identify (opcode 0). Sending 0 or omitting it means no DAVE. Opcode 4 Session Description returns `dave_protocol_version`. "The voice gateway selects the lowest shared protocol version for the call." Clients must stay compatible with all non-discontinued versions.
- DAVE opcodes 21 to 31 (prepare/execute transition, ready, prepare epoch, external sender, key package, proposals, commit/welcome, announce commit, welcome, invalid commit). Several are binary frames with an optional 2-byte sequence number, a 1-byte opcode, then the payload.
- Voice gateway version 8 is recommended; versions below 4 are rejected.
- Transport encryption stays on under DAVE. `aead_xchacha20_poly1305_rtpsize` is required; `aead_aes256_gcm_rtpsize` is preferred when offered. All `xsalsa20_*` modes and non-rtpsize `aead_aes256_gcm` are deprecated.
- The whitepaper ([daveprotocol.com](https://daveprotocol.com)) covers protocol version 1.1 (revision 1.1.4). It uses MLS 1.0 ciphersuite 2 (`DHKEMP256_AES128GCM_SHA256_P256`), with the voice gateway as the single external sender. Media frames use AES128-GCM with a ratcheted per-sender key. Opus frames are fully encrypted (no unencrypted ranges), and every received frame is decrypted per sender: a receiver needs the sender's user ID.
- Passthrough: frames that are not DAVE-formatted pass through unchanged during transport-only sessions and transitions. The 3-byte Opus silence frame `0xF8 0xFF 0xFE` is always allowed through.
- **Gap.** Discord's docs make no statement that bots may receive other users' audio. Only the frame-level E2EE description mentions "OPUS frames sent and received by call participants". The tracking issue for that question is separate (see the PRD's research list).

Only DAVE protocol version 1 exists. `@snazzah/davey` exports `DAVE_PROTOCOL_VERSION = 1` (verified, see [Experiments](#experiments)).

## Candidates

| | `@discordjs/voice` | `@snazzah/davey` | `@sonata-sdk/voice` | `discord-voip` | `@discordapp/libdave` (js) | libdave C++ |
|---|---|---|---|---|---|---|
| Role | Voice gateway + UDP/RTP + send/receive | DAVE/MLS engine only | Voice connection library | Voice library for discord-player | Fingerprints, display codes | Reference DAVE engine |
| DAVE | Yes, via davey | Yes | Yes, optional davey | Yes, requires davey | **Not a media engine** | Yes |
| Send | Yes | `encryptOpus` | Yes | Yes | n/a | Yes |
| Receive per speaker | Yes (`receiver.subscribe(userId)`) | `decrypt(userId, …)` | Not checked | Not checked | n/a | Yes |
| Latest | 0.19.2 (2026-03-13 changelog; npm published 2026-03-17) | 0.1.12 (2026-06-22); 0.2.0-beta.1 (2026-10-27) | 1.0.13 (2026-05-25) | 7.2.0 (2026-03-01) | private, not on npm | `v1.2.2/cpp` (2026-10-23) |
| Maintenance | discord.js monorepo; main updated 2026-10-30 | Active; pushed 2026-10-30 | Single-package, third party | discord-player monorepo | Discord | Discord |

### `@discordjs/voice`

- **DAVE (verified).** `Networking.ts` sends `max_dave_protocol_version: getMaxProtocolVersion()` (davey's `DAVE_PROTOCOL_VERSION`, i.e. 1) unless the option `daveEncryption === false`; it builds a `DAVESession` from `dave_protocol_version` in the session description ([`Networking.ts`](https://github.com/discordjs/discord.js/blob/main/packages/voice/src/networking/Networking.ts), read at `107f61d`). `DAVESession.ts` wraps davey and handles opcodes 21 to 31 transitions, passthrough windows (10 s; 24 s for a pending downgrade), and re-initialises after 36 consecutive decrypt failures.
- **History (verified).** DAVE landed in 0.19.0 (2025-08-17, #10921). 0.19.1 (2026-03-09) made davey a hard dependency "as DAVE is becoming required" and fixed concurrent transitions. 0.19.2 (2026-03-13) strips RTP padding ([CHANGELOG](https://github.com/discordjs/discord.js/blob/main/packages/voice/CHANGELOG.md)). npm shows `@snazzah/davey ^0.1.9` for 0.19.2.
- **Send (verified).** `createAudioPlayer` and `createAudioResource` with `StreamType.Opus` play pre-encoded Opus packets without transcoding. `StreamType.Raw` (PCM) goes through `prism-media`'s `opus.Encoder` at 48 kHz, 2 channels, 960-sample frames (`dist/index.js` of 0.19.2). Each packet is E2EE-encrypted by `DAVESession.encryptOpus`, then transport-encrypted.
- **Receive (verified).** `VoiceReceiver.subscribe(userId)` returns a per-user `AudioReceiveStream` of Opus payloads. It maps SSRC to user ID from voice gateway events, strips transport encryption, then calls `DAVESession.decrypt(payload, userId)`. Packets that fail to decrypt are dropped. `receiver.speaking` emits start/end per user (100 ms silence delay, `SpeakingMap.DELAY`). Per-speaker streams with user IDs is the native model, which matches the PRD's per-speaker WebSocket.
- **Receive, published vs main (verified).** Published 0.19.2 pushes bare Opus `Buffer`s with no RTP sequence, timestamp, or SSRC. `main` (unreleased) pushes `AudioPacket` objects with `payload`, `sequence`, `ssrc`, and requires Node `>=24.17.0` (0.19.2 requires `>=22.12.0`). Without sequence numbers, a bridge cannot detect loss or reorder, or run packet-loss concealment. **Inference:** the next release will carry `AudioPacket`; until then pin to a git/commit build or live without sequence data.
- **Gateway coupling (verified).** `joinVoiceChannel` takes an `adapterCreator` (`DiscordGatewayAdapterCreator`): the host supplies `sendPayload` for Gateway op 4 (voice state update) and forwards `VOICE_STATE_UPDATE` / `VOICE_SERVER_UPDATE`. discord.js clients provide one; Textile's own sharded Gateway client must implement it. **Inference:** a small shim, since the interface is two inbound events and one outbound call.
- **Crypto deps (verified).** Transport encryption uses native `node:crypto` AES-256-GCM when available (`generateDependencyReport` printed `native crypto support for aes-256-gcm: yes`), else `sodium-native`, `sodium`, `libsodium-wrappers`, `@stablelib/xchacha20poly1305`, or `@noble/ciphers`. `tweetnacl` was dropped in 0.18.0.

### `@snazzah/davey`

- **What it is (verified).** A Rust DAVE implementation on OpenMLS, exposed through NAPI-RS ([README](https://github.com/Snazzah/davey/blob/master/davey-node/README.md)). API: `DAVESession`, `setExternalSender`, `getSerializedKeyPackage`, `processProposals`, `processCommit`, `processWelcome`, `encrypt`/`encryptOpus`, `decrypt(userId, mediaType, packet)`, `voicePrivacyCode`, fingerprint helpers. MIT licensed.
- **Not libdave (verified).** It reimplements the protocol on OpenMLS and tracks libdave behaviour by hand ("parity with libdave" lines in its [CHANGELOG](https://github.com/Snazzah/davey/blob/master/davey-node/CHANGELOG.md)). Discord's libdave is C++ on mlspp with OpenSSL or BoringSSL ([cpp README](https://github.com/discord/libdave/blob/main/cpp/README.md)).
- **Versions (verified).** npm `latest` is 0.1.12 (2026-06-22); `beta` is 0.2.0-beta.1 (2026-10-27). The CHANGELOG "Unreleased" section lists breaking changes: `processCommit`/`processWelcome` no longer switch keys (call `prepareTransition`, then `executeTransition`), `reinit` keeps keys until the next transition, `processCommit` returns a boolean. It also lists fixes to match libdave v1.2.0 to v1.2.2, including "Re-installing the encryption key of the current epoch no longer restarts the nonce sequence, which reused nonces", group ID checks on welcomes, and duplicate-user rejection. **Inference:** 0.1.12 lacks these hardening fixes; the nonce-reuse fix matters for an always-on bot. The 0.2 API is incompatible with `@discordjs/voice` 0.19.2's `DAVESession.ts`, which does not call `prepareTransition`.
- **Binaries (verified).** `@snazzah/davey` lists optional dependencies for `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `linux-arm64-musl`, `linux-arm-gnueabihf`, darwin, win32, android, freebsd, and a wasm32-wasi build. `npm pack @snazzah/davey-linux-arm64-gnu@0.1.12` yields `davey.linux-arm64-gnu.node`, which `file` reports as `ELF 64-bit LSB shared object, ARM aarch64`. The x64 glibc binary loaded on this machine. No compiler, no node-gyp.
- **Opus.** None. davey operates on already-encoded Opus frames; it never encodes or decodes audio.

### Other Node packages that mention DAVE

- `@sonata-sdk/voice` 1.0.13 (2026-05-25): description reads "WebSocket gateway, UDP, RTP, encryption, DAVE/MLS". It depends on `opusscript` and `tweetnacl`, with `@snazzah/davey` optional. Not examined beyond `npm view`; third-party, single package. **Inference:** no advantage over `@discordjs/voice`, and `tweetnacl` suggests older transport modes may still be in the code path.
- `discord-voip` 7.2.0 (2026-03-01, discord-player): `dist/index.js` contains `require("@snazzah/davey")`. It is a fork of the same lineage, tied to discord-player. Not examined further.
- `@discordapp/libdave` (JS, in [discord/libdave](https://github.com/discord/libdave/tree/main/js)): `package.json` has `"private": true`. Its published-file list is fingerprint, display-code, and serialization helpers plus a `wasm/libdave.wasm` build. The README says Discord clients use it "to enable out-of-band verifications of DAVE protocol call members and the MLS epoch authenticator". Not a Node media engine, and not on npm.
- libdave C++ has `bindings_capi.cpp` and `bindings_wasm.cpp` ([source tree](https://github.com/discord/libdave/tree/main/cpp/src)), so Node bindings are possible, but no maintained Node package wraps it (`npm search` for "libdave", "dave discord e2ee", "discord dave protocol", "discord voice dave" found only the packages above). **Inference:** wrapping libdave ourselves buys libdave's patch cadence at the cost of owning a C++/vcpkg build; it is not worth it unless davey stalls.

## Opus encode and decode

Neither `@discordjs/voice` nor davey does codec work itself; `@discordjs/voice` delegates to `prism-media`, which picks the first installed of `@discordjs/opus`, `node-opus`, `opusscript` (verified in `prism-media/src/opus/Opus.js`).

| Package | Kind | Version | Last published | Node 24 on linux x64 | arm64 |
|---|---|---|---|---|---|
| `@discordjs/opus` | Native, node-pre-gyp | 0.10.0 | 2025-01-25 | **Compiled from source here** | Prebuilt for Node ≤ 22 only (not tested) |
| `opusscript` | WASM, bundled libopus | 0.1.1 | 2023-10-10 | Loads and round-trips | Same artifact (no native code) |
| `@evan/opus` | WASM | 1.0.3 | 2024-02-11 | Loads and round-trips | Same artifact (no native code) |

- **`@discordjs/opus` prebuilts (verified).** The v0.10.0 GitHub release has 95 assets named `opus-v0.10.0-node-v<ABI>-napi-v3-<platform>-<arch>-<libc>-…`. Linux x64 and arm64, glibc and musl, are covered for ABIs v72 to v127 (Node 12 to 22). No asset exists for ABI v131 or higher; Node 24 is ABI 137 (`process.versions.modules`). On this machine the install produced `build-tmp-napi-v3/Release/opus.node` copied to `prebuild/node-v137-napi-v3-linux-x64-glibc-2.41/opus.node`, which only happens on the source-build fallback. Building needs `gcc`/`g++`, `make`, `python3` (present here: gcc 14.2). The repo commits show active work (a pnpm build change on 2026-10-30, "bump minimum node version to v20" on 2025-12-11) but no release after v0.10.0. **Inference:** a release with Node 24 prebuilts may follow; plan for a build stage in the image until one does. Whether the same source build works on arm64 is untested (no arm64 host).
- **Install scripts (verified).** npm warned `@discordjs/opus@0.10.0 (install: node-pre-gyp install --fallback-to-build)` is not covered by `allowScripts`. The binary was nonetheless present, so the default config ran it; a locked-down CI or pnpm (`onlyBuiltDependencies`) must allow it explicitly. **Inference** for pnpm, which blocks dependency build scripts by default.
- **Speed (verified, this machine only).** 50 frames of 20 ms 48 kHz stereo, encode then decode, mean per frame: `@evan/opus` 0.10 ms, `@discordjs/opus` 0.12 ms, `opusscript` 0.41 ms. Even the slowest is about 2% of a core for one 20 ms stream. **Inference:** 25 simultaneous speakers on `opusscript` is about half a core of decode, fine for v1.
- **prism-media pairing (verified).** `prism-media` 1.3.5 (2023-02-27) lists `opusscript ^0.0.8` as its peer range; the 0.1.1 package I installed loads directly but I did not run it through prism-media. `@evan/opus` is not a `prism-media` backend, so using it means writing our own transform.
- **Passthrough needs none (inference).** With `codec=opus` the bridge forwards the decrypted Opus payload from `receiver.subscribe` and sends agent Opus through `StreamType.Opus`; only `pcm16` needs a decoder (inbound) and an encoder (outbound).

## Experiments

All run on this machine (linux x86_64, Node v24.19.0, npm 11.17.0, gcc 14.2.0), in `~/scratch/dave-probe` (outside the repo). Nothing connected to Discord.

```sh
npm i @discordjs/voice@0.19.2 @snazzah/davey @discordjs/opus opusscript @evan/opus \
  libsodium-wrappers sodium-native prism-media
node ~/scratch/probe-load.mjs     # load each native module; encode+decode a 20 ms frame
node ~/scratch/probe-davey.mjs    # DAVESession smoke test; Opus timing
npm pack @snazzah/davey-linux-arm64-gnu@0.1.12 && tar -xzf … && file davey.linux-arm64-gnu.node
```

Results:

- `@snazzah/davey` 0.1.12 loads; `DAVE_PROTOCOL_VERSION` is 1.
- A new `DAVESession(1, userId, channelId)` is inactive (status 0, `ready` false), and `getSerializedKeyPackage()` returns a 392-byte key package. `decrypt` before any group exists throws `NoDecryptorForUser`.
- `@discordjs/opus` (compiled in install), `opusscript`, and `@evan/opus` each encode and decode a 20 ms stereo frame. A silent frame encodes to 3 bytes and decodes to 3840 bytes of PCM.
- `generateDependencyReport()` from `@discordjs/voice` 0.19.2 reports `@snazzah/davey: 0.1.12`, native `aes-256-gcm`: yes, and `libopus: yes` for the system FFmpeg.
- The arm64 davey tarball contains an ELF aarch64 shared object.

**Not tested.**

- A full MLS handshake (needs a live Discord external sender or captured traffic; davey's own `session.test.ts` uses captured buffers).
- Any run on arm64 hardware, glibc minimum for davey binaries, musl.
- `@sonata-sdk/voice` and `discord-voip` behaviour.
- Voice quality, jitter, or multi-speaker load.

## Recommended stack

For the voice bridge on a Node 24 bot host, linux x64 and arm64 (glibc):

1. **Transport, send, receive: `@discordjs/voice`.** Write a `DiscordGatewayAdapterCreator` shim over Textile's own Gateway client. Track the next release for `AudioPacket` (sequence numbers, SSRC); pin the exact version.
2. **DAVE: `@snazzah/davey` 0.1.12**, as `@discordjs/voice` requires. Revisit the 0.2.x line when `@discordjs/voice` adopts it; the nonce-reuse and welcome-validation fixes are reasons to follow it. Never fall back to `max_dave_protocol_version: 0` (the gateway closes with 4017).
3. **Opus: `opus` codec passthrough by default**; no codec library on that path. For `pcm16`, install both `@discordjs/opus` (built in a multi-stage image build with `gcc`, `make`, `python3`) and `opusscript` (WASM). `prism-media` uses the native one when it loads and falls back to `opusscript`, so a failed source build on one architecture degrades instead of breaking.
4. **Transport crypto:** Node's built-in AES-256-GCM, no extra dependency; add `sodium-native` or `libsodium-wrappers` as the `xchacha20` fallback (the required mode) for hosts that lack it.
5. **Image:** build and test both `linux/amd64` and `linux/arm64`; the first time an arm64 build of `@discordjs/opus` or the davey `.node` runs is the first real proof for the k3s nodes.

## Implications for the PRD

- The per-speaker WebSocket with user IDs maps directly to `receiver.subscribe(userId)`. Speaking and presence events map to `receiver.speaking`.
- Plan a spike with a real voice channel before the Voice bridge slice: DAVE transitions, lost-packet behaviour, and bot receive permission cannot be verified without Discord.
- Whether Discord allows bots to receive other users' audio is not answered by the docs; the separate research issue must settle it.

## Sources

- Discord voice connections: https://docs.discord.com/developers/topics/voice-connections
- Discord opcodes and status codes: https://docs.discord.com/developers/topics/opcodes-and-status-codes
- DAVE whitepaper: https://daveprotocol.com
- libdave: https://github.com/discord/libdave (tree read at depth 1 on 2026-10-31; C++ README; `js/package.json`)
- `@discordjs/voice`: https://github.com/discordjs/discord.js/tree/main/packages/voice (read at `107f61d`), npm tarball 0.19.2
- davey: https://github.com/Snazzah/davey (README, `davey-node/CHANGELOG.md`, `davey-node/test/session.test.ts`), npm `@snazzah/davey` 0.1.12
- `@discordjs/opus`: https://github.com/discordjs/opus/releases/tag/v0.10.0
- npm registry metadata via `npm view` for every package named above.
