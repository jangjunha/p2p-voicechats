/** Minimal webp sniffing for sticker uploads (no decoding library needed). */

/** True if the bytes are a RIFF/WEBP container. */
export function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length > 16 &&
    // "RIFF"
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    // "WEBP"
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/**
 * True for an animated webp: the extended ("VP8X") format with the animation
 * flag set in its feature byte.
 */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (!isWebp(bytes)) return false;
  const isVp8x =
    bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58; // "VP8X"
  if (!isVp8x) return false;
  // Feature flags live in the byte right after the 4-byte chunk size; bit 1 (0x02)
  // marks animation.
  return ((bytes[20] ?? 0) & 0x02) !== 0;
}
