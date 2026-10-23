/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyPostgrestError, extractConstraintName } from './index.js';

/** Inline copy of the original ErrorService.parseToHuman branching, as an oracle. */
function oracle(err: { httpCode?: number; code?: string; message?: string }): string {
  if (err.httpCode === 0) return 'Network error. Please check your connection.';
  else if (err.code == '42501') return 'Permissions error';
  else if (err.code == '23505') return 'Record must be unique';
  else if (err.code == '23514') return 'Validation failed';
  else if (err.code == '23P01') return 'This conflicts with an existing record.';
  else if (err.httpCode == 404) return 'Resource not found';
  else if (err.httpCode == 401) return 'Your session has expired. Please refresh the page to log in again.';
  else if (err.code == 'P0001') return err.message as string;
  return 'System Error';
}

const RENDER = {
  network: () => 'Network error. Please check your connection.',
  permission: () => 'Permissions error',
  unique: () => 'Record must be unique',
  check: () => 'Validation failed',
  exclusion: () => 'This conflicts with an existing record.',
  notFound: () => 'Resource not found',
  sessionExpired: () => 'Your session has expired. Please refresh the page to log in again.',
  raise: (m?: string) => m as string,
  system: () => 'System Error',
} as const;

describe('classifyPostgrestError', () => {
  const cases: Array<[object, string]> = [
    [{ httpCode: 0 }, 'network'],
    [{ httpCode: 0, code: '42501' }, 'network'],
    [{ code: '42501' }, 'permission'],
    [{ code: '23505' }, 'unique'],
    [{ code: '23514' }, 'check'],
    [{ code: '23P01', httpCode: 404 }, 'exclusion'],
    [{ httpCode: 404, code: 'P0001' }, 'notFound'],
    [{ httpCode: 401, code: 'P0001' }, 'sessionExpired'],
    [{ code: 'P0001', message: 'boom' }, 'raise'],
    [{ code: 'PGRST301', httpCode: 403 }, 'system'],
    [{}, 'system'],
  ];
  for (const [input, kind] of cases) {
    it(`${JSON.stringify(input)} -> ${kind}`, () => {
      expect(classifyPostgrestError(Object.freeze(input) as never).kind).toBe(kind);
    });
  }

  it('carries the RAISE message and constraint names as params', () => {
    expect(classifyPostgrestError({ code: 'P0001', message: 'x' }).params).toEqual({ message: 'x' });
    expect(classifyPostgrestError({ code: '23514', details: 'violates check constraint "c1"' }).params).toEqual({ constraintName: 'c1' });
    expect(classifyPostgrestError({ code: '23P01', message: 'violates exclusion constraint "c2"' }).params).toEqual({ constraintName: 'c2' });
    expect(classifyPostgrestError({ code: '23514' }).params).toEqual({});
  });

  it('extractConstraintName prefers details, falls back to message', () => {
    expect(extractConstraintName({ details: 'constraint "a"', message: 'constraint "b"' })).toBe('a');
    expect(extractConstraintName({ details: 'no match', message: 'constraint "b"' })).toBe('b');
    expect(extractConstraintName({ message: 'none' })).toBeUndefined();
  });

  it('rendered kind equals the original branching for any input (oracle)', () => {
    const arb = fc.record(
      {
        httpCode: fc.constantFrom(0, 401, 404, 403, 500, undefined),
        code: fc.constantFrom('42501', '23505', '23514', '23P01', 'P0001', 'PGRST301', '', undefined),
        message: fc.string(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(arb, (err) => {
        const { kind, params } = classifyPostgrestError(err);
        expect(RENDER[kind](params.message)).toBe(oracle(err));
      }),
    );
  });
});
