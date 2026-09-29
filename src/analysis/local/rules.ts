/**
 * Deterministic, in-browser writing rules. Pure functions of the block text:
 * no network, no DOM, no globals. Run inside the local analysis worker.
 */
import type { Finding, Category, Severity } from '@/suggestions/model';
import { CATEGORY_SEVERITY } from '@/suggestions/model';
import type { Sensitivity } from '@/settings/model';
import { splitSentences, tokenizeWords, overlapsAny, isAllCapsAcronym, type TextRange } from '@/lib/text';

export interface RuleContext {
  text: string;
  /** Cursor offset within this block, or null when the cursor is elsewhere. */
  cursorOffset: number | null;
  protectedRanges: TextRange[];
  sensitivity: Sensitivity;
}

export interface RuleOutput {
  findings: Finding[];
  /** True when a finding was withheld only because the cursor is inside it. */
  cursorSuppressed: boolean;
}

interface Rule {
  id: string;
  run(ctx: RuleContext, out: RuleOutput): void;
}

function finding(
  start: number,
  end: number,
  text: string,
  replacements: string[],
  category: Category,
  ruleId: string,
  title: string,
  explanation: string,
  confidence: number,
  severity: Severity = CATEGORY_SEVERITY[category],
): Finding {
  return { start, end, original: text.slice(start, end), replacements, category, severity, ruleId, title, explanation, confidence };
}

function matchCase(source: string, replacement: string): string {
  if (!replacement) return replacement;
  if (source.length > 1 && source === source.toUpperCase() && /\p{Lu}/u.test(source)) return replacement.toUpperCase();
  if (/^\p{Lu}/u.test(source)) return replacement[0]!.toUpperCase() + replacement.slice(1);
  return replacement;
}

// ── Repeated words ──────────────────────────────────────────────────────────
const LEGIT_DOUBLES = new Set(['had', 'that', 'is', 'do', 'bye', 'no', 'yes', 'ha', 'la', 'so', 'very', 'really', 'many', 'knock', 'tut', 'chop']);

const repeatedWord: Rule = {
  id: 'local:repeated-word',
  run({ text }, out) {
    const words = tokenizeWords(text);
    for (let i = 1; i < words.length; i++) {
      const a = words[i - 1]!;
      const b = words[i]!;
      if (a.text.toLowerCase() !== b.text.toLowerCase()) continue;
      if (!/^[ \t]+$/.test(text.slice(a.end, b.start))) continue;
      if (LEGIT_DOUBLES.has(a.text.toLowerCase()) || /\d/.test(a.text)) continue;
      out.findings.push(finding(a.start, b.end, text, [a.text], 'repetition', this.id, 'Repeated word',
        `“${b.text}” appears twice in a row.`, 0.92, 'error'));
      i++;
    }
  },
};

// ── a / an ──────────────────────────────────────────────────────────────────
const CONSONANT_SOUND_VOWEL = /^(uni(?!n[aeiou])|unan|use|usi|usu|usa|ute|uti|uto|ura|ure|uri|uro|eu|ewe|one\b|once|onesie|ubiq|uku|ufo|uvu)/i;
const VOWEL_SOUND_CONSONANT = /^(hour|honest|honou?r|heir|herbs?\b|homage)/i;
const LETTER_VOWEL_SOUND = new Set('AEFHILMNORSX'.split(''));

function wantsAn(word: string): boolean | null {
  if (/^\d/.test(word)) return null;
  if (isAllCapsAcronym(word.replace(/['’]s$/, ''))) return LETTER_VOWEL_SOUND.has(word[0]!.toUpperCase());
  const lower = word.toLowerCase();
  if (/^herb/.test(lower)) return null; // "an herb" (US) vs "a herb" (UK): both acceptable
  if (VOWEL_SOUND_CONSONANT.test(lower)) return true;
  if (CONSONANT_SOUND_VOWEL.test(lower)) return false;
  if (lower.length === 1) return LETTER_VOWEL_SOUND.has(lower.toUpperCase());
  return /^[aeiou]/.test(lower);
}

const articleAgreement: Rule = {
  id: 'local:a-an',
  run({ text }, out) {
    const re = /(?<![\p{L}\p{N}'’-])(a|an|A|An|AN)\s+([\p{L}\p{N}][\p{L}\p{N}'’-]*)/gu;
    for (const m of text.matchAll(re)) {
      const article = m[1]!;
      const word = m[2]!;
      const need = wantsAn(word);
      if (need === null) continue;
      const isAn = article.toLowerCase() === 'an';
      if (need === isAn) continue;
      const start = m.index;
      const replacement = matchCase(article, need ? 'an' : 'a');
      const acronym = isAllCapsAcronym(word);
      out.findings.push(finding(start, start + article.length, text, [replacement], 'grammar', this.id, 'Article agreement',
        need ? `Use “an” before a vowel sound (“${word}”).` : `Use “a” before a consonant sound (“${word}”).`,
        acronym ? 0.62 : 0.88));
    }
  },
};

// ── Capitalization ──────────────────────────────────────────────────────────
const capitalization: Rule = {
  id: 'local:capitalization',
  run({ text }, out) {
    for (const s of splitSentences(text)) {
      const m = /^[\s"'“‘(\[]*([\p{L}][\p{L}\p{N}'’-]*)/u.exec(s.text);
      if (!m) continue;
      const word = m[1]!;
      const start = s.start + m.index + m[0].length - word.length;
      if (!/^\p{Ll}/u.test(word)) continue;
      if (/\p{Lu}/u.test(word.slice(1))) continue; // iPhone, eBay
      if (/\d/.test(word)) continue;
      if (text[start + word.length] === '.' && /\p{L}/u.test(text[start + word.length + 1] ?? '')) continue; // e.g.
      if (word === 'i' || /^i['’]/.test(word)) continue; // handled by the pronoun rule
      out.findings.push(finding(start, start + word.length, text, [word[0]!.toUpperCase() + word.slice(1)], 'grammar', this.id,
        'Capitalization', 'Start a sentence with a capital letter.', 0.8));
    }
    for (const m of text.matchAll(/(?<![\p{L}\p{N}'’.-])(i)(['’](?:m|ve|ll|d))?(?![\p{L}\p{N}-])/gu)) {
      const start = m.index;
      const end = start + m[0].length;
      if (text[end] === '.' && /\p{L}/u.test(text[end + 1] ?? '')) continue; // i.e.
      if (text[start - 1] === '(' && text[end] === ')') continue; // (i) list numbering
      out.findings.push(finding(start, end, text, ['I' + (m[2] ?? '')], 'grammar', this.id, 'Capitalization',
        'The pronoun “I” is always capitalized.', 0.93));
    }
  },
};

// ── Spacing ─────────────────────────────────────────────────────────────────
const spacing: Rule = {
  id: 'local:spacing',
  run({ text }, out) {
    // Double spaces between words.
    for (const m of text.matchAll(/(?<=\S) {2,}(?=\S)/g)) {
      out.findings.push(finding(m.index, m.index + m[0].length, text, [' '], 'punctuation', 'local:double-space', 'Extra space',
        'There are extra spaces here.', 0.75, 'style'));
    }
    // Space before punctuation: "word ," → "word,"; "word ,next" → "word, next" (the space moves).
    for (const m of text.matchAll(/(?<=[\p{L}\p{N}"”’)]) +([,;:!?]|\.(?!\.))(?=\s|$|["”’)]|\p{L})/gu)) {
      const end = m.index + m[0].length;
      const joinsWord = /\p{L}/u.test(text[end] ?? '');
      if (joinsWord && m[1] === '.') continue; // " .com", " .NET"
      out.findings.push(finding(m.index, end, text, [joinsWord ? `${m[1]} ` : m[1]!], 'punctuation', 'local:space-before-punct',
        'Space before punctuation', `Remove the space before “${m[1]}”.`, 0.86));
    }
    // Missing space after , ; : ! ? before a letter.
    for (const m of text.matchAll(/(?<=[\p{L}\p{N}")\]”’])([,;!?]|:(?![\/\d]))(?=\p{L})/gu)) {
      if (m[1] === ':' && /^\d/.test(text.slice(m.index + 1))) continue;
      out.findings.push(finding(m.index, m.index + 1, text, [m[1] + ' '], 'punctuation', 'local:missing-space',
        'Missing space', `Add a space after “${m[1]}”.`, 0.86));
    }
    // Missing space after a period: "end.Next" (not domains, versions, abbreviations).
    for (const m of text.matchAll(/(?<=\p{Ll}{2})\.(?=\p{Lu}\p{Ll})/gu)) {
      out.findings.push(finding(m.index, m.index + 1, text, ['. '], 'punctuation', 'local:missing-space',
        'Missing space', 'Add a space after the period.', 0.8));
    }
  },
};

// ── Brackets and quotes ─────────────────────────────────────────────────────
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '“': '”' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '”': '“' };

const bracketsAndQuotes: Rule = {
  id: 'local:unmatched',
  run({ text, cursorOffset }, out) {
    const stack: { ch: string; index: number }[] = [];
    const unmatched: { index: number; ch: string; opener: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (PAIRS[ch]) stack.push({ ch, index: i });
      else if (CLOSERS[ch]) {
        // Allow list markers like "1)" / "a)" at the start of a line.
        if (ch === ')' && /^\s*[\p{L}\d]{1,3}$/u.test(text.slice(text.lastIndexOf('\n', i) + 1, i))) continue;
        const top = stack[stack.length - 1];
        if (top && top.ch === CLOSERS[ch]) stack.pop();
        else unmatched.push({ index: i, ch, opener: false });
      }
    }
    for (const s of stack) unmatched.push({ index: s.index, ch: s.ch, opener: true });
    const straight = [...text.matchAll(/"/g)].map((m) => m.index);
    if (straight.length % 2 === 1) unmatched.push({ index: straight[straight.length - 1]!, ch: '"', opener: true });

    for (const u of unmatched) {
      // An opener the writer is still inside (cursor after it, same sentence) is not an error yet.
      if (u.opener && cursorOffset !== null && cursorOffset > u.index) {
        const sentenceEnd = text.slice(u.index).search(/[.!?](\s|$)/);
        if (sentenceEnd === -1 || cursorOffset <= u.index + sentenceEnd + 1) {
          out.cursorSuppressed = true;
          continue;
        }
      }
      const isQuote = u.ch === '"' || u.ch === '“' || u.ch === '”';
      const name = isQuote ? 'quotation mark' : u.ch === '(' || u.ch === ')' ? 'parenthesis' : 'bracket';
      out.findings.push(finding(u.index, u.index + 1, text, [], 'punctuation', this.id, `Unmatched ${name}`,
        u.opener ? `This ${name} is never closed.` : `This ${name} has no opening partner.`, 0.74));
    }
  },
};

// ── Filler words and wordy phrases ──────────────────────────────────────────
interface Phrase {
  re: RegExp;
  replace: string | null;
  confidence: number;
  explanation: string;
}
const PHRASES: Phrase[] = [
  { re: /\bdue to the fact that\b/giu, replace: 'because', confidence: 0.82, explanation: '“Because” says the same thing in one word.' },
  { re: /\b(?:despite|in spite of) the fact that\b/giu, replace: 'although', confidence: 0.8, explanation: '“Although” is more direct.' },
  { re: /\bin order to\b/giu, replace: 'to', confidence: 0.76, explanation: '“To” usually works on its own.' },
  { re: /\bat this point in time\b/giu, replace: 'now', confidence: 0.82, explanation: '“Now” is shorter and clearer.' },
  { re: /\bin the event that\b/giu, replace: 'if', confidence: 0.76, explanation: '“If” is shorter and clearer.' },
  { re: /\beach and every\b/giu, replace: 'every', confidence: 0.7, explanation: 'The pair is redundant.' },
  { re: /\bfor the purpose of\b/giu, replace: 'for', confidence: 0.62, explanation: 'A shorter phrasing is usually clearer.' },
  { re: /\bwhether or not\b/giu, replace: 'whether', confidence: 0.55, explanation: '“Or not” is often unnecessary.' },
  { re: /\bthe fact that\b/giu, replace: null, confidence: 0.6, explanation: '“The fact that” is often wordy; consider rephrasing.' },
];
const INTENSIFIERS: { word: string; confidence: number }[] = [
  { word: 'very', confidence: 0.6 },
  { word: 'really', confidence: 0.6 },
  { word: 'basically', confidence: 0.5 },
  { word: 'actually', confidence: 0.45 },
  { word: 'literally', confidence: 0.45 },
  { word: 'quite', confidence: 0.42 },
];

const filler: Rule = {
  id: 'local:filler',
  run({ text }, out) {
    const taken: TextRange[] = [];
    for (const p of PHRASES) {
      for (const m of text.matchAll(p.re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (overlapsAny(start, end, taken)) continue;
        taken.push({ start, end });
        out.findings.push(finding(start, end, text, p.replace === null ? [] : [matchCase(m[0], p.replace)], 'concision', this.id,
          'Wordy phrase', p.explanation, p.confidence));
      }
    }
    for (const { word, confidence } of INTENSIFIERS) {
      const re = new RegExp(`(?<![\\p{L}'’-])(${word}) (?=[\\p{L}])`, 'giu');
      for (const m of text.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (overlapsAny(start, end, taken)) continue;
        const before = text.slice(0, start).trimEnd();
        if (before === '' || /[.!?:"“(]$/.test(before)) continue; // sentence-initial: removal would need re-capitalization
        if (/\b(?:the|this|that|at|its)$/i.test(before)) continue; // "the very thing", "at the very least"
        if (word === 'very' && /^very (?:much|well|few|many|little|first|last|same|best|least|most)\b/i.test(text.slice(start))) continue;
        out.findings.push(finding(start, end, text, [''], 'concision', this.id, 'Filler word',
          `“${m[1]}” rarely adds meaning; the sentence is stronger without it.`, confidence));
      }
    }
  },
};

// ── Long sentences ──────────────────────────────────────────────────────────
const LONG_SENTENCE_WORDS: Record<Sensitivity, number> = { conservative: 45, balanced: 35, thorough: 28 };

const longSentence: Rule = {
  id: 'local:long-sentence',
  run({ text, sensitivity }, out) {
    const limit = LONG_SENTENCE_WORDS[sensitivity];
    for (const s of splitSentences(text)) {
      const words = tokenizeWords(s.text).length;
      if (words <= limit) continue;
      out.findings.push(finding(s.start, s.end, text, [], 'readability', this.id, 'Long sentence',
        `This sentence runs ${words} words. Splitting it would make it easier to follow.`, 0.72, 'style'));
    }
  },
};

// ── Repeated sentence starters ──────────────────────────────────────────────
const repeatedStarters: Rule = {
  id: 'local:repeated-starter',
  run({ text, sensitivity }, out) {
    const run = sensitivity === 'thorough' ? 2 : 3;
    const starters = splitSentences(text).map((s) => {
      const w = tokenizeWords(s.text)[0];
      return w && w.start < 4 ? { start: s.start + w.start, end: s.start + w.end, word: w.text.toLowerCase() } : null;
    });
    let streak = 1;
    for (let i = 1; i < starters.length; i++) {
      const cur = starters[i];
      const prev = starters[i - 1];
      streak = cur && prev && cur.word === prev.word ? streak + 1 : 1;
      if (cur && streak >= run) {
        out.findings.push(finding(cur.start, cur.end, text, [], 'repetition', this.id, 'Repeated sentence opening',
          `Several sentences in a row begin with “${text.slice(cur.start, cur.end)}”. Varying the openings reads more smoothly.`,
          0.62, 'style'));
      }
    }
  },
};

export const RULES: readonly Rule[] = [repeatedWord, articleAgreement, capitalization, spacing, bracketsAndQuotes, filler, longSentence, repeatedStarters];

export function runRules(ctx: RuleContext): RuleOutput {
  const out: RuleOutput = { findings: [], cursorSuppressed: false };
  for (const rule of RULES) rule.run(ctx, out);
  // Sentence-level advisories may contain a URL; everything else must stay clear of protected text.
  out.findings = out.findings.filter((f) => f.ruleId === 'local:long-sentence' || !overlapsAny(f.start, f.end, ctx.protectedRanges));
  return out;
}
