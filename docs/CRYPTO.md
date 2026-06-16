# Encryption design

Threat model: protect message content and call media from a **curious server
operator who is not a member of the space**, and from anyone on the network
path (including a TURN relay). We are **not** defending against compromised
member devices, nation-state attackers, or the server lying about membership
*metadata*. Members of a space mutually trust each other.

Primitives (via `@noble/curves` and `@noble/ciphers` in the client):

- Signatures: **Ed25519**
- Key agreement: **X25519**
- AEAD: **XChaCha20-Poly1305** (24-byte nonces)
- KDF: **HKDF-SHA256**

## Device identity

On first run each client generates and stores locally:

- `sign_key`: Ed25519 keypair — identity & message/signal authenticity.
- `kem_key`: X25519 keypair — receiving wrapped space keys.

The public halves are registered with the server at account creation and are
**pinned** by other members the first time they are seen (trust on first use).
The fingerprint (base58 of SHA-256 of both public keys) is shown in the UI so
friends can verify out-of-band if they care.

v1: one device per user. Moving devices = exporting the key file.

## Login

Authentication to the server proves possession of `sign_key`:

1. `GET /auth/challenge?user_id=…` → random 32-byte nonce (single-use, 60 s).
2. Client sends `sig = Ed25519(sign_key, "vc-login:" || nonce)`.
3. Server verifies against the registered public key and issues an opaque
   bearer token (stored server-side as SHA-256).

## Space keys

Each space has a 32-byte symmetric **space key**, versioned by integer
`epoch` starting at 1. The creator generates epoch 1 locally. The server only
ever stores **wrapped** copies.

### Sealed box (key wrapping)

To wrap a space key `K` for a member with X25519 public key `R`:

```
(e_priv, e_pub) = X25519 keypair (ephemeral, fresh per wrap)
shared  = X25519(e_priv, R)
wrapkey = HKDF-SHA256(ikm = shared, salt = e_pub || R, info = "vc-seal-v1", len = 32)
ct      = XChaCha20-Poly1305(key = wrapkey, nonce = 0^24, aad = "", plaintext = K)
wrapped = e_pub (32 bytes) || ct
```

The all-zero nonce is safe because `wrapkey` is unique per wrap (fresh
ephemeral key). This is the age/libsodium-sealed-box construction with
explicit, documented parameters.

### Distribution

- **Join:** when a new member redeems an invite, the server emits
  `key_request` to online members. Any member wraps **all epochs it holds**
  for the newcomer's `kem_key` and uploads them. This is what gives new
  members history access (a deliberate property). If no member is online the
  newcomer waits — acceptable for a friend group.
- **Removal:** the owner removes the member, then generates epoch `n+1`,
  wraps it for every remaining member, and uploads. New messages use the new
  epoch. The removed member keeps anything they already saw (unavoidable) but
  cannot read new messages. The server deletes the removed member's wraps.

## Message encryption

Every chat message is encrypted client-side with the current epoch's space
key:

```
nonce = random 24 bytes
aad   = "vc-msg-v1:" || space_id || ":" || channel_id || ":" || epoch || ":" || sender_user_id
ct    = XChaCha20-Poly1305(key = K_epoch, nonce, aad, plaintext = UTF-8 message JSON)
sig   = Ed25519(sender sign_key, "vc-msg-v1:" || nonce || ct)
```

The server stores `{epoch, nonce, ct, sig}` and the (plaintext) routing
metadata: channel, sender id, timestamp. Receivers verify `sig` against the
sender's pinned key **before** decrypting; the AAD binds the ciphertext to
its space/channel/epoch/sender so the server cannot replay a message into a
different channel or attribute it to another sender.

Plaintext message JSON is tagged by `t`: `{ "t": "text", "body": "…" }` for
chat and `{ "t": "sticker", "id": "<sticker_id>" }` to send a space sticker.
The tag is versioned so DMs, attachments, etc. can be added later without
schema breakage.

## Sticker encryption

Stickers are space assets (animated webp), uploaded by the owner and shared
with all members, so they are encrypted with the **space key** rather than a
per-recipient wrap. The owner encrypts the webp bytes client-side under the
current epoch key:

```
nonce = random 24 bytes
aad   = "vc-sticker-v1:" || space_id || ":" || epoch
ct    = XChaCha20-Poly1305(key = K_epoch, nonce, aad, plaintext = webp bytes)
```

The server stores `{epoch, nonce, ct}` opaquely. Members decrypt with the same
epoch key on display; because clients retain every epoch key they have been
given, stickers stay readable across key rotations. There is no per-sticker
signature — the AEAD tag authenticates the blob, only members hold the key, and
only the owner may upload (enforced server-side). A malicious member with the
key still cannot publish a sticker (no upload permission) or swap an existing
one (addressed by id, never overwritten).

## Call security

Calls are a **P2P mesh**: every pair of participants has its own WebRTC
connection secured by **DTLS-SRTP**. There is no media server, so pairwise
transport encryption *is* end-to-end. A TURN relay, when used, forwards
SRTP ciphertext it cannot decrypt.

Residual risk: the signaling server could MITM the DTLS handshake by swapping
SDP fingerprints. Mitigation: every signaling payload (SDP offers/answers,
ICE candidates) is signed:

```
sig = Ed25519(sender sign_key, "vc-signal-v1:" || space_id || ":" || channel_id
              || ":" || from_user || ":" || to_user || ":" || payload_json)
```

Receivers verify against the pinned member key and **reject the connection**
on mismatch. Since the SDP carries the DTLS certificate fingerprint, a forged
fingerprint cannot be injected without breaking the signature.

If an SFU is ever added (it is not in v1), frame-level encryption
(SFrame-style, via Insertable Streams / `RTCRtpScriptTransform` with the
space key) is the documented extension point; the APIs are available in
WebView2's Chromium.

## Properties summary

Provided:

- Server operator (non-member) cannot read messages or media.
- Network observers and TURN relays cannot read messages or media.
- Sender authenticity for messages and signaling (pinned device keys).
- Offline members catch up on history; new members read full history.

Explicitly **not** provided:

- Forward secrecy / post-compromise security (a stolen device key + saved
  ciphertext reveals history; rotate by removing/re-adding members).
- Deniability.
- Metadata privacy: the server sees membership, message times/sizes, and who
  is in which call.
- Protection against a malicious *member* (out of scope by definition).
