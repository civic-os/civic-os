/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from src/app; record payloads are untyped JSON (SDK P1.4+). */

import type { GuidedFormCondition } from '../model/index.js';

/**
 * Evaluates one guided-form skip_if / require_if condition against the parent record.
 *
 * Deliberately separate from evaluateActionCondition: operators ('eq' | 'neq' |
 * is_null | is_not_null), missing-field handling (eq on null is false, neq on
 * null is true) and type coercion (String(value) === condition.value) differ.
 * Embedded FK/category/status objects ({id: 7, ...}) are reduced to their id.
 *
 * @consumer app
 */
export function evaluateGuidedFormCondition(
  condition: Pick<GuidedFormCondition, 'field' | 'operator' | 'value'>,
  parentRecord: any
): boolean {
  let value = parentRecord?.[condition.field];
  // Handle embedded FK/category/status objects (e.g., {id: 7, display_name: '...'})
  if (value && typeof value === 'object' && 'id' in value) {
    value = value.id;
  }
  switch (condition.operator) {
    case 'eq':
      if (value == null) return false;
      return String(value) === condition.value;
    case 'neq':
      if (value == null) return true;
      return String(value) !== condition.value;
    case 'is_null': return value === null || value === undefined;
    case 'is_not_null': return value !== null && value !== undefined;
    default: return false;
  }
}
