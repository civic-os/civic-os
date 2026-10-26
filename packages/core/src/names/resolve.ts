/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataClient } from '../client/data-client.js';
import { interpretNameMatches, type NameCandidate } from './match.js';

/**
 * The part of {@link DataClient} the resolver reads through.
 *
 * @consumer typed resolveNameToId
 */
export type NameLookupSource = Pick<DataClient, 'getData'>;

/**
 * Outcome of looking a display name up in a table: a {@link NameMatch}, plus
 * the stage that produced a multiple match so a consumer can word it.
 *
 * @consumer typed resolveNameToId
 */
export type NameLookupResult<Id> =
  | { kind: 'found'; id: Id }
  | { kind: 'none' }
  | { kind: 'ambiguous'; stage: 'exact' | 'caseInsensitive'; candidates: NameCandidate<Id>[] };

/**
 * A POSIX regex matching exactly `value` (every metacharacter escaped), for
 * the PostgREST `imatch` operator. Not `ilike`: `%` and `_` would act as
 * wildcards, and PostgREST rewrites every `*` to `%` with no way to escape it,
 * so "a*b" would match "aXb".
 *
 * Module-internal: not part of the public barrel; `resolveNameToId` is the entry point.
 */
export function exactCaseInsensitivePattern(value: string): string {
  return `^${value.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}$`;
}

interface NameRow {
  id: unknown;
  display_name?: unknown;
}

function toCandidates<Id>(rows: unknown[]): NameCandidate<Id>[] {
  return (rows as NameRow[]).map((r) => ({ id: r.id as Id, name: String(r.display_name ?? '') }));
}

/**
 * Looks a display name up in `table` through `data`: an exact match first,
 * then, when nothing matches, a case-insensitive exact match. The name is
 * trimmed (N-03) and a blank name matches nothing without a request, because
 * core drops an empty filter value (Q-08) and the request would match every
 * row. Several rows at either stage are `ambiguous` and list every candidate
 * (N-06); the caller decides how to word it.
 *
 * @consumer mcp
 */
export async function resolveNameToId<Id = number | string>(
  data: NameLookupSource,
  table: string,
  name: string,
  options: { limit?: number } = {},
): Promise<NameLookupResult<Id>> {
  const wanted = name.trim();
  if (wanted === '') return { kind: 'none' };
  const limit = options.limit ?? 5;

  const exact = interpretNameMatches(toCandidates<Id>(await data.getData({
    key: table,
    fields: ['id', 'display_name'],
    filters: [{ column: 'display_name', operator: 'eq', value: wanted }],
    limit,
  })));
  if (exact.kind === 'found') return exact;
  if (exact.kind === 'ambiguous') return { ...exact, stage: 'exact' };

  const insensitive = interpretNameMatches(toCandidates<Id>(await data.getData({
    key: table,
    fields: ['id', 'display_name'],
    filters: [{ column: 'display_name', operator: 'imatch', value: exactCaseInsensitivePattern(wanted) }],
    limit,
  })));
  if (insensitive.kind === 'ambiguous') return { ...insensitive, stage: 'caseInsensitive' };
  return insensitive;
}
