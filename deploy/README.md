# Running the server

The server is intentionally tiny: one Rust binary + SQLite, plus coturn for
the TURN fallback and Caddy for TLS. A Raspberry-Pi-class home box or the
cheapest Seoul VPS is plenty — remember that **media never flows through the
server** except when a peer needs the TURN relay.

## Docker compose (recommended)

```sh
cp .env.example .env       # set DOMAIN and TURN_SECRET
docker compose up -d --build
```

Point a DNS record (or dynamic-DNS name) at the box. Clients connect with
`https://<DOMAIN>` as the server URL.

### Ports to open / forward

| Port | Protocol | Purpose |
|---|---|---|
| 80, 443 | tcp | Caddy (TLS + API + WebSocket) |
| 3478 | udp + tcp | TURN listener |
| 49160–49200 | udp | TURN relay range |

If you cannot forward ports at all (e.g., the *server host itself* is behind
CGNAT), run the same compose file on a small VPS in Seoul instead — Vultr,
Lightsail, or Oracle Cloud free tier all work; TURN egress only matters for
calls where a friend's direct P2P fails.

## Bare binary (no Docker)

```sh
cargo build --release -p vc-server
VC_DB=/var/lib/vc/vc.sqlite3 VC_TURN_SECRET=… \
  VC_TURN_URLS="turn:chat.example.com:3478?transport=udp" \
  ./target/release/vc-server
```

Put any TLS-terminating proxy in front of port 8787 and install coturn from
your distro (`use-auth-secret` + the same secret).

## Configuration reference (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `VC_BIND` | `0.0.0.0:8787` | HTTP listen address |
| `VC_DB` | `vc.sqlite3` | SQLite path |
| `VC_TURN_SECRET` | unset | coturn shared secret; unset = STUN-only |
| `VC_TURN_URLS` | empty | TURN URLs handed to clients |
| `VC_TURN_TTL` | `3600` | TURN credential lifetime (seconds) |
| `VC_STUN_URLS` | Google STUN | STUN URLs handed to clients |

## Backups

Everything lives in the SQLite file (`vc-data` volume). It contains only
ciphertext and metadata; copy it anywhere. Losing it loses chat history but
not identities (those live on members' devices).
