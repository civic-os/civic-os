/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyPostgrestError, ERROR_KIND_PRECEDENCE, extractConstraintName } from './classify.js';
import { DEFAULT_ERROR_MESSAGES } from './messages.js';

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

/** Wording of the original branching only; the kinds added by F-04 / F-17 are tested in messages.test.ts. */
const RENDER: Record<string, (m?: string) => string> = {
  network: () => 'Network error. Please check your connection.',
  permission: () => 'Permissions error',
  unique: () => 'Record must be unique',
  check: () => 'Validation failed',
  exclusion: () => 'This conflicts with an existing record.',
  notFound: () => 'Resource not found',
  sessionExpired: () => 'Your session has expired. Please refresh the page to log in again.',
  raise: (m?: string) => m as string,
  system: () => 'System Error',
};

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

  it('F-15: status beats code for a RAISE, and the precedence is explicit and exhaustive', () => {
    // 401 / 404 / 412 (HTTP status) win over P0001 (code); a code kind wins over the status.
    expect(classifyPostgrestError({ httpCode: 401, code: 'P0001', message: 'x' }).kind).toBe('sessionExpired');
    expect(classifyPostgrestError({ httpCode: 404, code: 'P0001', message: 'x' }).kind).toBe('notFound');
    expect(classifyPostgrestError({ httpCode: 412, code: 'P0001', message: 'x' }).kind).toBe('preconditionFailed');
    expect(classifyPostgrestError({ httpCode: 400, code: 'P0001', message: 'x' }).kind).toBe('raise');
    expect(classifyPostgrestError({ httpCode: 404, code: '42501' }).kind).toBe('permission');
    expect(classifyPostgrestError({ httpCode: 0, code: 'P0001' }).kind).toBe('network');
    const idx = (k: string) => ERROR_KIND_PRECEDENCE.indexOf(k as never);
    expect(idx('sessionExpired')).toBeLessThan(idx('raise'));
    expect(idx('notFound')).toBeLessThan(idx('raise'));
    expect(idx('permission')).toBeLessThan(idx('notFound'));
    expect(ERROR_KIND_PRECEDENCE[0]).toBe('network');
    expect(ERROR_KIND_PRECEDENCE[ERROR_KIND_PRECEDENCE.length - 1]).toBe('system');
    expect(new Set(ERROR_KIND_PRECEDENCE).size).toBe(Object.keys(DEFAULT_ERROR_MESSAGES).length);
    // A P0001 without a message carries no message param.
    expect(classifyPostgrestError({ code: 'P0001', httpCode: 400 })).toEqual({ kind: 'raise', params: {} });
  });

  it('F-04 / F-17: the codes the MCP names get their own kinds, with the values to name', () => {
    expect(classifyPostgrestError({ code: '23502', message: 'null value in column "c" violates not-null constraint' })).toEqual({ kind: 'notNull', params: { column: 'c' } });
    expect(classifyPostgrestError({ code: '23502' })).toEqual({ kind: 'notNull', params: {} });
    expect(classifyPostgrestError({ code: '22P02', message: 'invalid input syntax for type integer: "abc"' })).toEqual({ kind: 'invalidInput', params: { expectedType: 'integer' } });
    expect(classifyPostgrestError({ code: '22007' }).kind).toBe('invalidDate');
    expect(classifyPostgrestError({ code: '22008' }).kind).toBe('invalidDate');
    expect(classifyPostgrestError({ httpCode: 412 }).kind).toBe('preconditionFailed');
    expect(classifyPostgrestError({ code: '23503', httpCode: 409 }).kind).toBe('foreignKey');
    expect(classifyPostgrestError({ code: 'PGRST116', httpCode: 406 }).kind).toBe('noRows');
    // PT503 stays with the maintenance interceptor: no kind of its own.
    expect(classifyPostgrestError({ code: 'PT503', httpCode: 503 }).kind).toBe('system');
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
