/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** PostgREST error classification and wording (P1.1e). */
export { classifyPostgrestError } from './classify.js';
export type {
  ClassifiedPostgrestError,
  ErrorKind,
  ErrorParams,
  PostgrestErrorKind,
  PostgrestErrorShape,
} from './classify.js';
export { DEFAULT_ERROR_MESSAGES, humanizeError } from './messages.js';
export type {
  ErrorMessage,
  ErrorMessageContext,
  ErrorMessageOverrides,
  HumanizeErrorOptions,
} from './messages.js';
