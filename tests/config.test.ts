import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/server/ai/config';

describe('AI configuration', () => {
  it('defaults to Anthropic and reports a missing key calmly', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ provider: 'anthropic', configured: false, reason: 'ANTHROPIC_API_KEY is not set.' });
  });

  it('uses the documented Anthropic defaults, overridable per model', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: 'k' });
    expect(c).toMatchObject({ configured: true, fastModel: 'claude-haiku-4-5-20251001', qualityModel: 'claude-sonnet-5' });
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k', INKWELL_AI_FAST_MODEL: 'claude-x' }).fastModel).toBe('claude-x');
  });

  it('treats blank values (copied from .env.example) as unset', () => {
    const c = loadConfig({ INKWELL_AI_PROVIDER: '', INKWELL_AI_FAST_MODEL: '', ANTHROPIC_API_KEY: 'k', INKWELL_AI_TIMEOUT_MS: '' });
    expect(c).toMatchObject({ provider: 'anthropic', fastModel: 'claude-haiku-4-5-20251001', checkTimeoutMs: 8000 });
  });

  it('requires a base URL and model for openai-compatible', () => {
    expect(loadConfig({ INKWELL_AI_PROVIDER: 'openai-compatible' }).reason).toContain('INKWELL_AI_BASE_URL');
    const c = loadConfig({ INKWELL_AI_PROVIDER: 'openai-compatible', INKWELL_AI_BASE_URL: 'http://localhost:11434/v1', INKWELL_AI_FAST_MODEL: 'llama3.2' });
    expect(c).toMatchObject({ configured: true, apiKey: null, qualityModel: 'llama3.2' });
  });

  it('supports none and mock, and rejects unknown providers', () => {
    expect(loadConfig({ INKWELL_AI_PROVIDER: 'none' }).configured).toBe(false);
    expect(loadConfig({ INKWELL_AI_PROVIDER: 'mock' }).configured).toBe(true);
    expect(loadConfig({ INKWELL_AI_PROVIDER: 'skynet' })).toMatchObject({ configured: false, provider: 'none' });
  });
});
