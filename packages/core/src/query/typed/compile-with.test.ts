/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { M2mPropertyMetadata, SchemaEntityProperty, SchemaEntityTable } from '../../model/index.js';
import { getPropertyType } from '../../schema/property-type.js';
import { enrichPropertiesWithManyToMany } from '../../schema/relations.js';
import { propertyToSelectString } from '../../schema/select.js';
import { QueryValidationError } from '../encode.js';
import { compileWith } from './compile-with.js';
import { relationGraph } from './graph.js';
import type { WithSchemaContext } from './compile-with.js';
import { defineQuery } from './define.js';

// The pothole raw captures, interpreted the way the MCP schema cache does. Core has no Node types and may not
// import outside its package, so the captures come in through Vite's glob (typed by hand; the call must stay a
// literal `import.meta.glob(` for Vite to rewrite it).
const captures: Record<string, unknown> =
  // @ts-expect-error `glob` is a Vite extension of ImportMeta that core's lib set does not declare
  import.meta.glob('../../../../../tests/golden/raw/pothole/testadmin/schema_*.json', { eager: true, import: 'default' });
const raw = <T>(name: string): T[] => {
  const key = Object.keys(captures).find(k => k.endsWith(`/${name}`));
  if (!key) throw new Error(`missing capture ${name}`);
  return JSON.parse(JSON.stringify(captures[key])) as T[]; // a copy: getPropertyType result is assigned onto the rows
};

function loadPothole(): WithSchemaContext {
  const tables = raw<SchemaEntityTable>('schema_entities.json');
  const rows = raw<SchemaEntityProperty>('schema_properties.json');
  for (const p of rows) p.type = getPropertyType(p);
  const properties = enrichPropertiesWithManyToMany(rows, tables, raw<M2mPropertyMetadata>('schema_m2m_properties.json'));
  return { properties, tables };
}

const pothole = loadPothole();

/** The golden select for the Issue detail page: the M:M embed string recorded in data.queries.json. */
const queries: Record<string, { entities: Record<string, { named: Record<string, string[]> }> }> =
  // @ts-expect-error as above
  import.meta.glob('../../../../../tests/golden/derived/frontend/pothole/_example/data.queries.json', { eager: true, import: 'default' });
const GOLDEN_ISSUE_TAGS = Object.values(queries)[0]!.entities['Issue']!.named['detail']!.find(s => s.startsWith('issue_tags_m2m:'))!;

describe('compileWith (pothole fixtures)', () => {
  it('with: { issue_tags_m2m: true } is exactly the golden M:M embed', () => {
    const r = compileWith('Issue', { select: [], with: { issue_tags_m2m: true } }, pothole);
    expect(r).toEqual({ select: GOLDEN_ISSUE_TAGS, params: [] });
  });

  it('the golden embed is what propertyToSelectString returns for the property', () => {
    const prop = pothole.properties.find(p => p.table_name === 'Issue' && p.column_name === 'issue_tags_m2m')!;
    expect(propertyToSelectString(prop)).toBe(GOLDEN_ISSUE_TAGS);
  });

  it('plainly selected columns use their default shapes (FK, status, user)', () => {
    const r = compileWith('Issue', { select: ['id', 'display_name', 'status', 'created_user', 'work_package', 'location'] }, pothole);
    expect(r.select).toBe([
      'id',
      'display_name',
      'status:statuses!status(id,display_name,color,status_key)',
      'created_user:civic_os_users!created_user(id,display_name,full_name,phone,email)',
      'work_package:WorkPackage!work_package(id,display_name)',
      'location:location_text',
    ].join(','));
  });

  it('with wins over a same-named FK in select', () => {
    const r = compileWith('Issue', { select: ['id', 'work_package'], with: { work_package: { columns: ['id', 'cost'] } } }, pothole);
    expect(r.select).toBe('id,work_package:WorkPackage!work_package(id,cost)');
  });

  it('nests two levels: FK, then an inverse and a status on the target', () => {
    const r = compileWith('Issue', {
      select: ['id'],
      with: { work_package: { columns: ['id', 'display_name'], with: { status: true, Bid: { columns: ['id'] } } } },
    }, pothole);
    expect(r.select).toBe(
      'id,work_package:WorkPackage!work_package(id,display_name,'
      + 'status:statuses!status(id,display_name,color,status_key),'
      + 'Bid!work_package(id))',
    );
    expect(r.params).toEqual([]);
  });

  it('limit and order are per-embed query parameters addressed by the alias path', () => {
    const r = compileWith('Issue', {
      select: ['id'],
      with: {
        work_package: {
          columns: ['id'],
          limit: 1,
          with: { Bid: { columns: ['id', 'total_cost'], limit: 5, order: { column: 'total_cost', direction: 'desc' } } },
        },
      },
    }, pothole);
    expect(r.select).toBe('id,work_package:WorkPackage!work_package(id,Bid!work_package(id,total_cost))');
    expect(r.params).toEqual(['work_package.Bid.order=total_cost.desc', 'work_package.Bid.limit=5', 'work_package.limit=1']);
  });

  it('a many-to-many with columns and a limit rebuilds the junction embed around the chosen fields', () => {
    const r = compileWith('Issue', { select: ['id'], with: { issue_tags_m2m: { columns: ['display_name'], limit: 3 } } }, pothole);
    expect(r.select).toBe('id,issue_tags_m2m:issue_tags!issue_id(Tag!tag_id(display_name))');
    expect(r.params).toEqual(['issue_tags_m2m.limit=3']);
  });

  it('no select embeds every column and keeps M:M out of the default row', () => {
    const r = compileWith('Tag', {}, pothole);
    expect(r.select.split(',')).not.toContain('issue_tags_m2m');
    expect(r.select).toContain('display_name');
  });

  it('the default select leaves out the tsvector search column, and it is not a selectable column', () => {
    expect(pothole.properties.some(p => p.table_name === 'Issue' && p.column_name === 'civic_os_text_search')).toBe(true);
    expect(compileWith('Issue', {}, pothole).select.split(',')).not.toContain('civic_os_text_search');
    expect(() => compileWith('Issue', { select: ['civic_os_text_search'] }, pothole)).toThrow(QueryValidationError);
  });

  it('relationGraph names exactly the relations `with` accepts', () => {
    const graph = relationGraph(pothole, 'Issue');
    expect([...graph.keys()].sort()).toEqual(['WorkDetail', 'created_user', 'issue_tags_m2m', 'photo', 'photos', 'status', 'work_package']);
    for (const key of graph.keys()) expect(() => compileWith('Issue', { select: ['id'], with: { [key]: true } }, pothole)).not.toThrow();
  });

  it('is deterministic and does not mutate its input', () => {
    const q = Object.freeze({ select: Object.freeze(['id']), with: Object.freeze({ issue_tags_m2m: true as const }) });
    expect(compileWith('Issue', q, pothole)).toEqual(compileWith('Issue', q, pothole));
  });

  it('skips a relation whose value is undefined', () => {
    expect(compileWith('Issue', { select: ['id'], with: { issue_tags_m2m: undefined } }, pothole).select).toBe('id');
  });

  it.each([
    ['unknown entity', () => compileWith('Nope', {}, pothole)],
    ['unknown column', () => compileWith('Issue', { select: ['nope'] }, pothole)],
    ['unknown relation', () => compileWith('Issue', { with: { nope: true } }, pothole)],
    ['unknown nested column', () => compileWith('Issue', { with: { work_package: { columns: ['nope'] } } }, pothole)],
    ['unknown order column', () => compileWith('Issue', { with: { work_package: { order: { column: 'nope', direction: 'asc' } } } }, pothole)],
    ['bad direction', () => compileWith('Issue', { with: { work_package: { order: { column: 'id', direction: 'up' as 'asc' } } } }, pothole)],
    ['negative limit', () => compileWith('Issue', { with: { work_package: { limit: -1 } } }, pothole)],
    ['fractional limit', () => compileWith('Issue', { with: { work_package: { limit: 1.5 } } }, pothole)],
    ['options on a system embed', () => compileWith('Issue', { with: { status: { columns: ['id'] } } }, pothole)],
    ['order on a many-to-many', () => compileWith('Issue', { with: { issue_tags_m2m: { order: { column: 'id', direction: 'asc' } } } }, pothole)],
  ])('rejects %s', (_name, run) => {
    expect(run).toThrow(QueryValidationError);
  });
});

describe('compileWith (synthetic schema)', () => {
  const col = (table: string, column: string, extra: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty => ({
    table_catalog: 'db', table_schema: 'public', table_name: table, column_name: column, display_name: column,
    sort_order: 0, column_default: '', is_nullable: true, data_type: 'integer', character_maximum_length: 0,
    udt_schema: 'pg_catalog', udt_name: 'int4', is_self_referencing: false, is_identity: false, is_generated: false,
    is_updatable: true, join_schema: undefined as never, join_table: undefined as never, join_column: undefined as never,
    geography_type: '', type: undefined as never, ...extra,
  });
  const fk = (table: string, column: string, to: string) => col(table, column, { join_schema: 'public', join_table: to, join_column: 'id' });
  const table = (name: string) => ({ table_name: name, display_name: name } as SchemaEntityTable);

  const rows = [
    col('Trip', 'id'), col('Trip', 'display_name'), fk('Trip', 'origin', 'Place'), fk('Trip', 'destination', 'Place'),
    col('Place', 'id'), col('Place', 'display_name'),
  ];
  for (const r of rows) r.type = getPropertyType(r);
  const ctx: WithSchemaContext = { properties: rows, tables: [table('Trip'), table('Place')] };

  it('two FKs to the same table each carry their own !column hint', () => {
    const r = compileWith('Trip', { select: ['id'], with: { origin: { columns: ['display_name'] }, destination: true } }, ctx);
    expect(r.select).toBe('id,origin:Place!origin(display_name),destination:Place!destination(id,display_name)');
  });

  it('a plain select of both FKs matches propertyToSelectString for each', () => {
    const r = compileWith('Trip', { select: ['origin', 'destination'] }, ctx);
    expect(r.select).toBe('origin:Place!origin(id,display_name),destination:Place!destination(id,display_name)');
  });

  it('inverse relations come from core and are named by the source table', () => {
    const r = compileWith('Place', { select: ['id'], with: { Trip: { columns: ['id'], limit: 2 } } }, ctx);
    expect(r.select).toBe('id,Trip!origin(id)');
    expect(r.params).toEqual(['Trip.limit=2']);
  });
});

describe('defineQuery', () => {
  type None = Record<never, never>;
  interface Db {
    entities: { A: { Row: { id: number }; Insert: None; Update: None; Embedded: None; Relations: None } };
  }

  it('returns its argument unchanged', () => {
    const q = { select: ['id'] } as const;
    expect(defineQuery<Db, 'A'>()(q)).toBe(q);
  });
});
