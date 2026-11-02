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
    /**
     * Off by default so the TZ matrix and the type-test passes skip it;
     * test:packages:unit turns it on with --coverage. The thresholds sit a
     * little below the 2026-11-02 numbers (97.79 / 95.65 / 99.48 / 98.79), so a
     * drop in the published interpreter fails CI instead of passing unseen.
     * See docs/development/TEST_HARNESS_LIFECYCLE.md (Coverage).
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/testing/**'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: '../../coverage/core',
      thresholds: { statements: 97, branches: 95, functions: 99, lines: 98 },
    },
  },
});
