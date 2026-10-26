/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, inject, test } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    hostTimeZone: { offsets: [number, number]; name: string };
  }
}

test('test workers run in the same timezone as the vitest main process', () => {
  // Guards the TZ matrix (scripts/test-packages-tz.mjs): if workers ignored the
  // TZ the runner set, every matrix run would silently test the host timezone.
  const worker = {
    offsets: [new Date(2026, 0, 15).getTimezoneOffset(), new Date(2026, 6, 15).getTimezoneOffset()],
    name: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  expect(worker).toEqual(inject('hostTimeZone'));
});
