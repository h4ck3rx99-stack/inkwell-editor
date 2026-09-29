import { z } from 'zod';
import { CategorySchema, SeveritySchema } from '@/suggestions/model';

/** One issue as the model reports it. No offsets: the model never supplies positions. */
export const ModelIssueSchema = z.object({
  original: z.string().min(1).max(400),
  prefix: z.string().max(400).optional().default(''),
  replacements: z.array(z.string().max(600)).max(5),
  category: CategorySchema,
  severity: SeveritySchema.optional(),
  title: z.string().trim().min(1).max(120),
  explanation: z.string().max(600).optional().default(''),
  confidence: z.preprocess(
    (v) => (typeof v === 'string' ? Number(v) : v),
    z.number().transform((n) => (n > 1 && n <= 100 ? n / 100 : n)).pipe(z.number().min(0).max(1)),
  ),
});
export type ModelIssue = z.infer<typeof ModelIssueSchema>;

const EnvelopeSchema = z.object({ issues: z.array(z.unknown()).max(60) });

export class MalformedOutputError extends Error {
  constructor(readonly reason: 'empty' | 'not_json' | 'bad_shape') {
    super(`malformed model output: ${reason}`);
    this.name = 'MalformedOutputError';
  }
}

/** Extract a JSON value from model text: raw JSON, fenced JSON, or the outermost {...}. */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) throw new MalformedOutputError('empty');
  const attempts: string[] = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) attempts.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next strategy
    }
  }
  throw new MalformedOutputError('not_json');
}

/**
 * Parse and validate model output. The envelope must be well-formed; individual
 * issues that fail validation are dropped (and counted), never surfaced.
 */
export function parseModelOutput(raw: string): { issues: ModelIssue[]; invalid: number } {
  const json = extractJson(raw);
  const envelope = EnvelopeSchema.safeParse(Array.isArray(json) ? { issues: json } : json);
  if (!envelope.success) throw new MalformedOutputError('bad_shape');
  const issues: ModelIssue[] = [];
  let invalid = 0;
  for (const item of envelope.data.issues) {
    const parsed = ModelIssueSchema.safeParse(item);
    if (parsed.success) issues.push(parsed.data);
    else invalid++;
  }
  return { issues, invalid };
}
