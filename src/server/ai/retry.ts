import { ProviderError } from './errors';

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal: AbortSignal;
  /** Absolute time (ms since epoch) after which no retry may start. */
  deadline?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('aborted', 'aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError('aborted', 'aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry retryable provider errors (429, 5xx, network) with exponential
 * backoff and full jitter, honoring Retry-After when the provider sends one.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 400;
  const max = opts.maxDelayMs ?? 8000;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError('network', String((err as Error)?.message ?? err));
      if (opts.signal.aborted) throw e.kind === 'timeout' ? e : new ProviderError('aborted', 'aborted');
      if (!e.retryable || attempt >= opts.retries) throw e;
      const backoff = Math.min(max, base * 2 ** attempt);
      const jittered = backoff / 2 + random() * (backoff / 2);
      const delay = e.retryAfterMs !== undefined ? Math.min(Math.max(e.retryAfterMs, 0), 60_000) : jittered;
      if (opts.deadline !== undefined && Date.now() + delay >= opts.deadline) throw e;
      opts.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: e });
      await sleep(delay, opts.signal);
    }
  }
}

/** Combine the caller's signal with a timeout; reports which one fired. */
export function withTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; abort: () => void; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    controller.abort(new ProviderError('timeout', `timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onAbort = () => controller.abort(new ProviderError('aborted', 'aborted'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abort: () => controller.abort(new ProviderError('aborted', 'aborted')),
    dispose: () => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
    },
  };
}
