import 'server-only';
import type { AIConfig } from '../config';
import { createAnthropicProvider } from './anthropic';
import { createMockProvider } from './mock';
import { createOpenAIProvider } from './openai';
import type { AIProvider } from './types';

let cached: { key: string; provider: AIProvider } | null = null;

/** Returns the configured provider adapter, or null when AI is not configured. */
export function getProvider(config: AIConfig): AIProvider | null {
  if (!config.configured) return null;
  const key = [config.provider, config.baseUrl, config.apiKey?.length, config.mockLatencyMs, config.mockMode].join('|');
  if (cached?.key === key) return cached.provider;
  let provider: AIProvider | null = null;
  switch (config.provider) {
    case 'anthropic':
      provider = createAnthropicProvider({ apiKey: config.apiKey!, baseURL: config.baseUrl });
      break;
    case 'openai':
      provider = createOpenAIProvider({ apiKey: config.apiKey, baseURL: config.baseUrl ?? 'https://api.openai.com/v1', compatible: false });
      break;
    case 'openai-compatible':
      provider = createOpenAIProvider({ apiKey: config.apiKey, baseURL: config.baseUrl!, compatible: true });
      break;
    case 'mock':
      provider = createMockProvider({ latencyMs: config.mockLatencyMs, mode: config.mockMode });
      break;
    case 'none':
      provider = null;
  }
  if (provider) cached = { key, provider };
  return provider;
}
