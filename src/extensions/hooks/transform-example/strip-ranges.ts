/**
 * Codepoint-range stripper for the transform-example reference hook.
 *
 * Removes every Unicode codepoint that falls within any of the given ranges.
 * Handles surrogate pairs correctly by iterating over code points via
 * `Array.from`, which produces one entry per Unicode scalar value.
 *
 * Wiki: reference-extensions/hooks/Transform.md
 */

/** A parsed Unicode codepoint range (inclusive on both ends). */
export interface UnicodeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Default emoji codepoint ranges to strip.
 *
 * Covers the four most common emoji blocks:
 *   Emoticons                          U+1F600–U+1F64F
 *   Miscellaneous Symbols and Pictographs  U+1F300–U+1F5FF
 *   Transport and Map Symbols          U+1F680–U+1F6FF
 *   Supplemental Symbols and Pictographs   U+1F900–U+1F9FF
 */
export const DEFAULT_EMOJI_RANGES: readonly UnicodeRange[] = Object.freeze([
  { from: 0x1f600, to: 0x1f64f },
  { from: 0x1f300, to: 0x1f5ff },
  { from: 0x1f680, to: 0x1f6ff },
  { from: 0x1f900, to: 0x1f9ff },
]);

/**
 * Returns true if `s` is a valid hexadecimal string (no `0x` prefix).
 * Used to validate user-supplied codepoint strings at init time.
 */
export function isValidHex(s: string): boolean {
  return /^[0-9a-f]+$/i.test(s);
}

/**
 * Parse a validated hex string into a codepoint number.
 * Caller is responsible for ensuring `isValidHex(s)` is true first.
 */
export function parseHex(s: string): number {
  return parseInt(s, 16);
}

/**
 * Remove every Unicode codepoint that falls within any of the given ranges.
 *
 * Uses `Array.from` to iterate over code points (handles surrogate pairs).
 * Returns a new string; never mutates the input.
 * When the entire string is stripped, returns `""`.
 */
export function stripRanges(text: string, ranges: readonly UnicodeRange[]): string {
  return Array.from(text)
    .filter((char) => {
      const cp = char.codePointAt(0);
      if (cp === undefined) return true;
      for (const range of ranges) {
        if (cp >= range.from && cp <= range.to) return false;
      }
      return true;
    })
    .join("");
}
