/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one URL-encoding step for values the core puts into a PostgREST query
 * string: filter values, `id=eq.<entityId>` and the values of the other
 * `col=eq.<value>` filters the clients build (ledger row F-01). `+`, `&`, `#`,
 * `%`, `=`, `?`, spaces and non-ASCII would otherwise split, corrupt or
 * mis-decode the query (a raw `+` in an ISO offset decodes as a space, and
 * PostgREST answers 400 22007). Column names, operators and the PostgREST
 * syntax around a value (`in.(`, `and=(`, `.`) are never encoded.
 */
export function encodeQueryValue(value: unknown): string {
  return encodeURIComponent(String(value));
}

/** An `in.(...)` item is double-quoted when it contains any of these (F-13). */
const LIST_ITEM_RESERVED = /[,().:"]/;
/** Inside `and=(...)` a single value only breaks on the structural characters; `.` and `:` (ISO timestamps) are safe unquoted. */
const LOGIC_VALUE_RESERVED = /[,()"]/;

function quote(text: string): string {
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** An `in.(...)` item: double-quoted when it contains any of `,().:"` (F-13). */
export function quoteListItem(item: unknown): string {
  const text = String(item);
  return LIST_ITEM_RESERVED.test(text) ? quote(text) : text;
}

/** A scalar value inside `and=(...)`: double-quoted when it contains any of `,()"` (Q-09). */
export function quoteLogicValue(value: unknown): string {
  const text = String(value);
  return LOGIC_VALUE_RESERVED.test(text) ? quote(text) : text;
}
