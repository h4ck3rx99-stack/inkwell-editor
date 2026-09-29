import { SEVERITY_RANK, type Suggestion } from './model';

type Rankable = Pick<Suggestion, 'from' | 'to' | 'severity' | 'confidence' | 'source'>;

/**
 * Positive when `a` should win over `b` for an overlapping range:
 * error > improvement > style, then higher confidence, then the narrower span.
 * Local wins exact ties because it is deterministic and instant.
 */
export function comparePriority(a: Rankable, b: Rankable): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  const conf = a.confidence - b.confidence;
  if (Math.abs(conf) > 1e-9) return conf;
  const width = b.to - b.from - (a.to - a.from);
  if (width !== 0) return width;
  if (a.source !== b.source) return a.source === 'local' ? 1 : -1;
  return 0;
}

export function overlaps(a: Pick<Suggestion, 'from' | 'to'>, b: Pick<Suggestion, 'from' | 'to'>): boolean {
  return a.from < b.to && b.from < a.to;
}

/** Same span and same primary fix (or both advisory): the findings are duplicates. */
export function isDuplicate(
  a: Pick<Suggestion, 'from' | 'to' | 'replacements'>,
  b: Pick<Suggestion, 'from' | 'to' | 'replacements'>,
): boolean {
  if (a.from !== b.from || a.to !== b.to) return false;
  const ra = a.replacements[0]?.trim().toLowerCase() ?? '';
  const rb = b.replacements[0]?.trim().toLowerCase() ?? '';
  return ra === rb;
}

/**
 * Choose the visible set: deduplicate, then greedily keep the highest-priority
 * suggestion among any overlapping group. Output is sorted by position and
 * contains no two overlapping suggestions.
 */
export function selectVisible<T extends Rankable & Pick<Suggestion, 'replacements' | 'id'>>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => comparePriority(b, a) || a.from - b.from || (a.id < b.id ? -1 : 1));
  const kept: T[] = [];
  for (const item of sorted) {
    if (item.to <= item.from) continue;
    if (kept.some((k) => isDuplicate(k, item) || overlaps(k, item))) continue;
    kept.push(item);
  }
  return kept.sort((a, b) => a.from - b.from);
}

/** Stable identity: the same finding re-reported for the same place keeps its id (no re-render/flash). */
export function sameFinding(a: Suggestion, b: Suggestion): boolean {
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.original === b.original &&
    a.source === b.source &&
    a.ruleId === b.ruleId &&
    a.replacements.join('\u0000') === b.replacements.join('\u0000')
  );
}
