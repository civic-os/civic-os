/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

/** Type tests only, under tsconfig.test-exact.json (exactOptionalPropertyTypes). */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'node',
    include: [],
    typecheck: {
      tsconfig: './tsconfig.test-exact.json',
      include: ['src/**/*.test-d.ts'],
    },
  },
});
