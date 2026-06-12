# p2p-voicechats

A lightweight, self-hostable Discord alternative for a small group of friends:
text chat, voice calls, and low-latency game screen sharing. Media is
peer-to-peer and end-to-end encrypted; the server only does signaling and
stores ciphertext.

Built to fix three Discord pain points: paid-tier screen-share quality limits,
a heavy client, and ads.

## Architecture at a glance

```
┌────────────┐   WebRTC (DTLS-SRTP, P2P mesh)   ┌────────────┐
│  Client A  │◄────────────────────────────────►│  Client B  │
│ Tauri +    │                                  │            │
│ WebView2   │      (TURN relay, last resort,   │            │
└─────┬──────┘       ciphertext only)           └─────┬──────┘
      │                                               │
      │  HTTPS + WebSocket (signaling, presence,      │
      │  ciphertext chat, wrapped keys)               │
      └────────────────┬──────────────────────────────┘
                       ▼
              ┌─────────────────┐
              │  vc-server      │  single Rust binary + SQLite
              │  (+ coturn)     │  runs on a home box or tiny VPS
              └─────────────────┘
```

- **Client**: Tauri v2 shell (Rust) + Svelte/TypeScript UI in WebView2.
  All real-time media uses the webview's built-in Chromium WebRTC stack:
  hardware encoding, congestion control, and `getStats()` telemetry for free.
- **Server**: one Rust binary (`vc-server`), SQLite storage, WebSocket
  signaling. It never sees media and never sees plaintext messages.
- **Connectivity**: ICE with STUN; self-hosted TURN (coturn) as an automatic
  last resort for CGNAT/symmetric-NAT peers. TURN relays ciphertext only.
- **Encryption**: calls are E2E via pairwise DTLS-SRTP with identity-signed
  fingerprints; chat uses a per-space symmetric key wrapped to each member's
  device key. See [docs/CRYPTO.md](docs/CRYPTO.md).

See [docs/DECISIONS.md](docs/DECISIONS.md) for why each of these was chosen,
[docs/PROTOCOL.md](docs/PROTOCOL.md) for the client–server protocol, and
[docs/SPIKE.md](docs/SPIKE.md) for the Windows validation checklist
(milestone 0).

## Repository layout

```
server/    vc-server: signaling + ciphertext storage (Rust, axum, SQLite)
client/    desktop app (Tauri v2 + Svelte 5 + TypeScript)
deploy/    docker-compose, Caddyfile, coturn config
docs/      decisions, protocol, crypto design, spike checklist
```

## Running the server (operator quick start)

```sh
cd deploy
cp .env.example .env   # set DOMAIN and TURN_SECRET
docker compose up -d
```

This starts `vc-server`, coturn (TURN relay), and Caddy (automatic TLS).
A home box behind a router needs ports 443/tcp, 3478/udp+tcp and the coturn
relay range 49160–49200/udp forwarded. See [deploy/README.md](deploy/README.md).

Bare-metal alternative: `cargo build --release -p vc-server` produces a single
binary; point it at a SQLite path and put any TLS proxy in front.

## Developing

```sh
# server
cd server && cargo test && cargo run

# client (UI in a browser during development, full app via Tauri)
cd client && npm install && npm run dev      # Vite dev server
npm run tauri dev                            # full desktop app (Windows)
```

## Status

Early development. Feature scope for v1 (deliberately small):

- [x] Architecture & protocol design
- [x] Spaces, channels, invites
- [x] Encrypted text chat with offline catch-up
- [x] Voice calls (P2P mesh) — *built, pending Windows validation*
- [x] Screen share with sender-side codec/bitrate/resolution/fps controls
      and system-audio capture — *built, pending the
      [Windows spike](docs/SPIKE.md)*
- [ ] Windows installer + auto-update (Tauri bundling configured; updater
      and release pipeline still to do)

Non-goals for v1: DMs, reactions, uploads, threads, search, moderation
tooling, mobile apps. The data model deliberately leaves room for DMs and
attachments later.
