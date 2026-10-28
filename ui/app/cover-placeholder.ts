const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

const LQIP_MASK = 0xfffff;

const encoder = new TextEncoder();

/**
 * 20-bit `--lqip` code derived from a title, decoded by the `.cover` styles.
 * Bit layout follows https://leanrada.com/notes/css-only-lqip/, stored
 * unsigned instead of the article's -2^19 offset:
 *   bits 19..8  six 2-bit grey cells, 3x2, top-left first
 *   bits  7..6  L of the Oklab base colour
 *   bits  5..3  a, bits 2..0  b
 * The CSS limits L to the two lightest levels, scales a/b to pastel chroma,
 * and keeps grey cells at 40% opacity so the base hue shows through.
 * Seigiard/opds-generator encodes book titles the same way; keep the two in
 * step so one title gets one code and one picture in both viewers.
 */
export function coverPlaceholder(title: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (const byte of encoder.encode(title.trim().normalize("NFC").toLowerCase())) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }

  return hash & LQIP_MASK;
}
