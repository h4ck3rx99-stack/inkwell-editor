/**
 * In-memory ring buffer of analysis events (never document text). Exposed as
 * window.__inkwellLog so ordering bugs are visible in tests and devtools.
 */
export interface DebugEvent {
  at: number;
  event: string;
  data: Record<string, unknown>;
}

const MAX = 1000;
const buffer: DebugEvent[] = [];

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  buffer.push({ at: Date.now(), event, data });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  if (typeof window !== 'undefined') (window as unknown as { __inkwellLog: DebugEvent[] }).__inkwellLog = buffer;
}
