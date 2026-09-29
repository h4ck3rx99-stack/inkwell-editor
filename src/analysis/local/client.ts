/**
 * Main-thread handle to the local analysis worker. Falls back to in-thread
 * rule analysis (without harper) when workers are unavailable.
 */
import type { Dialect, Sensitivity } from '@/settings/model';
import { analyzeBlock, type LocalBlockInput, type LocalBlockResult } from './analyze';
import type { WorkerRequest, WorkerResponse } from './protocol';

export const HARPER_BINARY_PATH = '/harper/harper_wasm_slim_bg.wasm';

export type EngineStatus = 'loading' | 'ready' | 'failed';

export interface AnalyzeOptions {
  sensitivity: Sensitivity;
  dictionary: string[];
}

export class LocalAnalyzerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: LocalBlockResult[]) => void; reject: (e: Error) => void }>();
  private engineListeners = new Set<(s: EngineStatus) => void>();
  engineStatus: EngineStatus = 'loading';

  constructor() {
    if (typeof Worker === 'undefined') {
      this.engineStatus = 'failed';
      return;
    }
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'inkwell-local-analysis' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      this.worker.onerror = () => {
        this.setEngine('failed');
        for (const p of this.pending.values()) p.reject(new Error('local analysis worker crashed'));
        this.pending.clear();
        this.worker = null;
      };
    } catch {
      this.worker = null;
      this.engineStatus = 'failed';
    }
  }

  configure(dialect: Dialect, words: string[]): void {
    const binaryUrl = new URL(HARPER_BINARY_PATH, location.origin).href;
    this.post({ type: 'configure', binaryUrl, dialect, words });
  }

  analyze(blocks: LocalBlockInput[], opts: AnalyzeOptions): Promise<LocalBlockResult[]> {
    if (!this.worker) {
      const dictionary = new Set(opts.dictionary);
      return Promise.all(blocks.map((b) => analyzeBlock(b, { sensitivity: opts.sensitivity, dictionary }, null)));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'analyze', id, blocks, sensitivity: opts.sensitivity, dictionary: opts.dictionary });
    });
  }

  onEngineStatus(fn: (s: EngineStatus) => void): () => void {
    this.engineListeners.add(fn);
    return () => this.engineListeners.delete(fn);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  private post(msg: WorkerRequest) {
    this.worker?.postMessage(msg);
  }

  private setEngine(s: EngineStatus) {
    this.engineStatus = s;
    for (const fn of this.engineListeners) fn(s);
  }

  private onMessage(msg: WorkerResponse) {
    switch (msg.type) {
      case 'engine':
        this.setEngine(msg.status);
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg.results);
        break;
      }
      case 'error': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.reject(new Error(msg.error));
        break;
      }
      case 'configured':
        break;
    }
  }
}
