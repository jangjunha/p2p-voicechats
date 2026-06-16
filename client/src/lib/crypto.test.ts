import { describe, expect, it } from 'vitest';
import {
  b64u,
  canonicalJson,
  decryptBlob,
  decryptMessage,
  deserializeIdentity,
  encryptBlob,
  encryptMessage,
  fingerprint,
  generateIdentity,
  generateSpaceKey,
  loginSignature,
  openBox,
  sealBox,
  serializeIdentity,
  signSignal,
  unb64u,
  verifySignal,
} from './crypto';

describe('encoding', () => {
  it('roundtrips base64url without padding', () => {
    const data = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(unb64u(b64u(data))).toEqual(data);
    expect(b64u(data)).not.toContain('=');
  });
});

describe('identity', () => {
  it('serializes and restores, deriving the same public keys', () => {
    const id = generateIdentity();
    const restored = deserializeIdentity(serializeIdentity(id));
    expect(restored.signPub).toEqual(id.signPub);
    expect(restored.kemPub).toEqual(id.kemPub);
    expect(fingerprint(restored.signPub, restored.kemPub)).toEqual(
      fingerprint(id.signPub, id.kemPub),
    );
  });

  it('produces a verifiable login signature', () => {
    const id = generateIdentity();
    // Just shape-check here; the server integration test verifies semantics.
    expect(loginSignature(id, 'abc').length).toBeGreaterThan(80);
  });
});

describe('sealed box', () => {
  it('roundtrips a space key to the right recipient', () => {
    const recipient = generateIdentity();
    const key = generateSpaceKey();
    const wrapped = sealBox(recipient.kemPub, key);
    expect(openBox(recipient, wrapped)).toEqual(key);
  });

  it('cannot be opened by another identity', () => {
    const recipient = generateIdentity();
    const other = generateIdentity();
    const wrapped = sealBox(recipient.kemPub, generateSpaceKey());
    expect(() => openBox(other, wrapped)).toThrow();
  });

  it('produces distinct ciphertexts per wrap (fresh ephemeral keys)', () => {
    const recipient = generateIdentity();
    const key = generateSpaceKey();
    expect(sealBox(recipient.kemPub, key)).not.toEqual(sealBox(recipient.kemPub, key));
  });
});

describe('message encryption', () => {
  const meta = { spaceId: 's1', channelId: 'c1', epoch: 1, senderId: 'alice' };

  it('roundtrips and authenticates', () => {
    const alice = generateIdentity();
    const key = generateSpaceKey();
    const enc = encryptMessage(alice, key, meta, { t: 'text', body: '안녕하세요 🎮' });
    const dec = decryptMessage(alice.signPub, key, meta, enc);
    expect(dec).toEqual({ t: 'text', body: '안녕하세요 🎮' });
  });

  it('rejects a forged sender', () => {
    const alice = generateIdentity();
    const mallory = generateIdentity();
    const key = generateSpaceKey();
    const enc = encryptMessage(mallory, key, meta, { t: 'text', body: 'hi' });
    expect(() => decryptMessage(alice.signPub, key, meta, enc)).toThrow(/signature/);
  });

  it('rejects replay into a different channel (AAD binding)', () => {
    const alice = generateIdentity();
    const key = generateSpaceKey();
    const enc = encryptMessage(alice, key, meta, { t: 'text', body: 'hi' });
    expect(() =>
      decryptMessage(alice.signPub, key, { ...meta, channelId: 'c2' }, enc),
    ).toThrow();
  });

  it('rejects the wrong epoch key', () => {
    const alice = generateIdentity();
    const enc = encryptMessage(alice, generateSpaceKey(), meta, { t: 'text', body: 'hi' });
    expect(() => decryptMessage(alice.signPub, generateSpaceKey(), meta, enc)).toThrow();
  });
});

describe('blob encryption (stickers)', () => {
  it('roundtrips a binary blob under the space key', () => {
    const key = generateSpaceKey();
    const data = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 250, 255]);
    const { nonce, ct } = encryptBlob(key, 's1', 2, data);
    expect(decryptBlob(key, 's1', 2, nonce, ct)).toEqual(data);
  });

  it('binds the space id and epoch as AAD', () => {
    const key = generateSpaceKey();
    const { nonce, ct } = encryptBlob(key, 's1', 2, new Uint8Array([1, 2, 3]));
    expect(() => decryptBlob(key, 's2', 2, nonce, ct)).toThrow();
    expect(() => decryptBlob(key, 's1', 3, nonce, ct)).toThrow();
  });

  it('rejects the wrong key', () => {
    const { nonce, ct } = encryptBlob(generateSpaceKey(), 's1', 1, new Uint8Array([9]));
    expect(() => decryptBlob(generateSpaceKey(), 's1', 1, nonce, ct)).toThrow();
  });
});

describe('canonical json', () => {
  it('is independent of object key order, recursively', () => {
    const a = canonicalJson({ kind: 'sdp', description: { type: 'offer', sdp: 'v=0' } });
    const b = canonicalJson({ description: { sdp: 'v=0', type: 'offer' }, kind: 'sdp' });
    expect(a).toEqual(b);
  });

  it('lets a signed signal survive server key reordering', () => {
    const alice = generateIdentity();
    const payload = { kind: 'sdp', description: { type: 'offer', sdp: 'v=0...' } };
    const sig = signSignal(alice, 's1', 'c1', 'alice', 'bob', canonicalJson(payload));
    // Simulate serde_json on the server reordering object keys alphabetically.
    const relayed = { description: { sdp: 'v=0...', type: 'offer' }, kind: 'sdp' };
    expect(
      verifySignal(alice.signPub, sig, 's1', 'c1', 'alice', 'bob', canonicalJson(relayed)),
    ).toBe(true);
  });
});

describe('signal signing', () => {
  it('verifies and binds every field', () => {
    const alice = generateIdentity();
    const payload = JSON.stringify({ kind: 'sdp', sdp: 'v=0...' });
    const sig = signSignal(alice, 's1', 'c1', 'alice', 'bob', payload);
    expect(verifySignal(alice.signPub, sig, 's1', 'c1', 'alice', 'bob', payload)).toBe(true);
    // Tampering with any bound field invalidates the signature.
    expect(verifySignal(alice.signPub, sig, 's1', 'c1', 'alice', 'carol', payload)).toBe(false);
    expect(verifySignal(alice.signPub, sig, 's1', 'c2', 'alice', 'bob', payload)).toBe(false);
    expect(
      verifySignal(alice.signPub, sig, 's1', 'c1', 'alice', 'bob', payload + ' '),
    ).toBe(false);
    const eve = generateIdentity();
    expect(verifySignal(eve.signPub, sig, 's1', 'c1', 'alice', 'bob', payload)).toBe(false);
  });
});
