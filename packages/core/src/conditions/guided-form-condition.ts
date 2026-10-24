/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GuidedFormCondition } from '../model/index.js';
import { evaluateCondition } from './action-condition.js';

/**
 * Evaluates one guided-form skip_if / require_if condition against the parent record.
 *
 * The same evaluator as entity actions (F-16) with string coercion: guided-form
 * condition values are stored as text, so `eq` / `neq` compare both sides as
 * strings (`'7'` matches `7`). Null handling follows the action evaluator: a
 * missing or null field equals a null condition value, and `neq` against null is
 * false for a null field. A missing parent record behaves like an empty one.
 * Embedded FK/category/status objects ({id: 7, ...}) are reduced to their id.
 *
 * @consumer app
 */
export function evaluateGuidedFormCondition(
  condition: Pick<GuidedFormCondition, 'field' | 'operator' | 'value'>,
  parentRecord: Record<string, unknown> | null | undefined
): boolean {
  // The condition is always present here (even with an empty field), so the
  // "no condition is true" shortcut never applies; a null record is an empty one.
  return evaluateCondition({ ...condition }, parentRecord ?? {}, { coercion: 'string' });
}
