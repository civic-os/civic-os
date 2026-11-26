/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EntityPropertyType } from '@civic-os/core';

// The worker is a script that registers its message listener once, on first import, so both
// describes below share one capture of it.
type WorkerHandler = (event: { data: unknown }) => void;
let handler: WorkerHandler;
let messages: any[];

beforeAll(async () => {
  vi.stubGlobal('addEventListener', (type: string, fn: WorkerHandler) => {
    if (type === 'message') handler = fn;
  });
  vi.stubGlobal('postMessage', (m: unknown) => messages.push(m));
  await import('./import-validation.worker');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/**
 * Foreign key name matching in the import validation worker. The worker is a
 * script (it registers a message listener on load), so the spec captures that
 * listener and drives it with the messages the main thread sends. Name matching
 * is the core matcher the MCP server resolves names with (ledger N-03, N-06).
 */
describe('import-validation.worker foreign key names', () => {
  const fkProperty = {
    column_name: 'client_id',
    display_name: 'Client',
    type: EntityPropertyType.ForeignKeyName,
    join_table: 'clients',
    is_nullable: false,
  };

  const lookups = {
    clients: {
      validIds: [1, 2, 3],
      displayNameToIds: { acme: [1], twin: [2, 3] },
      idsToDisplayName: { 1: 'Acme', 2: 'Twin', 3: 'TWIN' },
    },
  };

  function validate(value: unknown): { validRows: any[]; errors: any[] } {
    messages = [];
    handler({
      data: {
        type: 'validate',
        data: { rows: [{ Client: value }], properties: [fkProperty], fkLookups: lookups, entityKey: 'orders' },
      },
    });
    const complete = messages.find(m => m.type === 'complete');
    return { validRows: complete.results.validRows, errors: complete.results.errorSummary.allErrors };
  }

  it('resolves a name case-insensitively', () => {
    expect(validate('ACME').validRows).toEqual([{ client_id: 1 }]);
  });

  it('trims the name (N-03)', () => {
    expect(validate('  Acme  ').validRows).toEqual([{ client_id: 1 }]);
  });

  it('reports a duplicate name as ambiguous and lists the candidate ids (N-06)', () => {
    const { validRows, errors } = validate('twin');
    expect(validRows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].errorTypeKey).toBe('import_validation.type_fk_duplicate');
    expect(errors[0].errorTypeParams).toEqual({ column: 'Client' });
    expect(errors[0].errorKey).toBe('import_validation.err_fk_ambiguous');
    expect(errors[0].errorParams).toEqual({ value: 'twin', column: 'Client', ids: '2, 3' });
    expect(errors[0].error).toBeUndefined();
  });

  it('reports an unknown name as not found', () => {
    const { errors } = validate('nobody');
    expect(errors[0].errorTypeKey).toBe('import_validation.type_fk_not_found');
    expect(errors[0].errorTypeParams).toEqual({ column: 'Client' });
    expect(errors[0].errorKey).toBe('import_validation.err_fk_not_found');
    expect(errors[0].errorParams).toEqual({ value: 'nobody', column: 'Client' });
  });

  it('accepts a direct id', () => {
    expect(validate(2).validRows).toEqual([{ client_id: 2 }]);
  });
});

/**
 * Row error messages as translation keys (issue #170). The worker cannot reach the TranslationService,
 * so it reports keys with parameters and the import modal translates them; an integrator's rule
 * message and a thrown Error's message are literal text.
 */
describe('import-validation.worker message keys', () => {
  const prop = (type: EntityPropertyType, overrides: Record<string, unknown> = {}) => ({
    column_name: 'col',
    display_name: 'Col',
    type,
    is_nullable: false,
    ...overrides,
  });

  function errorsFor(property: any, value: unknown) {
    messages = [];
    handler({ data: { type: 'validate', data: { rows: [{ Col: value }], properties: [property], fkLookups: {}, entityKey: 't' } } });
    const complete = messages.find(m => m.type === 'complete');
    return complete.results.errorSummary.allErrors as any[];
  }

  it('reports a missing required value with the required keys', () => {
    const [e] = errorsFor(prop(EntityPropertyType.TextShort), '');
    expect(e).toMatchObject({ row: 3, column: 'Col', errorKey: 'import_validation.err_required', errorTypeKey: 'import_validation.type_required' });
  });

  it('reports text length with the limit as a parameter', () => {
    const rules = [{ type: 'minLength', value: '5' }, { type: 'maxLength', value: '2' }];
    const errors = errorsFor(prop(EntityPropertyType.TextShort, { validation_rules: rules }), 'abc');
    expect(errors.map(e => [e.errorKey, e.errorParams, e.errorTypeKey])).toEqual([
      ['import_validation.err_min_length', { n: '5' }, 'import_validation.type_text_length'],
      ['import_validation.err_max_length', { n: '2' }, 'import_validation.type_text_length'],
    ]);
  });

  it('passes an integrator rule message through as literal text with no key', () => {
    const rules = [{ type: 'minLength', value: '5', message: 'Too short for us' }];
    const [e] = errorsFor(prop(EntityPropertyType.TextShort, { validation_rules: rules }), 'abc');
    expect(e.error).toBe('Too short for us');
    expect(e.errorKey).toBeUndefined();
    expect(e.errorTypeKey).toBe('import_validation.type_text_length');
  });

  it('keys number, boolean, color, email and phone errors', () => {
    const cases: Array<[EntityPropertyType, unknown, string, string]> = [
      [EntityPropertyType.IntegerNumber, 'x', 'err_number', 'type_number'],
      [EntityPropertyType.Boolean, 'maybe', 'err_boolean', 'type_boolean'],
      [EntityPropertyType.Color, 'red', 'err_color', 'type_color'],
      [EntityPropertyType.Email, 'nope', 'err_email', 'type_email'],
      [EntityPropertyType.Telephone, '12', 'err_phone', 'type_phone'],
    ];
    for (const [type, value, err, typ] of cases) {
      const [e] = errorsFor(prop(type), value);
      expect(e.errorKey, err).toBe('import_validation.' + err);
      expect(e.errorTypeKey, typ).toBe('import_validation.' + typ);
    }
  });

  it('keys a geopoint range error', () => {
    const [e] = errorsFor(prop(EntityPropertyType.GeoPoint), '95,10');
    expect(e.errorKey).toBe('import_validation.err_geopoint_range');
    expect(e.errorTypeKey).toBe('import_validation.type_geopoint');
  });

  it('every error carries an error type key and either a key or literal text', () => {
    const errors = [
      ...errorsFor(prop(EntityPropertyType.TextShort), ''),
      ...errorsFor(prop(EntityPropertyType.Email), 'nope'),
      ...errorsFor(prop(EntityPropertyType.DateTime), 'not a date'),
    ];
    expect(errors.length).toBe(3);
    for (const e of errors) {
      expect(e.errorTypeKey).toMatch(/^import_validation\.type_/);
      expect(e.errorKey ?? e.error).toBeTruthy();
    }
  });
});
