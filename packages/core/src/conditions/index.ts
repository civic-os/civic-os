/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Action and guided-form condition evaluation (P1.1e). */
export { evaluateActionCondition, evaluateCondition, extractConditionFieldNames } from './action-condition.js';
export type { ConditionCoercion, EvaluateConditionOptions } from './action-condition.js';
export { evaluateGuidedFormCondition } from './guided-form-condition.js';
