/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/index.js';
import type { SchemaEntityProperty, SchemaEntityTable, StaticText } from '../model/index.js';
import {
  createRenderables,
  detailRenderables,
  editRenderables,
  ensureStructuralProps,
  getColumnSpan,
  getDefaultValueForProperty,
  getRenderableColumnSpan,
  propsForCreate,
  propsForDetail,
  propsForEdit,
  propsForFilter,
  propsForList,
} from './property-views.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function prop(column_name: string, over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty {
  return deepFreeze({
    table_catalog: '', table_schema: 'public', table_name: 't', column_name, display_name: column_name,
    sort_order: 0, column_default: '', is_nullable: true, data_type: 'text',
    character_maximum_length: 0, udt_schema: 'pg_catalog', udt_name: 'text',
    is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true,
    join_schema: '', join_table: '', join_column: '', geography_type: '',
    type: EntityPropertyType.TextShort,
    ...over,
  } as SchemaEntityProperty);
}

function table(over: Partial<SchemaEntityTable> = {}): SchemaEntityTable {
  return deepFreeze({ table_name: 't', display_name: 'T', ...over } as SchemaEntityTable);
}

function st(id: number, sort_order: number, over: Partial<StaticText> = {}): StaticText {
  return deepFreeze({
    id, table_name: 't', content: 'x', sort_order, column_width: 2,
    show_on_detail: true, show_on_create: true, show_on_edit: true, itemType: 'static_text',
    ...over,
  } as unknown as StaticText);
}

const cols = (ps: readonly { column_name: string }[]) => ps.map(p => p.column_name);

describe('ensureStructuralProps', () => {
  const all = deepFreeze([prop('a'), prop('display_name'), prop('status_id'), prop('submitted_at')]);

  it('appends missing structural props in fixed order without mutating inputs', () => {
    const visible = deepFreeze([all[0]]);
    const out = ensureStructuralProps(all, visible);
    expect(cols(out)).toEqual(['a', 'display_name', 'status_id', 'submitted_at']);
    expect(out).not.toBe(visible);
    expect(visible).toHaveLength(1);
  });

  it('does not duplicate props already visible and ignores absent structural columns', () => {
    const visible = [all[2], all[0]];
    expect(cols(ensureStructuralProps(all, visible))).toEqual(['status_id', 'a', 'display_name', 'submitted_at']);
    expect(cols(ensureStructuralProps([all[0]], [all[0]]))).toEqual(['a']);
  });

  it('is identity-based: a different object with the same column name is still appended', () => {
    const lookalike = prop('display_name');
    expect(ensureStructuralProps(all, [lookalike])).toHaveLength(4);
  });
});

describe('propsForList', () => {
  const props = deepFreeze([
    prop('id'), prop('hidden', { show_on_list: false }), prop('shown', { show_on_list: true }),
    prop('display_name', { show_on_list: false }), prop('loc', { show_on_list: false }),
  ]);

  it('filters hidden columns, keeps order, appends structural props', () => {
    expect(cols(propsForList(table(), props))).toEqual(['id', 'shown', 'display_name']);
  });

  it('includes a hidden map property before the structural ones', () => {
    const out = propsForList(table({ show_map: true, map_property_name: 'loc' }), props);
    expect(cols(out)).toEqual(['id', 'shown', 'loc', 'display_name']);
  });

  it('does not duplicate a visible map property; ignores a missing one; needs both flags', () => {
    expect(cols(propsForList(table({ show_map: true, map_property_name: 'shown' }), props))).toEqual(['id', 'shown', 'display_name']);
    expect(cols(propsForList(table({ show_map: true, map_property_name: 'nope' }), props))).toEqual(['id', 'shown', 'display_name']);
    expect(cols(propsForList(table({ show_map: true }), props))).toEqual(['id', 'shown', 'display_name']);
    expect(cols(propsForList(table({ show_map: false, map_property_name: 'loc' }), props))).toEqual(['id', 'shown', 'display_name']);
  });

  it('returns the same property objects (callers may rely on identity)', () => {
    expect(propsForList(table(), props)[0]).toBe(props[0]);
  });
});

describe('propsForDetail / propsForEdit / propsForCreate', () => {
  const props = deepFreeze([
    prop('id', { is_identity: true, is_updatable: false }),
    prop('name'),
    prop('detail_off', { show_on_detail: false, show_on_edit: false, show_on_create: false }),
    prop('created_at', { is_updatable: true }),
    prop('updated_at'),
    prop('gen', { is_generated: true }),
    prop('ro', { is_updatable: false }),
    prop('display_name', { show_on_detail: false, show_on_edit: false, show_on_create: false }),
    prop('status_id'),
  ]);

  it('detail: hides show_on_detail=false, then re-adds structural props', () => {
    expect(cols(propsForDetail(props))).toEqual(['id', 'name', 'created_at', 'updated_at', 'gen', 'ro', 'status_id', 'display_name']);
  });

  it('create: drops generated, identity, read-only, auto timestamps and hidden columns; no structural add', () => {
    expect(cols(propsForCreate(props))).toEqual(['name', 'status_id']);
  });

  it('edit: same exclusions as create but structural props are added back', () => {
    expect(cols(propsForEdit(props))).toEqual(['name', 'status_id', 'display_name']);
  });
});

describe('propsForFilter', () => {
  it('requires filterable === true and a supported type', () => {
    const T = EntityPropertyType;
    const supported = [T.ForeignKeyName, T.DateTime, T.DateTimeLocal, T.Date, T.Boolean, T.IntegerNumber, T.Money, T.User, T.Status, T.Category];
    const ps = deepFreeze([
      ...supported.map((type, i) => prop(`s${i}`, { filterable: true, type })),
      prop('text', { filterable: true, type: T.TextShort }),
      prop('decimal', { filterable: true, type: T.DecimalNumber }),
      prop('off', { filterable: false, type: T.Boolean }),
      prop('unset', { type: T.Boolean }),
    ]);
    expect(cols(propsForFilter(ps))).toEqual(supported.map((_, i) => `s${i}`));
  });
});

describe('defaults and spans', () => {
  it('default value is false for Boolean and null otherwise', () => {
    expect(getDefaultValueForProperty(prop('b', { type: EntityPropertyType.Boolean }))).toBe(false);
    expect(getDefaultValueForProperty(prop('t'))).toBeNull();
    expect(getDefaultValueForProperty(prop('n', { type: EntityPropertyType.IntegerNumber }))).toBeNull();
  });

  it('column span: custom width wins, else type defaults', () => {
    const T = EntityPropertyType;
    expect(getColumnSpan(prop('a', { column_width: 3, type: T.Markdown }))).toBe(3);
    expect(getColumnSpan(prop('a', { column_width: 0, type: T.Markdown }))).toBe(4);
    for (const t of [T.TextLong, T.GeoPoint, T.GeoPolygon, T.File, T.FileImage, T.FilePDF]) {
      expect(getColumnSpan(prop('a', { type: t }))).toBe(2);
    }
    expect(getColumnSpan(prop('a', { type: T.TextShort }))).toBe(1);
  });

  it('renderable span: static text uses column_width, properties use type defaults', () => {
    const text = st(1, 1, { column_width: 4 });
    const p = { ...prop('a', { type: EntityPropertyType.Markdown }), itemType: 'property' as const };
    expect(getRenderableColumnSpan(text)).toBe(4);
    expect(getRenderableColumnSpan(p)).toBe(4);
  });
});

describe('renderables', () => {
  const props = deepFreeze([
    prop('b', { sort_order: 20 }),
    prop('a', { sort_order: 10 }),
    prop('same1', { sort_order: 30 }),
    prop('same2', { sort_order: 30 }),
    prop('hidden_detail', { sort_order: 5, show_on_detail: false, show_on_edit: false }),
  ]);
  const texts = deepFreeze([
    st(1, 15),
    st(2, 30),
    st(3, 1, { show_on_detail: false, show_on_create: false, show_on_edit: false }),
  ]);
  const key = (items: readonly { sort_order: number; itemType: string }[]) =>
    items.map(i => `${i.itemType}:${(i as { column_name?: string }).column_name ?? (i as { id?: number }).id}`);

  it('detail: sorts by sort_order stably (props before static text on ties), drops hidden', () => {
    expect(key(detailRenderables(props, texts))).toEqual([
      'property:a', 'static_text:1', 'property:b', 'property:same1', 'property:same2', 'static_text:2',
    ]);
  });

  it('create: keeps every given prop, filters static text by show_on_create', () => {
    expect(key(createRenderables(props, texts))).toEqual([
      'property:hidden_detail', 'property:a', 'static_text:1', 'property:b', 'property:same1', 'property:same2', 'static_text:2',
    ]);
  });

  it('edit: re-filters show_on_edit=false and static text', () => {
    expect(key(editRenderables(props, texts))).toEqual([
      'property:a', 'static_text:1', 'property:b', 'property:same1', 'property:same2', 'static_text:2',
    ]);
  });

  it('tags copies of the properties and leaves the inputs untouched', () => {
    const out = detailRenderables(props, texts);
    const a = out.find(i => (i as { column_name?: string }).column_name === 'a')!;
    expect(a).not.toBe(props[1]);
    expect(a).toEqual({ ...props[1], itemType: 'property' });
    expect(out.find(i => i.itemType === 'static_text')).toBe(texts[0]);
    expect(props[1]).not.toHaveProperty('itemType');
  });
});
