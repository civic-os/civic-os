// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import Anthropic from '@anthropic-ai/sdk';
import { ProviderConfig, MODEL_PRICING } from '../config.js';
import { extractSQLBlocks } from '../output/sql-extractor.js';
import type {
  SchemaAssistantProvider, AssembledContext, LLMResponse,
  TokenUsage, CostEstimate,
} from './provider.js';

export class AnthropicProvider implements SchemaAssistantProvider {
  readonly name = 'anthropic' as const;
  readonly supportsPromptCaching = true;
  private client: Anthropic;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async generateSchema(context: AssembledContext, request: string): Promise<LLMResponse> {
    const systemContent = this.buildSystemContent(context);
    const userContent = this.buildUserContent(context, request);

    const start = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemContent,
      messages: [{ role: 'user', content: userContent }],
    });
    const latencyMs = Date.now() - start;

    const rawResponse = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as unknown as Record<string, number>).cache_read_input_tokens,
      cacheWriteTokens: (response.usage as unknown as Record<string, number>).cache_creation_input_tokens,
    };

    const sqlBlocks = extractSQLBlocks(rawResponse);

    // Extract reasoning (text before first SQL block)
    const firstBlockIndex = rawResponse.indexOf('-- [');
    const reasoning = firstBlockIndex > 0 ? rawResponse.substring(0, firstBlockIndex).trim() : '';

    return {
      rawResponse,
      sqlBlocks,
      reasoning,
      usage,
      latencyMs,
      model: this.model,
      cost: this.estimateCost(usage),
    };
  }

  estimateCost(usage: TokenUsage): CostEstimate {
    const pricing = MODEL_PRICING[this.model] ?? { input: 3 / 1e6, output: 15 / 1e6 };

    const inputCost = usage.inputTokens * pricing.input;
    const outputCost = usage.outputTokens * pricing.output;
    let cacheSavings = 0;

    if (usage.cacheReadTokens && pricing.cacheRead) {
      // Cache reads are cheaper than full input processing
      cacheSavings = usage.cacheReadTokens * (pricing.input - pricing.cacheRead);
    }

    return {
      inputCost,
      outputCost,
      cacheSavings: cacheSavings > 0 ? cacheSavings : undefined,
      totalCost: inputCost + outputCost - cacheSavings,
    };
  }

  private buildSystemContent(context: AssembledContext): string {
    const parts = [context.systemPrompt];

    if (context.fewShotExamples.length > 0) {
      parts.push('\n\n## Examples\n\n' + context.fewShotExamples.join('\n\n---\n\n'));
    }

    if (context.relevantGuideSections.length > 0) {
      parts.push('\n\n## Additional Reference\n\n' + context.relevantGuideSections.join('\n\n'));
    }

    return parts.join('');
  }

  private buildUserContent(context: AssembledContext, request: string): string {
    const parts: string[] = [];

    if (context.schemaState) {
      parts.push('## Current Schema State\n\n' + context.schemaState);
    }

    if (context.schemaDecisions) {
      parts.push('## Existing Schema Decisions\n\n' + context.schemaDecisions);
    }

    parts.push('## Request\n\n' + request);

    return parts.join('\n\n');
  }
}
