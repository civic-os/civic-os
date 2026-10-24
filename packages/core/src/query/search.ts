/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType } from '../model/entity.js';
import type { SchemaEntityProperty } from '../model/entity.js';
import { QueryValidationError } from './encode.js';

/** Options for {@link buildSearchParams}. */
export interface SearchParamsOptions {
  /** tsvector column for wfts, or null/undefined if none. */
  fulltextColumn?: string | null;
  /** Columns to substring-match with ILIKE. */
  substringColumns?: string[];
  /**
   * Text search configuration for wfts (Q-05). Absent renders bare `wfts.`
   * (the database default, `english`); present renders `wfts(<config>).`.
   * Must match `/^[a-z_][a-z0-9_]*$/`, else {@link QueryValidationError}.
   */
  textSearchConfig?: string;
  /**
   * When the entity has neither a fulltext nor a substring column, match
   * `display_name` with ILIKE instead of producing no params (Q-05, the MCP
   * behaviour). Default false, so the app output is unchanged.
   */
  displayNameFallback?: boolean;
  /**
   * Strip `(`, `)` and `,` from the term (default true, required inside an
   * `or=()` clause). The legacy single-column list search passes false.
   */
  stripReserved?: boolean;
}

const CONFIG_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * The one search builder (Q-05): wfts on a tsvector column, ILIKE substring
 * columns, or both combined in a PostgREST `or=()` clause, so whole-word
 * queries and partial fragments ("Smi" for "Smith") both match
 * (docs/notes/HYBRID_SEARCH_DESIGN.md). Shared by the List page, the FK search
 * modal, the legacy `civic_os_text_search` path of {@link compileDataQuery} and
 * (from P1.4) the MCP.
 *
 * @param term Raw user search input
 * @returns PostgREST query param strings; empty when no columns or blank term
 * @throws QueryValidationError for an invalid `textSearchConfig`
 *
 * @consumer app
 */
export function buildSearchParams(term: string, options: SearchParamsOptions = {}): string[] {
  const { fulltextColumn, textSearchConfig, displayNameFallback = false, stripReserved = true } = options;
  let substringColumns = options.substringColumns ?? [];
  if (textSearchConfig !== undefined && !CONFIG_PATTERN.test(textSearchConfig)) {
    throw new QueryValidationError(`textSearchConfig must match ${String(CONFIG_PATTERN)}, got ${JSON.stringify(textSearchConfig)}`);
  }
  const safe = (stripReserved ? term.replace(/[(),]/g, '') : term).trim();
  if (!safe) return [];
  const encoded = encodeURIComponent(safe);

  if (!fulltextColumn && substringColumns.length === 0 && displayNameFallback) {
    substringColumns = ['display_name'];
  }

  const clauses: string[] = [];
  if (fulltextColumn) {
    const operator = textSearchConfig === undefined ? 'wfts' : `wfts(${textSearchConfig})`;
    clauses.push(`${fulltextColumn}.${operator}.${encoded}`);
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
 * Builds PostgREST query params for hybrid search (v0.55.2 semantics); a thin
 * wrapper over {@link buildSearchParams} with the same output as before.
 *
 * @param term Raw user search input
 * @param fulltextColumn tsvector column for wfts, or null/undefined if none
 * @param substringColumns Columns to substring-match with ILIKE
 *
 * @consumer app
 */
export function buildHybridSearchParams(
  term: string,
  fulltextColumn?: string | null,
  substringColumns: string[] = []
): string[] {
  return buildSearchParams(term, { fulltextColumn, substringColumns });
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
