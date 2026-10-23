/**
 * Player-name handling for official results and prediction matching.
 *
 * Three levels, deliberately strict:
 *  - cleanName:  what we store and show. Unicode NFC, trimmed, single spaces, consistent apostrophes/hyphens.
 *  - nameKey:    what scoring compares. cleanName + case-insensitive. "Bukayo Saka", "bukayo saka" and
 *                " Bukayo  Saka " share a key; "Martin Ødegaard" and "Martin Odegaard" do NOT.
 *  - looseKey:   accent/punctuation-insensitive form, used ONLY to spot probable mismatches for an admin to
 *                review. It never awards points.
 *
 * There is no substring matching: "Gabriel" never matches "Gabriel Martinelli" automatically.
 */

const APOSTROPHES = /[‘’ʼ`´]/g; // ‘ ’ ʼ ` ´ → '
const HYPHENS = /[‐‑‒–—−]/g; // ‐ ‑ ‒ – — − → -
const VALID = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

export function cleanName(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFC')
    .replace(APOSTROPHES, "'")
    .replace(HYPHENS, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns an error message, or null if the name is acceptable. */
export function validateName(raw: string | null | undefined, label: string): string | null {
  const n = cleanName(raw);
  if (!n) return `${label}: enter a name.`;
  if (n.length > 60) return `${label}: the name is too long (60 characters max).`;
  if (!VALID.test(n)) return `${label}: use letters, spaces, apostrophes, hyphens and full stops only.`;
  return null;
}

export function nameKey(raw: string | null | undefined): string {
  return cleanName(raw).toLocaleLowerCase('en-GB');
}

const SPECIAL: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', ı: 'i', þ: 'th' };

export function looseKey(raw: string | null | undefined): string {
  return nameKey(raw)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[øæœßđðłıþ]/g, (c) => SPECIAL[c] ?? c)
    .replace(/['.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type NameMatch = 'exact' | 'probable' | 'different';

/**
 * exact     → same player for scoring.
 * probable  → looks like the same player but isn't an exact match (accents, punctuation, or a single name that
 *             appears in the other full name): needs an admin decision, never scored automatically.
 * different → not the same player.
 */
export function compareNames(a: string | null | undefined, b: string | null | undefined): NameMatch {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return 'different';
  if (ka === kb) return 'exact';
  const la = looseKey(a);
  const lb = looseKey(b);
  if (la === lb) return 'probable';
  const ta = la.split(' ');
  const tb = lb.split(' ');
  if ((ta.length === 1 && tb.includes(ta[0])) || (tb.length === 1 && ta.includes(tb[0]))) return 'probable';
  return 'different';
}
