/// <reference lib="webworker" />
/**
 * Local analysis worker. Hosts harper.js and the deterministic rules off the
 * main thread so typing never waits on analysis.
 */
import type { Dialect, Sensitivity } from '@/settings/model';
import { createHarperEngine, type GrammarEngine } from './harper';
import { analyzeBlock, type LocalBlockInput } from './analyze';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let engine: GrammarEngine | null = null;
let enginePromise: Promise<void> | null = null;
let dialect: Dialect = 'en-US';
let words: string[] = [];

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

function startEngine(binaryUrl: string) {
  if (enginePromise) return;
  const started = performance.now();
  enginePromise = createHarperEngine(binaryUrl, dialect, words)
    .then(async (e) => {
      // Settings may have changed while the binary was loading.
      await e.setDialect(dialect);
      await e.setWords(words);
      engine = e;
      post({ type: 'engine', status: 'ready', ms: Math.round(performance.now() - started) });
    })
    .catch((err: unknown) => {
      post({ type: 'engine', status: 'failed', ms: Math.round(performance.now() - started), error: String((err as Error)?.message ?? err) });
    });
}

async function analyze(id: number, blocks: LocalBlockInput[], sensitivity: Sensitivity, dictionary: string[]) {
  const dict = new Set(dictionary);
  const started = performance.now();
  const results = [];
  for (const block of blocks) results.push(await analyzeBlock(block, { sensitivity, dictionary: dict }, engine));
  post({ type: 'result', id, results, engine: engine !== null, ms: Math.round(performance.now() - started) });
}

// Messages are processed strictly in order, so a dictionary or dialect change
// always lands before the next analysis request.
let chain: Promise<void> = Promise.resolve();

async function handle(msg: WorkerRequest) {
  switch (msg.type) {
    case 'configure': {
      const dialectChanged = msg.dialect !== dialect;
      dialect = msg.dialect;
      words = msg.words;
      if (!enginePromise) startEngine(msg.binaryUrl);
      else if (engine) {
        if (dialectChanged) await engine.setDialect(dialect);
        await engine.setWords(words);
        post({ type: 'configured' });
      }
      break;
    }
    case 'analyze':
      try {
        await analyze(msg.id, msg.blocks, msg.sensitivity, msg.dictionary);
      } catch (err) {
        post({ type: 'error', id: msg.id, error: String((err as Error)?.message ?? err) });
      }
      break;
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  chain = chain.then(() => handle(msg)).catch(() => {});
};
