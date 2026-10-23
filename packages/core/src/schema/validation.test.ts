/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/index.js';
import type { SchemaEntityProperty, ValidationRule } from '../model/index.js';
import { validationRules } from './validation.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function prop(is_nullable: boolean, validation_rules?: Partial<ValidationRule>[]): SchemaEntityProperty {
  return deepFreeze({
    table_catalog: '', table_schema: 'public', table_name: 't', column_name: 'c', display_name: 'C',
    sort_order: 0, column_default: '', is_nullable, data_type: 'text',
    character_maximum_length: 0, udt_schema: 'pg_catalog', udt_name: 'text',
    is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true,
    join_schema: '', join_table: '', join_column: '', geography_type: '',
    type: EntityPropertyType.TextShort,
    validation_rules: validation_rules?.map(r => ({ message: '', ...r })),
  } as SchemaEntityProperty);
}

describe('validationRules', () => {
  it('is empty for a nullable property without rules, with undefined or empty rules', () => {
    expect(validationRules(prop(true))).toEqual([]);
    expect(validationRules(prop(true, []))).toEqual([]);
  });

  it('puts required first for a not-nullable column', () => {
    expect(validationRules(prop(false))).toEqual([{ kind: 'required' }]);
  });

  it('keeps metadata order after the nullability rule, duplicating required as before', () => {
    const rules = validationRules(prop(false, [
      { type: 'pattern', value: '^a+$' },
      { type: 'required' },
      { type: 'min', value: '5' },
      { type: 'max', value: '10.5' },
      { type: 'minLength', value: '2' },
      { type: 'maxLength', value: '8' },
    ]));
    expect(rules).toEqual([
      { kind: 'required' },
      { kind: 'pattern', value: '^a+$' },
      { kind: 'required' },
      { kind: 'min', value: 5 },
      { kind: 'max', value: 10.5 },
      { kind: 'minLength', value: 2 },
      { kind: 'maxLength', value: 8 },
    ]);
  });

  it('skips valued rules with a missing or empty value', () => {
    expect(validationRules(prop(true, [
      { type: 'min' }, { type: 'max', value: '' }, { type: 'minLength' }, { type: 'maxLength', value: '' }, { type: 'pattern', value: '' },
    ]))).toEqual([]);
  });

  it('keeps "0" (a non-empty string is truthy) and converts it to the number 0', () => {
    expect(validationRules(prop(true, [{ type: 'min', value: '0' }]))).toEqual([{ kind: 'min', value: 0 }]);
  });

  it('passes non-numeric values through as NaN, as Number() does', () => {
    const [r] = validationRules(prop(true, [{ type: 'max', value: 'abc' }]));
    expect(r.kind).toBe('max');
    expect(Number.isNaN((r as { value: number }).value)).toBe(true);
  });

  it('ignores fileType and maxFileSize rules', () => {
    expect(validationRules(prop(true, [
      { type: 'fileType', value: 'image/png' }, { type: 'maxFileSize', value: '1000' },
    ]))).toEqual([]);
  });

  it('does not mutate a frozen property and returns a fresh array each call', () => {
    const p = prop(false, [{ type: 'min', value: '1' }]);
    const a = validationRules(p);
    const b = validationRules(p);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
