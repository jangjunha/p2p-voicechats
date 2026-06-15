# Running the server

The server is intentionally tiny: one Rust binary + SQLite, plus coturn for
the TURN fallback and Caddy for TLS. A Raspberry-Pi-class home box or the
cheapest Seoul VPS is plenty — remember that **media never flows through the
server** except when a peer needs the TURN relay.

## Docker compose (recommended)

```sh
cp .env.example .env       # set DOMAIN and TURN_SECRET
docker compose pull        # fetch the prebuilt server image from GHCR
docker compose up -d
```

This uses the multi-arch (amd64 + arm64) image published to GitHub Packages at
`ghcr.io/jangjunha/malguem/server`. To build the server from source
instead of pulling, run `docker compose up -d --build`.

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

### TURN behind a home router (NAT)

If the box has a private LAN address behind a router (typical home setup),
coturn must be told its public address or it will hand out unreachable relay
candidates. Add `--external-ip` to the `coturn` service command in
`docker-compose.yml`:

```yaml
    command: >-
      --fingerprint
      --use-auth-secret
      --static-auth-secret=${TURN_SECRET}
      --realm=${DOMAIN}
      --listening-port=3478
      --min-port=49160
      --max-port=49200
      --external-ip=<your-public-ip>/<this-host-lan-ip>
```

On a VPS with a directly-attached public IP this is not needed.

## Bare binary (no Docker)

Each tagged release ships a static, dependency-free `malguem-server` binary for
`amd64` and `arm64` on the
[Releases page](https://github.com/jangjunha/malguem/releases). Download
the archive for your architecture, or build from source:

```sh
cargo build --release -p malguem-server
MALGUEM_DB=/var/lib/malguem/malguem.sqlite3 MALGUEM_TURN_SECRET=… \
  MALGUEM_TURN_URLS="turn:chat.example.com:3478?transport=udp" \
  ./target/release/malguem-server
```

Put any TLS-terminating proxy in front of port 8787 and install coturn from
your distro (`use-auth-secret` + the same secret).

## Configuration reference (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `MALGUEM_BIND` | `0.0.0.0:8787` | HTTP listen address |
| `MALGUEM_DB` | `malguem.sqlite3` | SQLite path |
| `MALGUEM_TURN_SECRET` | unset | coturn shared secret; unset = STUN-only |
| `MALGUEM_TURN_URLS` | empty | TURN URLs handed to clients |
| `MALGUEM_TURN_TTL` | `3600` | TURN credential lifetime (seconds) |
| `MALGUEM_STUN_URLS` | Google STUN | STUN URLs handed to clients |
| `MALGUEM_SPACE_CREATOR_SIGN_PUBS` | empty | CSV of `sign_pub` keys allowed to create spaces; empty = anyone |
| `MALGUEM_MAX_USERS` | unset | Cap on total registered users; new registrations get `409` once reached; unset = unlimited |

## Backups

Everything lives in the SQLite file (`malguem-data` volume). It contains only
ciphertext and metadata; copy it anywhere. Losing it loses chat history but
not identities (those live on members' devices).
