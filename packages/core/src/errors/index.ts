/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** PostgREST error classification (P1.1e). */
export { classifyPostgrestError, extractConstraintName } from './classify.js';
export type { PostgrestErrorShape, PostgrestErrorKind, ClassifiedPostgrestError } from './classify.js';
