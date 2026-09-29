/**
 * The ONLY client-side code path that sends document text off the device.
 * Everything here talks to Inkwell's own server routes, which forward to the
 * configured provider. See docs/ARCHITECTURE.md → "Privacy boundary".
 */
import {
  CheckResponseSchema, ErrorResponseSchema, MOCK_HEADER, STREAM_ERROR_MARKER, StatusResponseSchema,
  type AIStatus, type CheckRequest, type CheckResponse, type WriteRequest,
} from '@/shared/ai-contract';
import { AIRequestError } from '@/analysis/errors';

const MOCK_STORAGE_KEY = 'inkwell.mock';

function mockHeader(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MOCK_STORAGE_KEY);
    return raw ? { [MOCK_HEADER]: raw } : {};
  } catch {
    return {};
  }
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function parseRetryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function errorFrom(res: Response): Promise<AIRequestError> {
  let cls = 'http_error';
  let message = `HTTP ${res.status}`;
  try {
    const parsed = ErrorResponseSchema.safeParse(await res.json());
    if (parsed.success) {
      cls = parsed.data.error.class;
      message = parsed.data.error.message;
    }
  } catch {
    // non-JSON error body
  }
  const retryAfterMs = parseRetryAfter(res);
  if (res.status === 429) return new AIRequestError(message, 'rate_limited', retryAfterMs);
  if (res.status === 503 || cls === 'not_configured' || cls === 'circuit_open') return new AIRequestError(message, 'unavailable', retryAfterMs);
  return new AIRequestError(`${cls}: ${message}`, 'failed', retryAfterMs);
}

function rethrow(err: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new AIRequestError('aborted', 'aborted');
  if (err instanceof AIRequestError) throw err;
  if (isOffline()) throw new AIRequestError('offline', 'offline');
  throw new AIRequestError(String((err as Error)?.message ?? err), 'failed');
}

export async function fetchAIStatus(signal?: AbortSignal): Promise<AIStatus> {
  const res = await fetch('/api/ai/status', { signal, cache: 'no-store' });
  const parsed = StatusResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('invalid status response');
  return parsed.data;
}

/** Real-time correction check for one block (or sentence window). */
export async function checkText(req: CheckRequest, signal: AbortSignal): Promise<CheckResponse> {
  if (isOffline()) throw new AIRequestError('offline', 'offline');
  let res: Response;
  try {
    res = await fetch('/api/ai/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...mockHeader() },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    rethrow(err, signal);
  }
  if (!res.ok) throw await errorFrom(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    rethrow(err, signal);
  }
  const parsed = CheckResponseSchema.safeParse(body);
  if (!parsed.success) throw new AIRequestError('invalid response from server', 'failed');
  return parsed.data;
}

export interface StreamHandlers {
  onText(fullText: string, delta: string): void;
}

/** Streaming writing action. Resolves with the full text; rejects on error or abort. */
export async function streamWrite(req: WriteRequest, signal: AbortSignal, handlers: StreamHandlers): Promise<string> {
  if (isOffline()) throw new AIRequestError('You appear to be offline.', 'offline');
  let res: Response;
  try {
    res = await fetch('/api/ai/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...mockHeader() },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    rethrow(err, signal);
  }
  if (!res.ok || !res.body) throw await errorFrom(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const delta = decoder.decode(value, { stream: true });
      if (!delta) continue;
      full += delta;
      const marker = full.indexOf(STREAM_ERROR_MARKER);
      if (marker !== -1) {
        const cls = full.slice(marker + STREAM_ERROR_MARKER.length).trim() || 'stream_error';
        throw new AIRequestError(cls, cls === 'rate_limited' ? 'rate_limited' : 'failed');
      }
      handlers.onText(full, delta);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    rethrow(err, signal);
  }
  if (!full.trim()) throw new AIRequestError('The model returned an empty response.', 'failed');
  return full;
}

/** Human, non-technical message for a failed writing action. */
export function describeWriteError(err: unknown): string {
  if (err instanceof AIRequestError) {
    switch (err.kind) {
      case 'offline':
        return 'You’re offline. Reconnect and try again.';
      case 'rate_limited':
        return 'The writing model is busy right now. Try again in a moment.';
      case 'unavailable':
        return 'AI writing isn’t available right now.';
      case 'aborted':
        return 'Cancelled.';
      default:
        return 'That didn’t work. Try again?';
    }
  }
  return 'That didn’t work. Try again?';
}
