/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SchemaEntityProperty } from '../model/index.js';
import { validationRules } from '../schema/validation.js';
import type { ValidationRuleSpec } from '../schema/validation.js';

/**
 * One failed rule. Payload names follow Angular's error payloads so adapters map 1:1.
 *
 * @consumer typed createFormStore
 */
export type ValidationFailure =
  | { readonly kind: 'required' }
  | { readonly kind: 'min'; readonly min: number; readonly actual: unknown }
  | { readonly kind: 'max'; readonly max: number; readonly actual: unknown }
  | { readonly kind: 'minLength'; readonly requiredLength: number; readonly actualLength: number }
  | { readonly kind: 'maxLength'; readonly requiredLength: number; readonly actualLength: number }
  | { readonly kind: 'pattern'; readonly requiredPattern: string; readonly actualValue: unknown }
  /** An error a backend holds that no core rule produced (a server error, a framework-only validator). */
  | { readonly kind: 'other'; readonly key: string; readonly detail: unknown };

// The checks below reproduce Angular's Validators (forms.mjs: isEmptyInputValue, lengthOrSize, minValidator,
// maxValidator, requiredValidator, minLengthValidator, maxLengthValidator, patternValidator) decision for
// decision, without importing Angular. src/app/testing/golden/validator-parity.spec.ts proves the match
// against the real validators over every golden variant.

/** Angular's lengthOrSize: arrays and strings have a length, a Set has a size, everything else none. */
function lengthOrSize(value: unknown): number | null {
  if (value == null) return null;
  if (Array.isArray(value) || typeof value === 'string') return value.length;
  if (value instanceof Set) return value.size;
  return null;
}

/** Angular's isEmptyInputValue: null, undefined, or a zero-length string, array or Set ({} and 0 are not empty). */
function isEmptyInputValue(value: unknown): boolean {
  return value == null || lengthOrSize(value) === 0;
}

/** Angular reads `control.value?.length ?? lengthOrSize(value)`: any object with a `length` counts, not just arrays. */
function lengthOf(value: unknown): number | null {
  const own = (value as { length?: unknown } | null | undefined)?.length;
  return (own ?? lengthOrSize(value)) as number | null;
}

const patternCache = new Map<string, { readonly regex: RegExp; readonly wrapped: string }>();

/**
 * Angular wraps a string pattern in `^...$` unless it already starts with `^` or ends with `$`. An invalid
 * pattern throws a SyntaxError, as `Validators.pattern` does when the validator is created; here that is
 * when the rule is first checked.
 */
function compilePattern(pattern: string): { readonly regex: RegExp; readonly wrapped: string } {
  let entry = patternCache.get(pattern);
  if (!entry) {
    let wrapped = '';
    if (pattern.charAt(0) !== '^') wrapped += '^';
    wrapped += pattern;
    if (pattern.charAt(pattern.length - 1) !== '$') wrapped += '$';
    entry = { regex: new RegExp(wrapped), wrapped };
    patternCache.set(pattern, entry);
  }
  return entry;
}

/**
 * Checks one rule against a value; null when it passes. Every rule but `required` passes an empty value
 * (null, undefined, '', [] where Angular says so). `min` and `max` apply `parseFloat` to the value, so '5.5abc'
 * counts as 5.5 and a non-numeric value passes; the `actual` payload is the original value, not the parsed one.
 *
 * @consumer custom-app
 */
export function checkRule(rule: ValidationRuleSpec, value: unknown): ValidationFailure | null {
  switch (rule.kind) {
    case 'required':
      return isEmptyInputValue(value) ? { kind: 'required' } : null;
    case 'min': {
      if (value == null || rule.value == null) return null;
      const n = parseFloat(String(value));
      return !isNaN(n) && n < rule.value ? { kind: 'min', min: rule.value, actual: value } : null;
    }
    case 'max': {
      if (value == null || rule.value == null) return null;
      const n = parseFloat(String(value));
      return !isNaN(n) && n > rule.value ? { kind: 'max', max: rule.value, actual: value } : null;
    }
    case 'minLength': {
      const length = lengthOf(value);
      if (length === null || length === 0) return null;
      return length < rule.value ? { kind: 'minLength', requiredLength: rule.value, actualLength: length } : null;
    }
    case 'maxLength': {
      const length = lengthOf(value);
      return length !== null && length > rule.value
        ? { kind: 'maxLength', requiredLength: rule.value, actualLength: length }
        : null;
    }
    case 'pattern': {
      if (!rule.value) return null; // Angular: an empty pattern is the null validator
      const { regex, wrapped } = compilePattern(rule.value);
      if (isEmptyInputValue(value)) return null;
      return regex.test(value as string) ? null : { kind: 'pattern', requiredPattern: wrapped, actualValue: value };
    }
  }
}

/**
 * Every failure of `rules` for `value`, one per failed rule in rule order. Duplicates are kept: a
 * not-nullable column that also carries a `required` rule fails twice.
 *
 * @consumer custom-app
 */
export function validateValue(rules: readonly ValidationRuleSpec[], value: unknown): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  for (const rule of rules) {
    const failure = checkRule(rule, value);
    if (failure) failures.push(failure);
  }
  return failures;
}

/**
 * `validateValue(validationRules(prop), value)`.
 *
 * @consumer custom-app
 */
export function validateProperty(prop: SchemaEntityProperty, value: unknown): ValidationFailure[] {
  return validateValue(validationRules(prop), value);
}
