/**
 * Metadata-only logging for AI routes. The type deliberately has no field for
 * document text: lengths, timings, statuses and error classes only.
 */
export interface AILogEvent {
  route: 'check' | 'write' | 'status';
  provider: string;
  model?: string;
  status: 'ok' | 'error' | 'aborted' | 'rejected' | 'rate_limited' | 'malformed' | 'not_configured' | 'circuit_open';
  latencyMs?: number;
  textLength?: number;
  contextLength?: number;
  action?: string;
  errorClass?: string;
  httpStatus?: number;
  issues?: number;
  invalidIssues?: number;
  dropped?: Record<string, number>;
  retries?: number;
  promptVersion?: string;
}

export function logAI(event: AILogEvent): void {
  if (process.env.INKWELL_LOG === 'silent') return;
  const line = JSON.stringify({ t: 'inkwell.ai', at: new Date().toISOString(), ...event });
  if (event.status === 'error' || event.status === 'malformed') console.warn(line);
  else console.info(line);
}
