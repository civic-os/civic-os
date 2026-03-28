// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { ProviderConfig, ProviderName } from '../config.js';

/** Token usage from an LLM API call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt caching: tokens read from cache. */
  cacheReadTokens?: number;
  /** Anthropic prompt caching: tokens written to cache. */
  cacheWriteTokens?: number;
}

/** Cost estimate in USD. */
export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  cacheSavings?: number;
  totalCost: number;
}

/** Categorized SQL block extracted from LLM output. */
export interface CategorizedSQL {
  category: SQLCategory;
  sql: string;
  description: string;
  order: number;
}

export type SQLCategory =
  | 'ddl' | 'indexes' | 'status' | 'category' | 'metadata' | 'validations'
  | 'grants' | 'rls' | 'permissions' | 'functions' | 'triggers' | 'notify' | 'adr';

/** Complete response from an LLM generation call. */
export interface LLMResponse {
  rawResponse: string;
  sqlBlocks: CategorizedSQL[];
  reasoning: string;
  usage: TokenUsage;
  latencyMs: number;
  model: string;
  cost: CostEstimate;
}

/** Assembled context sent to the LLM. */
export interface AssembledContext {
  systemPrompt: string;
  schemaState: string;
  fewShotExamples: string[];
  relevantGuideSections: string[];
  schemaDecisions: string;
}

/** Interface all LLM providers must implement. */
export interface SchemaAssistantProvider {
  readonly name: ProviderName;
  readonly supportsPromptCaching: boolean;

  /** Generate schema SQL from assembled context and a user request. */
  generateSchema(context: AssembledContext, request: string): Promise<LLMResponse>;

  /** Calculate cost estimate from token usage. */
  estimateCost(usage: TokenUsage): CostEstimate;
}

/** Create a provider instance from config. */
export async function createProvider(config: ProviderConfig): Promise<SchemaAssistantProvider> {
  switch (config.provider) {
    case 'anthropic': {
      const { AnthropicProvider } = await import('./anthropic.js');
      return new AnthropicProvider(config);
    }
    case 'openai':
    case 'openrouter':
    case 'huggingface':
    case 'digitalocean': {
      const { OpenAICompatibleProvider } = await import('./openai.js');
      return new OpenAICompatibleProvider(config);
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
