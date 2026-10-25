/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { emitTypes } from './emit.js';
import { loadRawSchema } from './load.js';
import type { SchemaSource } from './load.js';
import { buildModel } from './model.js';
import type { CodegenModel } from './model.js';

/**
 * The generator's name and version, as the file header prints it.
 *
 * @consumer tooling
 */
export function generatorName(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
  return `${manifest.name} ${manifest.version}`;
}

/**
 * Read the views from `source` and generate the types file. Returns the structured model next to the text.
 *
 * @consumer tooling
 */
export async function generateTypes(source: SchemaSource): Promise<{ text: string; model: CodegenModel }> {
  const model = buildModel(await loadRawSchema(source));
  return { text: emitTypes(model, generatorName()), model };
}
