/**
 * All client-side cryptography. The wire formats here are the normative
 * implementation of docs/CRYPTO.md — change both together.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';

const SEAL_INFO = 'vc-seal-v1';
const MSG_CONTEXT = 'vc-msg-v1:';
const SIGNAL_CONTEXT = 'vc-signal-v1:';
const STICKER_CONTEXT = 'vc-sticker-v1:';
const LOGIN_CONTEXT = 'vc-login:';

const te = new TextEncoder();
const td = new TextDecoder();

// ---------- encoding ----------

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function unb64u(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- identity ----------

export interface Identity {
  signPriv: Uint8Array;
  signPub: Uint8Array;
  kemPriv: Uint8Array;
  kemPub: Uint8Array;
}

export function generateIdentity(): Identity {
  const signPriv = ed25519.utils.randomPrivateKey();
  const kemPriv = x25519.utils.randomPrivateKey();
  return {
    signPriv,
    signPub: ed25519.getPublicKey(signPriv),
    kemPriv,
    kemPub: x25519.getPublicKey(kemPriv),
  };
}

export function serializeIdentity(id: Identity): string {
  return JSON.stringify({
    v: 1,
    sign_priv: b64u(id.signPriv),
    kem_priv: b64u(id.kemPriv),
  });
}

export function deserializeIdentity(json: string): Identity {
  const o = JSON.parse(json);
  if (o.v !== 1) throw new Error('unsupported identity version');
  const signPriv = unb64u(o.sign_priv);
  const kemPriv = unb64u(o.kem_priv);
  return {
    signPriv,
    signPub: ed25519.getPublicKey(signPriv),
    kemPriv,
    kemPub: x25519.getPublicKey(kemPriv),
  };
}

/** Short human-comparable fingerprint of a member's public keys. */
export function fingerprint(signPub: Uint8Array, kemPub: Uint8Array): string {
  return base58(sha256(concat(signPub, kemPub)).slice(0, 12));
}

export function loginSignature(id: Identity, nonce: string): string {
  return b64u(ed25519.sign(te.encode(LOGIN_CONTEXT + nonce), id.signPriv));
}

// ---------- sealed box (space-key wrapping) ----------

export function sealBox(recipientKemPub: Uint8Array, plaintext: Uint8Array): string {
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientKemPub);
  const wrapKey = hkdf(sha256, shared, concat(ephPub, recipientKemPub), te.encode(SEAL_INFO), 32);
  // Zero nonce is safe: wrapKey is unique per wrap (fresh ephemeral key).
  const ct = xchacha20poly1305(wrapKey, new Uint8Array(24)).encrypt(plaintext);
  return b64u(concat(ephPub, ct));
}

export function openBox(id: Identity, wrapped: string): Uint8Array {
  const data = unb64u(wrapped);
  if (data.length < 32 + 16) throw new Error('sealed box too short');
  const ephPub = data.slice(0, 32);
  const ct = data.slice(32);
  const shared = x25519.getSharedSecret(id.kemPriv, ephPub);
  const wrapKey = hkdf(sha256, shared, concat(ephPub, id.kemPub), te.encode(SEAL_INFO), 32);
  return xchacha20poly1305(wrapKey, new Uint8Array(24)).decrypt(ct);
}

export function generateSpaceKey(): Uint8Array {
  return randomBytes(32);
}

// ---------- messages ----------

export interface MessageMeta {
  spaceId: string;
  channelId: string;
  epoch: number;
  senderId: string;
}

function messageAad(m: MessageMeta): Uint8Array {
  return te.encode(`${MSG_CONTEXT}${m.spaceId}:${m.channelId}:${m.epoch}:${m.senderId}`);
}

export interface EncryptedMessage {
  nonce: string;
  ct: string;
  sig: string;
}

export function encryptMessage(
  id: Identity,
  spaceKey: Uint8Array,
  meta: MessageMeta,
  body: unknown,
): EncryptedMessage {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(spaceKey, nonce, messageAad(meta)).encrypt(
    te.encode(JSON.stringify(body)),
  );
  const sig = ed25519.sign(concat(te.encode(MSG_CONTEXT), nonce, ct), id.signPriv);
  return { nonce: b64u(nonce), ct: b64u(ct), sig: b64u(sig) };
}

/** Verifies the sender's signature, then decrypts. Throws on any failure. */
export function decryptMessage(
  senderSignPub: Uint8Array,
  spaceKey: Uint8Array,
  meta: MessageMeta,
  msg: EncryptedMessage,
): unknown {
  const nonce = unb64u(msg.nonce);
  const ct = unb64u(msg.ct);
  const ok = ed25519.verify(unb64u(msg.sig), concat(te.encode(MSG_CONTEXT), nonce, ct), senderSignPub);
  if (!ok) throw new Error('message signature verification failed');
  const pt = xchacha20poly1305(spaceKey, nonce, messageAad(meta)).decrypt(ct);
  return JSON.parse(td.decode(pt));
}

// ---------- binary blobs (stickers) ----------

/**
 * Symmetric AEAD for a binary blob under the space key, used for sticker
 * images. Authentication comes from the AEAD tag bound to `${spaceId}:${epoch}`
 * as associated data; there's no per-blob signature because only the owner can
 * upload (enforced server-side) and only space members hold the key.
 */
function blobAad(spaceId: string, epoch: number): Uint8Array {
  return te.encode(`${STICKER_CONTEXT}${spaceId}:${epoch}`);
}

export function encryptBlob(
  spaceKey: Uint8Array,
  spaceId: string,
  epoch: number,
  data: Uint8Array,
): { nonce: string; ct: string } {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(spaceKey, nonce, blobAad(spaceId, epoch)).encrypt(data);
  return { nonce: b64u(nonce), ct: b64u(ct) };
}

export function decryptBlob(
  spaceKey: Uint8Array,
  spaceId: string,
  epoch: number,
  nonce: string,
  ct: string,
): Uint8Array {
  return xchacha20poly1305(spaceKey, unb64u(nonce), blobAad(spaceId, epoch)).decrypt(unb64u(ct));
}

// ---------- call signaling ----------

/**
 * Deterministic JSON with recursively sorted object keys. Signaling payloads
 * are relayed through the server as `serde_json::Value`, which reorders object
 * keys, so both signer and verifier must canonicalize identically rather than
 * relying on insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function signalBytes(
  spaceId: string,
  channelId: string,
  from: string,
  to: string,
  payloadJson: string,
): Uint8Array {
  return te.encode(`${SIGNAL_CONTEXT}${spaceId}:${channelId}:${from}:${to}:${payloadJson}`);
}

export function signSignal(
  id: Identity,
  spaceId: string,
  channelId: string,
  from: string,
  to: string,
  payloadJson: string,
): string {
  return b64u(ed25519.sign(signalBytes(spaceId, channelId, from, to, payloadJson), id.signPriv));
}

export function verifySignal(
  senderSignPub: Uint8Array,
  sig: string,
  spaceId: string,
  channelId: string,
  from: string,
  to: string,
  payloadJson: string,
): boolean {
  try {
    return ed25519.verify(unb64u(sig), signalBytes(spaceId, channelId, from, to, payloadJson), senderSignPub);
  } catch {
    return false;
  }
}
