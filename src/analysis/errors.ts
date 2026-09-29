/** Error raised by the AI tier on the client; `kind` drives scheduling and circuit-breaker behavior. */
export class AIRequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'aborted' | 'rate_limited' | 'unavailable' | 'failed' | 'offline',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AIRequestError';
  }
}
