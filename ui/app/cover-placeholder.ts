const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

// Values are centered on zero because larger custom-property integers lose
// precision in browsers; the CSS decoder adds the offset back.
const LQIP_OFFSET = 2 ** 19;

const encoder = new TextEncoder();

/**
 * Encodes a title as the 20-bit `--lqip` value the `.cover` styles decode:
 * six 2-bit greyscale cells (bits 8–19), a 2-bit Oklab lightness (bits 6–7),
 * and 3-bit Oklab a and b (bits 3–5, 0–2).
 */
export function coverPlaceholder(title: string): number {
  const hash = fnv1a(title.trim().normalize("NFC").toLowerCase());
  const cells = (hash >>> 8) & 0xfff;
  // Only the two middle lightness levels, so no placeholder is near-black or near-white.
  const lightness = 1 + ((hash >>> 6) & 1);
  const chroma = hash & 0x3f;

  return ((cells << 8) | (lightness << 6) | chroma) - LQIP_OFFSET;
}

function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (const byte of encoder.encode(text)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME);
  }

  return hash >>> 0;
}
