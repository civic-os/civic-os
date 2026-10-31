/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// A custom app's own "reschedule an inspection" form, built without recordEditor: it shows stored
// values in the viewer's zone and turns the edited values back into what PostgREST stores, through
// core's value transforms (hand-derived 2026 offsets: New York EDT -4, Kolkata +5:30).

import assert from 'node:assert/strict';
import { EntityPropertyType, transformValueForControl, transformValuesForApi, ValueTransformError } from '@civic-os/core';
import type { TransformControlOptions, TransformProp, TransformValuesOptions } from '@civic-os/core';

const props: TransformProp[] = [
  { column_name: 'inspect_at', type: EntityPropertyType.DateTimeLocal },
  { column_name: 'fee', type: EntityPropertyType.Money },
];

export function runTransforms(): void {
  const newYork: TransformControlOptions = { timeZone: 'America/New_York' };
  const kolkata: TransformControlOptions = { timeZone: 'Asia/Kolkata' };
  const stored = { inspect_at: '2026-07-04T14:30:00+00:00', fee: '$1,234.50' };

  // Shown as wall-clock time in the viewer's zone, money as a number.
  assert.equal(transformValueForControl(props[0], stored.inspect_at, newYork), '2026-07-04T10:30');
  assert.equal(transformValueForControl(props[0], stored.inspect_at, kolkata), '2026-07-04T20:00');
  assert.equal(transformValueForControl(props[1], stored.fee, newYork), 1234.5);

  // The edited wall clock goes back as a UTC instant read in the same zone.
  const options: TransformValuesOptions = { mode: 'edit', timeZone: newYork.timeZone };
  assert.deepEqual(transformValuesForApi({ inspect_at: '2026-07-04T11:00', fee: 1300 }, props, options), {
    inspect_at: '2026-07-04T15:00:00.000Z',
    fee: 1300,
  });

  // A value the database could not take is refused before anything is sent, naming the column.
  assert.throws(
    () => transformValuesForApi({ inspect_at: '2026-07-04T10:30:75', fee: 1 }, props, options),
    (err: unknown) => err instanceof ValueTransformError && err.column === 'inspect_at',
  );
}
