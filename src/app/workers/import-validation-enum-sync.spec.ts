/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { EntityPropertyType } from '../interfaces/entity';

/**
 * Drift guard: verifies the canonical EntityPropertyType enum has the expected
 * number of members. When a new type is added, this test fails and reminds
 * the developer to update both the worker's hardcoded copy
 * (import-validation.worker.ts) and the Property Management type label map.
 *
 * The import-validation worker runs in a Web Worker context and cannot
 * import from the main app, so it duplicates the enum as a plain object.
 * Karma runs in a browser, so we can't read the worker source with `fs`.
 * Instead, this test locks the expected count so any enum addition triggers
 * a conscious review of all downstream copies.
 *
 * When this test fails:
 * 1. Update EXPECTED_COUNT below to the new enum size
 * 2. Add the new member to the worker's const in import-validation.worker.ts
 * 3. Add the new label to getPropertyTypeLabel() in property-management.page.ts
 */
describe('Import Validation Worker - EntityPropertyType Sync', () => {
  // UPDATE THIS when adding new EntityPropertyType members.
  // Current members: Unknown(0) through GeoPolygon(26) = 27 values
  const EXPECTED_COUNT = 27;

  it('should have the expected number of EntityPropertyType enum members', () => {
    // TypeScript numeric enums have reverse mappings (key→value AND value→key),
    // so filter to only numeric values to get the true member count.
    const enumValues = Object.values(EntityPropertyType).filter(v => typeof v === 'number');
    expect(enumValues.length).toBe(EXPECTED_COUNT,
      `EntityPropertyType has ${enumValues.length} members but expected ${EXPECTED_COUNT}. ` +
      `If you added a new type, update: (1) EXPECTED_COUNT in this test, ` +
      `(2) worker copy in import-validation.worker.ts, ` +
      `(3) type labels in property-management.page.ts getPropertyTypeLabel()`);
  });

  it('should have contiguous enum values from 0 to max', () => {
    const enumValues = Object.values(EntityPropertyType)
      .filter(v => typeof v === 'number') as number[];
    const max = Math.max(...enumValues);
    expect(max).toBe(EXPECTED_COUNT - 1,
      `Enum max value (${max}) should be ${EXPECTED_COUNT - 1} for contiguous values`);
    for (let i = 0; i <= max; i++) {
      expect(enumValues).toContain(i, `Missing enum value ${i}`);
    }
  });
});
