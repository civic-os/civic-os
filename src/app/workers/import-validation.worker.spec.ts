/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EntityPropertyType } from '@civic-os/core';

/**
 * Foreign key name matching in the import validation worker. The worker is a
 * script (it registers a message listener on load), so the spec captures that
 * listener and drives it with the messages the main thread sends. Name matching
 * is the core matcher the MCP server resolves names with (ledger N-03, N-06).
 */
describe('import-validation.worker foreign key names', () => {
  let handler: (event: { data: unknown }) => void;
  let messages: any[];

  beforeAll(async () => {
    vi.stubGlobal('addEventListener', (type: string, fn: typeof handler) => {
      if (type === 'message') handler = fn;
    });
    vi.stubGlobal('postMessage', (m: unknown) => messages.push(m));
    await import('./import-validation.worker');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

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
    expect(errors[0].errorType).toBe('Duplicate Client');
    expect(errors[0].error).toBe('"twin" matches multiple Client entries (IDs: 2, 3). Use ID instead.');
  });

  it('reports an unknown name as not found', () => {
    const { errors } = validate('nobody');
    expect(errors[0].errorType).toBe('Client not found');
    expect(errors[0].error).toBe('"nobody" not found in Client');
  });

  it('accepts a direct id', () => {
    expect(validate(2).validRows).toEqual([{ client_id: 2 }]);
  });
});
