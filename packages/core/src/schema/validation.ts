/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SchemaEntityProperty } from '../model/index.js';

/**
 * Data description of one form validator. A framework adapter (Angular
 * `Validators`, a schema library, a server check) maps each rule onto its own
 * primitive; the core only decides which rules apply and in what order.
 *
 * Numeric rules carry the already converted `Number(rule.value)`, which may be
 * `NaN` when the metadata value is not numeric (preserved as-is). `fileType`
 * and `maxFileSize` metadata rules produce no entry: they are enforced by the
 * file upload components, not by form validators.
 *
 * @consumer typed validationRules
 */
export type ValidationRuleSpec =
  | { readonly kind: 'required' }
  | { readonly kind: 'min'; readonly value: number }
  | { readonly kind: 'max'; readonly value: number }
  | { readonly kind: 'minLength'; readonly value: number }
  | { readonly kind: 'maxLength'; readonly value: number }
  | { readonly kind: 'pattern'; readonly value: string };

/**
 * The validators that apply to a property, in application order: `required`
 * first when the column is not nullable (backwards compatibility), then one
 * entry per `validation_rules` metadata row that has a value (a `required` rule
 * needs none). A not-nullable column that also carries a `required` rule yields
 * two `required` entries, as it always has.
 *
 * @consumer app
 */
export function validationRules(prop: SchemaEntityProperty): ValidationRuleSpec[] {
  const rules: ValidationRuleSpec[] = [];

  // First, check is_nullable for backwards compatibility
  if (!prop.is_nullable) {
    rules.push({ kind: 'required' });
  }

  // Then, add validators from validation_rules metadata
  if (prop.validation_rules && prop.validation_rules.length > 0) {
    prop.validation_rules.forEach(rule => {
      switch (rule.type) {
        case 'required':
          rules.push({ kind: 'required' });
          break;
        case 'min':
          if (rule.value) {
            rules.push({ kind: 'min', value: Number(rule.value) });
          }
          break;
        case 'max':
          if (rule.value) {
            rules.push({ kind: 'max', value: Number(rule.value) });
          }
          break;
        case 'minLength':
          if (rule.value) {
            rules.push({ kind: 'minLength', value: Number(rule.value) });
          }
          break;
        case 'maxLength':
          if (rule.value) {
            rules.push({ kind: 'maxLength', value: Number(rule.value) });
          }
          break;
        case 'pattern':
          if (rule.value) {
            rules.push({ kind: 'pattern', value: rule.value });
          }
          break;
      }
    });
  }

  return rules;
}
