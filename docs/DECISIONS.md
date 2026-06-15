# Architecture decisions

Status: all six decisions below were researched, proposed with tradeoffs, and
approved by the project owner on 2026-06-12. Revisit only with a written
reason here.

## 1. Languages & runtime

**Rust for everything native (server, Tauri shell); TypeScript for the client
UI and all WebRTC/crypto client logic.**

- Server must be cheap to self-host → a single Rust binary with SQLite has a
  tens-of-MB RAM footprint and no runtime dependencies.
- Client media runs inside WebView2 (decision 3), so the call/crypto logic
  naturally lives in TypeScript next to the UI.
- Both are on the preferred-language list from the brief.

## 2. Client architecture

**Tauri v2 (Rust shell) hosting a Svelte 5 + TypeScript UI in the system
WebView2. Not Electron.**

- WebView2 is a shared system runtime: installers are a few MB and RAM use is
  far below Electron, satisfying the "lightweight client" priority.
- Svelte compiles away its framework at build time — small bundle, no virtual
  DOM, good fit for a low-overhead client.
- The Rust shell handles tray, updater, identity-key storage, and the native
  WASAPI loopback fallback (see decision 3 risk).
- macOS stays possible later (Tauri/WKWebView), and the documented
  HTTP+WebSocket protocol keeps a future mobile client open.

## 3. Real-time media stack

**The Chromium WebRTC engine inside WebView2 is the media stack.** No native
media pipeline in v1.

What this buys (all verified against 2025–2026 sources):

- **Hardware encoding** via Media Foundation / the D3D12 encode path on
  Windows 11: H.264 broadly, HEVC enabled by default since ~Chrome 136, AV1 on
  recent GPUs. Spares CPU/GPU for the game.
- **Adaptive bitrate / congestion control** (transport-cc + GCC), jitter
  buffering, FEC/NACK — would take months to reimplement natively.
- **Sender controls are standard APIs**: `setCodecPreferences` (codec),
  `RTCRtpSender.setParameters({ maxBitrate })`, `getDisplayMedia`
  width/height/frameRate constraints, `contentHint`/`degradationPreference`.
- **Reliable telemetry** via `getStats()`: RTT, `jitterBufferDelay`, encoded
  bitrate, FPS, encode time, `qualityLimitationReason`. This sidesteps the
  `webrtc-rs` arrival-timestamp trap entirely.
- **Monitor capture** works at target FPS in WebView2. Known WebView2 issues
  and mitigations: window capture runs at ~5 FPS
  (WebView2Feedback #4176 — irrelevant: monitor capture is the requirement);
  the share-picker dialog clips in small windows (#5173 — keep the window
  ≥600 px when opening the picker).

**Known risk & fallback (validate first, see docs/SPIKE.md):** whether the
WebView2 share picker offers Chromium's "also share system audio" loopback.
If not, the fallback is native WASAPI loopback capture in the Rust shell,
streamed into the page and attached via Web Audio — which also implements the
required mic vs. system-audio toggle independent of any picker UI.

**Rejected:** `webrtc-rs`/`str0m` (BYO encoders, BWE, capture — high effort,
high risk, weak telemetry), native libwebrtc bindings (same engine, brutal
build/maintenance), GStreamer (heavy Windows deployment, weaker congestion
control story). Because the wire protocol is standard WebRTC, a native client
remains a future escape hatch without protocol changes.

## 4. Connectivity

**ICE with public STUN, plus self-hosted TURN (coturn) as an automatic last
resort.** Media never touches `malguem-server`.

- Korean residential ISPs (KT, SK Broadband, LG U+) use CGNAT on some lines;
  STUN-only would leave such peers permanently unable to connect.
- ICE candidate priorities already prefer host/server-reflexive over relay, so
  TURN engages only when direct paths fail — last-resort by construction.
- TURN relays DTLS-SRTP ciphertext it cannot decrypt; E2EE is preserved.
- coturn runs next to the server (same compose file, Seoul-local → minimal
  added latency). Credentials are ephemeral HMAC credentials
  (`use-auth-secret` mechanism) minted by `malguem-server` for authenticated space
  members only.
- IPv6 ICE candidates enabled — Korean dual-stack often bypasses CGNAT.

## 5. Encryption design

Full design in [CRYPTO.md](CRYPTO.md). Summary:

- **Calls:** pure P2P mesh → pairwise DTLS-SRTP is already end-to-end (no
  media server exists; TURN can't decrypt). To stop a malicious signaling
  server from MITM-ing key exchange, every signaling payload is signed with
  the sender's Ed25519 device identity key, which is pinned per space.
  Frame-level encryption (SFrame/insertable streams) is unnecessary without an
  SFU and is left as a documented extension point.
- **Chat:** a per-space symmetric key (XChaCha20-Poly1305), wrapped to each
  member device's X25519 key (sealed box) and stored server-side as opaque
  blobs. Messages are encrypted + signed client-side; the server stores only
  ciphertext, so offline members catch up by fetching ciphertext, and new
  members can read history because members wrap the key for them on join.
  The key rotates to a new epoch when a member is removed.
- **Provided:** confidentiality against the server operator; sender
  authenticity; new-member history; offline catch-up.
  **Not provided (deliberate):** forward secrecy, post-compromise security,
  deniability, metadata privacy (the server sees who talks where and when).
- **Rejected:** MLS/OpenMLS (heavy, and its FS design actively fights the
  new-member-history requirement), Megolm-style sender keys (most key-sharing
  machinery for the least benefit at this group size).
- v1 simplification: one device per user; moving devices = exporting the
  identity key. Multi-device is additive later.

## 6. Deployment & distribution

- **Server:** primary story is `docker compose` (malguem-server + coturn + Caddy
  for automatic TLS) on a home box, with dynamic DNS and port forwarding
  documented. A bare static binary + systemd is supported for minimalists; a
  ~$5/mo Seoul VPS works identically.
- **Client:** NSIS installer built by Tauri, published on GitHub Releases.
  Auto-update via Tauri's built-in updater, which verifies its own minisign
  signatures — secure updates without an OS code-signing certificate.
  SmartScreen will warn on first install (acceptable for a friend group; an OS
  signing cert or winget can be added later without redesign).

## 7. Multi-server client & credential storage

Added 2026-06-15, after the proof-of-concept, by the project owner.

**One client connects to multiple servers at once, each with its own
identity, and credentials live in the OS keychain — not localStorage.**

- **Per-server identity.** `Identity{sign_key, kem_key}` is generated and
  pinned per *server*, never per space and never reused across servers. A
  server only ever sees the one identity registered with it.
- **N live connections.** On boot the client walks the account vault and logs
  into every server in parallel, holding one `Api` + one `EventSocket` per
  server simultaneously. All per-server reactive state (spaces, members,
  messages, space keys) carries a `serverId` dimension and every action routes
  to that server's `Api`/socket. The left sidebar lists every server's spaces
  expanded together.
- **Keychain over localStorage.** Secrets — identity private keys and auth
  tokens — are stored in the OS keychain via a small Rust `keyring`-crate
  command surface (`keychain_get/set/delete`) invoked from a TypeScript
  wrapper. This realizes the "Rust shell handles identity-key storage" line
  from decision 2. Non-secret values (server URL, user id, display name) stay
  in localStorage as the account index (the "vault"). A plain browser dev build
  (vite, no Tauri) transparently falls back to localStorage.
- This supersedes the v1 "single account in localStorage" shape from the
  proof-of-concept; the single-device-per-identity simplification in decision 5
  still holds (moving a device = exporting that server's identity key).
