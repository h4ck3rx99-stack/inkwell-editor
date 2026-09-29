/**
 * Analysis scheduler: decides *when* each block is analyzed by each tier.
 *
 * Local tier: every edited block, ~150 ms after typing pauses (max wait 1 s).
 * AI tier: a block becomes eligible once it has *settled* — a sentence was
 * completed, the user paused ~900 ms, or the cursor left the block. Eligible
 * blocks enter a priority queue (cursor block → visible blocks by proximity →
 * everything else in the background) drained with a small concurrency cap.
 * Any edit to a block aborts its in-flight request. Results are cached by
 * hash(text + settings) so unchanged or reverted text is never re-sent.
 */
import { hashText } from '@/lib/hash';
import type { CircuitBreaker } from '@/lib/circuit-breaker';
import { splitSentences } from '@/lib/text';
import { AIRequestError } from '@/analysis/errors';
import type { Finding } from '@/suggestions/model';

export { AIRequestError };

export interface SchedulerBlock {
  text: string;
  hash: string;
  /** Up to ~400 chars of the preceding block, read-only context for the AI. */
  context: string;
  revision: number;
}

export interface AIRequestInput {
  blockId: string;
  /** Offset of this window within the block text. */
  windowStart: number;
  text: string;
  context: string;
  revision: number;
}

export interface SchedulerHost {
  getBlock(blockId: string): SchedulerBlock | null;
  getCursorBlockId(): string | null;
  /** Visible blocks ordered by proximity to the cursor. */
  getVisibleBlockIds(): string[];
  getAllBlockIds(): string[];
  isComposing(): boolean;
  isOnline(): boolean;
  aiAvailable(): boolean;
  aiSettingsKey(): string;
  runLocal(blockIds: string[]): Promise<void>;
  requestAI(input: AIRequestInput, signal: AbortSignal): Promise<Finding[]>;
  /** Apply findings (offsets relative to the full block text) computed for `hash`. */
  applyAI(blockId: string, hash: string, findings: Finding[], revision: number): void;
  onStatus?(status: SchedulerStatus): void;
  log?(event: string, data: Record<string, unknown>): void;
}

export interface SchedulerStatus {
  localBusy: boolean;
  aiInFlight: number;
  aiQueued: number;
}

export interface SchedulerOptions {
  localDebounceMs?: number;
  localMaxWaitMs?: number;
  settleMs?: number;
  maxConcurrent?: number;
  backgroundIdleMs?: number;
  windowChars?: number;
  cacheSize?: number;
  breaker: CircuitBreaker;
}

interface QueueEntry {
  background: boolean;
  seq: number;
}

interface InFlight {
  controller: AbortController;
  hash: string;
  revision: number;
}

const MIN_AI_TEXT = 12;
const LOCAL_CHUNK = 24;

export function splitWindows(text: string, maxChars = 800): { start: number; text: string }[] {
  if (text.length <= maxChars * 1.5) return [{ start: 0, text }];
  const windows: { start: number; text: string }[] = [];
  let winStart = -1;
  let winEnd = -1;
  for (const s of splitSentences(text)) {
    if (winStart === -1) {
      winStart = s.start;
      winEnd = s.end;
    } else if (s.end - winStart > maxChars) {
      windows.push({ start: winStart, text: text.slice(winStart, winEnd) });
      winStart = s.start;
      winEnd = s.end;
    } else winEnd = s.end;
  }
  if (winStart !== -1) windows.push({ start: winStart, text: text.slice(winStart, winEnd) });
  return windows;
}

export class AnalysisScheduler {
  private readonly o: Required<Omit<SchedulerOptions, 'breaker'>>;
  private readonly breaker: CircuitBreaker;

  private localDirty = new Set<string>();
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  private localFirstDirtyAt = 0;
  private localRunning = 0;

  /** Blocks waiting to settle → time they become eligible. One shared timer, so blocks that settle together are prioritized together. */
  private settling = new Map<string, number>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private queue = new Map<string, QueueEntry>();
  private inFlight = new Map<string, InFlight>();
  private analyzed = new Map<string, string>();
  private failed = new Set<string>();
  private cache = new Map<string, Finding[]>();
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private lastEditAt = 0;
  private lastCursorBlock: string | null = null;
  private disposed = false;
  private unsubscribeBreaker: () => void;

  constructor(
    private readonly host: SchedulerHost,
    opts: SchedulerOptions,
  ) {
    this.breaker = opts.breaker;
    this.o = {
      localDebounceMs: opts.localDebounceMs ?? 150,
      localMaxWaitMs: opts.localMaxWaitMs ?? 1000,
      settleMs: opts.settleMs ?? 900,
      maxConcurrent: opts.maxConcurrent ?? 2,
      backgroundIdleMs: opts.backgroundIdleMs ?? 1500,
      windowChars: opts.windowChars ?? 800,
      cacheSize: opts.cacheSize ?? 500,
    };
    // When the breaker recovers, retry blocks whose analysis failed.
    this.unsubscribeBreaker = this.breaker.subscribe(() => {
      if (this.breaker.state === 'closed' && this.failed.size) {
        for (const id of this.failed) this.enqueue(id, false);
        this.failed.clear();
      }
    });
  }

  /** Initial pass after a document opens: everything gets local checks; AI starts near the cursor. */
  start(): void {
    const ordered = this.prioritized(this.host.getAllBlockIds());
    for (const id of ordered) this.localDirty.add(id);
    this.flushLocal();
    const visible = new Set(this.host.getVisibleBlockIds());
    const cursor = this.host.getCursorBlockId();
    for (const id of ordered) this.enqueue(id, !(id === cursor || visible.has(id)), false);
    this.pump();
  }

  /** Blocks whose text changed. */
  edit(blockIds: readonly string[], info: { sentenceCompleted: boolean; cursorBlockId: string | null }): void {
    if (this.disposed) return;
    this.lastEditAt = Date.now();
    // A bulk change (paste, large delete/undo) touches many blocks: only the ones near the
    // writer settle normally; the rest are analyzed lazily in the background.
    const bulk = blockIds.length > 3;
    const near = bulk ? new Set([info.cursorBlockId, ...this.host.getVisibleBlockIds()]) : null;
    for (const id of blockIds) {
      this.abortBlock(id, 'edited');
      this.queue.delete(id);
      this.failed.delete(id);
      this.analyzed.delete(id);
      this.localDirty.add(id);
      if (near && !near.has(id)) {
        this.settling.delete(id);
        this.enqueue(id, true, false);
        continue;
      }
      this.resetSettleTimer(id);
      if (info.sentenceCompleted && id === info.cursorBlockId) this.settle(id);
    }
    this.scheduleLocal();
    this.emitStatus();
  }

  selectionChanged(cursorBlockId: string | null): void {
    if (this.disposed || cursorBlockId === this.lastCursorBlock) return;
    const previous = this.lastCursorBlock;
    this.lastCursorBlock = cursorBlockId;
    // Leaving a block settles it.
    if (previous && this.settling.has(previous)) this.settle(previous);
    this.pump();
  }

  viewportChanged(): void {
    this.pump();
  }

  /** Re-run local analysis for specific blocks (e.g. after the cursor leaves a suppressed word). */
  requestLocal(blockIds: readonly string[], immediate = false): void {
    for (const id of blockIds) this.localDirty.add(id);
    if (immediate) this.flushLocal();
    else this.scheduleLocal();
  }

  /** Settings changed: forget what was analyzed and start over near the cursor. */
  invalidate(opts: { local: boolean; ai: boolean }): void {
    if (opts.ai) {
      for (const id of [...this.inFlight.keys()]) this.abortBlock(id, 'settings');
      this.analyzed.clear();
      this.queue.clear();
      const visible = new Set(this.host.getVisibleBlockIds());
      const cursor = this.host.getCursorBlockId();
      for (const id of this.prioritized(this.host.getAllBlockIds())) this.enqueue(id, !(id === cursor || visible.has(id)), false);
      this.pump();
    }
    if (opts.local) this.requestLocal(this.prioritized(this.host.getAllBlockIds()), true);
  }

  /** Stop all AI work (AI turned off). Local checks are unaffected. */
  cancelAI(): void {
    for (const id of [...this.inFlight.keys()]) this.abortBlock(id, 'disabled');
    this.queue.clear();
    this.settling.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.emitStatus();
  }

  /** Network came back or the breaker window elapsed. */
  resume(): void {
    this.pump();
  }

  get status(): SchedulerStatus {
    return { localBusy: this.localRunning > 0 || this.localDirty.size > 0, aiInFlight: this.inFlight.size, aiQueued: this.queue.size };
  }

  /** Test/diagnostic view of internal state. */
  debugState() {
    return {
      queued: [...this.queue.keys()],
      inFlight: [...this.inFlight.keys()],
      settling: [...this.settling.keys()],
      localDirty: [...this.localDirty],
      cacheSize: this.cache.size,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.inFlight.keys()]) this.abortBlock(id, 'disposed');
    this.settling.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.localTimer) clearTimeout(this.localTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.unsubscribeBreaker();
  }

  // ── local tier ────────────────────────────────────────────────────────────

  private scheduleLocal() {
    if (this.localDirty.size === 0) return;
    const now = Date.now();
    if (!this.localTimer) this.localFirstDirtyAt = now;
    else clearTimeout(this.localTimer);
    const waited = now - this.localFirstDirtyAt;
    const delay = waited >= this.o.localMaxWaitMs ? 0 : this.o.localDebounceMs;
    this.localTimer = setTimeout(() => {
      this.localTimer = null;
      this.flushLocal();
    }, delay);
  }

  private flushLocal() {
    if (this.disposed || this.localDirty.size === 0) return;
    if (this.host.isComposing()) {
      this.localTimer = setTimeout(() => {
        this.localTimer = null;
        this.flushLocal();
      }, this.o.localDebounceMs);
      return;
    }
    const ids = this.prioritized([...this.localDirty]);
    this.localDirty.clear();
    this.localRunning++;
    this.emitStatus();
    void (async () => {
      try {
        for (let i = 0; i < ids.length && !this.disposed; i += LOCAL_CHUNK) {
          await this.host.runLocal(ids.slice(i, i + LOCAL_CHUNK));
        }
      } catch (err) {
        this.host.log?.('local.error', { error: String(err) });
      } finally {
        this.localRunning--;
        this.emitStatus();
      }
    })();
  }

  // ── AI tier ───────────────────────────────────────────────────────────────

  private resetSettleTimer(id: string) {
    this.settling.set(id, Date.now() + this.o.settleMs);
    this.armSettleTimer();
  }

  private armSettleTimer() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.settling.size === 0 || this.disposed) return;
    const due = Math.min(...this.settling.values());
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const now = Date.now();
      for (const [id, at] of this.settling) {
        if (at <= now + 1) {
          this.settling.delete(id);
          this.enqueue(id, false, false);
        }
      }
      this.pump();
      this.armSettleTimer();
    }, Math.max(0, due - Date.now()));
  }

  private settle(id: string) {
    this.settling.delete(id);
    this.armSettleTimer();
    this.enqueue(id, false);
  }

  private enqueue(id: string, background: boolean, pump = true) {
    if (this.disposed || !this.host.aiAvailable()) return;
    const existing = this.queue.get(id);
    this.queue.set(id, { background: existing ? existing.background && background : background, seq: existing?.seq ?? this.seq++ });
    if (pump) this.pump();
    else this.emitStatus();
  }

  private schedulePump(ms: number) {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, ms));
  }

  private pump() {
    if (this.disposed) return;
    if (!this.host.aiAvailable()) {
      this.queue.clear();
      this.emitStatus();
      return;
    }
    if (this.host.isComposing()) {
      this.schedulePump(150);
      return;
    }
    while (this.inFlight.size < this.o.maxConcurrent) {
      const next = this.pickNext();
      if (!next) break;
      if (next === 'wait') {
        this.schedulePump(this.o.backgroundIdleMs - (Date.now() - this.lastEditAt) + 5);
        break;
      }
      const id = next;
      const block = this.host.getBlock(id);
      if (!block || block.text.trim().length < MIN_AI_TEXT || !/\p{L}{2}/u.test(block.text)) {
        this.queue.delete(id);
        continue;
      }
      const key = hashText(`${block.text}\u0001${this.host.aiSettingsKey()}`);
      if (this.analyzed.get(id) === key || this.inFlight.get(id)?.hash === block.hash) {
        this.queue.delete(id);
        continue;
      }
      const cached = this.cache.get(key);
      if (cached) {
        this.queue.delete(id);
        this.cache.delete(key);
        this.cache.set(key, cached); // LRU touch
        this.analyzed.set(id, key);
        this.host.log?.('ai.cache-hit', { blockId: id });
        this.host.applyAI(id, block.hash, cached, block.revision);
        continue;
      }
      if (!this.host.isOnline()) break; // resume() is called on 'online'
      if (!this.breaker.tryAcquire()) {
        // Open: try again when the cooldown ends. Half-open: the probe's completion pumps.
        if (this.breaker.retryInMs > 0) this.schedulePump(this.breaker.retryInMs + 50);
        break;
      }
      this.queue.delete(id);
      this.dispatch(id, block, key);
    }
    this.emitStatus();
  }

  private pickNext(): string | 'wait' | null {
    if (this.queue.size === 0) return null;
    const cursor = this.host.getCursorBlockId();
    const visible = this.host.getVisibleBlockIds();
    const visibleIndex = new Map(visible.map((id, i) => [id, i]));
    let best: string | null = null;
    let bestScore = Infinity;
    let backgroundOnly = true;
    for (const [id, entry] of this.queue) {
      if (this.inFlight.has(id)) continue;
      let score: number;
      if (id === cursor) score = 0;
      else if (visibleIndex.has(id)) score = 1 + visibleIndex.get(id)!;
      else score = entry.background ? 100_000 + entry.seq : 10_000 + entry.seq;
      if (score < 100_000) backgroundOnly = false;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (!best) return null;
    // Background analysis only runs while the writer is idle.
    if (backgroundOnly && Date.now() - this.lastEditAt < this.o.backgroundIdleMs) return 'wait';
    return best;
  }

  private dispatch(id: string, block: SchedulerBlock, key: string) {
    const controller = new AbortController();
    const flight: InFlight = { controller, hash: block.hash, revision: block.revision };
    this.inFlight.set(id, flight);
    this.host.log?.('ai.request', { blockId: id, revision: block.revision, chars: block.text.length });
    void (async () => {
      try {
        const windows = splitWindows(block.text, this.o.windowChars);
        const all: Finding[] = [];
        for (const w of windows) {
          const context = w.start === 0 ? block.context : block.text.slice(Math.max(0, w.start - 400), w.start);
          const findings = await this.host.requestAI({ blockId: id, windowStart: w.start, text: w.text, context, revision: block.revision }, controller.signal);
          if (controller.signal.aborted) throw new AIRequestError('aborted', 'aborted');
          for (const f of findings) all.push({ ...f, start: f.start + w.start, end: f.end + w.start });
        }
        this.breaker.onSuccess();
        this.cache.set(key, all);
        if (this.cache.size > this.o.cacheSize) this.cache.delete(this.cache.keys().next().value!);
        const current = this.host.getBlock(id);
        if (!current || current.hash !== block.hash) {
          this.host.log?.('ai.stale', { blockId: id, requestRevision: block.revision, currentRevision: current?.revision ?? null });
          return;
        }
        this.analyzed.set(id, key);
        this.host.applyAI(id, block.hash, all, block.revision);
      } catch (err) {
        const e = err instanceof AIRequestError ? err : new AIRequestError(String((err as Error)?.message ?? err), 'failed');
        if (controller.signal.aborted || e.kind === 'aborted') {
          this.breaker.onCancel();
        } else if (e.kind === 'rate_limited' || e.kind === 'unavailable') {
          this.breaker.openFor(e.retryAfterMs ?? 15_000);
          this.failed.add(id);
        } else if (e.kind === 'offline') {
          this.breaker.onCancel();
          this.enqueue(id, false, false);
        } else {
          this.breaker.onFailure();
          this.failed.add(id);
        }
        this.host.log?.('ai.error', { blockId: id, kind: controller.signal.aborted ? 'aborted' : e.kind });
      } finally {
        if (this.inFlight.get(id) === flight) this.inFlight.delete(id);
        this.pump();
      }
    })();
  }

  private abortBlock(id: string, reason: string) {
    const flight = this.inFlight.get(id);
    if (!flight) return;
    this.inFlight.delete(id);
    flight.controller.abort(new AIRequestError(reason, 'aborted'));
    this.host.log?.('ai.abort', { blockId: id, reason, revision: flight.revision });
  }

  private prioritized(ids: string[]): string[] {
    const cursor = this.host.getCursorBlockId();
    const visible = this.host.getVisibleBlockIds();
    const vi = new Map(visible.map((id, i) => [id, i]));
    const order = new Map(this.host.getAllBlockIds().map((id, i) => [id, i]));
    const score = (id: string) => (id === cursor ? -1 : vi.has(id) ? vi.get(id)! : 1e6 + (order.get(id) ?? 0));
    return [...new Set(ids)].sort((a, b) => score(a) - score(b));
  }

  private lastStatus = '';
  private emitStatus() {
    const s = this.status;
    const sig = `${s.localBusy}|${s.aiInFlight}|${s.aiQueued}`;
    if (sig === this.lastStatus) return;
    this.lastStatus = sig;
    this.host.onStatus?.(s);
  }
}
