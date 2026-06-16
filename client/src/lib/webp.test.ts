import { describe, expect, it } from 'vitest';
import { isAnimatedWebp, isWebp } from './webp';

// Build a minimal RIFF/WEBP header. `vp8x` adds the extended chunk; `anim`
// sets the animation feature bit.
function header(opts: { vp8x?: boolean; anim?: boolean } = {}): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  if (opts.vp8x) {
    b.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
    if (opts.anim) b[20] = 0x02; // animation flag
  } else {
    b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 " (simple lossy)
  }
  return b;
}

describe('isWebp', () => {
  it('accepts a RIFF/WEBP container', () => {
    expect(isWebp(header())).toBe(true);
  });

  it('rejects non-webp data', () => {
    expect(isWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(isWebp(new Uint8Array(4))).toBe(false); // too short
  });
});

describe('isAnimatedWebp', () => {
  it('detects the VP8X animation flag', () => {
    expect(isAnimatedWebp(header({ vp8x: true, anim: true }))).toBe(true);
  });

  it('rejects extended-but-static and simple webp', () => {
    expect(isAnimatedWebp(header({ vp8x: true, anim: false }))).toBe(false);
    expect(isAnimatedWebp(header())).toBe(false);
  });
});
