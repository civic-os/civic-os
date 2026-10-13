/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

/**
 * Timezone fingerprint of the vitest main process. The TZ matrix runner
 * (scripts/test-packages-tz.mjs) sets TZ for this process; timezone.test.ts
 * asserts that every test worker sees the same fingerprint, so a matrix run
 * cannot silently fall back to the host timezone.
 */
const hostTimeZone = {
  offsets: [new Date(2026, 0, 15).getTimezoneOffset(), new Date(2026, 6, 15).getTimezoneOffset()] as [number, number],
  name: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    provide: { hostTimeZone },
    typecheck: {
      tsconfig: './tsconfig.test.json',
      include: ['src/**/*.test-d.ts'],
    },
  },
});
