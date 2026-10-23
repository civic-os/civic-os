/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from './index.js';

/**
 * Pins the members of EntityPropertyType, the only copy of the enum (the MCP
 * server and the import worker import it from the core). The numeric values are
 * persisted nowhere but cross the worker message boundary and drive MCP
 * formatting, so a change must be deliberate.
 *
 * When this test fails because a type was added:
 * 1. Add the member to EXPECTED below (append only; never renumber).
 * 2. Add its label to getPropertyTypeLabel() in property-management.page.ts.
 * 3. Handle it in the MCP server: detectPropertyType() in schema-cache.ts and
 *    formatValue() in formatters/value.ts.
 */
const EXPECTED: ReadonlyArray<readonly [string, number]> = [
  ['Unknown', 0],
  ['TextShort', 1],
  ['TextLong', 2],
  ['Boolean', 3],
  ['Date', 4],
  ['DateTime', 5],
  ['DateTimeLocal', 6],
  ['Money', 7],
  ['IntegerNumber', 8],
  ['DecimalNumber', 9],
  ['ForeignKeyName', 10],
  ['User', 11],
  ['GeoPoint', 12],
  ['Color', 13],
  ['Email', 14],
  ['Telephone', 15],
  ['TimeSlot', 16],
  ['ManyToMany', 17],
  ['File', 18],
  ['FileImage', 19],
  ['FilePDF', 20],
  ['Payment', 21],
  ['Status', 22],
  ['Category', 23],
  ['RecurringTimeSlot', 24],
  ['PhotoGallery', 25],
  ['GeoPolygon', 26],
  ['Markdown', 27],
];

// Numeric enums carry reverse mappings (value to name), so split them apart.
const names = Object.keys(EntityPropertyType).filter((k) => Number.isNaN(Number(k)));
const values = Object.values(EntityPropertyType).filter((v): v is number => typeof v === 'number');

describe('EntityPropertyType', () => {
  it('has exactly 28 members', () => {
    expect(values).toHaveLength(28);
    expect(names).toHaveLength(28);
  });

  it('has contiguous values from 0 to 27', () => {
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 28 }, (_, i) => i));
  });

  it('maps every member name to its pinned value, in order', () => {
    expect(names.map((n) => [n, (EntityPropertyType as unknown as Record<string, number>)[n]])).toEqual(
      EXPECTED.map(([n, v]) => [n, v]),
    );
  });

  it('keeps the reverse mapping from value to name', () => {
    for (const [name, value] of EXPECTED) {
      expect(EntityPropertyType[value]).toBe(name);
    }
  });
});
