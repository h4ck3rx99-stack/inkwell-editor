/** Simple in-memory token-bucket rate limiter, keyed per client and route. */
interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one token. Returns 0 when allowed, otherwise ms until a token is available. */
  take(key: string): number {
    const now = this.now();
    const capacity = Math.max(1, this.perMinute);
    const refillPerMs = capacity / 60_000;
    const b = this.buckets.get(key) ?? { tokens: capacity, updated: now };
    b.tokens = Math.min(capacity, b.tokens + (now - b.updated) * refillPerMs);
    b.updated = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      this.gc(now);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.ceil((1 - b.tokens) / refillPerMs);
  }

  private gc(now: number) {
    if (this.buckets.size < 5000) return;
    for (const [k, b] of this.buckets) if (now - b.updated > 120_000) this.buckets.delete(k);
  }
}

/** Best-effort client key. Behind a proxy, the first X-Forwarded-For hop. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'local';
}
