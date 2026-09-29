import 'server-only';
import { z } from 'zod';

export const PROVIDER_IDS = ['anthropic', 'openai', 'openai-compatible', 'mock', 'none'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

const intFrom = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = v === undefined || v.trim() === '' ? NaN : Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    });

const EnvSchema = z.object({
  INKWELL_AI_PROVIDER: z.string().optional(),
  INKWELL_AI_FAST_MODEL: z.string().optional(),
  INKWELL_AI_QUALITY_MODEL: z.string().optional(),
  INKWELL_AI_BASE_URL: z.string().optional(),
  INKWELL_AI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  INKWELL_AI_TIMEOUT_MS: intFrom(8000),
  INKWELL_AI_WRITE_TIMEOUT_MS: intFrom(60_000),
  INKWELL_RATE_LIMIT_PER_MIN: intFrom(120),
  INKWELL_MOCK_LATENCY_MS: intFrom(250),
  INKWELL_MOCK_MODE: z.string().optional(),
});

export const DEFAULT_MODELS: Record<Exclude<ProviderId, 'none' | 'openai-compatible'>, { fast: string; quality: string }> = {
  anthropic: { fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5' },
  openai: { fast: 'gpt-5-mini', quality: 'gpt-5' },
  mock: { fast: 'mock-fast', quality: 'mock-quality' },
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
  mock: 'Mock',
  none: 'None',
};

export interface AIConfig {
  provider: ProviderId;
  configured: boolean;
  /** Why AI is unavailable (safe to show; never contains secrets). */
  reason: string | null;
  fastModel: string | null;
  qualityModel: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  checkTimeoutMs: number;
  writeTimeoutMs: number;
  rateLimitPerMin: number;
  mockLatencyMs: number;
  mockMode: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AIConfig {
  // Blank values (e.g. copied straight from .env.example) mean "not set".
  const cleaned = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v?.trim() ? v.trim() : undefined]));
  const e = EnvSchema.parse(cleaned);
  const requested = (e.INKWELL_AI_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const base = {
    checkTimeoutMs: e.INKWELL_AI_TIMEOUT_MS,
    writeTimeoutMs: e.INKWELL_AI_WRITE_TIMEOUT_MS,
    rateLimitPerMin: e.INKWELL_RATE_LIMIT_PER_MIN,
    mockLatencyMs: e.INKWELL_MOCK_LATENCY_MS,
    mockMode: e.INKWELL_MOCK_MODE ?? 'ok',
    baseUrl: e.INKWELL_AI_BASE_URL?.trim() || null,
  };
  const off = (provider: ProviderId, reason: string): AIConfig => ({
    ...base, provider, configured: false, reason, fastModel: null, qualityModel: null, apiKey: null,
  });

  if (!(PROVIDER_IDS as readonly string[]).includes(requested)) return off('none', `Unknown INKWELL_AI_PROVIDER "${requested}".`);
  const provider = requested as ProviderId;

  switch (provider) {
    case 'none':
      return off('none', 'AI is turned off (INKWELL_AI_PROVIDER=none).');
    case 'mock':
      return {
        ...base, provider, configured: true, reason: null, apiKey: null,
        fastModel: e.INKWELL_AI_FAST_MODEL ?? DEFAULT_MODELS.mock.fast,
        qualityModel: e.INKWELL_AI_QUALITY_MODEL ?? DEFAULT_MODELS.mock.quality,
      };
    case 'anthropic': {
      const key = e.ANTHROPIC_API_KEY?.trim();
      if (!key) return off('anthropic', 'ANTHROPIC_API_KEY is not set.');
      return {
        ...base, provider, configured: true, reason: null, apiKey: key,
        fastModel: e.INKWELL_AI_FAST_MODEL ?? DEFAULT_MODELS.anthropic.fast,
        qualityModel: e.INKWELL_AI_QUALITY_MODEL ?? DEFAULT_MODELS.anthropic.quality,
      };
    }
    case 'openai': {
      const key = e.OPENAI_API_KEY?.trim();
      if (!key) return off('openai', 'OPENAI_API_KEY is not set.');
      return {
        ...base, provider, configured: true, reason: null, apiKey: key,
        fastModel: e.INKWELL_AI_FAST_MODEL ?? DEFAULT_MODELS.openai.fast,
        qualityModel: e.INKWELL_AI_QUALITY_MODEL ?? DEFAULT_MODELS.openai.quality,
      };
    }
    case 'openai-compatible': {
      if (!base.baseUrl) return off(provider, 'INKWELL_AI_BASE_URL is not set.');
      if (!e.INKWELL_AI_FAST_MODEL) return off(provider, 'INKWELL_AI_FAST_MODEL is not set.');
      return {
        ...base, provider, configured: true, reason: null,
        apiKey: e.INKWELL_AI_API_KEY?.trim() || e.OPENAI_API_KEY?.trim() || null,
        fastModel: e.INKWELL_AI_FAST_MODEL,
        qualityModel: e.INKWELL_AI_QUALITY_MODEL ?? e.INKWELL_AI_FAST_MODEL,
      };
    }
  }
}
