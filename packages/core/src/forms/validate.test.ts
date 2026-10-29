/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/index.js';
import type { SchemaEntityProperty } from '../model/index.js';
import type { ValidationRuleSpec } from '../schema/validation.js';
import { checkRule, validateProperty, validateValue } from './validate.js';

const required: ValidationRuleSpec = { kind: 'required' };

describe('checkRule: required', () => {
  it('fails only null, undefined, empty string, empty array and empty Set', () => {
    for (const v of [null, undefined, '', [], new Set()]) {
      expect(checkRule(required, v)).toEqual({ kind: 'required' });
    }
  });
  it('passes everything else, including whitespace, 0, false, NaN and {}', () => {
    for (const v of [' ', 0, '0', NaN, true, false, [1], {}, new Set([1])]) {
      expect(checkRule(required, v)).toBeNull();
    }
  });
});

describe('checkRule: min and max', () => {
  const min: ValidationRuleSpec = { kind: 'min', value: 5 };
  const max: ValidationRuleSpec = { kind: 'max', value: 5 };

  it('passes null and undefined, and any non-numeric value (parseFloat is NaN)', () => {
    for (const v of [null, undefined, '', ' ', 'abc', true, false, [], {}, NaN]) {
      expect(checkRule(min, v)).toBeNull();
      expect(checkRule(max, v)).toBeNull();
    }
  });
  it('compares numbers and numeric strings, reporting the original value', () => {
    expect(checkRule(min, 4)).toEqual({ kind: 'min', min: 5, actual: 4 });
    expect(checkRule(min, '4')).toEqual({ kind: 'min', min: 5, actual: '4' });
    expect(checkRule(min, 5)).toBeNull();
    expect(checkRule(min, 0)).toEqual({ kind: 'min', min: 5, actual: 0 });
    expect(checkRule(max, 6)).toEqual({ kind: 'max', max: 5, actual: 6 });
    expect(checkRule(max, '6')).toEqual({ kind: 'max', max: 5, actual: '6' });
    expect(checkRule(max, 5)).toBeNull();
  });
  it('applies parseFloat to strings: a numeric prefix counts', () => {
    expect(checkRule(min, '4.5abc')).toEqual({ kind: 'min', min: 5, actual: '4.5abc' });
    expect(checkRule(min, '5.5abc')).toBeNull();
    expect(checkRule(max, '5.5abc')).toEqual({ kind: 'max', max: 5, actual: '5.5abc' });
    expect(checkRule(max, 'abc5')).toBeNull();
  });
  it('coerces a one-element array through its string form, as parseFloat does', () => {
    expect(checkRule(min, [1])).toEqual({ kind: 'min', min: 5, actual: [1] });
  });
  it('never fails against a NaN bound', () => {
    expect(checkRule({ kind: 'min', value: NaN }, 1)).toBeNull();
    expect(checkRule({ kind: 'max', value: NaN }, 1)).toBeNull();
  });
});

describe('checkRule: minLength and maxLength', () => {
  const minL: ValidationRuleSpec = { kind: 'minLength', value: 3 };
  const maxL: ValidationRuleSpec = { kind: 'maxLength', value: 3 };

  it('passes values with no length, and length 0 for minLength', () => {
    for (const v of [null, undefined, '', [], 0, 5, true, false, NaN, {}]) {
      expect(checkRule(minL, v)).toBeNull();
    }
    for (const v of [null, undefined, '', [], 0, 5, true, false, NaN, {}]) {
      expect(checkRule(maxL, v)).toBeNull();
    }
  });
  it('measures strings, arrays and Sets', () => {
    expect(checkRule(minL, 'ab')).toEqual({ kind: 'minLength', requiredLength: 3, actualLength: 2 });
    expect(checkRule(minL, ' ')).toEqual({ kind: 'minLength', requiredLength: 3, actualLength: 1 });
    expect(checkRule(minL, [1])).toEqual({ kind: 'minLength', requiredLength: 3, actualLength: 1 });
    expect(checkRule(minL, new Set([1, 2]))).toEqual({ kind: 'minLength', requiredLength: 3, actualLength: 2 });
    expect(checkRule(minL, 'abc')).toBeNull();
    expect(checkRule(maxL, 'abcd')).toEqual({ kind: 'maxLength', requiredLength: 3, actualLength: 4 });
    expect(checkRule(maxL, [1, 2, 3, 4])).toEqual({ kind: 'maxLength', requiredLength: 3, actualLength: 4 });
    expect(checkRule(maxL, new Set([1, 2, 3, 4]))).toEqual({ kind: 'maxLength', requiredLength: 3, actualLength: 4 });
    expect(checkRule(maxL, 'abc')).toBeNull();
  });
  it('reads an own length property on any object, as Angular does', () => {
    expect(checkRule(minL, { length: 2 })).toEqual({ kind: 'minLength', requiredLength: 3, actualLength: 2 });
    expect(checkRule(maxL, { length: 9 })).toEqual({ kind: 'maxLength', requiredLength: 3, actualLength: 9 });
  });
});

describe('checkRule: pattern', () => {
  it('wraps a string pattern in ^ and $ and reports the wrapped form', () => {
    const rule: ValidationRuleSpec = { kind: 'pattern', value: '\\d{3}' };
    expect(checkRule(rule, '123')).toBeNull();
    expect(checkRule(rule, '1234')).toEqual({ kind: 'pattern', requiredPattern: '^\\d{3}$', actualValue: '1234' });
    expect(checkRule(rule, 'a123')).not.toBeNull();
  });
  it('does not double the anchors it finds', () => {
    const rule: ValidationRuleSpec = { kind: 'pattern', value: '^\\d{3}$' };
    expect(checkRule(rule, 'x')).toEqual({ kind: 'pattern', requiredPattern: '^\\d{3}$', actualValue: 'x' });
    const startOnly: ValidationRuleSpec = { kind: 'pattern', value: '^ab' };
    expect(checkRule(startOnly, 'abc')).not.toBeNull(); // $ appended: ^ab$
    expect(checkRule(startOnly, 'ab')).toBeNull();
    const endOnly: ValidationRuleSpec = { kind: 'pattern', value: 'ab$' };
    expect(checkRule(endOnly, 'xab')).not.toBeNull(); // ^ prepended
    expect(checkRule(endOnly, 'ab')).toBeNull();
  });
  it('wraps an alternation as a whole only at the ends, like Angular (no group)', () => {
    const rule: ValidationRuleSpec = { kind: 'pattern', value: 'a|b' };
    // ^a|b$ : "a..." matches by the first branch, "...b" by the second.
    expect(checkRule(rule, 'axyz')).toBeNull();
    expect(checkRule(rule, 'xyzb')).toBeNull();
    expect(checkRule(rule, 'xyz')).toEqual({ kind: 'pattern', requiredPattern: '^a|b$', actualValue: 'xyz' });
  });
  it('passes every empty value and never tests a non-empty non-string against a throwing path', () => {
    const rule: ValidationRuleSpec = { kind: 'pattern', value: '\\d+' };
    for (const v of [null, undefined, '', [], new Set()]) expect(checkRule(rule, v)).toBeNull();
    expect(checkRule(rule, 12)).toBeNull(); // test() stringifies: '12'
    expect(checkRule(rule, true)).toEqual({ kind: 'pattern', requiredPattern: '^\\d+$', actualValue: true });
    expect(checkRule(rule, ' ')).not.toBeNull();
    expect(checkRule(rule, 0)).toBeNull();
    expect(checkRule(rule, NaN)).not.toBeNull();
  });
  it('treats an empty pattern as no rule', () => {
    expect(checkRule({ kind: 'pattern', value: '' }, 'anything')).toBeNull();
  });
  it('throws on an invalid pattern, as Validators.pattern does when it builds the validator', () => {
    expect(() => checkRule({ kind: 'pattern', value: '(' }, 'x')).toThrow(SyntaxError);
    expect(() => checkRule({ kind: 'pattern', value: '(' }, '')).toThrow(SyntaxError);
  });
  it('gives the same answer on repeated checks (cached regex, no lastIndex state)', () => {
    const rule: ValidationRuleSpec = { kind: 'pattern', value: '[a-z]+' };
    for (let i = 0; i < 3; i++) expect(checkRule(rule, 'abc')).toBeNull();
  });
});

describe('validateValue', () => {
  it('returns one failure per failed rule, in rule order, keeping duplicates', () => {
    const rules: ValidationRuleSpec[] = [
      required,
      required,
      { kind: 'minLength', value: 3 },
      { kind: 'pattern', value: '\\d+' },
    ];
    expect(validateValue(rules, '')).toEqual([{ kind: 'required' }, { kind: 'required' }]);
    expect(validateValue(rules, 'a')).toEqual([
      { kind: 'minLength', requiredLength: 3, actualLength: 1 },
      { kind: 'pattern', requiredPattern: '^\\d+$', actualValue: 'a' },
    ]);
    expect(validateValue(rules, '123')).toEqual([]);
    expect(validateValue([], null)).toEqual([]);
  });
});

describe('validateProperty', () => {
  it('runs the property rules from validationRules', () => {
    const prop = {
      column_name: 'c', is_nullable: false, type: EntityPropertyType.TextShort,
      validation_rules: [{ type: 'minLength', value: '3', message: '' }],
    } as SchemaEntityProperty;
    expect(validateProperty(prop, null)).toEqual([{ kind: 'required' }]);
    expect(validateProperty(prop, 'ab')).toEqual([{ kind: 'minLength', requiredLength: 3, actualLength: 2 }]);
    expect(validateProperty(prop, 'abc')).toEqual([]);
  });
});
