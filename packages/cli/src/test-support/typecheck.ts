/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

export const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

function runTsc(args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(process.execPath, [tsc, ...args], { encoding: 'utf8', cwd: repoRoot });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

/** Build core's declarations, which the type check resolves `@civic-os/core` to. Incremental. */
export function buildCore(): void {
  const r = runTsc(['-b', join(repoRoot, 'packages', 'core')]);
  if (!r.ok) throw new Error(`building @civic-os/core failed:\n${r.output}`);
}

/**
 * Type-check `files` (name to text) together in a temp directory: strict, NodeNext, `@civic-os/core`
 * mapped to its built declarations. `exact` turns on exactOptionalPropertyTypes, the way core's own type
 * tests run both settings.
 */
export function typecheck(files: Record<string, string>, exact: boolean): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'civic-os-typecheck-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: exact,
      noEmit: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      lib: ['ES2022'],
      types: [],
      skipLibCheck: true,
      paths: { '@civic-os/core': [join(repoRoot, 'packages', 'core', 'dist', 'index.d.ts')] },
    },
    include: Object.keys(files),
  }));
  return runTsc(['-p', join(dir, 'tsconfig.json')]);
}

/** The usage file every generated `database.ts` must support, written against `./database.js`. */
export function usageFile(entity: string, column: string): string {
  return `import { defineQuery } from '@civic-os/core';
import type { DatabaseShape, EmbeddedOf, InsertOf, QueryResult, RowOf, UpdateOf } from '@civic-os/core';
import type { Database } from './database.js';

type Satisfies = Database extends DatabaseShape ? true : never;
export const satisfies: Satisfies = true;

export type Row = RowOf<Database, ${JSON.stringify(entity)}>;
export type Insert = InsertOf<Database, ${JSON.stringify(entity)}>;
export type Update = UpdateOf<Database, ${JSON.stringify(entity)}>;
export type Embedded = EmbeddedOf<Database, ${JSON.stringify(entity)}>;

const q = defineQuery<Database, ${JSON.stringify(entity)}>()({ select: [${JSON.stringify(column)}] });
export type Result = QueryResult<Database, ${JSON.stringify(entity)}, typeof q>;
export declare const result: Result;

// @ts-expect-error an unknown column is a compile error
defineQuery<Database, ${JSON.stringify(entity)}>()({ select: ['no_such_column'] });
`;
}
