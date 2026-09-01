/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for renderMarkdownTable() and renderRecordDetail().
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdownTable, renderRecordDetail } from '../../formatters/markdown-table.js';
import { EntityPropertyType } from '../../interfaces.js';
import type { SchemaProperty } from '../../interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProp(overrides: Partial<SchemaProperty> = {}): SchemaProperty {
  return {
    table_name: 'projects',
    column_name: 'name',
    display_name: 'Name',
    data_type: 'character varying',
    udt_name: 'varchar',
    udt_schema: 'pg_catalog',
    sort_order: 1,
    join_schema: '',
    join_table: '',
    join_column: '',
    geography_type: '',
    is_nullable: true,
    is_updatable: true,
    is_identity: false,
    is_generated: false,
    is_self_referencing: false,
    column_default: '',
    type: EntityPropertyType.TextShort,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderMarkdownTable()
// ---------------------------------------------------------------------------

describe('renderMarkdownTable()', () => {
  it('returns placeholder when records array is empty', () => {
    const result = renderMarkdownTable([], [makeProp()]);
    expect(result).toBe('_No records found._');
  });

  it('returns placeholder when no columns to display', () => {
    // No properties AND includeId=false → no columns
    const result = renderMarkdownTable([{ id: 1 }], [], { includeId: false });
    expect(result).toBe('_No columns to display._');
  });

  it('renders a simple single-row table with ID column', () => {
    const props = [makeProp({ column_name: 'title', display_name: 'Title' })];
    const records = [{ id: 1, title: 'Alpha' }];

    const result = renderMarkdownTable(records, props, { includeId: true });
    const lines = result.split('\n');

    // Header row, separator, one data row
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('ID');
    expect(lines[0]).toContain('Title');
    expect(lines[1]).toMatch(/^\|[-| ]+\|$/);
    expect(lines[2]).toContain('1');
    expect(lines[2]).toContain('Alpha');
  });

  it('omits ID column when includeId=false', () => {
    const props = [makeProp({ column_name: 'title', display_name: 'Title' })];
    const records = [{ id: 1, title: 'Alpha' }];

    const result = renderMarkdownTable(records, props, { includeId: false });

    expect(result).not.toContain('| ID');
    expect(result).toContain('Title');
  });

  it('renders multiple rows', () => {
    const props = [makeProp({ column_name: 'name', display_name: 'Name' })];
    const records = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Carol' },
    ];

    const result = renderMarkdownTable(records, props);
    const lines = result.split('\n');

    // Header + separator + 3 data rows = 5 lines
    expect(lines).toHaveLength(5);
  });

  it('truncates long values with ellipsis', () => {
    const longValue = 'A'.repeat(50);
    const props = [makeProp({ column_name: 'description', display_name: 'Description' })];
    const records = [{ id: 1, description: longValue }];

    const result = renderMarkdownTable(records, props, { maxColumnWidth: 20 });
    // The cell value should be truncated
    expect(result).toContain('…');
    // Should not contain the full 50-char value
    expect(result).not.toContain('A'.repeat(40));
  });

  it('respects custom maxColumnWidth', () => {
    const props = [makeProp({ column_name: 'text', display_name: 'Text' })];
    const records = [{ id: 1, text: 'Short' }];

    const result = renderMarkdownTable(records, props, { maxColumnWidth: 5 });
    // 'Short' is exactly 5 chars — should not be truncated
    expect(result).toContain('Short');
  });

  it('escapes pipe characters in cell values', () => {
    const props = [makeProp({ column_name: 'notes', display_name: 'Notes' })];
    const records = [{ id: 1, notes: 'A | B' }];

    const result = renderMarkdownTable(records, props);
    expect(result).toContain('A \\| B');
  });

  it('escapes newlines in cell values (converts to space)', () => {
    const props = [makeProp({ column_name: 'notes', display_name: 'Notes' })];
    const records = [{ id: 1, notes: 'Line1\nLine2' }];

    const result = renderMarkdownTable(records, props);
    expect(result).not.toContain('\n\n'); // No bare newline mid-cell
    expect(result).toContain('Line1 Line2');
  });

  it('renders null values as empty string', () => {
    const props = [makeProp({ column_name: 'optional', display_name: 'Optional' })];
    const records = [{ id: 1, optional: null }];

    const result = renderMarkdownTable(records, props);
    const lines = result.split('\n');
    expect(lines[2]).toBeDefined();
    // The ID cell should contain "1" and the optional cell should be empty/whitespace
    expect(lines[2]).toContain('1');
    // Verify null produced an empty cell (no content after the ID cell)
    expect(lines[2]).toMatch(/\|\s*1\s*\|\s*\|/);
  });

  it('formats FK object via formatValue', () => {
    const fkProp = makeProp({
      column_name: 'client_id',
      display_name: 'Client',
      join_table: 'clients',
      join_column: 'id',
      type: EntityPropertyType.ForeignKeyName,
    });
    const records = [{ id: 5, client_id: { id: 42, display_name: 'Acme Corp' } }];

    const result = renderMarkdownTable(records, [fkProp]);
    expect(result).toContain('Acme Corp');
    expect(result).not.toContain('"id"');
  });

  it('formats status objects via formatValue', () => {
    const statusProp = makeProp({
      column_name: 'status_id',
      display_name: 'Status',
      join_table: 'statuses',
      join_column: 'id',
      status_entity_type: 'projects',
      type: EntityPropertyType.Status,
    });
    const records = [{ id: 1, status_id: { id: 1, display_name: 'Active', color: 'green' } }];

    const result = renderMarkdownTable(records, [statusProp]);
    expect(result).toContain('Active');
  });

  it('formats boolean values as Yes/No', () => {
    const boolProp = makeProp({
      column_name: 'is_active',
      display_name: 'Active',
      udt_name: 'bool',
      type: EntityPropertyType.Boolean,
    });
    const records = [
      { id: 1, is_active: true },
      { id: 2, is_active: false },
    ];

    const result = renderMarkdownTable(records, [boolProp]);
    expect(result).toContain('Yes');
    expect(result).toContain('No');
  });

  it('aligns columns to minimum 3-char width', () => {
    // Column header "ID" is 2 chars; min 3 should apply
    const props: SchemaProperty[] = [];
    const records = [{ id: 1 }];

    const result = renderMarkdownTable(records, props, { includeId: true });
    // Separator should be at least 3 dashes
    expect(result).toMatch(/---/);
  });

  it('produces valid markdown table structure', () => {
    const props = [
      makeProp({ column_name: 'name', display_name: 'Name' }),
      makeProp({ column_name: 'budget', display_name: 'Budget', udt_name: 'money', type: EntityPropertyType.Money }),
    ];
    const records = [{ id: 1, name: 'Project A', budget: '$1,000.00' }];

    const result = renderMarkdownTable(records, props);
    const lines = result.split('\n');

    // Every line starts and ends with |
    for (const line of lines) {
      expect(line.trim()).toMatch(/^\|.*\|$/);
    }

    // Separator row has only pipes and dashes and spaces
    expect(lines[1]).toMatch(/^[\| -]+$/);
  });
});

// ---------------------------------------------------------------------------
// renderRecordDetail()
// ---------------------------------------------------------------------------

describe('renderRecordDetail()', () => {
  it('includes ID as first line', () => {
    const props = [makeProp({ column_name: 'name', display_name: 'Name' })];
    const record = { id: 42, name: 'Test Project' };

    const result = renderRecordDetail(record, props);
    const lines = result.split('\n');
    expect(lines[0]).toBe('**ID**: 42');
  });

  it('includes each property with display_name label', () => {
    const props = [
      makeProp({ column_name: 'name', display_name: 'Project Name' }),
      makeProp({ column_name: 'budget', display_name: 'Budget', udt_name: 'money', type: EntityPropertyType.Money }),
    ];
    const record = { id: 1, name: 'Alpha', budget: '$500.00' };

    const result = renderRecordDetail(record, props);
    expect(result).toContain('**Project Name**: Alpha');
    expect(result).toContain('**Budget**: $500.00');
  });

  it('omits ID when not present in record', () => {
    const props = [makeProp()];
    const record = { name: 'No ID' };

    const result = renderRecordDetail(record, props);
    expect(result).not.toContain('**ID**');
  });

  it('omits properties with empty formatted values', () => {
    const props = [
      makeProp({ column_name: 'optional', display_name: 'Optional' }),
    ];
    const record = { id: 1, optional: null };

    const result = renderRecordDetail(record, props);
    // null → '' → skipped
    expect(result).not.toContain('**Optional**');
  });

  it('includes created_at timestamp when present', () => {
    const props: SchemaProperty[] = [];
    const record = { id: 1, created_at: '2024-01-15T10:30:00Z' };

    const result = renderRecordDetail(record, props);
    expect(result).toContain('**Created**: Jan 15, 2024,');
  });

  it('includes updated_at timestamp when present', () => {
    const props: SchemaProperty[] = [];
    const record = { id: 1, updated_at: '2024-06-01T08:00:00Z' };

    const result = renderRecordDetail(record, props);
    expect(result).toContain('**Updated**: Jun 1, 2024,');
  });

  it('omits created_at when falsy', () => {
    const props: SchemaProperty[] = [];
    const record = { id: 1, created_at: null };

    const result = renderRecordDetail(record, props);
    expect(result).not.toContain('**Created**');
  });

  it('formats FK objects by display_name', () => {
    const fkProp = makeProp({
      column_name: 'client_id',
      display_name: 'Client',
      join_table: 'clients',
      join_column: 'id',
      type: EntityPropertyType.ForeignKeyName,
    });
    const record = { id: 1, client_id: { id: 7, display_name: 'Globocorp' } };

    const result = renderRecordDetail(record, [fkProp]);
    expect(result).toContain('**Client**: Globocorp');
  });

  it('formats boolean as Yes/No', () => {
    const boolProp = makeProp({
      column_name: 'active',
      display_name: 'Active',
      udt_name: 'bool',
      type: EntityPropertyType.Boolean,
    });
    const record = { id: 1, active: true };

    const result = renderRecordDetail(record, [boolProp]);
    expect(result).toContain('**Active**: Yes');
  });

  it('returns lines joined with newline', () => {
    const props = [
      makeProp({ column_name: 'name', display_name: 'Name' }),
      makeProp({ column_name: 'code', display_name: 'Code' }),
    ];
    const record = { id: 1, name: 'Project', code: 'PRJ-001' };

    const result = renderRecordDetail(record, props);
    expect(result.split('\n').length).toBeGreaterThanOrEqual(3);
  });
});
