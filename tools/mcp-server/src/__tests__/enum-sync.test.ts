/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Drift guard: verifies the MCP server's EntityPropertyType enum stays in sync
 * with the Angular frontend's canonical copy in src/app/interfaces/entity.ts.
 *
 * The MCP server duplicates the enum because it's a separate TypeScript project
 * that can't import from the Angular app. This test locks the expected count so
 * any addition to the frontend enum triggers a conscious review of the MCP copy.
 *
 * The Angular codebase has a matching test at:
 *   src/app/workers/import-validation-enum-sync.spec.ts
 *
 * When this test fails:
 * 1. Update EXPECTED_COUNT below to match the new enum size
 * 2. Add the new member to src/interfaces.ts EntityPropertyType enum
 * 3. Handle the new type in src/schema-cache.ts detectPropertyType()
 * 4. Handle the new type in src/formatters/value.ts formatValue()
 */

import { describe, it, expect } from 'vitest';
import { EntityPropertyType } from '../interfaces.js';

describe('EntityPropertyType Enum Sync', () => {
  // UPDATE THIS when adding new EntityPropertyType members.
  // Must match the Angular frontend's EXPECTED_COUNT in
  // src/app/workers/import-validation-enum-sync.spec.ts
  //
  // Current members: Unknown(0) through Markdown(27) = 28 values
  const EXPECTED_COUNT = 28;

  it('should have the expected number of enum members', () => {
    // TypeScript numeric enums have reverse mappings (key→value AND value→key),
    // so filter to only numeric values to get the true member count.
    const enumValues = Object.values(EntityPropertyType).filter(v => typeof v === 'number');
    expect(enumValues.length).toBe(EXPECTED_COUNT);
  });

  it('should have contiguous enum values from 0 to max', () => {
    const enumValues = Object.values(EntityPropertyType)
      .filter(v => typeof v === 'number') as number[];
    const max = Math.max(...enumValues);
    expect(max).toBe(EXPECTED_COUNT - 1);
    for (let i = 0; i <= max; i++) {
      expect(enumValues).toContain(i);
    }
  });

  it('should have all expected member names', () => {
    // Exhaustive list — forces update when a new type is added.
    const expectedNames = [
      'Unknown', 'TextShort', 'TextLong', 'Boolean',
      'Date', 'DateTime', 'DateTimeLocal', 'Money',
      'IntegerNumber', 'DecimalNumber', 'ForeignKeyName', 'User',
      'GeoPoint', 'Color', 'Email', 'Telephone',
      'TimeSlot', 'ManyToMany', 'File', 'FileImage',
      'FilePDF', 'Payment', 'Status', 'Category',
      'RecurringTimeSlot', 'PhotoGallery', 'GeoPolygon', 'Markdown',
    ];

    const actualNames = Object.keys(EntityPropertyType)
      .filter(k => isNaN(Number(k)));

    expect(actualNames.sort()).toEqual(expectedNames.sort());
  });
});
