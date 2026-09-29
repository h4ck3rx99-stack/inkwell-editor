import { countOccurrences, normalizeForMatch } from '@/lib/text';

export type ResolveResult =
  | { ok: true; start: number; end: number; method: 'exact' | 'normalized' }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous' | 'crosses_boundary' };

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

const squash = (s: string) => s.replace(/\s+/g, ' ');

/**
 * Pick one of several candidate start offsets using the model's `prefix`
 * (the text it says precedes the span). Returns null if still ambiguous.
 */
function disambiguate(haystack: string, hits: number[], prefix: string): number | null {
  if (hits.length === 1) return hits[0]!;
  const p = squash(prefix);
  const scored = hits.map((h) => {
    const before = squash(haystack.slice(Math.max(0, h - p.length - 40), h));
    // An empty prefix means "at the very start of the text".
    const score = p.trim() === '' ? (h === 0 ? 1 : 0) : commonSuffixLength(before, p) + (before.endsWith(p) ? 1000 : 0);
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score === 0) return null;
  if (second && second.score === best.score) return null;
  return best.h;
}

/**
 * Locate the model's `original` inside the analyzed text. The model never
 * returns offsets; we derive them here or drop the issue.
 *   1. exact match (prefix disambiguates repeats)
 *   2. whitespace/quote-normalized match, mapped back to source offsets
 */
export function resolveSpan(text: string, original: string, prefix = '', context = ''): ResolveResult {
  if (!original || !original.trim()) return { ok: false, reason: 'empty' };
  if (/\n\s*\n/.test(original)) return { ok: false, reason: 'crosses_boundary' };

  const exact = countOccurrences(text, original);
  if (exact.length) {
    const start = disambiguate(text, exact, prefix);
    if (start === null) return { ok: false, reason: 'ambiguous' };
    return { ok: true, start, end: start + original.length, method: 'exact' };
  }

  const nText = normalizeForMatch(text);
  const nOrig = normalizeForMatch(original.trim()).norm;
  const nPrefix = normalizeForMatch(prefix).norm;
  const hits = countOccurrences(nText.norm, nOrig);
  if (hits.length) {
    const idx = disambiguate(nText.norm, hits, nPrefix);
    if (idx === null) return { ok: false, reason: 'ambiguous' };
    const start = nText.map[idx]!;
    const end = nText.map[idx + nOrig.length - 1]! + 1;
    return { ok: true, start, end, method: 'normalized' };
  }

  // Classify failures that straddle the previous block and this one.
  if (context) {
    // Compare normalized text: the block break is a newline, the model may have written a space.
    const joined = normalizeForMatch(`${context}\n${text}`);
    const at = joined.norm.indexOf(nOrig);
    if (at !== -1) {
      const start = joined.map[at]!;
      const end = joined.map[at + nOrig.length - 1]! + 1;
      if (start <= context.length && end > context.length + 1) return { ok: false, reason: 'crosses_boundary' };
    }
  }
  return { ok: false, reason: 'not_found' };
}
