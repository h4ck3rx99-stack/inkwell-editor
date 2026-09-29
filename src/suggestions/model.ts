import { z } from 'zod';

export const SOURCES = ['local', 'ai'] as const;
export type Source = (typeof SOURCES)[number];

export const CATEGORIES = [
  'spelling', 'grammar', 'punctuation', 'word-choice', 'clarity',
  'concision', 'repetition', 'structure', 'tone', 'readability',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ['error', 'improvement', 'style'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type Status = 'open' | 'accepted' | 'dismissed' | 'ignored' | 'stale';

export interface Suggestion {
  id: string;
  blockId: string;
  /** Live document positions, remapped on every transaction. */
  from: number;
  to: number;
  /** Exact text expected at [from, to). */
  original: string;
  /** [0] is primary; empty = advisory. */
  replacements: string[];
  category: Category;
  severity: Severity;
  source: Source;
  ruleId?: string;
  title: string;
  explanation?: string;
  confidence: number;
  /** Hash of the block text the analysis ran on. */
  blockHash: string;
  /** Editor revision at request time. */
  revision: number;
  status: Status;
}

/**
 * A finding relative to a block's text, produced by an analyzer before it is
 * anchored to document positions.
 */
export interface Finding {
  start: number;
  end: number;
  original: string;
  replacements: string[];
  category: Category;
  severity: Severity;
  ruleId: string;
  title: string;
  explanation?: string;
  confidence: number;
}

export const CategorySchema = z.enum(CATEGORIES);
export const SeveritySchema = z.enum(SEVERITIES);

export const FindingSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  original: z.string().min(1).max(2000),
  replacements: z.array(z.string().max(2000)).max(5),
  category: CategorySchema,
  severity: SeveritySchema,
  ruleId: z.string().max(120),
  title: z.string().min(1).max(120),
  explanation: z.string().max(600).optional(),
  confidence: z.number().min(0).max(1),
});

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, improvement: 2, style: 1 };

export const CATEGORY_LABEL: Record<Category, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  'word-choice': 'Word choice',
  clarity: 'Clarity',
  concision: 'Concision',
  repetition: 'Repetition',
  structure: 'Structure',
  tone: 'Tone',
  readability: 'Readability',
};

/** The default severity for a category (analyzers may override). */
export const CATEGORY_SEVERITY: Record<Category, Severity> = {
  spelling: 'error',
  grammar: 'error',
  punctuation: 'error',
  'word-choice': 'improvement',
  clarity: 'improvement',
  concision: 'improvement',
  repetition: 'style',
  structure: 'style',
  tone: 'style',
  readability: 'style',
};

export const isAdvisory = (s: Pick<Suggestion, 'replacements'>) => s.replacements.length === 0;

/** Rule id used for dismissals and "ignore this rule". AI findings share one rule per category. */
export function ruleKeyOf(s: Pick<Suggestion, 'ruleId' | 'category' | 'source'>): string {
  return s.ruleId ?? `${s.source}:${s.category}`;
}
