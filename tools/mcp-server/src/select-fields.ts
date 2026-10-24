/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The `select` fields for a set of properties. The embed for each property is
 * core's `propertyToSelectString`; this only decides which properties are
 * selected (consumer policy).
 */

import { EntityPropertyType, propertyToSelectString } from '@civic-os/core';
import type { SchemaProperty } from './interfaces.js';

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
