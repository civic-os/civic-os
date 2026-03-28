// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

/** Provider configuration for LLM API access. */
export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export type ProviderName = 'anthropic' | 'openai' | 'openrouter' | 'huggingface' | 'digitalocean';

/** Per-token pricing in USD. Indexed by model ID. */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  // Anthropic
  'claude-sonnet-4-20250514': { input: 3 / 1e6, output: 15 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 },
  'claude-opus-4-20250514':   { input: 15 / 1e6, output: 75 / 1e6, cacheRead: 1.5 / 1e6, cacheWrite: 18.75 / 1e6 },
  'claude-haiku-4-5-20251001': { input: 0.8 / 1e6, output: 4 / 1e6, cacheRead: 0.08 / 1e6, cacheWrite: 1 / 1e6 },
  // OpenAI
  'gpt-4o':       { input: 2.5 / 1e6, output: 10 / 1e6 },
  'gpt-4.1':      { input: 2 / 1e6, output: 8 / 1e6 },
  'o3-mini':      { input: 1.1 / 1e6, output: 4.4 / 1e6 },
  // OpenRouter (approximate — OR returns actual cost in headers)
  'deepseek/deepseek-chat-v3-0324': { input: 0.27 / 1e6, output: 1.10 / 1e6 },
  'qwen/qwen3-235b-a22b':          { input: 0.14 / 1e6, output: 0.54 / 1e6 },
};

/** Connection config for reading schema state. */
export interface SchemaConnectionConfig {
  postgrestUrl: string;
  /** Optional JWT for authenticated access (needed for RLS policy introspection). */
  jwt?: string;
}

/** Resolve provider config from CLI args + environment variables. */
export function resolveProviderConfig(opts: {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}): ProviderConfig {
  const envKeyMap: Record<ProviderName, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    huggingface: 'HF_API_KEY',
    digitalocean: 'DO_API_KEY',
  };

  const baseUrlMap: Record<ProviderName, string | undefined> = {
    anthropic: undefined,
    openai: undefined,
    openrouter: 'https://openrouter.ai/api/v1',
    huggingface: 'https://api-inference.huggingface.co/v1',
    digitalocean: 'https://inference.do-ai.run/v1',
  };

  return {
    provider: opts.provider,
    model: opts.model,
    apiKey: opts.apiKey || process.env[envKeyMap[opts.provider]],
    baseUrl: opts.baseUrl || baseUrlMap[opts.provider],
  };
}
