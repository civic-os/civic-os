// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssembledContext } from '../providers/provider.js';
import type { SchemaConnectionConfig } from '../config.js';
import { readSchemaState } from './schema-reader.js';
import { detectFeatures, getRelevantSections } from './guide-sections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../../prompts');

/**
 * Assemble the full context for an LLM schema generation call.
 *
 * Components:
 * 1. System prompt (condensed Integrator Guide)
 * 2. Few-shot examples
 * 3. Current schema state (from PostgREST)
 * 4. Feature-specific guide sections (based on request keywords)
 * 5. Schema decisions (ADRs)
 */
export async function assembleContext(
  request: string,
  schemaConfig?: SchemaConnectionConfig,
): Promise<AssembledContext> {
  // Load system prompt
  const systemPrompt = await readFile(resolve(PROMPTS_DIR, 'system.md'), 'utf-8');

  // Load few-shot examples
  const exampleFiles = ['simple-entity.md', 'entity-with-status.md'];
  const fewShotExamples = await Promise.all(
    exampleFiles.map(f =>
      readFile(resolve(PROMPTS_DIR, 'examples', f), 'utf-8').catch(() => '')
    )
  ).then(results => results.filter(Boolean));

  // Detect features and load relevant guide sections
  const features = detectFeatures(request);
  const relevantGuideSections = await getRelevantSections(features);

  // Read current schema state from PostgREST (if configured)
  let schemaState = '';
  let schemaDecisions = '';

  if (schemaConfig) {
    try {
      const fullState = await readSchemaState(schemaConfig);
      // Split out decisions section if present
      const decisionsIdx = fullState.indexOf('### Recent Schema Decisions');
      if (decisionsIdx !== -1) {
        schemaState = fullState.substring(0, decisionsIdx).trim();
        schemaDecisions = fullState.substring(decisionsIdx).trim();
      } else {
        schemaState = fullState;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Could not read schema state: ${msg}`);
      console.warn('Proceeding without schema context (the LLM will generate from scratch).');
    }
  }

  return {
    systemPrompt,
    schemaState,
    fewShotExamples,
    relevantGuideSections,
    schemaDecisions,
  };
}
