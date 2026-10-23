/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal structural shape of an API error, as read by the classifier. The
 * app's ApiError satisfies it; no Angular HttpErrorResponse involved.
 *
 * @consumer app
 */
export interface PostgrestErrorShape {
  httpCode?: number;
  code?: string;
  details?: string;
  message?: string;
}

/**
 * Every branch the human-message mapping distinguishes, in precedence order.
 *
 * @consumer app
 */
export type PostgrestErrorKind =
  | 'network'
  | 'permission'
  | 'unique'
  | 'check'
  | 'exclusion'
  | 'notFound'
  | 'sessionExpired'
  | 'raise'
  | 'system';

/**
 * Classification result. `params.message` is set for 'raise' (the RAISE
 * EXCEPTION text, interpolated verbatim); `params.constraintName` is set for
 * 'check' and 'exclusion' when a constraint name can be extracted.
 *
 * @consumer app
 */
export interface ClassifiedPostgrestError {
  kind: PostgrestErrorKind;
  params: { message?: string; constraintName?: string };
}

/**
 * Extracts a PostgreSQL constraint name from error details, falling back to the message.
 * Formats: 'new row for relation "t" violates check constraint "name"' and
 * 'conflicting key value violates exclusion constraint "name"'.
 *
 * @consumer app
 */
export function extractConstraintName(err: PostgrestErrorShape): string | undefined {
  const match = err.details?.match(/constraint "([^"]+)"/) || err.message?.match(/constraint "([^"]+)"/);
  return match && match[1] ? match[1] : undefined;
}

/**
 * Classifies a PostgREST error. Branch precedence is exactly that of the
 * original ErrorService.parseToHuman (loose equality preserved).
 * See https://postgrest.org/en/stable/references/errors.html
 *
 * @consumer app
 */
export function classifyPostgrestError(err: PostgrestErrorShape): ClassifiedPostgrestError {
  if (err.httpCode === 0) {
    return { kind: 'network', params: {} };
  } else if (err.code == '42501') {
    return { kind: 'permission', params: {} };
  } else if (err.code == '23505') {
    return { kind: 'unique', params: {} };
  } else if (err.code == '23514') {
    return { kind: 'check', params: constraintParams(err) };
  } else if (err.code == '23P01') {
    return { kind: 'exclusion', params: constraintParams(err) };
  } else if (err.httpCode == 404) {
    return { kind: 'notFound', params: {} };
  } else if (err.httpCode == 401) {
    return { kind: 'sessionExpired', params: {} };
  } else if (err.code == 'P0001') {
    return { kind: 'raise', params: { message: err.message } };
  }
  return { kind: 'system', params: {} };
}

function constraintParams(err: PostgrestErrorShape): { constraintName?: string } {
  const constraintName = extractConstraintName(err);
  return constraintName === undefined ? {} : { constraintName };
}
