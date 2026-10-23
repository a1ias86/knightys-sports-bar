/**
 * Player-name handling for official results and prediction matching.
 *
 *  - cleanName:  what we store and show. Unicode NFC, trimmed, single spaces, consistent apostrophes/hyphens.
 *  - nameKey:    case-insensitive identity. "Bukayo Saka", "bukayo saka" and " Bukayo  Saka " share a key.
 *  - looseKey:   accent/punctuation-insensitive form ("Ødegaard" → "odegaard"), used for close matching.
 *
 * Member picks are matched to the OFFICIAL names with matchPickToOfficial(): exact, then accent/punctuation
 * insensitive, then whole-word (surname) matches, then small typos in longer names. Matching is only ever
 * against the two official names for that match, and a pick that fits both is flagged, never guessed.
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

// ─── Matching a member's typed pick to an official name ───────

export type PickMatch = 'exact' | 'close' | 'none';

/** Optimal-string-alignment distance (insertions, deletions, substitutions, adjacent swaps). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Typos allowed in one word: none for short names (Saka, Rice), 1 from 5 letters, 2 from 9. */
function tokensClose(a: string, b: string): boolean {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  const allowed = len >= 9 ? 2 : len >= 5 ? 1 : 0;
  return allowed > 0 && editDistance(a, b) <= allowed;
}

/** Every word of `small` matches (exactly, or within typo tolerance) a different word of `big`. */
function wordsContained(small: string[], big: string[], fuzzy: boolean): boolean {
  const used = new Set<number>();
  return small.every((w) => {
    const i = big.findIndex((b, idx) => !used.has(idx) && (fuzzy ? tokensClose(w, b) : w === b));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

/**
 * How a member's typed pick relates to one official name.
 *  exact → same after normalisation ("bukayo saka" v "Bukayo Saka").
 *  close → accent/punctuation-insensitive equality ("Odegaard" v "Ødegaard"), whole-word match either way
 *          ("Saka" v "Bukayo Saka"), or a small typo in a longer word ("Havetz" v "Kai Havertz").
 *  none  → anything else.
 */
export function matchPickToOfficial(pick: string | null | undefined, official: string | null | undefined): PickMatch {
  const kp = nameKey(pick);
  const ko = nameKey(official);
  if (!kp || !ko) return 'none';
  if (kp === ko) return 'exact';
  const lp = looseKey(pick);
  const lo = looseKey(official);
  if (lp === lo) return 'close';
  const tp = lp.split(' ').filter(Boolean);
  const to = lo.split(' ').filter(Boolean);
  if (wordsContained(tp, to, false) || wordsContained(to, tp, false)) return 'close';
  if (wordsContained(tp, to, true) || wordsContained(to, tp, true)) return 'close';
  return 'none';
}
