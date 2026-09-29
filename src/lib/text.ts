/** Text utilities shared by local analyzers, the server resolver and the editor. Pure functions only. */

export interface TextRange {
  start: number;
  end: number;
}

export const WORD_CHAR = /[\p{L}\p{N}\p{M}'’_-]/u;
const LETTER = /\p{L}/u;

export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && WORD_CHAR.test(ch);
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Inclusive "touch" test: ranges that share a boundary count. */
export function rangesTouch(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

const URL_RE = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+|\b[a-z0-9.-]+\.(?:com|org|net|io|dev|app|edu|gov|co|uk|ai|me|info|biz|us|ca|de|fr|jp|au|in)(?:\/[^\s<>"'`]*)?\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HANDLE_RE = /(?:^|\s)([@#][\w-]+)/g;
const PATHLIKE_RE = /(?:^|\s)((?:~|\.{1,2})?\/[\w./-]+|\w+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|css|html|yml|yaml|toml|txt))\b/g;

/** Ranges that analyzers must never flag: URLs, emails, @handles/#tags, file paths. */
export function findProtectedRanges(text: string): TextRange[] {
  const out: TextRange[] = [];
  const push = (start: number, end: number) => {
    // Trim trailing sentence punctuation from URLs ("see example.com.")
    while (end > start && /[.,;:!?)\]]/.test(text[end - 1] ?? '')) end--;
    if (end > start) out.push({ start, end });
  };
  for (const m of text.matchAll(EMAIL_RE)) push(m.index, m.index + m[0].length);
  for (const m of text.matchAll(URL_RE)) push(m.index, m.index + m[0].length);
  for (const m of text.matchAll(HANDLE_RE)) {
    const s = m.index + m[0].length - (m[1]?.length ?? 0);
    push(s, m.index + m[0].length);
  }
  for (const m of text.matchAll(PATHLIKE_RE)) {
    const s = m.index + m[0].length - (m[1]?.length ?? 0);
    push(s, m.index + m[0].length);
  }
  // Backtick code in plain text (inline code marks are passed separately by the editor).
  for (const m of text.matchAll(/`[^`\n]+`/g)) out.push({ start: m.index, end: m.index + m[0].length });
  return mergeRanges(out);
}

export function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TextRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function overlapsAny(start: number, end: number, ranges: readonly TextRange[]): boolean {
  for (const r of ranges) if (rangesOverlap(start, end, r.start, r.end)) return true;
  return false;
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'eg', 'ie', 'cf', 'al', 'approx',
  'no', 'fig', 'inc', 'ltd', 'co', 'corp', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec', 'mt', 'ft', 'u.s', 'u.k', 'a.m', 'p.m', 'ph.d', 'vol', 'pp', 'ed', 'est', 'dept',
]);

export interface Sentence extends TextRange {
  text: string;
}

/**
 * Split text into sentences. Conservative: only breaks after . ! ? (or …) followed by
 * whitespace, and not after common abbreviations, initials, or inside decimals.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i]!;
    if (ch === '\n') {
      pushSentence(out, text, start, i);
      start = i + 1;
      i++;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i + 1;
      while (j < len && /[.!?…]/.test(text[j]!)) j++;
      while (j < len && /["'”’)\]»]/.test(text[j]!)) j++;
      if (j >= len) {
        i = j;
        continue;
      }
      if (!/\s/.test(text[j]!)) {
        i = j;
        continue;
      }
      if (ch === '.' && isAbbreviationBefore(text, i)) {
        i = j;
        continue;
      }
      pushSentence(out, text, start, j);
      while (j < len && /[ \t]/.test(text[j]!)) j++;
      start = j;
      i = j;
      continue;
    }
    i++;
  }
  pushSentence(out, text, start, len);
  return out;
}

function pushSentence(out: Sentence[], text: string, start: number, end: number) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (e > s) out.push({ start: s, end: e, text: text.slice(s, e) });
}

function isAbbreviationBefore(text: string, dotIndex: number): boolean {
  let k = dotIndex - 1;
  while (k >= 0 && /[\p{L}.]/u.test(text[k]!)) k--;
  const word = text.slice(k + 1, dotIndex).toLowerCase();
  if (!word) return false;
  if (ABBREVIATIONS.has(word)) return true;
  // Single initials like "J. R. R. Tolkien" (uppercase single letter).
  if (/^\p{Lu}$/u.test(text.slice(k + 1, dotIndex))) return true;
  return false;
}

export function sentenceAt(text: string, offset: number): Sentence | undefined {
  const sentences = splitSentences(text);
  return sentences.find((s) => offset >= s.start && offset <= s.end);
}

export interface Word extends TextRange {
  text: string;
}

const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu;

export function tokenizeWords(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD_RE)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

export function countWords(text: string): number {
  let n = 0;
  for (const m of text.matchAll(WORD_RE)) if (LETTER.test(m[0]) || /\d/.test(m[0])) n++;
  return n;
}

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = new Array(rows * cols).fill(0);
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[(i - 1) * cols + j]! + 1, d[i * cols + j - 1]! + 1, d[(i - 1) * cols + j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[(i - 2) * cols + j - 2]! + 1);
      d[i * cols + j] = v;
    }
  }
  return d[rows * cols - 1]!;
}

export function editRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : editDistance(a, b) / max;
}

const QUOTE_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '«': '"', '»': '"',
  '–': '-', '—': '-', '‐': '-', ' ': ' ',
};

/**
 * Normalize whitespace runs to one space and typographic quotes/dashes to ASCII.
 * Returns the normalized string and, for each normalized index, the source index.
 */
export function normalizeForMatch(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!;
    ch = QUOTE_MAP[ch] ?? ch;
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      ch = ' ';
      prevSpace = true;
    } else prevSpace = false;
    norm += ch;
    map.push(i);
  }
  map.push(text.length);
  return { norm, map };
}

export function countOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

export function isAllCapsAcronym(word: string): boolean {
  return word.length >= 2 && /^[\p{Lu}\d&.-]+$/u.test(word) && /\p{Lu}/u.test(word);
}

export function hasDigit(word: string): boolean {
  return /\d/.test(word);
}

/** True when the word is capitalized and not the first word of its sentence: likely a proper noun. */
export function isLikelyProperNoun(text: string, start: number, word: string): boolean {
  if (!/^\p{Lu}/u.test(word)) return false;
  if (/^\p{Lu}[\p{Ll}]*\p{Lu}/u.test(word)) return true; // CamelCase / McDonald
  let k = start - 1;
  while (k >= 0 && /[\s"'“‘(\[]/.test(text[k]!)) k--;
  if (k < 0) return false; // sentence-initial
  return !/[.!?:…]/.test(text[k]!);
}

export function readingTimeMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / 230));
}
