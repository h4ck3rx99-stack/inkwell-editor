/**
 * A small circuit breaker used on both sides of the AI boundary.
 *
 * closed    → requests flow; consecutive failures are counted.
 * open      → requests are refused until `openUntil`; cooldown grows exponentially.
 * half-open → exactly one probe request is allowed; success closes, failure re-opens.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private trips = 0;
  private openUntil = 0;
  private probeInFlight = false;
  private readonly threshold: number;
  private readonly baseCooldown: number;
  private readonly maxCooldown: number;
  private readonly now: () => number;
  private listeners = new Set<() => void>();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.baseCooldown = opts.baseCooldownMs ?? 15_000;
    this.maxCooldown = opts.maxCooldownMs ?? 120_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.openUntil === 0) return 'closed';
    return this.now() >= this.openUntil ? 'half-open' : 'open';
  }

  /** Milliseconds until a probe may be attempted (0 when closed or half-open). */
  get retryInMs(): number {
    return this.openUntil === 0 ? 0 : Math.max(0, this.openUntil - this.now());
  }

  /** Ask for permission to send a request. Must be followed by onSuccess/onFailure/onCancel. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'open') return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    const changed = this.openUntil !== 0 || this.failures !== 0;
    this.failures = 0;
    this.trips = 0;
    this.openUntil = 0;
    this.probeInFlight = false;
    if (changed) this.emit();
  }

  onFailure(): void {
    this.probeInFlight = false;
    this.failures++;
    if (this.openUntil !== 0 || this.failures >= this.threshold) this.trip();
  }

  /** A cancelled request says nothing about provider health. */
  onCancel(): void {
    this.probeInFlight = false;
  }

  /** Open immediately for a known duration (e.g. a 429 with Retry-After). */
  openFor(ms: number): void {
    this.openUntil = this.now() + Math.max(0, ms);
    this.probeInFlight = false;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private trip() {
    const cooldown = Math.min(this.maxCooldown, this.baseCooldown * 2 ** this.trips);
    this.trips++;
    this.openUntil = this.now() + cooldown;
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
