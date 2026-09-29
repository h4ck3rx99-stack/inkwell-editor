/**
 * The local analysis tier: harper.js (spelling + rule-based grammar) plus our
 * deterministic rules, with shared skip logic. Pure with respect to the network.
 */
import type { Category, Finding, Severity } from '@/suggestions/model';
import type { Sensitivity } from '@/settings/model';
import { normalizeDictionaryWord } from '@/settings/model';
import {
  editDistance, findProtectedRanges, hasDigit, isAllCapsAcronym, isLikelyProperNoun, mergeRanges, overlapsAny, rangesTouch,
  type TextRange,
} from '@/lib/text';
import { runRules } from './rules';
import type { EngineLint, GrammarEngine } from './harper';

export interface LocalBlockInput {
  blockId: string;
  text: string;
  hash: string;
  cursorOffset: number | null;
  /** Ranges the editor knows are code (inline code marks) or link targets. */
  codeRanges: TextRange[];
}

export interface LocalBlockResult {
  blockId: string;
  hash: string;
  findings: Finding[];
  cursorSuppressed: boolean;
}

export interface LocalOptions {
  sensitivity: Sensitivity;
  dictionary: ReadonlySet<string>;
}

const KIND_MAP: Record<string, { category: Category; severity: Severity; title: string; confidence: number }> = {
  Spelling: { category: 'spelling', severity: 'error', title: 'Spelling', confidence: 0.9 },
  Typo: { category: 'spelling', severity: 'error', title: 'Possible typo', confidence: 0.85 },
  Agreement: { category: 'grammar', severity: 'error', title: 'Agreement', confidence: 0.85 },
  Grammar: { category: 'grammar', severity: 'error', title: 'Grammar', confidence: 0.82 },
  BoundaryError: { category: 'spelling', severity: 'error', title: 'Word boundary', confidence: 0.8 },
  Capitalization: { category: 'grammar', severity: 'error', title: 'Capitalization', confidence: 0.85 },
  Punctuation: { category: 'punctuation', severity: 'error', title: 'Punctuation', confidence: 0.84 },
  Formatting: { category: 'punctuation', severity: 'style', title: 'Formatting', confidence: 0.7 },
  Repetition: { category: 'repetition', severity: 'error', title: 'Repeated word', confidence: 0.9 },
  Redundancy: { category: 'concision', severity: 'improvement', title: 'Redundancy', confidence: 0.66 },
  WordChoice: { category: 'word-choice', severity: 'improvement', title: 'Word choice', confidence: 0.7 },
  Usage: { category: 'word-choice', severity: 'improvement', title: 'Usage', confidence: 0.72 },
  Malapropism: { category: 'word-choice', severity: 'error', title: 'Wrong word', confidence: 0.8 },
  Eggcorn: { category: 'word-choice', severity: 'error', title: 'Wrong word', confidence: 0.8 },
  Nonstandard: { category: 'word-choice', severity: 'improvement', title: 'Nonstandard usage', confidence: 0.7 },
  Regionalism: { category: 'word-choice', severity: 'improvement', title: 'Regional spelling', confidence: 0.75 },
  WordOrder: { category: 'grammar', severity: 'error', title: 'Word order', confidence: 0.75 },
  Readability: { category: 'readability', severity: 'style', title: 'Readability', confidence: 0.6 },
  Style: { category: 'clarity', severity: 'style', title: 'Style', confidence: 0.55 },
  Enhancement: { category: 'clarity', severity: 'improvement', title: 'Clarity', confidence: 0.55 },
  Miscellaneous: { category: 'grammar', severity: 'error', title: 'Grammar', confidence: 0.75 },
};

/**
 * Weighted edit cost that favors the corrections people actually need:
 * doubled/undoubled letters and transpositions are cheap, whole-word splits are
 * expensive. Used only to reorder the engine's own candidates.
 */
function correctionCost(original: string, candidate: string): number {
  const o = original.toLowerCase();
  const c = candidate.toLowerCase();
  let cost = editDistance(o, c);
  if (c.includes(' ') && !o.includes(' ')) cost += 1.5;
  if (o[0] !== c[0]) cost += 0.6;
  const squeeze = (s: string) => s.replace(/(.)\1+/g, '$1');
  if (squeeze(o) === squeeze(c)) cost -= 0.6;
  if ([...o].sort().join('') === [...c].sort().join('')) cost -= 0.5;
  return cost;
}

export function rankSpelling(original: string, candidates: string[]): string[] {
  const unique = [...new Set(candidates.filter((c) => c && c !== original))];
  return unique
    .map((c, i) => ({ c, i, cost: correctionCost(original, c) }))
    .sort((a, b) => a.cost - b.cost || a.i - b.i)
    .map((x) => x.c)
    .slice(0, 3);
}

function mapEngineLint(text: string, lint: EngineLint): Finding | null {
  const meta = KIND_MAP[lint.kind] ?? KIND_MAP.Miscellaneous!;
  let replacements = lint.replacements.filter((r) => r !== lint.problem);
  if (meta.category === 'spelling') replacements = rankSpelling(lint.problem, replacements);
  replacements = [...new Set(replacements)].slice(0, 3);
  let confidence = meta.confidence;
  // A lone "split this into two words" guess for a misspelling is weak evidence.
  if (lint.kind === 'Typo' && replacements.length === 1 && replacements[0]!.includes(' ') && !lint.problem.includes(' ')) confidence = 0.55;
  if (replacements.length === 0 && meta.category === 'spelling') confidence = Math.min(confidence, 0.7);
  return {
    start: lint.start,
    end: lint.end,
    original: text.slice(lint.start, lint.end),
    replacements,
    category: meta.category,
    severity: meta.severity,
    ruleId: `harper:${lint.rule}`,
    title: meta.title,
    explanation: meta.category === 'spelling' && lint.kind === 'Spelling'
      ? `“${lint.problem}” isn’t in the dictionary${replacements[0] ? `; did you mean “${replacements[0]}”?` : '.'}`
      : cleanMessage(lint.message),
    confidence,
  };
}

function cleanMessage(message: string): string {
  return message.replace(/`([^`]+)`/g, '“$1”').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Should a spelling finding on this token be skipped (acronym, number, proper noun, user word)? */
export function skipSpelling(text: string, start: number, end: number, dictionary: ReadonlySet<string>): boolean {
  const word = text.slice(start, end);
  if (isAllCapsAcronym(word) || hasDigit(word)) return true;
  if (dictionary.has(normalizeDictionaryWord(word))) return true;
  if (isLikelyProperNoun(text, start, word)) return true;
  return false;
}

export async function analyzeBlock(
  input: LocalBlockInput,
  opts: LocalOptions,
  engine: GrammarEngine | null,
): Promise<LocalBlockResult> {
  const { text } = input;
  const protectedRanges = mergeRanges([...findProtectedRanges(text), ...input.codeRanges]);
  const ruleOut = runRules({ text, cursorOffset: input.cursorOffset, protectedRanges, sensitivity: opts.sensitivity });
  const findings: Finding[] = [...ruleOut.findings];

  if (engine && text.trim()) {
    let lints: EngineLint[] = [];
    try {
      lints = await engine.lint(text);
    } catch {
      lints = [];
    }
    for (const lint of lints) {
      if (lint.end <= lint.start) continue;
      if (overlapsAny(lint.start, lint.end, protectedRanges)) continue;
      const f = mapEngineLint(text, lint);
      if (!f) continue;
      if (f.category === 'spelling' && skipSpelling(text, f.start, f.end, opts.dictionary)) continue;
      findings.push(f);
    }
  }

  // Never report a spelling problem on the word the cursor is touching: it may be half-typed.
  let cursorSuppressed = ruleOut.cursorSuppressed;
  const visible = findings.filter((f) => {
    if (input.cursorOffset !== null && f.category === 'spelling' && rangesTouch(f.start, f.end, input.cursorOffset, input.cursorOffset)) {
      cursorSuppressed = true;
      return false;
    }
    return true;
  });

  return { blockId: input.blockId, hash: input.hash, findings: visible, cursorSuppressed };
}
