/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Markdown table formatting for MCP server output.
 * Renders arrays of records as aligned markdown tables with display-name headers.
 */

import { type SchemaProperty } from '../interfaces.js';
import { formatValue } from './value.js';

/**
 * Render an array of records as a markdown table.
 *
 * @param records - Array of record objects from PostgREST
 * @param properties - Properties to include as columns (in order)
 * @param options - Formatting options
 * @returns Markdown table string
 */
export function renderMarkdownTable(
  records: Record<string, unknown>[],
  properties: SchemaProperty[],
  options: {
    /** Include record ID as first column */
    includeId?: boolean;
    /** Maximum column width before truncation */
    maxColumnWidth?: number;
  } = {},
): string {
  const { includeId = true, maxColumnWidth = 40 } = options;

  if (records.length === 0) {
    return '_No records found._';
  }

  // Build column definitions
  const columns: Array<{ header: string; key: string; property?: SchemaProperty }> = [];

  if (includeId) {
    columns.push({ header: 'ID', key: 'id' });
  }

  for (const prop of properties) {
    columns.push({
      header: prop.display_name,
      key: prop.column_name,
      property: prop,
    });
  }

  if (columns.length === 0) return '_No columns to display._';

  // Format all cell values
  const rows: string[][] = records.map(record =>
    columns.map(col => {
      const raw = resolveNestedValue(record, col.key);
      const formatted = col.property
        ? formatValue(raw, col.property)
        : (raw != null ? String(raw) : '');
      return escapeMarkdown(truncate(formatted, maxColumnWidth));
    }),
  );

  // Calculate column widths (min 3 chars for markdown alignment)
  const widths = columns.map((col, i) => {
    const headerWidth = col.header.length;
    const maxDataWidth = rows.reduce((max, row) => Math.max(max, row[i].length), 0);
    return Math.max(headerWidth, maxDataWidth, 3);
  });

  // Build table
  const headerRow = '| ' + columns.map((col, i) => col.header.padEnd(widths[i])).join(' | ') + ' |';
  const separatorRow = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const dataRows = rows.map(
    row => '| ' + row.map((cell, i) => cell.padEnd(widths[i])).join(' | ') + ' |',
  );

  return [headerRow, separatorRow, ...dataRows].join('\n');
}

/**
 * Resolve a potentially nested value from a record.
 * Handles PostgREST embedded objects (FK, status, etc.).
 *
 * For FK columns like `client_id`, the record may contain:
 * - `{ client_id: { id: 5, display_name: "Acme" } }` (embedded)
 * - `{ client_id: 5 }` (raw)
 */
function resolveNestedValue(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

/** Escape pipe characters in markdown table cells */
function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Truncate text to max length with ellipsis */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

/**
 * Render a single record as a key-value list (for get_record detail view).
 *
 * @param record - Record object from PostgREST
 * @param properties - Properties to include
 * @returns Markdown key-value list
 */
export function renderRecordDetail(
  record: Record<string, unknown>,
  properties: SchemaProperty[],
): string {
  const lines: string[] = [];

  // Always show ID first
  if ('id' in record) {
    lines.push(`**ID**: ${record.id}`);
  }

  for (const prop of properties) {
    const raw = record[prop.column_name];
    const formatted = formatValue(raw, prop);
    if (formatted) {
      lines.push(`**${prop.display_name}**: ${formatted}`);
    }
  }

  // Show timestamps if present
  if ('created_at' in record && record.created_at) {
    lines.push(`**Created**: ${record.created_at}`);
  }
  if ('updated_at' in record && record.updated_at) {
    lines.push(`**Updated**: ${record.updated_at}`);
  }

  return lines.join('\n');
}
