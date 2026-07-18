/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
