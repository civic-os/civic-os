/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConstraintMessage } from '../model/index.js';
import { classifyPostgrestError } from './classify.js';
import type { ErrorKind, ErrorParams, PostgrestErrorShape } from './classify.js';

/**
 * What a message function receives: the classifier's `params` and the full
 * error, so a consumer's override can print the raw message (the MCP's
 * "Error: <message>") or the HTTP status.
 *
 * @consumer typed humanizeError
 */
export interface ErrorMessageContext {
  params: ErrorParams;
  error: PostgrestErrorShape;
}

/**
 * A message for one {@link ErrorKind}: text, or a function of the context.
 *
 * @consumer typed humanizeError
 */
export type ErrorMessage = string | ((context: ErrorMessageContext) => string);

/**
 * Per-consumer wording: any subset of kinds. The MCP keeps its LLM-oriented
 * sentences this way; the frontend moves to i18n keys at P3a.2.
 *
 * @consumer mcp
 */
export type ErrorMessageOverrides = Partial<Record<ErrorKind, ErrorMessage>>;

/** "email_address_check" becomes "email address". */
function humanizeConstraintName(name: string): string {
  return name.replace(/_check$/, '').replace(/_/g, ' ');
}

const PG_TYPE_NAMES: Record<string, string> = {
  integer: 'a whole number',
  numeric: 'a number',
  boolean: 'true or false',
  date: 'a date (YYYY-MM-DD)',
  timestamp: 'a date/time',
  uuid: 'a valid UUID',
};

/**
 * Default English wording for every {@link ErrorKind}, built from the frontend's
 * strings (E-01). Constraint fallbacks end with the raw constraint name so a
 * report can be traced to the constraint (E-03); 23502, 22P02, 22007/8 and 412
 * name the problem (F-04); 23503 and PGRST116 are friendly (F-17); an empty or
 * missing RAISE message gets a generic sentence (F-15); the unrecognized
 * `system` error stays "System Error" (E-04). PT503 is not here: the
 * maintenance interceptor handles it.
 *
 * @consumer mcp
 */
export const DEFAULT_ERROR_MESSAGES = {
  network: 'Network error. Please check your connection.',
  permission: 'Permissions error',
  unique: 'Record must be unique',
  notNull: ({ params }) =>
    params.column === undefined ? 'A required field is missing.' : `Required field "${params.column}" is missing.`,
  foreignKey:
    'This record is linked to another record that does not exist or is still in use. Check the linked record and try again.',
  check: ({ params }) =>
    params.constraintName === undefined
      ? 'Validation failed. Check the value and try again.'
      : `Invalid ${humanizeConstraintName(params.constraintName)}. Check the value and try again. (${params.constraintName})`,
  exclusion: ({ params }) =>
    params.constraintName === undefined
      ? 'This conflicts with an existing record. Please check your input and try again.'
      : `This conflicts with an existing record. Please check your input and try again. (${params.constraintName})`,
  invalidInput: ({ params }) =>
    params.expectedType === undefined
      ? 'Invalid value format. Check the value and try again.'
      : `Invalid value: expected ${PG_TYPE_NAMES[params.expectedType] ?? `type "${params.expectedType}"`}. Check the value and try again.`,
  invalidDate: 'Invalid date format. Use YYYY-MM-DD for dates or YYYY-MM-DDTHH:MM:SS for timestamps.',
  noRows: 'Expected exactly one matching record, but the request matched none or several.',
  notFound: 'Resource not found',
  sessionExpired: 'Your session has expired. Please refresh the page to log in again.',
  preconditionFailed:
    'This record has been modified since you last read it. Please fetch the latest version and try again.',
  raise: ({ params }) =>
    params.message ? params.message : 'The operation was rejected. Please check your input and try again.',
  system: 'System Error',
} satisfies Record<ErrorKind, ErrorMessage>;

/**
 * @consumer typed humanizeError
 */
export interface HumanizeErrorOptions {
  /** Configured messages; a hit for a 'check' or 'exclusion' constraint wins over the default. */
  constraintMessages?: readonly Pick<ConstraintMessage, 'constraint_name' | 'error_message'>[] | null;
  /** Consumer wording, merged over {@link DEFAULT_ERROR_MESSAGES}. */
  messages?: ErrorMessageOverrides;
}

/**
 * Turns a PostgREST error into one sentence: classify it, prefer a configured
 * constraint message, then the consumer's override, then the default.
 *
 * @consumer app
 */
export function humanizeError(err: PostgrestErrorShape, options: HumanizeErrorOptions = {}): string {
  const { kind, params } = classifyPostgrestError(err);
  if ((kind === 'check' || kind === 'exclusion') && params.constraintName !== undefined) {
    const hit = options.constraintMessages?.find(cm => cm.constraint_name === params.constraintName);
    if (hit) return hit.error_message;
  }
  const message: ErrorMessage = options.messages?.[kind] ?? DEFAULT_ERROR_MESSAGES[kind];
  return typeof message === 'function' ? message({ params, error: err }) : message;
}
