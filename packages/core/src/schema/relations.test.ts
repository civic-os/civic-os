/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/index.js';
import type { M2mPropertyMetadata, SchemaEntityProperty, SchemaEntityTable } from '../model/index.js';
import {
  detectJunctionTables,
  detectParentHops,
  displayNameForTable,
  enrichPropertiesWithManyToMany,
  getJunctionTableNamesFromProperties,
  inverseRelationships,
} from './relations.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function prop(table_name: string, column_name: string, over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty {
  return {
    table_catalog: '', table_schema: 'public', table_name, column_name, display_name: column_name,
    sort_order: 0, column_default: '', is_nullable: true, data_type: 'text',
    character_maximum_length: 0, udt_schema: 'pg_catalog', udt_name: 'text',
    is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true,
    join_schema: '', join_table: '', join_column: '', geography_type: '',
    type: EntityPropertyType.TextShort,
    ...over,
  } as SchemaEntityProperty;
}

const fk = (table_name: string, column_name: string, join_table: string, over: Partial<SchemaEntityProperty> = {}) =>
  prop(table_name, column_name, {
    type: EntityPropertyType.ForeignKeyName, join_schema: 'public', join_table, join_column: 'id',
    udt_name: 'int4', ...over,
  });

const tbl = (table_name: string, display_name = table_name.toUpperCase(), over: Partial<SchemaEntityTable> = {}) =>
  ({ table_name, display_name, ...over }) as SchemaEntityTable;

// issues <-> tags through issue_tags (tags has color); owners has display_name; plain junction.
const baseTables = [tbl('issues', 'Issues'), tbl('tags', 'Tags'), tbl('issue_tags', 'Issue Tags'), tbl('owners', 'Owners')];
const baseProps = [
  prop('issues', 'id'), prop('issues', 'display_name'), fk('issues', 'owner_id', 'owners'),
  prop('tags', 'id'), prop('tags', 'display_name'), prop('tags', 'color'),
  prop('owners', 'id'), prop('owners', 'display_name'),
  fk('issue_tags', 'issue_id', 'issues'), fk('issue_tags', 'tag_id', 'tags'),
  prop('issue_tags', 'id'), prop('issue_tags', 'created_at'),
];

describe('displayNameForTable', () => {
  it('uses display_name, falling back to the table name', () => {
    const tables = deepFreeze([tbl('a', 'Alpha'), tbl('b', '')]);
    expect(displayNameForTable(tables, 'a')).toBe('Alpha');
    expect(displayNameForTable(tables, 'b')).toBe('b');
    expect(displayNameForTable(tables, 'zzz')).toBe('zzz');
    expect(displayNameForTable(undefined, 'zzz')).toBe('zzz');
  });
});

describe('detectJunctionTables', () => {
  it('detects a plain junction in both directions with relatedTableHasColor', () => {
    const props = deepFreeze(baseProps.map(p => ({ ...p })));
    const tables = deepFreeze(baseTables.map(t => ({ ...t })));
    const j = detectJunctionTables(tables, props);
    expect([...j.keys()].sort()).toEqual(['issues', 'tags']);
    const [m1] = j.get('issues')!;
    expect(m1).toEqual({
      junctionTable: 'issue_tags', sourceTable: 'issues', targetTable: 'tags',
      sourceColumn: 'issue_id', targetColumn: 'tag_id', relatedTable: 'tags',
      relatedTableDisplayName: 'Tags', showOnSource: true, showOnTarget: true,
      displayOrder: 100, relatedTableHasColor: true, extraColumns: [],
    });
    const [m2] = j.get('tags')!;
    expect(m2.targetTable).toBe('issues');
    expect(m2.relatedTableHasColor).toBe(false);
    expect(m2.relatedTableDisplayName).toBe('Issues');
  });

  it('uses the table list passed in for display names', () => {
    const j = detectJunctionTables([...baseTables.filter(t => t.table_name !== 'tags'), tbl('tags', 'Labels')], baseProps);
    expect(j.get('issues')![0].relatedTableDisplayName).toBe('Labels');
    expect(detectJunctionTables(baseTables.filter(t => t.table_name === 'issue_tags'), baseProps).get('issues')![0].relatedTableDisplayName).toBe('tags');
  });

  it('rejects tables without exactly two public FKs', () => {
    const one = [fk('j', 'a_id', 'issues'), prop('j', 'id')];
    const three = [fk('j', 'a_id', 'issues'), fk('j', 'b_id', 'tags'), fk('j', 'c_id', 'owners')];
    const nonPublic = [fk('j', 'a_id', 'issues'), fk('j', 'b_id', 'tags', { join_schema: 'metadata' })];
    for (const extra of [one, three, nonPublic]) {
      expect(detectJunctionTables([tbl('j')], [...baseProps, ...extra]).size).toBe(0);
    }
  });

  it('User FKs count as FKs; extra columns disqualify unless the table is a rich junction', () => {
    const userFk = prop('j', 'user_id', { type: EntityPropertyType.User, join_schema: 'public', join_table: 'civic_os_users' });
    const withExtra = [...baseProps, fk('j', 'issue_id', 'issues'), userFk, prop('j', 'qty', { sort_order: 1 })];
    expect(detectJunctionTables([tbl('j')], withExtra).size).toBe(0);
    const rich = detectJunctionTables([tbl('j', 'J', { is_rich_junction: true })], withExtra);
    // civic_os_users lacks display_name here: only issues -> ... direction can't hop, issue side lacks nothing
    expect([...rich.keys()]).toEqual(['civic_os_users']);
    expect(rich.get('civic_os_users')![0].extraColumns.map(c => c.column_name)).toEqual(['qty']);
  });

  it('rich junction extra columns exclude those hidden from both create and edit', () => {
    const props = [
      ...baseProps.filter(p => p.table_name !== 'issue_tags'),
      fk('issue_tags', 'issue_id', 'issues'), fk('issue_tags', 'tag_id', 'tags'),
      prop('issue_tags', 'qty'), prop('issue_tags', 'token', { show_on_create: false, show_on_edit: false }),
      prop('issue_tags', 'half', { show_on_create: false }),
    ];
    const tables = baseTables.map(t => t.table_name === 'issue_tags' ? tbl('issue_tags', 'IT', { is_rich_junction: true }) : t);
    const j = detectJunctionTables(tables, props);
    expect(j.get('issues')![0].extraColumns.map(c => c.column_name)).toEqual(['qty', 'half']);
    expect(j.get('tags')![0].extraColumns.map(c => c.column_name)).toEqual(['qty', 'half']);
  });

  it('a non-rich junction without extra columns ignores a stray is_rich_junction flag', () => {
    const tables = baseTables.map(t => t.table_name === 'issue_tags' ? tbl('issue_tags', 'IT', { is_rich_junction: true }) : t);
    expect(detectJunctionTables(tables, baseProps).get('issues')![0].extraColumns).toEqual([]);
  });

  it('skips a direction whose related table has no display_name and cannot hop', () => {
    const props = baseProps.filter(p => !(p.table_name === 'tags' && p.column_name === 'display_name'));
    const j = detectJunctionTables(baseTables, props);
    expect(j.has('issues')).toBe(false);
    expect(j.get('tags')).toHaveLength(1);
  });

  it('hops through an intermediate table to a displayable parent (both directions)', () => {
    // junction links issues <-> room_slots; room_slots lacks display_name, has FK to rooms (display_name)
    const props = [
      prop('issues', 'display_name'),
      prop('rooms', 'display_name'), prop('rooms', 'color'),
      prop('room_slots', 'id'), fk('room_slots', 'room_id', 'rooms'),
      fk('issue_slots', 'issue_id', 'issues'), fk('issue_slots', 'slot_id', 'room_slots'),
    ];
    const tables = [tbl('issues', 'Issues'), tbl('rooms', 'Rooms'), tbl('room_slots', 'Slots'), tbl('issue_slots', 'IS')];
    const j = detectJunctionTables(tables, props);
    const [m] = j.get('issues')!;
    expect(m).toMatchObject({
      sourceTable: 'issues', targetTable: 'room_slots', relatedTable: 'rooms', relatedTableDisplayName: 'Rooms',
      relatedTableHasColor: true, extraColumns: [], parentHops: [{ table: 'rooms', fkColumn: 'room_id' }],
    });
    // reverse direction: slots -> issues; issues has display_name so plain
    expect(j.get('room_slots')![0]).toMatchObject({ relatedTable: 'issues' });
    expect(j.get('room_slots')![0].parentHops).toBeUndefined();

    // mirrored: the lacking side is fk1 (hop in direction 2)
    const mirrored = props.map(p => p.table_name === 'issue_slots'
      ? (p.column_name === 'issue_id' ? fk('issue_slots', 'slot_id', 'room_slots') : fk('issue_slots', 'issue_id', 'issues'))
      : p);
    const jm = detectJunctionTables(tables, mirrored);
    expect(jm.get('issues')![0].parentHops).toEqual([{ table: 'rooms', fkColumn: 'room_id' }]);
  });
});

describe('detectParentHops', () => {
  const props = deepFreeze([
    prop('rooms', 'display_name'), prop('buildings', 'display_name'), prop('plain', 'id'),
    fk('mid', 'room_id', 'rooms'), fk('mid', 'plain_id', 'plain'), fk('mid', 'back', 'junc'),
    fk('mid', 'st', 'statuses'), prop('mid', 'x'),
  ]);

  it('returns the single unambiguous displayable parent', () => {
    expect(detectParentHops('mid', 'junc', props)).toEqual({
      hops: [{ table: 'rooms', fkColumn: 'room_id' }], finalTable: 'rooms',
    });
  });

  it('returns null for zero or multiple candidates', () => {
    expect(detectParentHops('none', 'junc', props)).toBeNull();
    const two = [...props, fk('mid', 'bldg', 'buildings')];
    expect(detectParentHops('mid', 'junc', two)).toBeNull();
  });

  it('excludes the junction itself, system tables and non-public/non-FK types', () => {
    const only = [
      prop('junc', 'display_name'), prop('statuses', 'display_name'),
      fk('mid', 'back', 'junc'), fk('mid', 'st', 'statuses'),
      fk('mid', 'meta', 'rooms', { join_schema: 'metadata' }), prop('rooms', 'display_name'),
      prop('mid', 'text', { join_table: 'rooms', join_schema: 'public' }),
    ];
    expect(detectParentHops('mid', 'junc', only)).toBeNull();
  });

  it('accepts User-typed FKs', () => {
    const p = [
      prop('people', 'display_name'),
      prop('mid', 'p', { type: EntityPropertyType.User, join_schema: 'public', join_table: 'people' }),
    ];
    expect(detectParentHops('mid', 'junc', p)?.finalTable).toBe('people');
  });
});

describe('getJunctionTableNamesFromProperties', () => {
  it('collects junction names of M:M properties only', () => {
    const m = prop('a', 'x_m2m', {
      type: EntityPropertyType.ManyToMany,
      many_to_many_meta: { junctionTable: 'jx' } as never,
    });
    const noMeta = prop('a', 'y_m2m', { type: EntityPropertyType.ManyToMany });
    expect([...getJunctionTableNamesFromProperties(deepFreeze([m, noMeta, prop('a', 'z')]))]).toEqual(['jx']);
  });
});

describe('enrichPropertiesWithManyToMany', () => {
  it('appends virtual M:M properties and does not mutate the inputs', () => {
    const props = deepFreeze(baseProps.map(p => ({ ...p })));
    const tables = deepFreeze(baseTables.map(t => ({ ...t })));
    const out = enrichPropertiesWithManyToMany(props, tables);
    expect(out).not.toBe(props);
    expect(out.slice(0, props.length)).toEqual(props);
    const added = out.slice(props.length);
    expect(added.map(p => `${p.table_name}.${p.column_name}`)).toEqual(['issues.issue_tags_m2m', 'tags.issue_tags_m2m']);
    expect(added[0]).toMatchObject({
      type: EntityPropertyType.ManyToMany, display_name: 'Tags', sort_order: 100, column_width: 2,
      sortable: false, filterable: false, is_nullable: true, udt_name: 'many_to_many',
      show_on_list: false, show_on_create: true, show_on_edit: true, show_on_detail: true,
      fk_search_modal: false, show_inline: false, description: 'Many-to-many relationship via issue_tags',
    });
    expect(added[0].many_to_many_meta?.junctionTable).toBe('issue_tags');
  });

  it('applies metadata overrides keyed by source table and column', () => {
    const meta: M2mPropertyMetadata[] = deepFreeze([{
      table_name: 'issues', column_name: 'issue_tags_m2m', display_name: 'Labels', sort_order: 7,
      column_width: 1, show_on_create: false, show_on_edit: false, show_on_detail: false,
      options_source_rpc: 'rpc', depends_on_columns: ['owner_id'], fk_search_modal: true,
      show_inline: true, options_filter_column: 'active',
    } as unknown as M2mPropertyMetadata]);
    const out = enrichPropertiesWithManyToMany(baseProps, baseTables, meta);
    const v = out.find(p => p.table_name === 'issues' && p.column_name === 'issue_tags_m2m')!;
    expect(v).toMatchObject({
      display_name: 'Labels', sort_order: 7, column_width: 1, show_on_create: false, show_on_edit: false,
      show_on_detail: false, options_source_rpc: 'rpc', depends_on_columns: ['owner_id'],
      fk_search_modal: true, show_inline: true, options_filter_column: 'active',
    });
    // the other direction has no metadata row: defaults
    const t = out.find(p => p.table_name === 'tags' && p.column_name === 'issue_tags_m2m')!;
    expect(t.display_name).toBe('Issues');
    expect(t.options_source_rpc).toBeUndefined();
  });

  it('rich junctions force the search modal; parent-hop M:M is detail-only and inline', () => {
    const richTables = baseTables.map(t => t.table_name === 'issue_tags' ? tbl('issue_tags', 'IT', { is_rich_junction: true }) : t);
    const richProps = [...baseProps, prop('issue_tags', 'qty')];
    const rich = enrichPropertiesWithManyToMany(richProps, richTables).find(p => p.table_name === 'issues' && p.column_name === 'issue_tags_m2m')!;
    expect(rich.fk_search_modal).toBe(true);

    const hopProps = [
      prop('issues', 'display_name'), prop('rooms', 'display_name'),
      prop('room_slots', 'id'), fk('room_slots', 'room_id', 'rooms'),
      fk('issue_slots', 'issue_id', 'issues'), fk('issue_slots', 'slot_id', 'room_slots'),
    ];
    const hopTables = [tbl('issues'), tbl('rooms'), tbl('room_slots'), tbl('issue_slots')];
    const v = enrichPropertiesWithManyToMany(hopProps, hopTables, [{
      table_name: 'issues', column_name: 'issue_slots_m2m', show_on_create: true, show_on_edit: true, fk_search_modal: true, show_inline: false,
    } as unknown as M2mPropertyMetadata]).find(p => p.table_name === 'issues' && p.column_name === 'issue_slots_m2m')!;
    expect(v).toMatchObject({ show_on_create: false, show_on_edit: false, fk_search_modal: false, show_inline: true });
  });

  it('returns a plain copy when there are no junctions', () => {
    const out = enrichPropertiesWithManyToMany(deepFreeze([prop('a', 'id')]), deepFreeze([tbl('a')]));
    expect(out).toEqual([prop('a', 'id')]);
  });
});

describe('inverseRelationships', () => {
  const tables = deepFreeze([tbl('owners', 'Owners'), tbl('issues', 'Issues'), tbl('tasks', 'Tasks'), tbl('links', 'Links')]);
  const props = deepFreeze([
    prop('owners', 'id'), prop('owners', 'display_name'),
    prop('issues', 'id'), prop('issues', 'display_name'), fk('issues', 'owner_id', 'owners', { display_name: 'Owner', sort_order: 3 }),
    fk('issues', 'backup_owner_id', 'owners'),
    prop('tasks', 'id'), fk('tasks', 'owner_id', 'owners', { display_name: 'Task Owner' }),
    fk('links', 'owner_id', 'owners'), fk('links', 'other_id', 'owners'),
    fk('system', 'owner_id', 'owners', { join_schema: 'metadata' }),
    // junction detected: excluded from inverse
    prop('junc', 'x', { table_name: 'owners', column_name: 'jm_m2m', type: EntityPropertyType.ManyToMany, many_to_many_meta: { junctionTable: 'links' } as never }),
  ]);

  it('groups by source table (first prop wins), derives preview mode and names', () => {
    const out = inverseRelationships(props, tables, 'owners');
    expect(out.map(r => r.sourceTable)).toEqual(['issues', 'tasks']);
    expect(out[0]).toEqual({
      sourceTable: 'issues', sourceColumn: 'owner_id', sourceTableDisplayName: 'Issues',
      sourceColumnDisplayName: 'Owner', showOnDetail: true, sortOrder: 3, previewLimit: 5, previewMode: 'display_name',
    });
    expect(out[1]).toMatchObject({ sourceTable: 'tasks', sortOrder: 0, previewMode: 'id' });
  });

  it('excludes caller-specified tables; falls back to table name when tables unknown', () => {
    expect(inverseRelationships(props, undefined, 'owners', new Set(['issues'])).map(r => r.sourceTable)).toEqual(['tasks']);
    expect(inverseRelationships(props, undefined, 'owners')[0].sourceTableDisplayName).toBe('issues');
  });

  it('preview mode is count when the source table has neither id nor display_name', () => {
    const p = deepFreeze([fk('bare', 'owner_id', 'owners')]);
    expect(inverseRelationships(p, tables, 'owners')[0].previewMode).toBe('count');
  });

  it('returns nothing for a target without inbound FKs', () => {
    expect(inverseRelationships(props, tables, 'tasks')).toEqual([]);
  });
});
