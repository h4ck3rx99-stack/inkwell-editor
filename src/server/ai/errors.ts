export type ProviderErrorKind =
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'server'
  | 'auth'
  | 'bad_request'
  | 'unsupported_format'
  | 'network'
  | 'empty'
  | 'malformed'
  | 'not_configured'
  | 'circuit_open';

/** Normalized provider failure. Messages never contain document text. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'server' || this.kind === 'network';
  }
}

export function parseRetryAfterHeader(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function errorFromStatus(status: number, message: string, retryAfter?: string | null): ProviderError {
  const retryAfterMs = parseRetryAfterHeader(retryAfter);
  if (status === 429) return new ProviderError('rate_limited', message, { status, retryAfterMs });
  if (status === 401 || status === 403) return new ProviderError('auth', message, { status });
  if (status === 408) return new ProviderError('timeout', message, { status });
  if (status >= 500) return new ProviderError('server', message, { status, retryAfterMs });
  return new ProviderError('bad_request', message, { status });
}

/** HTTP status the Inkwell route should answer with for a provider failure. */
export function httpStatusFor(err: ProviderError): number {
  switch (err.kind) {
    case 'rate_limited':
      return 429;
    case 'timeout':
      return 504;
    case 'not_configured':
    case 'circuit_open':
      return 503;
    case 'aborted':
      return 499;
    default:
      return 502;
  }
}
