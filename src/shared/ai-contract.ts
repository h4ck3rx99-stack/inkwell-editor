/**
 * The wire contract between the browser AI client and the server AI routes.
 * Validated with Zod on both sides of the trust boundary.
 */
import { z } from 'zod';
import { CategorySchema, SeveritySchema } from '@/suggestions/model';
import { DIALECTS, GOALS, SENSITIVITIES } from '@/settings/model';

export const MAX_CHECK_TEXT = 4000;
export const MAX_CONTEXT = 600;
export const MAX_WRITE_TEXT = 12_000;
export const MAX_SUMMARY_TEXT = 400_000;

export const CheckRequestSchema = z.object({
  text: z.string().min(1).max(MAX_CHECK_TEXT),
  context: z.string().max(MAX_CONTEXT).default(''),
  dialect: z.enum(DIALECTS),
  goal: z.enum(GOALS),
  sensitivity: z.enum(SENSITIVITIES),
  categories: z.array(CategorySchema).max(20),
  /** Ranges inside `text` the model must not touch (inline code, links). */
  protectedRanges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).max(100).default([]),
});
export type CheckRequest = z.input<typeof CheckRequestSchema>;

export const CheckIssueSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  original: z.string().min(1),
  replacements: z.array(z.string()).max(3),
  category: CategorySchema,
  severity: SeveritySchema,
  title: z.string().min(1).max(80),
  explanation: z.string().max(300).optional(),
  confidence: z.number().min(0).max(1),
});
export type CheckIssue = z.infer<typeof CheckIssueSchema>;

export const CheckResponseSchema = z.object({
  issues: z.array(CheckIssueSchema).max(20),
  meta: z.object({
    provider: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    latencyMs: z.number(),
    dropped: z.number().int().nonnegative(),
  }),
});
export type CheckResponse = z.infer<typeof CheckResponseSchema>;

export const WRITE_ACTIONS = ['improve', 'clearer', 'shorter', 'longer', 'tone', 'custom', 'explain', 'continue', 'summarize', 'why'] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

export const TONES = ['formal', 'friendly', 'confident', 'neutral', 'persuasive'] as const;
export type Tone = (typeof TONES)[number];

export const WriteRequestSchema = z.object({
  action: z.enum(WRITE_ACTIONS),
  /** The selection (rewrite actions), recent text (continue), whole document (summarize). */
  text: z.string().min(1).max(MAX_SUMMARY_TEXT),
  before: z.string().max(2000).default(''),
  after: z.string().max(2000).default(''),
  tone: z.enum(TONES).optional(),
  instruction: z.string().max(500).optional(),
  dialect: z.enum(DIALECTS),
  goal: z.enum(GOALS),
  suggestion: z
    .object({ original: z.string().max(500), replacement: z.string().max(500), title: z.string().max(120), category: CategorySchema })
    .optional(),
});
export type WriteRequest = z.input<typeof WriteRequestSchema>;

export const StatusResponseSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openai-compatible', 'mock', 'none']),
  configured: z.boolean(),
  label: z.string(),
  fastModel: z.string().nullable(),
  qualityModel: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AIStatus = z.infer<typeof StatusResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({ class: z.string(), message: z.string() }),
});

/** In-band error marker for a streaming body that fails after bytes were sent. */
export const STREAM_ERROR_MARKER = '\u0000INKWELL_ERROR:';

/** Mock-provider controls a client may request (honored only when the server runs the mock provider). */
export const MockControlSchema = z.object({
  latencyMs: z.number().int().min(0).max(30_000).optional(),
  mode: z.enum(['ok', 'error', 'timeout', 'malformed', 'ratelimit', 'flaky', 'noisy', 'empty']).optional(),
});
export type MockControl = z.infer<typeof MockControlSchema>;
export const MOCK_HEADER = 'x-inkwell-mock';
