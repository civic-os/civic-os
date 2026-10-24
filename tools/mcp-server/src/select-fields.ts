/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The `select` fields for a set of properties. The embed for each property is
 * core's `propertyToSelectString`; this only decides which properties are
 * selected (consumer policy).
 */

import { EntityPropertyType, extractConditionFieldNames, propertyToSelectString } from '@civic-os/core';
import type { SchemaEntityAction, SchemaProperty } from './interfaces.js';

/**
 * PostgREST select fields for `properties`, one entry per property (embedded
 * where core embeds).
 *
 * - `id` is included only when the properties contain `id` or an identity column
 *   (report VIEWs without an id column would get a PostgREST error otherwise).
 * - Many-to-many properties are left out: the MCP formatters do not render the
 *   junction embeds (ledger T-12).
 * - With `includeTimestamps`, `created_at` / `updated_at` are selected when the
 *   entity has them (VIEWs and junction tables often lack one or both).
 */
export function selectFields(
  properties: readonly SchemaProperty[],
  options?: { includeTimestamps?: boolean },
): string[] {
  const fields = new Set<string>();

  if (properties.some(p => p.column_name === 'id' || p.is_identity === true)) {
    fields.add('id');
  }

  for (const prop of properties) {
    if (prop.column_name === 'id') continue;
    if (prop.type === EntityPropertyType.ManyToMany) continue;
    fields.add(propertyToSelectString(prop));
  }

  if (options?.includeTimestamps) {
    for (const ts of ['created_at', 'updated_at']) {
      if (properties.some(p => p.column_name === ts)) fields.add(ts);
    }
  }

  return Array.from(fields);
}

/**
 * PostgREST select fields for the core detail plan of one record (Q-13): the
 * properties to show, `id` when the entity has one, and the root column of
 * every field an action's visibility or enabled condition reads, as the
 * frontend's detail page adds them. A condition field that is a schema property
 * is embedded like any other (so a dot-notation path such as
 * `status_id.status_key` resolves); one that is not is selected by name.
 *
 * @param allProperties Every property of the entity (decides `id` and the condition columns)
 * @param displayProperties The properties to show: core's `propsForDetail`, or `columns`, plus any extra `fields`
 * @param actions The entity's actions, whose conditions need their fields
 * @param options `includeTimestamps` as in {@link selectFields}
 */
export function detailSelectFields(
  allProperties: readonly SchemaProperty[],
  displayProperties: readonly SchemaProperty[],
  actions: readonly SchemaEntityAction[],
  options?: { includeTimestamps?: boolean },
): string[] {
  const planned = new Map<string, SchemaProperty>();
  const idProperty = allProperties.find(p => p.column_name === 'id' || p.is_identity === true);
  if (idProperty) planned.set(idProperty.column_name, idProperty);
  for (const prop of displayProperties) planned.set(prop.column_name, prop);

  const byName = new Map(allProperties.map(p => [p.column_name, p]));
  const unknownConditionColumns: string[] = [];
  for (const action of actions) {
    for (const condition of [action.visibility_condition, action.enabled_condition]) {
      for (const root of extractConditionFieldNames(condition)) {
        const prop = byName.get(root);
        if (prop) planned.set(prop.column_name, prop);
        else if (!unknownConditionColumns.includes(root)) unknownConditionColumns.push(root);
      }
    }
  }

  const fields = selectFields([...planned.values()]);
  for (const column of unknownConditionColumns) {
    if (!fields.includes(column)) fields.push(column);
  }
  // Timestamps are selected when the entity has them, whether or not the detail plan shows them (Q-12).
  if (options?.includeTimestamps) {
    for (const ts of ['created_at', 'updated_at']) {
      if (allProperties.some(p => p.column_name === ts) && !fields.includes(ts)) fields.push(ts);
    }
  }
  return fields;
}
