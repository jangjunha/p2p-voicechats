# Client–server protocol

Transport: HTTPS REST for state changes and history; one authenticated
WebSocket per client for real-time events and call signaling. All bodies are
JSON. Authentication: `Authorization: Bearer <token>` (see CRYPTO.md §Login).

The server never sees plaintext message content or media. Binary fields
(keys, nonces, ciphertext, signatures) are base64url-encoded strings.

IDs: users/spaces/channels use UUIDv4; messages use ULID (lexicographically
time-sortable, used as the pagination cursor).

## REST

### Auth

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/register` | `{name, sign_pub, kem_pub}` → `{user_id}` |
| GET | `/api/auth/challenge?user_id=` | → `{nonce}` (single-use, 60 s TTL) |
| POST | `/api/auth/login` | `{user_id, nonce, sig}` → `{token, user}` |

### Spaces, channels, members, invites

| Method | Path | Notes |
|---|---|---|
| POST | `/api/spaces` | `{name}` → space. Creator becomes `owner`. |
| GET | `/api/spaces` | Spaces the caller belongs to, with channels. |
| GET | `/api/spaces/:id/members` | `[{user_id, name, role, sign_pub, kem_pub}]` — source for key pinning. |
| DELETE | `/api/spaces/:id/members/:user_id` | Owner only. Deletes the member's key wraps. Follow with a key rotation. |
| POST | `/api/spaces/:id/channels` | `{name}` → channel. Owner only. |
| POST | `/api/spaces/:id/invites` | `{expires_in_secs?}` → `{token}`. Owner only. |
| POST | `/api/invites/:token/accept` | Joins the space → space. Emits `key_request` to online members. |

### Space keys (wrapped, opaque to server)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/spaces/:id/keys` | `{epoch, wraps: [{user_id, wrapped}]}`. Any member may upload wraps for an existing epoch (join flow); only the owner may introduce a **new** epoch (rotation). |
| GET | `/api/spaces/:id/keys` | `{current_epoch, wraps: [{epoch, wrapped}]}` — only the caller's own wraps. |

### Messages (ciphertext)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/channels/:id/messages` | `{epoch, nonce, ct, sig}` → `{id, created_at}`. Fans out `message_new` to online space members. |
| GET | `/api/channels/:id/messages?before=<ulid>&limit=50` | Newest-first page of `{id, sender_id, epoch, nonce, ct, sig, created_at}`. |

### TURN

| Method | Path | Notes |
|---|---|---|
| GET | `/api/turn-credentials` | → `{urls: [...], username, credential, ttl_secs}`. Ephemeral HMAC credentials (coturn `use-auth-secret`): `username = "<unix_expiry>:<user_id>"`, `credential = base64(HMAC-SHA1(secret, username))`. |

Errors: non-2xx with `{error: "machine_readable_code", message: "human text"}`.

## WebSocket `/api/ws`

Connect with the bearer token (`Sec-WebSocket-Protocol: bearer,<token>` or
`?token=` during development). One connection per client. Messages are JSON
with a `type` tag.

### Client → server

```jsonc
{"type": "call_join",  "channel_id": "…"}
{"type": "call_leave", "channel_id": "…"}
{"type": "signal", "channel_id": "…", "to": "<user_id>",
 "payload": { /* opaque to server */ }, "sig": "…"}
{"type": "ping"}
```

`signal.payload` is producer-defined (SDP / ICE / renegotiation), signed per
CRYPTO.md §Call security. The server relays it only if both users share the
space and the recipient is online; it never inspects it.

### Server → client

```jsonc
{"type": "hello", "user_id": "…"}                 // on connect
{"type": "pong"}
{"type": "message_new", "channel_id": "…", "message": {…}}   // same shape as REST history
{"type": "call_roster", "channel_id": "…", "participants": ["user_id", …]}
{"type": "call_peer_joined", "channel_id": "…", "user_id": "…"}
{"type": "call_peer_left",   "channel_id": "…", "user_id": "…"}
{"type": "signal", "channel_id": "…", "from": "…", "payload": {…}, "sig": "…"}
{"type": "member_joined", "space_id": "…",
 "user": {"user_id": "…", "name": "…", "sign_pub": "…", "kem_pub": "…"}}
{"type": "member_removed", "space_id": "…", "user_id": "…"}
{"type": "channel_created", "space_id": "…", "channel": {"id": "…", "name": "…"}}
{"type": "key_request", "space_id": "…",          // wrap your epochs for this user
 "user": {"user_id": "…", "kem_pub": "…"}}
{"type": "keys_updated", "space_id": "…", "current_epoch": 2}
```

### Call membership semantics

- `call_join` adds the sender to the channel's roster and broadcasts
  `call_peer_joined` plus a fresh `call_roster` to roster members; the joiner
  receives the existing roster and **initiates offers to every existing
  participant** (deterministic initiator = the joiner; later renegotiation
  uses perfect negotiation with the lexicographically smaller user id as the
  polite peer).
- Disconnecting the WebSocket implies `call_leave` from all rosters.
- Voice and screen-share travel over the same peer connections; screen share
  is an extra video (+ audio) track added by the broadcaster with sender-side
  codec/bitrate/resolution/fps settings applied locally.

## Versioning

The WebSocket handshake path is unversioned during pre-1.0; breaking protocol
changes bump `/api` → `/api/v2` and are listed here. The protocol is the
contract a future mobile or native client builds against.
