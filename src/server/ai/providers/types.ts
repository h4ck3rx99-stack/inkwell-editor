import type { Dialect, Goal } from '@/settings/model';
import type { MockControl, Tone, WriteAction } from '@/shared/ai-contract';
import type { ProviderId } from '../config';

/** Structured task payloads. Real providers use the rendered prompts; the mock uses these. */
export interface CorrectionTask {
  kind: 'correction';
  text: string;
  context: string;
}

export interface WriteTask {
  kind: 'write';
  action: WriteAction | 'summarize-chunk';
  text: string;
  tone?: Tone;
  instruction?: string;
  suggestion?: { original: string; replacement: string; title: string };
  dialect: Dialect;
  goal: Goal;
}

export interface StructuredRequest {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  /** JSON Schema of the expected output (used for native structured output). */
  schema: Record<string, unknown>;
  maxTokens: number;
  signal: AbortSignal;
  task: CorrectionTask;
  mock?: MockControl;
}

export interface TextRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  signal: AbortSignal;
  task: WriteTask;
  mock?: MockControl;
}

/**
 * A provider adapter. Both capabilities must honor `signal` (which carries the
 * route's timeout and the client's disconnect) and throw ProviderError.
 */
export interface AIProvider {
  readonly id: Exclude<ProviderId, 'none'>;
  /** Returns the raw model text, which should be JSON. Validation happens in the orchestrator. */
  generateStructured(req: StructuredRequest): Promise<string>;
  streamText(req: TextRequest): AsyncIterable<string>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
