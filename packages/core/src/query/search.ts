/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType } from '../model/entity.js';
import type { SchemaEntityProperty } from '../model/entity.js';

/**
 * Builds PostgREST query params for hybrid search (v0.55.2 semantics).
 *
 * Combines full-text search (wfts on a tsvector column) with ILIKE substring
 * matching (pg_trgm) via a PostgREST or=() clause, so whole-word queries and
 * partial fragments ("Smi" for "Smith") both match. Shared by the List page
 * and the FK search modal so both surfaces behave identically
 * (docs/notes/HYBRID_SEARCH_DESIGN.md).
 *
 * @param term Raw user search input
 * @param fulltextColumn tsvector column for wfts, or null/undefined if none
 * @param substringColumns Columns to substring-match with ILIKE
 * @returns PostgREST query param strings; empty when no columns or blank term
 *
 * @consumer app
 */
export function buildHybridSearchParams(
  term: string,
  fulltextColumn?: string | null,
  substringColumns: string[] = []
): string[] {
  const safe = term.replace(/[(),]/g, '').trim();
  if (!safe) return [];
  const encoded = encodeURIComponent(safe);

  const clauses: string[] = [];
  if (fulltextColumn) {
    clauses.push(`${fulltextColumn}.wfts.${encoded}`);
  }
  for (const col of substringColumns) {
    clauses.push(`${col}.ilike.*${encoded}*`);
  }

  if (clauses.length === 0) return [];
  if (clauses.length === 1) {
    // Single clause renders as a plain column=operator.value param
    const clause = clauses[0];
    const dot = clause.indexOf('.');
    return [`${clause.slice(0, dot)}=${clause.slice(dot + 1)}`];
  }
  return [`or=(${clauses.join(',')})`];
}

/**
 * Builds the PostgREST order field string.
 * For FK and User columns, orders by the related entity's display_name.
 * For regular columns, uses the column name directly.
 *
 * @consumer app
 */
export function buildOrderField(property: Pick<SchemaEntityProperty, 'type' | 'column_name'>): string {
  // For foreign key columns, order by the embedded resource's display_name
  // The embedded resource name is the column name (without _id suffix for FKs)
  if (property.type === EntityPropertyType.ForeignKeyName) {
    return `${property.column_name}(display_name)`;
  }

  // For user columns, order by the embedded user's display_name
  // User columns are embedded as: column_name:civic_os_users!column_name(...)
  if (property.type === EntityPropertyType.User) {
    return `${property.column_name}(display_name)`;
  }

  // For regular columns, use the column name
  return property.column_name;
}
