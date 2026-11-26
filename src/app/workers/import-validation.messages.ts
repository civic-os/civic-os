/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Message shapes the import validation worker posts to the import modal (issue #170).
 *
 * The worker cannot reach the TranslationService, so it reports a translation key plus
 * parameters and the modal translates them when the result arrives. No Angular or DOM
 * imports here: the worker bundle imports this file.
 */

/** Parameters interpolated into a message as `{{name}}`. */
export type MessageParams = Record<string, string | number>;

/**
 * A row error as the worker reports it. `error` is a literal message (an integrator's
 * validation-rule message, or text from a thrown Error) shown verbatim; otherwise
 * `errorKey` (+ `errorParams`) names the translated message. `errorTypeKey` always
 * names the translated error category.
 */
export interface RawImportError {
  row: number;
  column: string;
  value: any;
  error?: string;
  errorKey?: string;
  errorParams?: MessageParams;
  errorTypeKey: string;
  errorTypeParams?: MessageParams;
}

/** The worker's error summary before the modal translates it and groups by type. */
export interface RawErrorSummary {
  totalErrors: number;
  errorsByColumn: Map<string, number>;
  allErrors: RawImportError[];
}
