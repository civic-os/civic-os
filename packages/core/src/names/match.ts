/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One record a name can resolve to. `key` is a programmatic identifier
 * (a status's `status_key`) that outranks the display name (N-02).
 *
 * @consumer typed matchName
 */
export interface NameEntry<Id> {
  id: Id;
  name: string;
  key?: string | null;
}

/**
 * A record a name matched, as listed when the match is ambiguous (N-06).
 *
 * @consumer typed interpretNameMatches
 */
export interface NameCandidate<Id> {
  id: Id;
  name: string;
}

/** Outcome of matching a name: one record, none, or several (N-06). */
export type NameMatch<Id> =
  | { kind: 'found'; id: Id }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: NameCandidate<Id>[] };

/**
 * The form a name is compared in: trimmed and lowercased (N-03). Spreadsheet
 * cells and LLM tool arguments often carry stray whitespace around the name.
 *
 * @consumer app
 */
export function normalizeNameKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Judges the records a name matched: none is `none`, one is `found`, and
 * several are `ambiguous`, listing every candidate so the user can pick one
 * by id instead of getting the first (N-06).
 *
 * @consumer app
 */
export function interpretNameMatches<Id>(matches: readonly NameCandidate<Id>[]): NameMatch<Id> {
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'found', id: matches[0].id };
  return { kind: 'ambiguous', candidates: matches.map((m) => ({ id: m.id, name: m.name })) };
}

/**
 * Matches `input` against a list of records, trimmed and case-insensitive.
 * A record whose `key` equals the input wins outright; only when no key
 * matches is the display name compared (N-02: resolve `status_key` first, then
 * the display name, as the Excel import always did). Duplicate display names
 * are ambiguous, never resolved to the first (N-06).
 *
 * @consumer mcp
 */
export function matchName<Id>(input: string, entries: readonly NameEntry<Id>[]): NameMatch<Id> {
  const wanted = normalizeNameKey(input);
  if (wanted === '') return { kind: 'none' };
  const byKey = entries.filter((e) => e.key != null && normalizeNameKey(e.key) === wanted);
  if (byKey.length > 0) return interpretNameMatches(byKey);
  return interpretNameMatches(entries.filter((e) => normalizeNameKey(e.name) === wanted));
}
