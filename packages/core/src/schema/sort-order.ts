/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

type SortOrderKeys = {
  readonly sort_order?: number | null;
  readonly table_name?: string;
  readonly column_name?: string;
  readonly itemType?: string;
  readonly id?: number;
};

/**
 * The one order for properties and renderables: `sort_order`, then properties
 * before static text, then `table_name` and `column_name` between properties
 * and `id` between static texts.
 *
 * `schema_properties` falls back to the column's ordinal position when no
 * metadata `sort_order` is set, so a metadata value can tie another column's
 * ordinal, and M:M virtual properties share a default. The view has no
 * `ORDER BY`, so without a tiebreak tied rows keep whatever order PostgREST
 * returned, which differs between stacks. Within one entity the tiebreak is
 * the column name; `table_name` only orders a list that spans entities, such
 * as the one inverse relationships are read from. Names compare by code unit
 * (`<`), not `localeCompare`, so the order does not depend on the runtime's
 * locale. A missing `sort_order` counts as 0.
 *
 * @consumer app
 * @consumer mcp
 */
export function compareBySortOrder(a: SortOrderKeys, b: SortOrderKeys): number {
  const orderA = a.sort_order ?? 0;
  const orderB = b.sort_order ?? 0;
  if (orderA !== orderB) return orderA < orderB ? -1 : 1;

  const textA = a.itemType === 'static_text';
  const textB = b.itemType === 'static_text';
  if (textA !== textB) return textA ? 1 : -1;
  if (textA) {
    const idA = a.id ?? 0;
    const idB = b.id ?? 0;
    return idA === idB ? 0 : idA < idB ? -1 : 1;
  }

  return compareText(a.table_name, b.table_name) || compareText(a.column_name, b.column_name);
}

function compareText(a = '', b = ''): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
