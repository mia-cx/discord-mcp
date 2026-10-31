# Research: Discord support for bots receiving voice

Resolves [#18](https://github.com/mia-cx/discord-mcp/issues/18), part of [PRD #15](https://github.com/mia-cx/discord-mcp/issues/15) (Voice bridge, user stories 25–29). Researched 2026-10-31.

**Verified** means a primary source states it, or library source shows it. **Inferred** means I reasoned from verified facts; test before relying on it.

## Answer

1. **Receiving is not officially supported.** Discord has never documented it. The only staff statement says it is unsupported, and the current docs are silent.
2. **A bot can still receive.** `@discordjs/voice` ships a receiver (tagged `@beta`) that works on DAVE calls.
3. **Speakers are identified through the voice WebSocket, not the audio.** Opcode 5 (Speaking) from the server carries `ssrc` and `user_id`. Opcodes 11 and 13 carry user IDs only.
4. **DAVE decryption needs the user ID before the SSRC is trusted.** The per-sender key derives from the sender's user ID, so Textile must resolve SSRC → user ID first, and drop what it can't resolve.
5. **Discord's policies never mention voice audio.** They do impose purpose limits, a privacy-policy duty, deletion duties, and third-party sharing rules on "API Data", which plausibly covers received audio.

## 1. Is receiving officially supported?

**Verified: no.**

- The voice docs describe receiving only in passing: UDP is "used for both receiving and transmitting voice data". They document no receive flow, no per-speaker stream handling, and no SSRC → user mapping. ([voice-connections.mdx L8](https://github.com/discord/discord-api-docs/blob/9d2128bb8301e7d9f239ff259f2ee41cf4d73c70/developers/topics/voice-connections.mdx), docs repo `main` at 2026-10-31)
- [discord-api-docs#365 "Document voice recieving"](https://github.com/discord/discord-api-docs/issues/365) was opened in 2017 and is still open. Staff agreed to document it and never did.
- In [#808](https://github.com/discord/discord-api-docs/issues/808), staff member jhgg (2019-01-30) said: "Until it is documented, it is not supported", and that receiving "is currently not documented nor supported… we are deliberately not documenting or supporting it at this time until the feature-set and protocol stabilizes." They added that receive breakage is "probably by side-effect" of changes to the native client's setup.
- I found no later staff statement reversing this. Searching `discord-api-docs` issues for "receive voice" and "receiving audio" surfaced no newer thread on bot receive.

**Inferred:** the receive half of the Voice bridge relies on undocumented behaviour that Discord may change without notice. A fake voice gateway in tests cannot catch real-gateway drift.

**Verified, still working in practice:** `@discordjs/voice` 0.19.2 has a `VoiceReceiver` ("@beta") that handles DAVE calls ([VoiceReceiver.ts](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/receive/VoiceReceiver.ts), `main` at 2026-10-30). I did not run it against Discord; the brief forbids connecting a bot.

**Historical, unverified today:** in 2019 receiving required the bot to send an opcode 5 and some UDP packets first ([#808](https://github.com/discord/discord-api-docs/issues/808)). Check this when implementing.

## 2. DAVE is mandatory

**Verified.**

- Discord "will only support E2EE calls starting on March 1st, 2026". A client that doesn't support DAVE gets close code `4017` ("E2EE/DAVE protocol required"). A bot declares support with `max_dave_protocol_version` in opcode 0 Identify; omitting it or sending `0` means no support. ([voice-connections.mdx L229–258](https://github.com/discord/discord-api-docs/blob/9d2128bb8301e7d9f239ff259f2ee41cf4d73c70/developers/topics/voice-connections.mdx), [opcodes-and-status-codes.mdx](https://github.com/discord/discord-api-docs/blob/9d2128bb8301e7d9f239ff259f2ee41cf4d73c70/developers/topics/opcodes-and-status-codes.mdx))
- Under DAVE, "the full contents of OPUS frames… are end-to-end encrypted". Transport encryption between client and SFU remains. The SFU is not an MLS group member and cannot read frames. ([voice-connections.mdx L346](https://github.com/discord/discord-api-docs/blob/9d2128bb8301e7d9f239ff259f2ee41cf4d73c70/developers/topics/voice-connections.mdx), [DAVE whitepaper](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md))
- So Textile's bot host must be a full MLS group member (opcodes 21–31). To transcode or relay any speaker, it decrypts that speaker's frames itself.
- After decryption the payload is a plain Opus frame. `@discordjs/voice` hands it to `AudioReceiveStream` as `AudioPacket{payload, sequence, timestamp, ssrc}` ([VoiceReceiver.ts L198–199](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/receive/VoiceReceiver.ts)). **Inferred:** Opus passthrough per speaker is feasible; PCM16 needs an Opus decoder and a jitter buffer.

## 3. How speakers are identified

**Verified.**

| Signal | Carries | Source |
| --- | --- | --- |
| Opcode 5 Speaking, server → client | `ssrc`, `user_id`, speaking flags | [discord-api-types `VoiceSpeakingData`](https://github.com/discordjs/discord-api-types/blob/main/voice/v8.ts); the docs list op 5 as "client and server" but their example omits `user_id` |
| Opcode 11 Clients Connect | `user_ids[]` only, no SSRCs | [DAVE whitepaper §clients_connect](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md) |
| Opcode 13 Client Disconnect | `user_id` only | [DAVE whitepaper §client_disconnect](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md) |
| RTP header | 32-bit `ssrc` at bytes 8–11 | [voice-connections.mdx L455–465](https://github.com/discord/discord-api-docs/blob/9d2128bb8301e7d9f239ff259f2ee41cf4d73c70/developers/topics/voice-connections.mdx) |

- `@discordjs/voice` builds its map as follows ([VoiceReceiver.ts L74–80, L208–215](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/receive/VoiceReceiver.ts)):
  - It adds `ssrc → userId` on op 5 and removes the user on op 13.
  - It silently drops any UDP packet whose SSRC is not in the map.
  - It never reads op 11 for SSRCs, because op 11 has none.
- Per-sender key derivation: `sender_base_secret = MLS-Exporter("Discord Secure Frames v0", littleEndian64(senderUserId), 16)`. A receiver ratchets per sender and picks the generation from the top byte of the 32-bit nonce in each frame. ([whitepaper §Sender Key Derivation](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md); [daveprotocol.com](https://daveprotocol.com))
- `@discordjs/voice` calls `daveSession.decrypt(payload, userId)` with the user ID it got from the SSRC map ([VoiceReceiver.ts L184–196](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/receive/VoiceReceiver.ts), [DAVESession.ts L361](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/networking/DAVESession.ts)).
- The whitepaper does not say how a receiver maps SSRC to user. It notes that per-sender keys are not authentication: any member can derive any sender's key, and spoofing is limited only because the SFU forwards a given SSRC only for packets that decrypt under that sender's transport key. ([whitepaper §Impersonation](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md))

**Inferred:** the speaker tag on each stream is only as reliable as the op 5 mapping. A wrong mapping means decryption fails (wrong key), not mislabeled audio, because the key depends on the user ID. Treat decrypt failure as "unknown speaker" and drop.

## 4. Edge cases

**Silence frames — verified.**
- Senders should "send five frames of silence (`0xF8, 0xFF, 0xFE`) before stopping" ([voice-connections.mdx L504](https://github.com/discord/discord-api-docs/blob/9d2128bb8301e7d9f239ff259f2ee41cf4d73c70/developers/topics/voice-connections.mdx)).
- The SFU can synthesize `0xF8FFFE` itself when a source is muted. DAVE lets exactly those three bytes pass through unencrypted even in E2EE mode, and Discord says it plans to remove that exception ([whitepaper §Silence Packets](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md)).
- `@discordjs/voice` returns that frame untouched instead of decrypting it ([DAVESession.ts L363](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/networking/DAVESession.ts)).
- Implications for Textile: handle the plaintext silence frame without decrypting; treat the trailing run as end-of-utterance; do not count it as speech. Packets stop entirely when nobody talks, so "start/stop speaking" has to come from packet arrival gaps or op 5. `@discordjs/voice` uses a 100 ms gap ([SpeakingMap.ts](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/receive/SpeakingMap.ts)).

**Speakers joining mid-call.**
- *Verified:* members who join do not get earlier media, and group members refuse an MLS add for a user not in a prior op 11 ([whitepaper](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md)). A join triggers a new epoch: proposals (27), commit (29), welcome (30), transition ready (23), execute (22).
- *Verified:* receivers keep previous-epoch ratchets for up to 10 seconds across a transition. Removed members can still decrypt for roughly 2 seconds after removal.
- *Verified:* `@discordjs/voice` tolerates 36 consecutive decrypt failures before re-initializing the session, and says 5–24 more packets may fail after a re-init ([DAVESession.ts L45](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/networking/DAVESession.ts)). Expect short audio loss right after anyone joins or leaves.
- *Inferred:* if the bot joins after a speaker and that speaker hasn't sent op 5 since, the SSRC is unknown and audio is dropped until the next op 5. I found nothing saying the server replays op 5 to a late joiner. Textile should surface the op 5 map to the agent only after it exists, and test late join on a real call.

**SSRC reuse and staleness.**
- *Verified:* no Discord source documents SSRC lifetime or reuse across users or reconnects.
- *Verified:* `SSRCMap` is keyed by SSRC, `update` never removes a user's older SSRC, and `delete(userId)` stops at the first matching entry ([SSRCMap.ts](https://github.com/discordjs/discord.js/blob/107f61dcbaccda0bc537ccb7307f20e44323f3f4/packages/voice/src/receive/SSRCMap.ts)). A user who reconnects or changes SSRC can leave a stale entry behind, and a later packet on that SSRC would be attributed to the old user.
- *Inferred:* Textile should make "one user ↔ one current SSRC" explicit. On op 5, replace any previous SSRC for that `user_id` and evict any previous user for that SSRC. On op 13, clear every SSRC for that user.

**Duplicates and ordering.** *Verified:* the DAVE decryptor accepts a given key/nonce pair once, so a duplicate or replayed packet fails decryption. Old generations are cached ~10 seconds for out-of-order frames ([whitepaper §Sender Key Derivation](https://github.com/discord/dave-protocol/blob/1b2b706ad4a562ede5c2ef901f9d77f6dbe79446/protocol.md)). RTP sequence and timestamp are available for a jitter buffer.

**Bot's own SSRC and deafen state.** *Inferred:* the bot's own packets are not echoed to it, and a bot that joins with `self_deaf: true` presumably receives nothing. The docs list `self_deaf` in the voice state update but don't say what it does for bots ([voice-connections.mdx L50](https://github.com/discord/discord-api-docs/blob/9d2128bb8301e7d9f239ff259f2ee41cf4d73c70/developers/topics/voice-connections.mdx)). Test it.

## 5. Policy obligations

Sources: [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy) (effective 2024-07-08) and [Developer Terms of Service](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service) (effective 2024-07-08). Discord's support site blocks automated fetches, so I read Wayback snapshots from 2026-01-09 (policy) and 2025-10-01 (terms). Re-read the live pages before shipping; Discord may have revised them since.

**Verified: neither document mentions voice, audio, recording, or consent to record.** The rules below apply to "API Data" in general.

- **API Data** is "any data, information, or other content you obtain through the APIs" (Terms, definitions). **Inferred:** audio received over the voice gateway counts. Treat it as API Data.
- **Purpose limit** (Policy 15): use API Data only as necessary for the Application's stated functionality. The stated functionality should say that the bot listens in voice channels and forwards audio to the agent.
- **No profiling** (Policy 16) of users, identities, or relationships. Per-speaker streams tagged with user IDs are fine for relaying; building voice profiles or speaker analytics would not be.
- **No selling or commercializing, no brokers or ad networks** (Policy 17–18). **No mining or scraping** of Discord content (Policy 20).
- **ML training** (Policy 21) is banned "unless express permission is granted by Discord", but the rule says "message content". **Inferred:** audio is not literally covered, but Policy 15 and Terms §5 still limit it. Textile runs no inference ([PRD out of scope](https://github.com/mia-cx/discord-mcp/issues/15)); keep it that way, and tell agents not to use received audio for training.
- **No de-anonymizing or "unencrypt[ing]" API Data from the form obtained** (Policy 19). **Inferred:** DAVE decryption as an invited MLS group member is the sanctioned path and is not what this rule targets. Keep decryption inside the protocol and never log keys or ciphertext.
- **Respect opt-out** (Policy 3): the Application must respect users' ability to block it or remove it from spaces. **Policy 2:** do not "initiate processes on a user or server's behalf" without clearly labeled permission. **Inferred:** a server admin adding the bot and an explicit "join voice" action are the permission; Textile must not auto-join channels.
- **Privacy policy** (Terms §5a): each Application needs a public privacy policy that "clearly, accurately, and fully describes" what data is collected, how it is used, shared with third parties, and how users request deletion.
- **Sharing** (Terms §5b): API Data goes to no third party except a Service Provider bound in writing, where required by law, or where "a user… expressly directs you". **Inferred:** Textile is a Service Provider of the bot's owner. The agent's speech-to-speech provider receives the audio next, so the bot owner's privacy policy must name it.
- **Retention and security** (Terms §5): delete API Data when it is no longer needed, on user request, or when the app stops; encrypt it at rest. **Inferred:** the safest design is stream-only, with no audio written to disk or logs. Then retention and at-rest duties don't arise for audio.
- **Law** (Terms §4): comply with applicable law and "not infringe or violate… rights of privacy or publicity". **Not researched:** call-recording consent laws and GDPR specifics for voice. They vary by jurisdiction and need a legal read.

**Notice to people in the channel.** The Discord docs I read define no notice or consent mechanism for bots that listen. **Inferred obligations Textile should surface:**
- Announce in the channel when a voice session starts and that audio is relayed to an agent, for example a text message in the channel's chat.
- Name who operates the bot and where its privacy policy lives.
- Provide a way to stop: kick the bot, block it, or leave the channel. The bot should also stop relaying a speaker on request.

## Changes the PRD should consider

1. **Receiving is best-effort.** Say so on stories 26 and 29. Plan an integration test against real Discord, run manually, because the fake gateway can't catch drift.
2. **Speaker identity depends on op 5.** Stories 26 and 29 assume reliable per-speaker tags and joins/leaves. Op 11/13 give presence; only op 5 gives the SSRC. Define behaviour for audio from an SSRC that has no `user_id` yet (drop it, and don't buffer).
3. **Notice and privacy are Textile's job.** The PRD has no user story for people in the channel. Add one: session-start announcement, a named privacy policy, a no-persist rule for audio, and a stop mechanism.
