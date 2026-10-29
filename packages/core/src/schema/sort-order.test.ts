/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EntityPropertyType } from '../model/index.js';
import type { RenderableItem, SchemaEntityProperty, SchemaEntityTable, StaticText } from '../model/index.js';
import { detailRenderables } from './property-views.js';
import { enrichPropertiesWithManyToMany } from './relations.js';
import { compareBySortOrder } from './sort-order.js';

function prop(table_name: string, column_name: string, sort_order: number, over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty {
  return {
    table_catalog: '', table_schema: 'public', table_name, column_name, display_name: column_name,
    sort_order, column_default: '', is_nullable: true, data_type: 'text',
    character_maximum_length: 0, udt_schema: 'pg_catalog', udt_name: 'text',
    is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true,
    join_schema: '', join_table: '', join_column: '', geography_type: '',
    type: EntityPropertyType.TextShort,
    ...over,
  } as SchemaEntityProperty;
}

const fk = (table_name: string, column_name: string, join_table: string) =>
  prop(table_name, column_name, 0, {
    type: EntityPropertyType.ForeignKeyName, join_schema: 'public', join_table, join_column: 'id', udt_name: 'int4',
  });

function st(id: number, sort_order: number): StaticText {
  return {
    id, table_name: 'issues', content: 'x', sort_order, column_width: 2,
    show_on_detail: true, show_on_create: true, show_on_edit: true, itemType: 'static_text',
  };
}

const key = (items: readonly RenderableItem[]) =>
  items.map(i => i.itemType === 'static_text' ? `text:${i.id}` : i.column_name);

// Pothole Issue's real tie: contact_phone has metadata sort_order 4, display_name falls back to ordinal 4.
const issueProps = [
  prop('issues', 'id', 1), prop('issues', 'created_at', 2), prop('issues', 'updated_at', 2),
  prop('issues', 'display_name', 4), prop('issues', 'contact_phone', 4), prop('issues', 'location', 5),
];

describe('compareBySortOrder', () => {
  it('orders by sort_order, then column_name', () => {
    expect([...issueProps].sort(compareBySortOrder).map(p => p.column_name)).toEqual([
      'id', 'created_at', 'updated_at', 'contact_phone', 'display_name', 'location',
    ]);
  });

  it('resolves ties the same way whatever the input order', () => {
    const expected = [...issueProps].sort(compareBySortOrder);
    fc.assert(fc.property(fc.shuffledSubarray(issueProps, { minLength: issueProps.length }), shuffled => {
      expect([...shuffled].sort(compareBySortOrder)).toEqual(expected);
    }));
  });

  it('compares names by code unit, not locale', () => {
    // localeCompare puts 'a_b' after 'ab' under ICU root collation; code units put '_' (0x5F) before 'b'.
    const sorted = [prop('t', 'ab', 1), prop('t', 'a_b', 1), prop('t', 'B', 1)].sort(compareBySortOrder);
    expect(sorted.map(p => p.column_name)).toEqual(['B', 'a_b', 'ab']);
  });

  it('puts properties before static text at the same sort_order, and static texts in id order', () => {
    const texts = [st(9, 4), st(3, 4), st(5, 1)];
    expect(key(detailRenderables(issueProps, texts))).toEqual([
      'id', 'text:5', 'created_at', 'updated_at', 'contact_phone', 'display_name', 'text:3', 'text:9', 'location',
    ]);
    expect(key(detailRenderables([...issueProps].reverse(), [...texts].reverse())))
      .toEqual(key(detailRenderables(issueProps, texts)));
  });

  it('orders M:M virtual properties, which share the default sort_order, by column name', () => {
    const tables = [
      { table_name: 'issues', display_name: 'Issues' }, { table_name: 'tags', display_name: 'Tags' },
      { table_name: 'crews', display_name: 'Crews' }, { table_name: 'issue_tags', display_name: 'IT' },
      { table_name: 'issue_crews', display_name: 'IC' },
    ] as SchemaEntityTable[];
    const props = [
      prop('issues', 'id', 1), prop('issues', 'display_name', 2), prop('issues', 'notes', 100),
      prop('tags', 'id', 1), prop('tags', 'display_name', 2), prop('crews', 'id', 1), prop('crews', 'display_name', 2),
      fk('issue_tags', 'issue_id', 'issues'), fk('issue_tags', 'tag_id', 'tags'),
      fk('issue_crews', 'issue_id', 'issues'), fk('issue_crews', 'crew_id', 'crews'),
    ];
    const issueOrder = (input: SchemaEntityProperty[]) =>
      enrichPropertiesWithManyToMany(input, tables)
        .filter(p => p.table_name === 'issues')
        .sort(compareBySortOrder)
        .map(p => p.column_name);

    expect(issueOrder(props)).toEqual(['id', 'display_name', 'issue_crews_m2m', 'issue_tags_m2m', 'notes']);
    expect(issueOrder([...props].reverse())).toEqual(issueOrder(props));
  });

  it('orders a list spanning entities by table, then column, so inverse relationships are stable', () => {
    // Staff Portal: every FK to staff_members sits at sort_order 2 and several share a column name.
    const fks = [
      prop('time_entries', 'staff_member_id', 2), prop('sites', 'lead_id', 2),
      prop('reimbursements', 'staff_member_id', 2), prop('incident_reports', 'reported_by_id', 2),
    ];
    const order = (input: SchemaEntityProperty[]) => [...input].sort(compareBySortOrder).map(p => p.table_name);
    expect(order(fks)).toEqual(['incident_reports', 'reimbursements', 'sites', 'time_entries']);
    expect(order([...fks].reverse())).toEqual(order(fks));
  });

  it('treats a missing sort_order as 0', () => {
    expect(compareBySortOrder({ column_name: 'b' }, { sort_order: 0, column_name: 'a' })).toBe(1);
    expect(compareBySortOrder({ sort_order: null, column_name: 'a' }, { sort_order: 1, column_name: 'a' })).toBe(-1);
  });
});
