import type { Dialect, Sensitivity } from '@/settings/model';
import type { LocalBlockInput, LocalBlockResult } from './analyze';

export type WorkerRequest =
  | { type: 'configure'; binaryUrl: string; dialect: Dialect; words: string[] }
  | { type: 'analyze'; id: number; blocks: LocalBlockInput[]; sensitivity: Sensitivity; dictionary: string[] };

export type WorkerResponse =
  | { type: 'engine'; status: 'ready' | 'failed'; ms: number; error?: string }
  | { type: 'configured' }
  | { type: 'result'; id: number; results: LocalBlockResult[]; engine: boolean; ms: number }
  | { type: 'error'; id: number; error: string };
