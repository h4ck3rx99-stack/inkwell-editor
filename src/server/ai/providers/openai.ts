import { ProviderError, errorFromStatus } from '../errors';
import type { AIProvider, FetchLike, StructuredRequest, TextRequest } from './types';

export interface OpenAIProviderOptions {
  apiKey: string | null;
  /** e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama), https://openrouter.ai/api/v1 */
  baseURL: string;
  /** OpenAI-compatible servers vary in what they support; we probe down a ladder. */
  compatible: boolean;
  fetch?: FetchLike;
}

type FormatMode = 'json_schema' | 'json_object' | 'none';

function isReasoningModel(model: string) {
  return /^(gpt-5|o\d)/.test(model);
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    return body?.error?.code ?? body?.error?.message?.slice(0, 80) ?? `http ${res.status}`;
  } catch {
    return `http ${res.status}`;
  }
}

function mapFetchError(err: unknown, signal: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal.aborted) {
    const reason = signal.reason;
    return reason instanceof ProviderError ? reason : new ProviderError('aborted', 'aborted');
  }
  return new ProviderError('network', 'could not reach the AI endpoint');
}

export function createOpenAIProvider(opts: OpenAIProviderOptions): AIProvider {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.baseURL.replace(/\/+$/, '');
  const formatMode = new Map<string, FormatMode>();

  const headers = () => ({
    'content-type': 'application/json',
    ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
  });

  const tokenField = (model: string, n: number) =>
    opts.compatible ? { max_tokens: n } : isReasoningModel(model) ? { max_completion_tokens: n, reasoning_effort: 'minimal' } : { max_tokens: n };

  async function post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${base}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
    } catch (err) {
      throw mapFetchError(err, signal);
    }
    if (!res.ok) throw errorFromStatus(res.status, `openai ${await readError(res)}`, res.headers.get('retry-after'));
    return res;
  }

  return {
    id: opts.compatible ? 'openai-compatible' : 'openai',

    async generateStructured(req: StructuredRequest) {
      const ladder: FormatMode[] = ['json_schema', 'json_object', 'none'];
      let idx = ladder.indexOf(formatMode.get(req.model) ?? 'json_schema');
      for (;;) {
        const mode = ladder[idx]!;
        const body: Record<string, unknown> = {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          ...tokenField(req.model, req.maxTokens),
        };
        if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: true } };
        if (mode === 'json_object') body.response_format = { type: 'json_object' };
        try {
          const res = await post(body, req.signal);
          formatMode.set(req.model, mode);
          let json: { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
          try {
            json = await res.json();
          } catch (err) {
            throw req.signal.aborted ? mapFetchError(err, req.signal) : new ProviderError('malformed', 'response was not JSON');
          }
          const msg = json.choices?.[0]?.message;
          if (msg?.refusal) throw new ProviderError('empty', 'model declined');
          const content = msg?.content ?? '';
          if (!content.trim()) throw new ProviderError('empty', 'empty response');
          return content;
        } catch (err) {
          // Step down the ladder when the server rejects the response_format.
          if (err instanceof ProviderError && err.kind === 'bad_request' && idx < ladder.length - 1 && mode !== 'none') {
            idx++;
            continue;
          }
          throw err;
        }
      }
    },

    async *streamText(req: TextRequest) {
      const res = await post(
        {
          model: req.model,
          stream: true,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          ...tokenField(req.model, req.maxTokens),
        },
        req.signal,
      );
      if (!res.body) throw new ProviderError('empty', 'no response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            let evt: { choices?: { delta?: { content?: string | null } }[]; error?: unknown };
            try {
              evt = JSON.parse(data);
            } catch {
              continue;
            }
            if (evt.error) throw new ProviderError('server', 'stream error event');
            const text = evt.choices?.[0]?.delta?.content;
            if (text) yield text;
          }
        }
      } catch (err) {
        throw mapFetchError(err, req.signal);
      } finally {
        reader.releaseLock();
      }
    },
  };
}
