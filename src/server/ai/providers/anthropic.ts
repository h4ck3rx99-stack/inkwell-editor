import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, parseRetryAfterHeader } from '../errors';
import type { AIProvider, FetchLike, StructuredRequest, TextRequest } from './types';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string | null;
  fetch?: FetchLike;
}

/**
 * Model-specific request tuning. Real-time corrections and rewrites need low
 * latency, so on models with adaptive thinking we lower effort (and disable
 * thinking where the model allows it). Unknown/older models get no extras.
 */
export function tuningFor(model: string): Pick<Anthropic.MessageCreateParamsNonStreaming, 'thinking' | 'output_config'> {
  if (/^claude-(sonnet-5|opus-4-[678]|sonnet-4-6)(-\d{8})?$/.test(model)) {
    return { thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
  }
  if (/^claude-(opus-5|fable-5|mythos-5)/.test(model)) return { output_config: { effort: 'low' } };
  return {};
}

function mapError(err: unknown, signal: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal.aborted) {
    const reason = signal.reason;
    return reason instanceof ProviderError ? reason : new ProviderError('aborted', 'aborted');
  }
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted', 'aborted');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'provider timed out');
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', 'could not reach Anthropic');
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const retryAfterMs = parseRetryAfterHeader(err.headers?.get?.('retry-after'));
    const msg = `anthropic ${status}`;
    if (status === 429) return new ProviderError('rate_limited', msg, { status, retryAfterMs });
    if (status === 401 || status === 403) return new ProviderError('auth', msg, { status });
    if (status === 400 && /output_config|output_format|json_schema|structured/i.test(err.message)) {
      return new ProviderError('unsupported_format', msg, { status });
    }
    if (status >= 500) return new ProviderError('server', msg, { status, retryAfterMs });
    return new ProviderError('bad_request', msg, { status });
  }
  return new ProviderError('network', 'anthropic request failed');
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): AIProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    // Retries are owned by Inkwell's retry layer (backoff + jitter + Retry-After + deadline).
    maxRetries: 0,
    ...(opts.fetch ? { fetch: opts.fetch as typeof fetch } : {}),
  });
  // Models that rejected native structured output fall back to prompt-only JSON.
  const noStructured = new Set<string>();

  return {
    id: 'anthropic',

    async generateStructured(req: StructuredRequest) {
      const tuning = tuningFor(req.model);
      const useFormat = !noStructured.has(req.model);
      const call = (withFormat: boolean) =>
        client.messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
            ...(tuning.thinking ? { thinking: tuning.thinking } : {}),
            ...(withFormat || tuning.output_config
              ? {
                  output_config: {
                    ...(tuning.output_config ?? {}),
                    ...(withFormat ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}),
                  },
                }
              : {}),
          },
          { signal: req.signal },
        );
      let res: Anthropic.Message;
      try {
        res = await call(useFormat);
      } catch (err) {
        const e = mapError(err, req.signal);
        if (e.kind !== 'unsupported_format' || !useFormat) throw e;
        noStructured.add(req.model);
        try {
          res = await call(false);
        } catch (err2) {
          throw mapError(err2, req.signal);
        }
      }
      if (res.stop_reason === 'refusal') throw new ProviderError('empty', 'model declined');
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text.trim()) throw new ProviderError('empty', 'empty response');
      return text;
    },

    async *streamText(req: TextRequest) {
      const tuning = tuningFor(req.model);
      let stream: ReturnType<typeof client.messages.stream>;
      try {
        stream = client.messages.stream(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
            ...(tuning.thinking ? { thinking: tuning.thinking } : {}),
            ...(tuning.output_config ? { output_config: tuning.output_config } : {}),
          },
          { signal: req.signal },
        );
      } catch (err) {
        throw mapError(err, req.signal);
      }
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
            yield event.delta.text;
          } else if (event.type === 'message_delta' && event.delta.stop_reason === 'refusal') {
            throw new ProviderError('empty', 'model declined');
          }
        }
      } catch (err) {
        throw mapError(err, req.signal);
      }
    },
  };
}
