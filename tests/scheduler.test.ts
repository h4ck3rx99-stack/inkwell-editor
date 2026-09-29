import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashText } from '@/lib/hash';
import { CircuitBreaker } from '@/lib/circuit-breaker';
import { AIRequestError, AnalysisScheduler, splitWindows, type AIRequestInput, type SchedulerHost } from '@/analysis/scheduler/scheduler';
import type { Finding } from '@/suggestions/model';

interface PendingAI {
  input: AIRequestInput;
  signal: AbortSignal;
  resolve: (f: Finding[]) => void;
  reject: (e: unknown) => void;
}

class FakeHost implements SchedulerHost {
  blocks = new Map<string, string>();
  order: string[] = [];
  cursor: string | null = null;
  visible: string[] = [];
  composing = false;
  online = true;
  ai = true;
  localCalls: string[][] = [];
  aiCalls: PendingAI[] = [];
  applied: { blockId: string; hash: string; findings: Finding[] }[] = [];
  logs: { event: string; data: Record<string, unknown> }[] = [];

  set(id: string, text: string) {
    if (!this.blocks.has(id)) this.order.push(id);
    this.blocks.set(id, text);
  }
  getBlock(id: string) {
    const text = this.blocks.get(id);
    return text === undefined ? null : { text, hash: hashText(text), context: '', revision: 0 };
  }
  getCursorBlockId() {
    return this.cursor;
  }
  getVisibleBlockIds() {
    return this.visible;
  }
  getAllBlockIds() {
    return this.order;
  }
  isComposing() {
    return this.composing;
  }
  isOnline() {
    return this.online;
  }
  aiAvailable() {
    return this.ai;
  }
  aiSettingsKey() {
    return 'en-US|balanced';
  }
  async runLocal(ids: string[]) {
    this.localCalls.push(ids);
  }
  requestAI(input: AIRequestInput, signal: AbortSignal) {
    return new Promise<Finding[]>((resolve, reject) => {
      this.aiCalls.push({ input, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new AIRequestError('aborted', 'aborted')));
    });
  }
  applyAI(blockId: string, hash: string, findings: Finding[]) {
    this.applied.push({ blockId, hash, findings });
  }
  log(event: string, data: Record<string, unknown>) {
    this.logs.push({ event, data });
  }
  inFlight() {
    return this.aiCalls.filter((c) => !c.signal.aborted && !(c as { done?: boolean }).done);
  }
  finish(call: PendingAI, findings: Finding[] = []) {
    (call as { done?: boolean }).done = true;
    call.resolve(findings);
  }
}

const TEXT = 'This is a paragraph long enough to analyze.';
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('AnalysisScheduler', () => {
  let host: FakeHost;
  let breaker: CircuitBreaker;
  let scheduler: AnalysisScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    host = new FakeHost();
    breaker = new CircuitBreaker({ failureThreshold: 3, baseCooldownMs: 10_000 });
    scheduler = new AnalysisScheduler(host, { breaker, maxConcurrent: 2 });
    for (let i = 0; i < 6; i++) host.set(`b${i}`, `${TEXT} Block ${i}.`);
    host.cursor = 'b0';
    host.visible = ['b0', 'b1', 'b2'];
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  describe('local tier', () => {
    it('debounces edits (~150ms) into one local run', async () => {
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(100);
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(100);
      expect(host.localCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60);
      expect(host.localCalls).toEqual([['b0']]);
    });

    it('runs at least once per second during continuous typing (max wait)', async () => {
      for (let t = 0; t < 1200; t += 100) {
        scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(host.localCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('defers local analysis while an IME composition is active', async () => {
      host.composing = true;
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(600);
      expect(host.localCalls).toHaveLength(0);
      host.composing = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(host.localCalls).toEqual([['b0']]);
    });

    it('prioritizes the cursor block, then visible blocks', async () => {
      scheduler.edit(['b5', 'b2', 'b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(200);
      expect(host.localCalls[0]).toEqual(['b0', 'b2', 'b5']);
    });
  });

  describe('settle detection', () => {
    it('does not send on every keystroke; sends after a ~900ms pause', async () => {
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(500);
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(800);
      expect(host.aiCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(host.aiCalls).toHaveLength(1);
      expect(host.aiCalls[0]!.input.blockId).toBe('b0');
    });

    it('sends immediately when a sentence is completed', async () => {
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await flush();
      expect(host.aiCalls).toHaveLength(1);
    });

    it('sends when the cursor moves to another block', async () => {
      scheduler.selectionChanged('b0');
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      host.cursor = 'b1';
      scheduler.selectionChanged('b1');
      await flush();
      expect(host.aiCalls.map((c) => c.input.blockId)).toEqual(['b0']);
    });
  });

  describe('cancellation', () => {
    it('aborts the in-flight request when its block is edited', async () => {
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await flush();
      const call = host.aiCalls[0]!;
      host.set('b0', `${TEXT} changed`);
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      expect(call.signal.aborted).toBe(true);
      expect(host.logs.some((l) => l.event === 'ai.abort' && l.data.blockId === 'b0')).toBe(true);
      await flush();
      expect(host.applied).toHaveLength(0);
    });

    it('does not abort requests for other blocks', async () => {
      scheduler.edit(['b0', 'b1'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(950);
      const [c0, c1] = host.aiCalls;
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      expect(c0!.signal.aborted).toBe(true);
      expect(c1!.signal.aborted).toBe(false);
    });

    it('discards a response whose block text changed without an abort (race)', async () => {
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await flush();
      host.set('b0', `${TEXT} edited elsewhere`);
      host.finish(host.aiCalls[0]!, [{ start: 0, end: 4, original: 'This', replacements: ['That'], category: 'grammar', severity: 'error', ruleId: 'ai:grammar', title: 't', confidence: 0.9 }]);
      await flush();
      expect(host.applied).toHaveLength(0);
      expect(host.logs.some((l) => l.event === 'ai.stale')).toBe(true);
    });
  });

  describe('queue', () => {
    it('caps concurrency and drains as requests finish', async () => {
      host.visible = ['b0', 'b1', 'b2', 'b3', 'b4'];
      scheduler.edit(['b0', 'b1', 'b2', 'b3', 'b4'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(950);
      expect(host.inFlight()).toHaveLength(2);
      host.finish(host.aiCalls[0]!);
      await flush();
      expect(host.inFlight()).toHaveLength(2);
      expect(host.aiCalls).toHaveLength(3);
    });

    it('serves the cursor block first, then visible blocks by proximity', async () => {
      host.visible = ['b2', 'b3', 'b4'];
      host.cursor = 'b4';
      scheduler.edit(['b3', 'b2', 'b4'], { sentenceCompleted: false, cursorBlockId: 'b4' });
      await vi.advanceTimersByTimeAsync(950);
      expect(host.aiCalls.map((c) => c.input.blockId)).toEqual(['b4', 'b2']);
    });

    it('analyzes off-screen blocks only in the background while idle', async () => {
      host.visible = ['b0'];
      // The writer was just typing: background work must wait for ~1.5s of idle.
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      scheduler.start();
      await flush();
      expect(host.aiCalls.map((c) => c.input.blockId)).toEqual(['b0']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.aiCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(host.aiCalls).toHaveLength(2);
      expect(host.aiCalls[1]!.input.blockId).not.toBe('b0');
      // Finishing work lets the rest of the document drain, two at a time.
      for (let i = 0; i < 10 && host.inFlight().length; i++) {
        host.finish(host.inFlight()[0]!);
        await flush();
      }
      expect(new Set(host.aiCalls.map((c) => c.input.blockId)).size).toBe(6);
    });
  });

  it('treats a bulk edit (e.g. a big paste) as background work except near the writer', async () => {
    host.visible = ['b0', 'b1'];
    scheduler.edit(['b0', 'b1', 'b2', 'b3', 'b4', 'b5'], { sentenceCompleted: false, cursorBlockId: 'b0' });
    await vi.advanceTimersByTimeAsync(950);
    // Only the cursor/visible blocks settle into the foreground; the rest wait for idle.
    expect(host.aiCalls.map((c) => c.input.blockId).sort()).toEqual(['b0', 'b1']);
    expect(scheduler.debugState().queued.sort()).toEqual(['b2', 'b3', 'b4', 'b5']);
  });

  describe('cache', () => {
    it('never re-sends an unchanged block', async () => {
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await flush();
      host.finish(host.aiCalls[0]!);
      await flush();
      host.cursor = 'b1';
      scheduler.selectionChanged('b1');
      scheduler.invalidate({ local: false, ai: false });
      scheduler.viewportChanged();
      await flush();
      expect(host.aiCalls.filter((c) => c.input.blockId === 'b0')).toHaveLength(1);
    });

    it('reuses the cached result when text reverts to an analyzed state', async () => {
      const original = host.blocks.get('b0')!;
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await flush();
      host.finish(host.aiCalls[0]!);
      await flush();
      host.set('b0', `${original}!`);
      scheduler.edit(['b0'], { sentenceCompleted: false, cursorBlockId: 'b0' });
      host.set('b0', original);
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await flush();
      expect(host.aiCalls).toHaveLength(1);
      expect(host.applied).toHaveLength(2);
      expect(host.logs.some((l) => l.event === 'ai.cache-hit')).toBe(true);
    });
  });

  describe('failures', () => {
    it('opens the breaker after repeated failures and probes again after the cooldown', async () => {
      for (let i = 0; i < 3; i++) {
        scheduler.edit([`b${i}`], { sentenceCompleted: true, cursorBlockId: `b${i}` });
        host.cursor = `b${i}`;
        await flush();
        host.aiCalls[host.aiCalls.length - 1]!.reject(new AIRequestError('boom', 'failed'));
        await flush();
      }
      expect(breaker.state).toBe('open');
      const before = host.aiCalls.length;
      host.cursor = 'b3';
      scheduler.edit(['b3'], { sentenceCompleted: true, cursorBlockId: 'b3' });
      await flush();
      expect(host.aiCalls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(10_100);
      expect(host.aiCalls.length).toBe(before + 1);
    });

    it('honors a server Retry-After by pausing', async () => {
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await flush();
      host.aiCalls[0]!.reject(new AIRequestError('slow down', 'rate_limited', 5000));
      await flush();
      expect(breaker.state).toBe('open');
      expect(breaker.retryInMs).toBeGreaterThan(4000);
    });

    it('keeps local checks running while AI is failing', async () => {
      breaker.openFor(60_000);
      scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
      await vi.advanceTimersByTimeAsync(200);
      expect(host.localCalls).toHaveLength(1);
      expect(host.aiCalls).toHaveLength(0);
    });

    it('does not count aborts as failures', async () => {
      for (let i = 0; i < 5; i++) {
        scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
        await flush();
      }
      expect(breaker.state).toBe('closed');
    });
  });

  it('does nothing on the AI tier when AI is unavailable', async () => {
    host.ai = false;
    scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.aiCalls).toHaveLength(0);
    expect(host.localCalls).toHaveLength(1);
  });

  it('splits very long blocks into sentence windows', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here and it has a few words.`).join(' ');
    const windows = splitWindows(long, 400);
    expect(windows.length).toBeGreaterThan(3);
    for (const w of windows) {
      expect(long.slice(w.start, w.start + w.text.length)).toBe(w.text);
      expect(w.text.length).toBeLessThanOrEqual(400);
    }
  });

  it('sends each window of a long block with its offset', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} is written here with care.`).join(' ');
    host.set('b0', long);
    scheduler.edit(['b0'], { sentenceCompleted: true, cursorBlockId: 'b0' });
    await flush();
    const first = host.aiCalls[0]!;
    expect(first.input.windowStart).toBe(0);
    host.finish(first);
    await flush();
    expect(host.aiCalls[1]!.input.windowStart).toBeGreaterThan(0);
  });
});
