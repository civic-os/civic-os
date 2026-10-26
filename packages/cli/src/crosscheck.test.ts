/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileWith } from '@civic-os/core';
import { parseSelect } from './embed.js';
import type { SelectItem } from './embed.js';
import { emitTypes } from './emit.js';
import { generatorName } from './generate.js';
import { fixtureSource, loadRawSchema } from './load.js';
import { buildModel, prepareContext } from './model.js';
import type { TypeNode } from './model.js';
import { buildCore, repoRoot, typecheck } from './test-support/typecheck.js';

/** A shape reduced to its field names, so the generated model and core's default select can be compared. */
type NameTree = [string, NameTree[]][];

const treeOfType = (t: TypeNode): NameTree => (t.fields ?? []).map(f => [f.name, treeOfType(f.type)]);
const treeOfSelect = (items: SelectItem[]): NameTree => items.map(i => [i.key, treeOfSelect(i.children ?? [])]);

const manifest = JSON.parse(readFileSync(join(repoRoot, 'tests', 'golden', 'raw', 'MANIFEST.json'), 'utf8')) as {
  examples: Record<string, unknown>;
};
const examples = Object.keys(manifest.examples).sort();
const dir = (example: string) => join(repoRoot, 'tests', 'golden', 'raw', example, 'testadmin');
const snapshot = (example: string) => join(repoRoot, 'tests', 'golden', 'codegen', `${example}.ts`);

describe.each(examples)('cross-check against the core default select: %s', example => {
  let raw: Awaited<ReturnType<typeof loadRawSchema>>;
  let model: ReturnType<typeof buildModel>;
  let ctx: ReturnType<typeof prepareContext>;

  beforeAll(async () => {
    raw = await loadRawSchema(fixtureSource(dir(example), repoRoot));
    model = buildModel(raw);
    ctx = prepareContext(raw);
  });

  it('Row keys equal the columns of compileWith(entity, {})', () => {
    for (const e of model.entities) {
      const top = parseSelect(compileWith(e.name, {}, ctx).select).map(i => i.key).sort();
      expect(e.row.map(c => c.name), e.name).toEqual(top);
    }
  });

  it('each Embedded field set equals the embed fields of the default select for that column', () => {
    for (const e of model.entities) {
      const items = parseSelect(compileWith(e.name, {}, ctx).select);
      const embeds = items.filter(i => i.children);
      expect(e.embedded.map(c => c.column).sort(), e.name).toEqual(embeds.map(i => i.key).sort());
      for (const col of e.embedded) {
        const own = parseSelect(compileWith(e.name, { select: [col.column] }, ctx).select);
        expect(own, `${e.name}.${col.column}`).toHaveLength(1);
        expect(treeOfType(col.type), `${e.name}.${col.column}`).toEqual(treeOfSelect(own[0]!.children!));
        expect(treeOfType(col.type), `${e.name}.${col.column}`).toEqual(treeOfSelect(embeds.find(i => i.key === col.column)!.children!));
      }
    }
  });

  it('every Relations key compiles under with', () => {
    for (const e of model.entities) {
      for (const rel of e.relations) {
        expect(() => compileWith(e.name, { with: { [rel.key]: true } }, ctx), `${e.name}.${rel.key}`).not.toThrow();
        expect(model.entities.some(t => t.name === rel.target), `${e.name}.${rel.key} -> ${rel.target}`).toBe(true);
      }
    }
  });

  it('the committed snapshot is what the generator emits', () => {
    expect(readFileSync(snapshot(example), 'utf8')).toBe(emitTypes(model, generatorName()));
  });
});

describe('the eight snapshots type-check', () => {
  beforeAll(() => buildCore(), 120_000);

  it.each([false, true])('exactOptionalPropertyTypes %s', exact => {
    const files: Record<string, string> = {};
    for (const example of examples) {
      files[`${example}.ts`] = readFileSync(snapshot(example), 'utf8');
      files[`${example}.check.ts`] = [
        `import type { DatabaseShape } from '@civic-os/core';`,
        `import type { Database } from './${example}.js';`,
        `type Satisfies = Database extends DatabaseShape ? true : never;`,
        `export const satisfies: Satisfies = true;`,
        '',
      ].join('\n');
    }
    const r = typecheck(files, exact);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  }, 120_000);
});
