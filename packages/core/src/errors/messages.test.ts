/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_ERROR_MESSAGES, humanizeError } from './index.js';
import type { ErrorKind } from './index.js';

describe('humanizeError', () => {
  it('E-01: every ErrorKind has a default message, and the frontend wording is kept', () => {
    const kinds: ErrorKind[] = [
      'network', 'permission', 'unique', 'notNull', 'foreignKey', 'check', 'exclusion', 'invalidInput',
      'invalidDate', 'noRows', 'notFound', 'sessionExpired', 'preconditionFailed', 'raise', 'system',
    ];
    expect(Object.keys(DEFAULT_ERROR_MESSAGES).sort()).toEqual([...kinds].sort());
    expect(humanizeError({ httpCode: 0 })).toBe('Network error. Please check your connection.');
    expect(humanizeError({ code: '42501' })).toBe('Permissions error');
    expect(humanizeError({ code: '23505' })).toBe('Record must be unique');
    expect(humanizeError({ httpCode: 404 })).toBe('Resource not found');
    expect(humanizeError({ httpCode: 401 })).toBe('Your session has expired. Please refresh the page to log in again.');
    expect(humanizeError({ code: 'P0001', message: 'boom' })).toBe('boom');
  });

  it('E-01: consumers pass partial overrides (the MCP keeps its wording); the rest stays default', () => {
    const mcp = {
      permission: 'Permission denied. You do not have access to perform this action.',
      unique: 'A record with these values already exists (duplicate).',
      notFound: 'Record not found.',
      system: ({ error }: { error: { message?: string } }) => `Error: ${error.message}`,
    };
    expect(humanizeError({ code: '42501' }, { messages: mcp })).toBe('Permission denied. You do not have access to perform this action.');
    expect(humanizeError({ code: '23505' }, { messages: mcp })).toBe('A record with these values already exists (duplicate).');
    expect(humanizeError({ httpCode: 404 }, { messages: mcp })).toBe('Record not found.');
    expect(humanizeError({ httpCode: 500, message: 'raw db text' }, { messages: mcp })).toBe('Error: raw db text');
    expect(humanizeError({ httpCode: 401 }, { messages: mcp })).toBe(DEFAULT_ERROR_MESSAGES.sessionExpired);
    expect(DEFAULT_ERROR_MESSAGES.permission).toBe('Permissions error');
  });

  it('E-03: a constraint without a configured message gets the humanized sentence plus the raw name', () => {
    const check = { code: '23514', details: 'Failing row violates constraint "clients_user_id_unique".' };
    expect(humanizeError(check)).toBe('Invalid clients user id unique. Check the value and try again. (clients_user_id_unique)');
    expect(humanizeError({ code: '23514', details: 'violates check constraint "email_address_check"' }))
      .toBe('Invalid email address. Check the value and try again. (email_address_check)');
    expect(humanizeError({ code: '23P01', details: 'conflicting key value violates exclusion constraint "no_overlap"' }))
      .toBe('This conflicts with an existing record. Please check your input and try again. (no_overlap)');
    // Every fallback path, with and without a name, with and without a lookup table
    expect(humanizeError({ code: '23514' })).toBe('Validation failed. Check the value and try again.');
    expect(humanizeError({ code: '23P01' })).toBe('This conflicts with an existing record. Please check your input and try again.');
    expect(humanizeError(check, { constraintMessages: [] })).toContain('(clients_user_id_unique)');
    expect(humanizeError(check, { constraintMessages: [{ constraint_name: 'other', error_message: 'x' }] })).toContain('(clients_user_id_unique)');
    // A configured message still wins
    expect(humanizeError(check, { constraintMessages: [{ constraint_name: 'clients_user_id_unique', error_message: 'Each user may have one client.' }] }))
      .toBe('Each user may have one client.');
  });

  it('E-04: the unrecognized error is "System Error" and the full error stays available to the consumer', () => {
    expect(humanizeError({ httpCode: 500, message: 'relation "x" does not exist' })).toBe('System Error');
    let seen: unknown;
    humanizeError({ httpCode: 500, code: 'XX000', message: 'raw' }, { messages: { system: ({ error }) => { seen = error; return 'x'; } } });
    expect(seen).toEqual({ httpCode: 500, code: 'XX000', message: 'raw' });
  });

  it('E-06: the raw-message fallback is the consumer\'s choice, made on the same error kind', () => {
    // Frontend: the HTTP status text. MCP: "PostgREST returned <status>". Both are overrides of 'system'.
    const frontend = { system: ({ error }: { error: { message?: string } }) => error.message ?? 'Unknown Error' };
    const mcp = { system: ({ error }: { error: { httpCode?: number } }) => `PostgREST returned ${error.httpCode}` };
    const err = { httpCode: 500, message: 'Internal Server Error' };
    expect(humanizeError(err, { messages: frontend })).toBe('Internal Server Error');
    expect(humanizeError(err, { messages: mcp })).toBe('PostgREST returned 500');
    expect(humanizeError({ httpCode: 500 }, { messages: frontend })).toBe('Unknown Error');
  });

  it('F-04: specific messages for 23502, 22P02, 22007/8 and 412', () => {
    expect(humanizeError({ code: '23502', message: 'null value in column "c" violates not-null constraint' })).toBe('Required field "c" is missing.');
    expect(humanizeError({ code: '23502' })).toBe('A required field is missing.');
    expect(humanizeError({ code: '22P02', message: 'invalid input syntax for type integer: "abc"' }))
      .toBe('Invalid value: expected a whole number. Check the value and try again.');
    expect(humanizeError({ code: '22P02', message: 'invalid input syntax for type date: "x"' }))
      .toBe('Invalid value: expected a date (YYYY-MM-DD). Check the value and try again.');
    expect(humanizeError({ code: '22P02', message: 'invalid input syntax for type inet: "x"' }))
      .toBe('Invalid value: expected type "inet". Check the value and try again.');
    expect(humanizeError({ code: '22P02', message: 'something else' })).toBe('Invalid value format. Check the value and try again.');
    expect(humanizeError({ code: '22007' })).toBe('Invalid date format. Use YYYY-MM-DD for dates or YYYY-MM-DDTHH:MM:SS for timestamps.');
    expect(humanizeError({ code: '22008' })).toBe(humanizeError({ code: '22007' }));
    expect(humanizeError({ httpCode: 412 })).toBe('This record has been modified since you last read it. Please fetch the latest version and try again.');
  });

  it('F-15: a P0001 without a message gets a generic fallback; a message is shown verbatim', () => {
    const generic = 'The operation was rejected. Please check your input and try again.';
    expect(humanizeError({ code: 'P0001', httpCode: 400 })).toBe(generic);
    expect(humanizeError({ code: 'P0001', httpCode: 400, message: '' })).toBe(generic);
    expect(humanizeError({ code: 'P0001', httpCode: 400, message: 'Cannot approve own request' })).toBe('Cannot approve own request');
    // status over code
    expect(humanizeError({ code: 'P0001', httpCode: 401, message: 'x' })).toBe(DEFAULT_ERROR_MESSAGES.sessionExpired);
  });

  it('F-17: friendly messages for 23503 and PGRST116; PT503 is left to the maintenance interceptor', () => {
    const fk = humanizeError({ code: '23503', httpCode: 409, message: 'insert or update on table "x" violates foreign key constraint "x_fk"', details: 'Key (b)=(9) is not present in table "y".' });
    expect(fk).toBe('This record is linked to another record that does not exist or is still in use. Check the linked record and try again.');
    expect(fk).not.toContain('x_fk');
    const none = humanizeError({ code: 'PGRST116', httpCode: 406, message: 'The result contains 0 rows' });
    expect(none).toBe('Expected exactly one matching record, but the request matched none or several.');
    expect(none).not.toContain('0 rows');
    expect(humanizeError({ code: 'PT503', httpCode: 503, message: 'maintenance' })).toBe('System Error');
  });
});
