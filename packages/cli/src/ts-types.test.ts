/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { actionParamType, columnType } from './ts-types.js';

describe('columnType', () => {
  it.each([
    ['int8', 'bigint', 'number'],
    ['numeric', 'numeric', 'number'],
    ['money', 'numeric', 'number'],
    ['bool', 'boolean', 'boolean'],
    ['uuid', 'uuid', 'string'],
    ['timestamptz', 'timestamp with time zone', 'string'],
    ['email_address', 'character varying', 'string'],
    ['geography', 'USER-DEFINED', 'string'],
    ['time_slot', 'USER-DEFINED', 'string'],
    ['jsonb', 'jsonb', 'unknown'],
  ])('%s is %s', (udt, data, ts) => {
    expect(columnType({ udt_name: udt, data_type: data })).toBe(ts);
  });

  it('maps an integrator domain through its base type', () => {
    expect(columnType({ udt_name: 'genesee_parcel_id', data_type: 'character varying' })).toBe('string');
    expect(columnType({ udt_name: 'some_domain', data_type: 'integer' })).toBe('number');
  });

  it('falls back to unknown, never any', () => {
    expect(columnType({ udt_name: 'tsrange', data_type: 'USER-DEFINED' })).toBe('unknown');
  });

  it('maps arrays by element type', () => {
    expect(columnType({ udt_name: '_text', data_type: 'ARRAY' })).toBe('string[]');
    expect(columnType({ udt_name: '_tsrange', data_type: 'ARRAY' })).toBe('unknown[]');
    expect(columnType({ udt_name: '_int4', data_type: 'ARRAY' })).toBe('number[]');
  });
});

describe('actionParamType', () => {
  it('covers every parameter type', () => {
    expect(actionParamType('text', undefined)).toBe('string');
    expect(actionParamType('money', undefined)).toBe('number');
    expect(actionParamType('boolean', undefined)).toBe('boolean');
    expect(actionParamType('status', undefined)).toBe('number');
    expect(actionParamType('foreign_key', 'string')).toBe('string');
    expect(actionParamType('foreign_key', undefined)).toBe('unknown');
  });
});
