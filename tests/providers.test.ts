import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '@/server/ai/providers/anthropic';
import { createOpenAIProvider } from '@/server/ai/providers/openai';
import { createMockProvider } from '@/server/ai/providers/mock';
import type { AIProvider, StructuredRequest, TextRequest } from '@/server/ai/providers/types';
import { ProviderError } from '@/server/ai/errors';
import { withRetry, withTimeout } from '@/server/ai/retry';
import { CircuitBreaker } from '@/lib/circuit-breaker';
import { handleCheck, handleWrite, resetServiceStateForTests } from '@/server/ai/service';
import type { AIConfig } from '@/server/ai/config';
import { STREAM_ERROR_MARKER } from '@/shared/ai-contract';

process.env.INKWELL_LOG = 'silent';

type FetchCall = { url: string; init: RequestInit };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const anthropicMessage = (text: string) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
});

function sse(events: { event?: string; data: unknown }[]) {
  const body = events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function structuredReq(signal: AbortSignal, model = 'claude-haiku-4-5-20251001'): StructuredRequest {
  return {
    model, system: 'sys', user: 'user', schemaName: 's', schema: { type: 'object' }, maxTokens: 100, signal,
    task: { kind: 'correction', text: 'x', context: '' },
  };
}

function textReq(signal: AbortSignal, model = 'claude-sonnet-5'): TextRequest {
  return { model, system: 'sys', user: 'user', maxTokens: 100, signal, task: { kind: 'write', action: 'improve', text: 'x', dialect: 'en-US', goal: 'general' } };
}

/** A fetch that never answers until its signal aborts (to test timeouts and cancellation). */
function hangingFetch(calls: FetchCall[]) {
  return (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal?.aborted) fail();
      signal?.addEventListener('abort', fail);
    });
  };
}

describe('Anthropic adapter (mocked HTTP)', () => {
  it('sends native structured output and returns the model text', async () => {
    const calls: FetchCall[] = [];
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return json(anthropicMessage('{"issues":[]}'));
      },
    });
    const out = await provider.generateStructured(structuredReq(new AbortController().signal));
    expect(out).toBe('{"issues":[]}');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.output_config.format.type).toBe('json_schema');
    expect(calls[0]!.url).toContain('/v1/messages');
  });

  it('maps 429 with Retry-After to a retryable rate_limited error', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetch: async () => json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '2' }),
    });
    const err = await provider.generateStructured(structuredReq(new AbortController().signal)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(2000);
    expect(err.retryable).toBe(true);
  });

  it('retries 5xx with backoff and then succeeds', async () => {
    let n = 0;
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetch: async () => (++n < 3 ? json({ type: 'error', error: { type: 'api_error', message: 'boom' } }, 500) : json(anthropicMessage('{"issues":[]}'))),
    });
    const signal = new AbortController().signal;
    const sleeps: number[] = [];
    const out = await withRetry(() => provider.generateStructured(structuredReq(signal)), {
      retries: 3, baseDelayMs: 100, signal, random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(out).toBe('{"issues":[]}');
    expect(n).toBe(3);
    expect(sleeps).toEqual([75, 150]); // exponential backoff with jitter
  });

  it('falls back to prompt-only JSON when structured output is rejected', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.output_config?.format) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format is not supported for this model' } }, 400);
        return json(anthropicMessage('{"issues":[]}'));
      },
    });
    expect(await provider.generateStructured(structuredReq(new AbortController().signal, 'claude-old'))).toBe('{"issues":[]}');
    expect(bodies).toHaveLength(2);
    // The fallback is remembered per model.
    await provider.generateStructured(structuredReq(new AbortController().signal, 'claude-old'));
    expect(bodies).toHaveLength(3);
  });

  it('times out and reports a timeout (not a generic failure)', async () => {
    const calls: FetchCall[] = [];
    const provider = createAnthropicProvider({ apiKey: 'k', fetch: hangingFetch(calls) });
    const t = withTimeout(new AbortController().signal, 50);
    const err = await provider.generateStructured(structuredReq(t.signal)).catch((e) => e);
    t.dispose();
    expect(t.timedOut()).toBe(true);
    expect(err.kind).toBe('timeout');
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it('propagates cancellation to the upstream HTTP request', async () => {
    const calls: FetchCall[] = [];
    const provider = createAnthropicProvider({ apiKey: 'k', fetch: hangingFetch(calls) });
    const controller = new AbortController();
    const pending = provider.generateStructured(structuredReq(controller.signal)).catch((e) => e);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    const err = await pending;
    expect(err.kind).toBe('aborted');
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it('streams text deltas', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetch: async () =>
        sse([
          { event: 'message_start', data: { type: 'message_start', message: { ...anthropicMessage(''), content: [], stop_reason: null } } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
    });
    let out = '';
    for await (const piece of provider.streamText(textReq(new AbortController().signal))) out += piece;
    expect(out).toBe('Hello world');
  });

  it('lowers effort and disables thinking only for models that support it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetch: async (_i, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json(anthropicMessage('{}'));
      },
    });
    await provider.generateStructured(structuredReq(new AbortController().signal, 'claude-sonnet-5'));
    await provider.generateStructured(structuredReq(new AbortController().signal, 'claude-haiku-4-5-20251001'));
    expect(bodies[0]).toMatchObject({ thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
    expect(bodies[1]!.thinking).toBeUndefined();
  });
});

describe('OpenAI / OpenAI-compatible adapter (mocked HTTP)', () => {
  it('uses json_schema structured output and returns content', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createOpenAIProvider({
      apiKey: 'k', baseURL: 'https://api.test/v1', compatible: false,
      fetch: async (_i, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ choices: [{ message: { content: '{"issues":[]}' } }] });
      },
    });
    expect(await provider.generateStructured(structuredReq(new AbortController().signal, 'gpt-5-mini'))).toBe('{"issues":[]}');
    expect(bodies[0]).toMatchObject({ response_format: { type: 'json_schema' }, max_completion_tokens: 100 });
  });

  it('steps down to json_object, then prompt-only, when an endpoint rejects the format', async () => {
    const formats: (string | undefined)[] = [];
    const provider = createOpenAIProvider({
      apiKey: null, baseURL: 'http://localhost:11434/v1', compatible: true,
      fetch: async (_i, init) => {
        const body = JSON.parse(String(init?.body));
        formats.push(body.response_format?.type);
        if (body.response_format) return json({ error: { message: 'response_format unsupported' } }, 400);
        return json({ choices: [{ message: { content: 'Sure: {"issues": []}' } }] });
      },
    });
    expect(await provider.generateStructured(structuredReq(new AbortController().signal, 'llama3'))).toContain('"issues"');
    expect(formats).toEqual(['json_schema', 'json_object', undefined]);
  });

  it('maps 429 and 5xx to retryable errors, honoring Retry-After', async () => {
    const provider = createOpenAIProvider({ apiKey: 'k', baseURL: 'https://api.test/v1', compatible: false, fetch: async () => json({ error: { code: 'rate_limit' } }, 429, { 'retry-after': '3' }) });
    const err = await provider.generateStructured(structuredReq(new AbortController().signal, 'gpt-5-mini')).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 3000 });
    const p2 = createOpenAIProvider({ apiKey: 'k', baseURL: 'https://api.test/v1', compatible: false, fetch: async () => json({}, 503) });
    expect(await p2.generateStructured(structuredReq(new AbortController().signal, 'gpt-5-mini')).catch((e) => e.kind)).toBe('server');
  });

  it('parses SSE streaming deltas', async () => {
    const provider = createOpenAIProvider({
      apiKey: 'k', baseURL: 'https://api.test/v1', compatible: true,
      fetch: async () => sse([{ data: { choices: [{ delta: { content: 'Hi ' } }] } }, { data: { choices: [{ delta: { content: 'there' } }] } }, { data: '[DONE]' }]),
    });
    let out = '';
    for await (const piece of provider.streamText(textReq(new AbortController().signal, 'llama3'))) out += piece;
    expect(out).toBe('Hi there');
  });

  it('propagates cancellation', async () => {
    const calls: FetchCall[] = [];
    const provider = createOpenAIProvider({ apiKey: 'k', baseURL: 'https://api.test/v1', compatible: false, fetch: hangingFetch(calls) });
    const c = new AbortController();
    const pending = provider.generateStructured(structuredReq(c.signal, 'gpt-5-mini')).catch((e) => e);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    c.abort();
    expect((await pending).kind).toBe('aborted');
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });
});

describe('retry policy', () => {
  it('does not retry non-retryable errors', async () => {
    let n = 0;
    const err = await withRetry(
      async () => {
        n++;
        throw new ProviderError('auth', 'bad key', { status: 401 });
      },
      { retries: 3, signal: new AbortController().signal, sleep: async () => {} },
    ).catch((e) => e);
    expect(err.kind).toBe('auth');
    expect(n).toBe(1);
  });

  it('uses Retry-After instead of backoff when present', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (n++ === 0) throw new ProviderError('rate_limited', '429', { status: 429, retryAfterMs: 1234 });
        return 'ok';
      },
      { retries: 2, signal: new AbortController().signal, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(sleeps).toEqual([1234]);
  });

  it('gives up rather than sleeping past the deadline', async () => {
    let n = 0;
    const err = await withRetry(
      async () => {
        n++;
        throw new ProviderError('rate_limited', '429', { retryAfterMs: 10_000 });
      },
      { retries: 5, signal: new AbortController().signal, deadline: Date.now() + 1000, sleep: async () => {} },
    ).catch((e) => e);
    expect(n).toBe(1);
    expect(err.kind).toBe('rate_limited');
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures, half-opens after the cooldown, and closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, baseCooldownMs: 1000, now: () => now });
    for (let i = 0; i < 3; i++) {
      expect(b.tryAcquire()).toBe(true);
      b.onFailure();
    }
    expect(b.state).toBe('open');
    expect(b.tryAcquire()).toBe(false);
    now = 1000;
    expect(b.state).toBe('half-open');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // only one probe
    b.onSuccess();
    expect(b.state).toBe('closed');
  });

  it('grows the cooldown when the probe fails', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, baseCooldownMs: 1000, now: () => now });
    b.onFailure();
    expect(b.retryInMs).toBe(1000);
    now = 1000;
    b.tryAcquire();
    b.onFailure();
    expect(b.retryInMs).toBe(2000);
  });

  it('ignores cancellations', () => {
    const b = new CircuitBreaker({ failureThreshold: 1 });
    b.tryAcquire();
    b.onCancel();
    expect(b.state).toBe('closed');
  });
});

describe('AI route service', () => {
  const config: AIConfig = {
    provider: 'mock', configured: true, reason: null, fastModel: 'mock-fast', qualityModel: 'mock-quality', baseUrl: null, apiKey: null,
    checkTimeoutMs: 300, writeTimeoutMs: 1000, rateLimitPerMin: 1000, mockLatencyMs: 0, mockMode: 'ok',
  };
  const body = (text: string) =>
    JSON.stringify({ text, context: '', dialect: 'en-US', goal: 'general', sensitivity: 'balanced', categories: ['spelling', 'grammar', 'punctuation', 'word-choice', 'clarity', 'concision'] });
  const req = (text: string, init: RequestInit = {}) => new Request('http://x/api/ai/check', { method: 'POST', body: body(text), headers: { 'content-type': 'application/json' }, ...init });

  beforeEach(() => resetServiceStateForTests());
  afterEach(() => vi.useRealTimers());

  it('returns resolved issues with offsets computed by the server', async () => {
    const res = await handleCheck(req('We could of gone.'), { config, provider: createMockProvider({ latencyMs: 0, mode: 'ok' }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.issues[0]).toMatchObject({ start: 3, end: 11, original: 'could of', replacements: ['could have'] });
  });

  it('drops noisy / invalid model issues without surfacing errors', async () => {
    const res = await handleCheck(req('Their is a problem here.'), { config, provider: createMockProvider({ latencyMs: 0, mode: 'noisy' }) });
    const data = await res.json();
    expect(data.issues.map((i: { original: string }) => i.original)).toEqual(['Their is']);
    expect(data.meta.dropped).toBeGreaterThanOrEqual(2);
  });

  it('treats malformed model output as "no findings" (200, empty)', async () => {
    const res = await handleCheck(req('Some text here.'), { config, provider: createMockProvider({ latencyMs: 0, mode: 'malformed' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).issues).toEqual([]);
  });

  it('answers 503 not_configured when no provider is set up', async () => {
    const res = await handleCheck(req('Hello there.'), { config: { ...config, configured: false, provider: 'none', reason: 'off' }, provider: null });
    expect(res.status).toBe(503);
    expect((await res.json()).error.class).toBe('not_configured');
  });

  it('rejects invalid requests with 400', async () => {
    const res = await handleCheck(new Request('http://x', { method: 'POST', body: '{"text": 5}' }), { config, provider: createMockProvider({ latencyMs: 0, mode: 'ok' }) });
    expect(res.status).toBe(400);
  });

  it('times out with 504', async () => {
    const res = await handleCheck(req('Hello there friend.'), { config, provider: createMockProvider({ latencyMs: 0, mode: 'timeout' }) });
    expect(res.status).toBe(504);
  });

  it('rate-limits per client with Retry-After', async () => {
    const deps = { config: { ...config, rateLimitPerMin: 2 }, provider: createMockProvider({ latencyMs: 0, mode: 'ok' }) };
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' };
    expect((await handleCheck(req('Hello there.', { headers }), deps)).status).toBe(200);
    expect((await handleCheck(req('Hello there.', { headers }), deps)).status).toBe(200);
    const limited = await handleCheck(req('Hello there.', { headers }), deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // A different client is unaffected.
    expect((await handleCheck(req('Hello there.', { headers: { ...headers, 'x-forwarded-for': '5.6.7.8' } }), deps)).status).toBe(200);
  });

  it('opens the server-side breaker after repeated provider failures', async () => {
    const deps = { config, provider: createMockProvider({ latencyMs: 0, mode: 'error' }) };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await handleCheck(req('Hello there.'), deps)).status);
    expect(statuses.slice(0, 5).every((s) => s === 502)).toBe(true);
    expect(statuses[5]).toBe(503);
  });

  it('propagates a client disconnect to the provider call', async () => {
    let seen: AbortSignal | null = null;
    const provider: AIProvider = {
      id: 'mock',
      generateStructured: (r) =>
        new Promise((_, reject) => {
          seen = r.signal;
          r.signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'aborted')));
        }),
      streamText: async function* () {},
    };
    const controller = new AbortController();
    const pending = handleCheck(req('Hello there.', { signal: controller.signal }), { config: { ...config, checkTimeoutMs: 5000 }, provider });
    await vi.waitFor(() => expect(seen).not.toBeNull());
    controller.abort();
    const res = await pending;
    expect(seen!.aborted).toBe(true);
    expect(res.status).toBe(499);
  });

  it('streams writing actions and marks mid-stream failures in-band', async () => {
    const writeReq = new Request('http://x/api/ai/write', {
      method: 'POST',
      body: JSON.stringify({ action: 'shorter', text: 'This is really very important in order to win.', dialect: 'en-US', goal: 'general' }),
    });
    const res = await handleWrite(writeReq, { config, provider: createMockProvider({ latencyMs: 0, mode: 'ok' }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('This is important to win.');

    const failing: AIProvider = {
      id: 'mock',
      generateStructured: async () => '',
      streamText: async function* () {
        yield 'Partial ';
        throw new ProviderError('server', 'boom');
      },
    };
    const res2 = await handleWrite(
      new Request('http://x/api/ai/write', { method: 'POST', body: JSON.stringify({ action: 'improve', text: 'Hello.', dialect: 'en-US', goal: 'general' }) }),
      { config, provider: failing },
    );
    const text = await res2.text();
    expect(text.startsWith('Partial ')).toBe(true);
    expect(text).toContain(`${STREAM_ERROR_MARKER}server`);
  });

  it('never logs document text', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prev = process.env.INKWELL_LOG;
    process.env.INKWELL_LOG = '';
    try {
      const secret = 'Myverysecretsentence about teh plan.';
      await handleCheck(req(secret), { config, provider: createMockProvider({ latencyMs: 0, mode: 'ok' }) });
      await handleCheck(req(secret), { config, provider: createMockProvider({ latencyMs: 0, mode: 'malformed' }) });
      const logged = [...spy.mock.calls, ...warn.mock.calls].flat().join('\n');
      expect(logged).toContain('inkwell.ai');
      expect(logged).not.toContain('Myverysecretsentence');
      expect(logged).not.toContain('teh plan');
    } finally {
      process.env.INKWELL_LOG = prev;
    }
  });
});
