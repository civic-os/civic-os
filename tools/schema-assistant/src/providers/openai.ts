// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import OpenAI from 'openai';
import { ProviderConfig, ProviderName, MODEL_PRICING } from '../config.js';
import { extractSQLBlocks, stripThinkingTags } from '../output/sql-extractor.js';
import type {
  SchemaAssistantProvider, AssembledContext, LLMResponse,
  TokenUsage, CostEstimate,
} from './provider.js';

/**
 * OpenAI-compatible provider. Works with OpenAI, OpenRouter, and HuggingFace
 * Inference APIs since they all implement the same chat completions interface.
 */
export class OpenAICompatibleProvider implements SchemaAssistantProvider {
  readonly name: ProviderName;
  readonly supportsPromptCaching = false;
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.name = config.provider;
    this.model = config.model;

    const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: config.apiKey };
    if (config.baseUrl) {
      clientOpts.baseURL = config.baseUrl;
    }
    // OpenRouter requires site identification headers
    if (config.provider === 'openrouter') {
      clientOpts.defaultHeaders = {
        'HTTP-Referer': 'https://civic-os.org',
        'X-Title': 'Civic OS Schema Assistant',
      };
    }
    this.client = new OpenAI(clientOpts);
  }

  async generateSchema(context: AssembledContext, request: string): Promise<LLMResponse> {
    const systemMessage = this.buildSystemMessage(context);
    const userMessage = this.buildUserMessage(context, request);

    const start = Date.now();
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
    });
    const latencyMs = Date.now() - start;

    const rawResponse = response.choices[0]?.message?.content ?? '';

    const usage: TokenUsage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };

    // Strip thinking tags and markdown fences
    const { cleaned, thinking } = stripThinkingTags(rawResponse);
    const sqlBlocks = extractSQLBlocks(cleaned);

    const firstBlockIndex = cleaned.indexOf('-- [');
    const preamble = firstBlockIndex > 0 ? cleaned.substring(0, firstBlockIndex).trim() : '';
    const reasoning = [thinking, preamble].filter(Boolean).join('\n\n');

    // OpenRouter provides cost in custom header — but the SDK response object
    // doesn't expose headers directly. Fall back to estimated cost.
    const cost = this.estimateCostFromResponse(response, usage);

    return {
      rawResponse,
      sqlBlocks,
      reasoning,
      usage,
      latencyMs,
      model: this.model,
      cost,
    };
  }

  estimateCost(usage: TokenUsage): CostEstimate {
    const pricing = MODEL_PRICING[this.model] ?? { input: 5 / 1e6, output: 15 / 1e6 };
    const inputCost = usage.inputTokens * pricing.input;
    const outputCost = usage.outputTokens * pricing.output;
    return { inputCost, outputCost, totalCost: inputCost + outputCost };
  }

  private estimateCostFromResponse(
    response: OpenAI.Chat.Completions.ChatCompletion,
    usage: TokenUsage
  ): CostEstimate {
    // OpenRouter includes cost in response metadata when available
    const orCost = (response as unknown as Record<string, unknown>)['x_openrouter'] as { total_cost?: number } | undefined;
    if (orCost?.total_cost != null) {
      return {
        inputCost: 0,
        outputCost: 0,
        totalCost: orCost.total_cost,
      };
    }
    return this.estimateCost(usage);
  }

  private buildSystemMessage(context: AssembledContext): string {
    const parts = [context.systemPrompt];
    if (context.fewShotExamples.length > 0) {
      parts.push('\n\n## Examples\n\n' + context.fewShotExamples.join('\n\n---\n\n'));
    }
    if (context.relevantGuideSections.length > 0) {
      parts.push('\n\n## Additional Reference\n\n' + context.relevantGuideSections.join('\n\n'));
    }
    return parts.join('');
  }

  private buildUserMessage(context: AssembledContext, request: string): string {
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
