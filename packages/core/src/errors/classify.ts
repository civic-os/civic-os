/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal structural shape of an API error, as read by the classifier. The
 * app's ApiError satisfies it; no Angular HttpErrorResponse involved.
 *
 * @consumer typed classifyPostgrestError
 */
export interface PostgrestErrorShape {
  httpCode?: number;
  code?: string;
  details?: string;
  message?: string;
}

/**
 * Every branch the human-message mapping distinguishes, in precedence order
 * (see {@link ERROR_KIND_PRECEDENCE}).
 *
 * @consumer typed classifyPostgrestError
 */
export type ErrorKind =
  | 'network'
  | 'permission'
  | 'unique'
  | 'notNull'
  | 'foreignKey'
  | 'check'
  | 'exclusion'
  | 'invalidInput'
  | 'invalidDate'
  | 'noRows'
  | 'notFound'
  | 'sessionExpired'
  | 'preconditionFailed'
  | 'raise'
  | 'system';

/**
 * Former name of {@link ErrorKind}.
 *
 * @consumer typed classifyPostgrestError
 */
export type PostgrestErrorKind = ErrorKind;

/**
 * The order in which {@link classifyPostgrestError} tests an error, first match
 * wins. HTTP status 0 (no response) comes first; the PostgreSQL / PostgREST
 * `code` kinds follow; then the HTTP status kinds; `raise` (P0001) comes after
 * the status kinds, so status beats code for a RAISE: `{401, P0001}` is
 * `sessionExpired` and `{404, P0001}` is `notFound`. Anything unmatched is `system`.
 *
 * @consumer app
 */
export const ERROR_KIND_PRECEDENCE: readonly ErrorKind[] = [
  'network',
  'permission',
  'unique',
  'notNull',
  'foreignKey',
  'check',
  'exclusion',
  'invalidInput',
  'invalidDate',
  'noRows',
  'notFound',
  'sessionExpired',
  'preconditionFailed',
  'raise',
  'system',
];

/**
 * Values the classifier extracts for the message: `message` for 'raise' (the
 * RAISE EXCEPTION text, verbatim); `constraintName` for 'check' and 'exclusion'
 * when a name can be extracted; `column` for 'notNull'; `expectedType` (the
 * PostgreSQL type name) for 'invalidInput'.
 *
 * @consumer typed classifyPostgrestError
 */
export interface ErrorParams {
  message?: string;
  constraintName?: string;
  column?: string;
  expectedType?: string;
}

/**
 * Classification result.
 *
 * @consumer typed classifyPostgrestError
 */
export interface ClassifiedPostgrestError {
  kind: ErrorKind;
  params: ErrorParams;
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
 * Classifies a PostgREST error. Branch precedence is {@link ERROR_KIND_PRECEDENCE}
 * (loose equality preserved for `code` and `httpCode`).
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
  } else if (err.code == '23502') {
    const column = err.message?.match(/column "([^"]+)"/)?.[1];
    return { kind: 'notNull', params: column === undefined ? {} : { column } };
  } else if (err.code == '23503') {
    return { kind: 'foreignKey', params: {} };
  } else if (err.code == '23514') {
    return { kind: 'check', params: constraintParams(err) };
  } else if (err.code == '23P01') {
    return { kind: 'exclusion', params: constraintParams(err) };
  } else if (err.code == '22P02') {
    const expectedType = err.message?.match(/invalid input syntax for type (\w+)/)?.[1];
    return { kind: 'invalidInput', params: expectedType === undefined ? {} : { expectedType } };
  } else if (err.code == '22007' || err.code == '22008') {
    return { kind: 'invalidDate', params: {} };
  } else if (err.code == 'PGRST116') {
    return { kind: 'noRows', params: {} };
  } else if (err.httpCode == 404) {
    return { kind: 'notFound', params: {} };
  } else if (err.httpCode == 401) {
    return { kind: 'sessionExpired', params: {} };
  } else if (err.httpCode == 412) {
    return { kind: 'preconditionFailed', params: {} };
  } else if (err.code == 'P0001') {
    return { kind: 'raise', params: err.message === undefined ? {} : { message: err.message } };
  }
  return { kind: 'system', params: {} };
}

function constraintParams(err: PostgrestErrorShape): { constraintName?: string } {
  const constraintName = extractConstraintName(err);
  return constraintName === undefined ? {} : { constraintName };
}
