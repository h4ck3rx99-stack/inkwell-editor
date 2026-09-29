import { AI_ISSUE_CAP, CONFIDENCE_THRESHOLD, type Sensitivity } from '@/settings/model';
import { CATEGORY_SEVERITY, SEVERITY_RANK, type Category } from '@/suggestions/model';
import { editDistance, editRatio, findProtectedRanges, mergeRanges, overlapsAny, splitSentences, type TextRange } from '@/lib/text';
import type { CheckIssue } from '@/shared/ai-contract';
import type { ModelIssue } from './model-output';
import { resolveSpan } from './resolve';

export type DropReason =
  | 'category_disabled'
  | 'empty'
  | 'not_found'
  | 'ambiguous'
  | 'crosses_boundary'
  | 'identical'
  | 'advisory_not_allowed'
  | 'oversized_edit'
  | 'multi_sentence'
  | 'protected'
  | 'low_confidence'
  | 'overlap'
  | 'cap';

const MECHANICAL: ReadonlySet<Category> = new Set(['spelling', 'grammar', 'punctuation']);
const ADVISORY_OK: ReadonlySet<Category> = new Set(['clarity', 'readability', 'structure', 'tone', 'concision', 'repetition']);
const URLISH = /(?:https?:\/\/|www\.|`|@[\w-]+\.[a-z]{2,})/i;

export interface ValidateOptions {
  sensitivity: Sensitivity;
  categories: ReadonlySet<Category>;
  protectedRanges: TextRange[];
  context?: string;
}

export interface ValidateResult {
  issues: CheckIssue[];
  dropped: Partial<Record<DropReason, number>>;
}

/** Is this replacement a proportionate fix for a spelling/grammar/punctuation problem? */
export function isOversizedEdit(original: string, replacement: string): boolean {
  if (original.length > 60 || replacement.length > 80) return true;
  const dist = editDistance(original.toLowerCase(), replacement.toLowerCase());
  if (dist <= 3) return false;
  return editRatio(original.toLowerCase(), replacement.toLowerCase()) > 0.6;
}

function sentenceCount(s: string): number {
  return splitSentences(s).length;
}

export function validateIssues(text: string, raw: readonly ModelIssue[], opts: ValidateOptions): ValidateResult {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => {
    dropped[r] = (dropped[r] ?? 0) + 1;
  };
  const protectedRanges = mergeRanges([...findProtectedRanges(text), ...opts.protectedRanges]);
  const threshold = CONFIDENCE_THRESHOLD[opts.sensitivity];
  const candidates: CheckIssue[] = [];

  for (const issue of raw) {
    if (!opts.categories.has(issue.category)) {
      drop('category_disabled');
      continue;
    }
    const span = resolveSpan(text, issue.original, issue.prefix, opts.context);
    if (!span.ok) {
      drop(span.reason);
      continue;
    }
    const original = text.slice(span.start, span.end);
    if (original.includes('\n')) {
      drop('crosses_boundary');
      continue;
    }

    const hadReplacements = issue.replacements.length > 0;
    const replacements = [...new Set(issue.replacements)].filter((r) => r !== original && r.trim() !== original.trim()).slice(0, 3);
    if (hadReplacements && replacements.length === 0) {
      drop('identical');
      continue;
    }
    if (!hadReplacements && !ADVISORY_OK.has(issue.category)) {
      drop('advisory_not_allowed');
      continue;
    }

    if (overlapsAny(span.start, span.end, protectedRanges) || URLISH.test(original) || replacements.some((r) => URLISH.test(r))) {
      drop('protected');
      continue;
    }
    if (MECHANICAL.has(issue.category) && replacements.some((r) => isOversizedEdit(original, r))) {
      drop('oversized_edit');
      continue;
    }
    // The real-time path never rewrites more than one sentence.
    if (replacements.some((r) => sentenceCount(r) > 1 || r.length > 300) || (hadReplacements && sentenceCount(original) > 1)) {
      drop('multi_sentence');
      continue;
    }
    if (issue.confidence < threshold) {
      drop('low_confidence');
      continue;
    }

    const severity = MECHANICAL.has(issue.category) ? 'error' : (issue.severity ?? CATEGORY_SEVERITY[issue.category]);
    const explanation = splitSentences(issue.explanation ?? '')[0]?.text.slice(0, 280);
    candidates.push({
      start: span.start,
      end: span.end,
      original,
      replacements,
      category: issue.category,
      severity: severity === 'error' && !MECHANICAL.has(issue.category) ? 'improvement' : severity,
      title: issue.title.slice(0, 80),
      ...(explanation ? { explanation } : {}),
      confidence: issue.confidence,
    });
  }

  // No overlaps, highest priority first, then a per-block cap.
  candidates.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence || a.end - a.start - (b.end - b.start),
  );
  const kept: CheckIssue[] = [];
  const cap = AI_ISSUE_CAP[opts.sensitivity];
  for (const c of candidates) {
    if (kept.some((k) => c.start < k.end && k.start < c.end)) {
      drop('overlap');
      continue;
    }
    if (kept.length >= cap) {
      drop('cap');
      continue;
    }
    kept.push(c);
  }
  kept.sort((a, b) => a.start - b.start);
  return { issues: kept, dropped };
}
