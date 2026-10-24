/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- tests deliberately pass malformed operators and payloads. */

import { describe, expect, it } from 'vitest';
import type { ActionCondition } from '../model/index.js';
import { evaluateActionCondition, evaluateCondition, evaluateGuidedFormCondition, extractConditionFieldNames } from './index.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o as object).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

const record = deepFreeze({ n: 5, s: 'a', status_id: { id: 3, status_key: 'open' }, nul: null });

describe('evaluateActionCondition', () => {
  it('null condition is true, null data is false', () => {
    expect(evaluateActionCondition(null, null)).toBe(true);
    expect(evaluateActionCondition({ field: 'n', operator: 'eq', value: 1 }, null)).toBe(false);
  });
  it('operators', () => {
    const t = (operator: any, value: any, field = 'n') => evaluateActionCondition({ field, operator, value }, record);
    expect(t('eq', 5)).toBe(true);
    expect(t('ne', 5)).toBe(false);
    expect(t('gt', 4)).toBe(true);
    expect(t('lt', 4)).toBe(false);
    expect(t('gte', 5)).toBe(true);
    expect(t('lte', 4)).toBe(false);
    expect(t('gt', '4')).toBe(false);
    expect(t('in', [5, 6])).toBe(true);
    expect(t('in', 5)).toBe(false);
    expect(t('is_null', undefined, 'nul')).toBe(true);
    expect(t('is_not_null', undefined, 'n')).toBe(true);
  });
  it('FK embed reduces to id; dot-notation traverses', () => {
    expect(evaluateActionCondition({ field: 'status_id', operator: 'eq', value: 3 }, record)).toBe(true);
    expect(evaluateActionCondition({ field: 'status_id.status_key', operator: 'eq', value: 'open' }, record)).toBe(true);
    expect(evaluateActionCondition({ field: 's.x', operator: 'is_null' }, record)).toBe(true);
  });
  it('or/and compose', () => {
    const c: ActionCondition = deepFreeze({ and: [{ field: 'n', operator: 'gt', value: 1 }, { or: [{ field: 's', operator: 'eq', value: 'z' }, { field: 's', operator: 'eq', value: 'a' }] }] } as ActionCondition);
    expect(evaluateActionCondition(c, record)).toBe(true);
  });
  it('reports unknown operators through the callback and returns false', () => {
    const seen: unknown[] = [];
    expect(evaluateActionCondition({ field: 'n', operator: 'bogus' as any }, record, (o) => seen.push(o))).toBe(false);
    expect(seen).toEqual(['bogus']);
  });
  it('extractConditionFieldNames returns base columns', () => {
    const c: ActionCondition = deepFreeze({ or: [{ field: 'status_id.status_key', operator: 'eq', value: 'x' }, { and: [{ field: 'n', operator: 'gt', value: 0 }] }] } as ActionCondition);
    expect(extractConditionFieldNames(c)).toEqual(['status_id', 'n']);
    expect(extractConditionFieldNames(null)).toEqual([]);
  });
});

describe('evaluateGuidedFormCondition', () => {
  const c = (operator: any, value: string | null = null, field = 'f') => ({ field, operator, value });
  it('eq/neq coerce to string and treat missing differently', () => {
    expect(evaluateGuidedFormCondition(c('eq', '7'), { f: 7 })).toBe(true);
    expect(evaluateGuidedFormCondition(c('eq', '7'), { f: { id: 7 } })).toBe(true);
    expect(evaluateGuidedFormCondition(c('eq', '7'), {})).toBe(false);
    expect(evaluateGuidedFormCondition(c('neq', '7'), {})).toBe(true);
    expect(evaluateGuidedFormCondition(c('neq', '7'), { f: 7 })).toBe(false);
  });
  it('is_null / is_not_null / unknown', () => {
    expect(evaluateGuidedFormCondition(c('is_null'), null)).toBe(true);
    expect(evaluateGuidedFormCondition(c('is_not_null'), { f: 0 })).toBe(true);
    expect(evaluateGuidedFormCondition(c('gt'), { f: 0 })).toBe(false);
  });
});

describe('evaluateCondition', () => {
  it('C-06: malformed conditions fail closed and never throw', () => {
    const data = { n: 5 };
    const bad: unknown[] = [
      { or: [null] }, { and: [null] }, { or: [5] }, { or: 'x' }, { and: {} },
      { field: 7, operator: 'eq', value: 1 }, { operator: 'eq' }, 'oops', 42, [],
      { field: 'n', operator: 'bogus', value: 5 }, { or: [{ field: 'n', operator: 'bogus' }] },
    ];
    for (const c of bad) {
      expect(() => evaluateCondition(c, data)).not.toThrow();
      expect(evaluateCondition(c, data)).toBe(false);
      expect(evaluateCondition(c, data, { coercion: 'string' })).toBe(false);
    }
    // a valid sibling still works, and an absent condition is still true
    expect(evaluateCondition({ or: [null, { field: 'n', operator: 'eq', value: 5 }] }, data)).toBe(true);
    expect(evaluateCondition(null, data)).toBe(true);
    expect(extractConditionFieldNames({ or: [null, { field: 'n', operator: 'eq', value: 1 }] } as any)).toEqual(['n']);
    const seen: unknown[] = [];
    evaluateCondition({ field: 'n', operator: 'bogus' }, data, { onUnknownOperator: o => seen.push(o) });
    expect(seen).toEqual(['bogus']);
  });

  it('F-16: one evaluator, explicit coercion; neq against null follows the action evaluator', () => {
    const eq = (v: any) => ({ field: 'f', operator: 'eq', value: v });
    const ne = (op: string, v: any) => ({ field: 'f', operator: op, value: v });
    // strict (default): no coercion
    expect(evaluateCondition(eq('7'), { f: 7 })).toBe(false);
    expect(evaluateCondition(eq(7), { f: 7 })).toBe(true);
    // string: coerced both ways
    expect(evaluateCondition(eq('7'), { f: 7 }, { coercion: 'string' })).toBe(true);
    expect(evaluateCondition({ field: 'f', operator: 'in', value: ['7', 8] }, { f: 7 }, { coercion: 'string' })).toBe(true);
    // neq is an alias of ne
    expect(evaluateCondition(ne('neq', 7), { f: 7 })).toBe(false);
    expect(evaluateCondition(ne('neq', 7), { f: 8 })).toBe(true);
    // null alignment: a null record value is not unequal to null, in both modes
    for (const coercion of ['strict', 'string'] as const) {
      expect(evaluateCondition(ne('neq', null), { f: null }, { coercion })).toBe(false);
      expect(evaluateCondition(ne('ne', null), { f: null }, { coercion })).toBe(false);
      expect(evaluateCondition(eq(null), { f: null }, { coercion })).toBe(true);
    }
    expect(evaluateGuidedFormCondition({ field: 'f', operator: 'eq', value: null }, { f: null })).toBe(true);
    expect(evaluateGuidedFormCondition({ field: 'f', operator: 'neq', value: null }, { f: null })).toBe(false);
    // ordering stays number-only
    expect(evaluateCondition({ field: 'f', operator: 'gt', value: 1 }, { f: '5' }, { coercion: 'string' })).toBe(false);
  });
});
