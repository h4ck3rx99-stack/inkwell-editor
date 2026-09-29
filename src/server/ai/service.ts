import 'server-only';
import { CircuitBreaker } from '@/lib/circuit-breaker';
import {
  CheckRequestSchema, MOCK_HEADER, MockControlSchema, STREAM_ERROR_MARKER, WriteRequestSchema,
  type AIStatus, type CheckResponse, type MockControl,
} from '@/shared/ai-contract';
import { loadConfig, PROVIDER_LABEL, type AIConfig } from './config';
import { ProviderError, httpStatusFor } from './errors';
import { logAI } from './log';
import { MalformedOutputError, parseModelOutput } from './model-output';
import { CORRECTION_OUTPUT_SCHEMA, CORRECTION_PROMPT_VERSION, CORRECTION_SYSTEM_PROMPT, buildCorrectionUserPrompt } from './prompts/correction';
import { WRITING_PROMPT_VERSION, buildWritingPrompt } from './prompts/writing';
import { getProvider } from './providers';
import type { AIProvider, WriteTask } from './providers/types';
import { RateLimiter, clientKey } from './rate-limit';
import { withRetry, withTimeout } from './retry';
import { validateIssues } from './validate';

export interface ServiceDeps {
  config: AIConfig;
  provider: AIProvider | null;
}

const breakers = new Map<string, CircuitBreaker>();
function breakerFor(provider: string) {
  let b = breakers.get(provider);
  if (!b) {
    b = new CircuitBreaker({ failureThreshold: 5, baseCooldownMs: 10_000, maxCooldownMs: 60_000 });
    breakers.set(provider, b);
  }
  return b;
}

let limiters: { perMin: number; check: RateLimiter; write: RateLimiter } | null = null;
function limiterFor(route: 'check' | 'write', perMin: number) {
  if (!limiters || limiters.perMin !== perMin) {
    limiters = { perMin, check: new RateLimiter(perMin), write: new RateLimiter(Math.max(5, Math.ceil(perMin / 6))) };
  }
  return limiters[route];
}

export function defaultDeps(): ServiceDeps {
  const config = loadConfig();
  return { config, provider: getProvider(config) };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function errorResponse(cls: string, message: string, status: number, retryAfterMs?: number) {
  return json({ error: { class: cls, message } }, status, retryAfterMs !== undefined ? { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) } : {});
}

function mockControl(req: Request, config: AIConfig): MockControl | undefined {
  if (config.provider !== 'mock') return undefined;
  const raw = req.headers.get(MOCK_HEADER);
  if (!raw) return undefined;
  try {
    const parsed = MockControlSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new ProviderError('bad_request', 'request too large');
  const text = await req.text();
  if (text.length > maxBytes) throw new ProviderError('bad_request', 'request too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('bad_request', 'invalid JSON');
  }
}

export function handleStatus(deps: ServiceDeps = defaultDeps()): Response {
  const { config } = deps;
  const body: AIStatus = {
    provider: config.provider,
    configured: config.configured,
    label: PROVIDER_LABEL[config.provider],
    fastModel: config.fastModel,
    qualityModel: config.qualityModel,
    reason: config.reason,
  };
  return json(body);
}

/** Real-time correction for one block (or sentence window). */
export async function handleCheck(req: Request, deps: ServiceDeps = defaultDeps()): Promise<Response> {
  const started = Date.now();
  const { config, provider } = deps;
  const base = { route: 'check' as const, provider: config.provider, model: config.fastModel ?? undefined, promptVersion: CORRECTION_PROMPT_VERSION };

  if (!provider || !config.fastModel) {
    logAI({ ...base, status: 'not_configured' });
    return errorResponse('not_configured', config.reason ?? 'AI is not configured.', 503);
  }
  const wait = limiterFor('check', config.rateLimitPerMin).take(clientKey(req));
  if (wait > 0) {
    logAI({ ...base, status: 'rate_limited' });
    return errorResponse('rate_limited', 'Too many requests.', 429, wait);
  }

  let body: unknown;
  try {
    body = await readJson(req, 64 * 1024);
  } catch {
    logAI({ ...base, status: 'rejected', errorClass: 'bad_request' });
    return errorResponse('bad_request', 'Invalid request.', 400);
  }
  const parsed = CheckRequestSchema.safeParse(body);
  if (!parsed.success) {
    logAI({ ...base, status: 'rejected', errorClass: 'validation' });
    return errorResponse('bad_request', 'Invalid request.', 400);
  }
  const input = parsed.data;
  const meta = { ...base, textLength: input.text.length, contextLength: input.context.length };

  const breaker = breakerFor(config.provider);
  if (!breaker.tryAcquire()) {
    logAI({ ...meta, status: 'circuit_open' });
    return errorResponse('circuit_open', 'AI checks are paused after repeated failures.', 503, breaker.retryInMs || 5000);
  }

  const timeout = withTimeout(req.signal, config.checkTimeoutMs);
  const deadline = started + config.checkTimeoutMs;
  let retries = 0;
  try {
    const raw = await withRetry(
      () =>
        provider.generateStructured({
          model: config.fastModel!,
          system: CORRECTION_SYSTEM_PROMPT,
          user: buildCorrectionUserPrompt({ ...input, categories: input.categories }),
          schemaName: 'inkwell_corrections',
          schema: CORRECTION_OUTPUT_SCHEMA,
          maxTokens: 1500,
          signal: timeout.signal,
          task: { kind: 'correction', text: input.text, context: input.context },
          mock: mockControl(req, config),
        }),
      { retries: 2, baseDelayMs: 250, maxDelayMs: 2000, signal: timeout.signal, deadline, onRetry: () => retries++ },
    );

    let parsedOut: ReturnType<typeof parseModelOutput>;
    try {
      parsedOut = parseModelOutput(raw);
    } catch (err) {
      // Malformed output is logged (metadata only) and treated as "no findings".
      breaker.onSuccess();
      logAI({ ...meta, status: 'malformed', errorClass: err instanceof MalformedOutputError ? err.reason : 'unknown', latencyMs: Date.now() - started, retries });
      return json({ issues: [], meta: { provider: config.provider, model: config.fastModel, promptVersion: CORRECTION_PROMPT_VERSION, latencyMs: Date.now() - started, dropped: 0 } } satisfies CheckResponse);
    }

    const result = validateIssues(input.text, parsedOut.issues, {
      sensitivity: input.sensitivity,
      categories: new Set(input.categories),
      protectedRanges: input.protectedRanges.map(([start, end]) => ({ start, end })),
      context: input.context,
    });
    breaker.onSuccess();
    const droppedTotal = Object.values(result.dropped).reduce((a, b) => a + (b ?? 0), 0) + parsedOut.invalid;
    logAI({
      ...meta, status: 'ok', latencyMs: Date.now() - started, issues: result.issues.length, invalidIssues: parsedOut.invalid,
      dropped: result.dropped as Record<string, number>, retries,
    });
    return json({
      issues: result.issues,
      meta: { provider: config.provider, model: config.fastModel, promptVersion: CORRECTION_PROMPT_VERSION, latencyMs: Date.now() - started, dropped: droppedTotal },
    } satisfies CheckResponse);
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('network', 'unexpected failure');
    const kind = timeout.timedOut() ? 'timeout' : req.signal.aborted ? 'aborted' : e.kind;
    if (kind === 'aborted') breaker.onCancel();
    else if (kind === 'rate_limited') breaker.onCancel();
    else breaker.onFailure();
    logAI({ ...meta, status: kind === 'aborted' ? 'aborted' : 'error', errorClass: kind, latencyMs: Date.now() - started, retries });
    const status = httpStatusFor(new ProviderError(kind, e.message));
    return errorResponse(kind, kind === 'aborted' ? 'Cancelled.' : 'The AI check failed.', status, e.retryAfterMs);
  } finally {
    timeout.dispose();
  }
}

const SUMMARY_CHUNK = 20_000;

function chunkDocument(text: string): string[] {
  const paras = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > SUMMARY_CHUNK) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > SUMMARY_CHUNK) {
      chunks.push(cur.slice(0, SUMMARY_CHUNK));
      cur = cur.slice(SUMMARY_CHUNK);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/** Writing actions: streamed plain text. Errors before the first byte are JSON; after, an in-band marker. */
export async function handleWrite(req: Request, deps: ServiceDeps = defaultDeps()): Promise<Response> {
  const started = Date.now();
  const { config, provider } = deps;
  const base = { route: 'write' as const, provider: config.provider, model: config.qualityModel ?? undefined, promptVersion: WRITING_PROMPT_VERSION };

  if (!provider || !config.qualityModel) {
    logAI({ ...base, status: 'not_configured' });
    return errorResponse('not_configured', config.reason ?? 'AI is not configured.', 503);
  }
  const wait = limiterFor('write', config.rateLimitPerMin).take(clientKey(req));
  if (wait > 0) {
    logAI({ ...base, status: 'rate_limited' });
    return errorResponse('rate_limited', 'Too many requests.', 429, wait);
  }
  let body: unknown;
  try {
    body = await readJson(req, 1_200_000);
  } catch {
    return errorResponse('bad_request', 'Invalid request.', 400);
  }
  const parsed = WriteRequestSchema.safeParse(body);
  if (!parsed.success) {
    logAI({ ...base, status: 'rejected', errorClass: 'validation' });
    return errorResponse('bad_request', 'Invalid request.', 400);
  }
  const input = parsed.data;
  if (input.action !== 'summarize' && input.text.length > 12_000) return errorResponse('bad_request', 'Selection is too long.', 400);
  const meta = { ...base, action: input.action, textLength: input.text.length };

  const breaker = breakerFor(config.provider);
  if (!breaker.tryAcquire()) {
    logAI({ ...meta, status: 'circuit_open' });
    return errorResponse('circuit_open', 'AI is paused after repeated failures.', 503, breaker.retryInMs || 5000);
  }

  const timeout = withTimeout(req.signal, config.writeTimeoutMs);
  const mock = mockControl(req, config);
  const model = config.qualityModel;
  const task = (action: WriteTask['action'], text: string): WriteTask => ({
    kind: 'write', action, text, tone: input.tone, instruction: input.instruction,
    suggestion: input.suggestion, dialect: input.dialect, goal: input.goal,
  });

  const streamFor = (t: WriteTask, before: string, after: string) => {
    const prompt = buildWritingPrompt(t, before, after);
    return provider.streamText({ model, system: prompt.system, user: prompt.user, maxTokens: prompt.maxTokens, signal: timeout.signal, task: t, mock });
  };

  // Retry only until the first chunk arrives; after that, the stream is committed.
  let retries = 0;
  let first: { iterator: AsyncIterator<string>; value: string };
  try {
    let finalTask = task(input.action, input.text);
    if (input.action === 'summarize' && input.text.length > SUMMARY_CHUNK) {
      const notes: string[] = [];
      for (const chunk of chunkDocument(input.text)) {
        let out = '';
        await withRetry(async () => {
          out = '';
          for await (const piece of streamFor(task('summarize-chunk', chunk), '', '')) out += piece;
        }, { retries: 2, signal: timeout.signal, onRetry: () => retries++ });
        notes.push(out.trim());
      }
      finalTask = task('summarize', notes.join('\n'));
    }
    first = await withRetry(
      async () => {
        const iterator = streamFor(finalTask, input.before, input.after)[Symbol.asyncIterator]();
        const r = await iterator.next();
        if (r.done) throw new ProviderError('empty', 'empty response');
        return { iterator, value: r.value };
      },
      { retries: 2, baseDelayMs: 400, maxDelayMs: 4000, signal: timeout.signal, deadline: started + config.writeTimeoutMs, onRetry: () => retries++ },
    );
  } catch (err) {
    timeout.dispose();
    const e = err instanceof ProviderError ? err : new ProviderError('network', 'unexpected failure');
    const kind = timeout.timedOut() ? 'timeout' : req.signal.aborted ? 'aborted' : e.kind;
    if (kind === 'aborted' || kind === 'rate_limited') breaker.onCancel();
    else breaker.onFailure();
    logAI({ ...meta, status: kind === 'aborted' ? 'aborted' : 'error', errorClass: kind, latencyMs: Date.now() - started, retries });
    return errorResponse(kind, 'The writing action failed.', httpStatusFor(new ProviderError(kind, e.message)), e.retryAfterMs);
  }

  const encoder = new TextEncoder();
  let finished = false;
  const finish = (status: 'ok' | 'error' | 'aborted', errorClass?: string) => {
    if (finished) return;
    finished = true;
    timeout.dispose();
    if (status === 'ok') breaker.onSuccess();
    else if (status === 'aborted') breaker.onCancel();
    else breaker.onFailure();
    logAI({ ...meta, status, errorClass, latencyMs: Date.now() - started, retries });
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first.value));
    },
    async pull(controller) {
      try {
        const r = await first.iterator.next();
        if (r.done) {
          finish('ok');
          controller.close();
        } else controller.enqueue(encoder.encode(r.value));
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError('network', 'stream failed');
        const kind = timeout.timedOut() ? 'timeout' : req.signal.aborted ? 'aborted' : e.kind;
        finish(kind === 'aborted' ? 'aborted' : 'error', kind);
        try {
          if (kind !== 'aborted') controller.enqueue(encoder.encode(`${STREAM_ERROR_MARKER}${kind}`));
          controller.close();
        } catch {
          // client already gone
        }
      }
    },
    cancel() {
      // Client went away: abort the upstream provider call.
      finish('aborted', 'client_cancel');
      timeout.abort();
      void first.iterator.return?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-inkwell-provider': config.provider,
    },
  });
}

/** Test hook: reset per-process breaker and rate-limiter state. */
export function resetServiceStateForTests(): void {
  breakers.clear();
  limiters = null;
}
