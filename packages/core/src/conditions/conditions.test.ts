/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- tests deliberately pass malformed operators and payloads. */

import { describe, expect, it } from 'vitest';
import type { ActionCondition } from '../model/index.js';
import { evaluateActionCondition, evaluateGuidedFormCondition, extractConditionFieldNames } from './index.js';

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
