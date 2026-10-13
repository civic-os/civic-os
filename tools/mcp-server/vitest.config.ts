/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests run @civic-os/core from TypeScript source so they never depend on
// a stale packages/core/dist. tsc (npm run build) and Node resolve the built
// dist through the package exports instead.
const coreSource = (path: string) => fileURLToPath(new URL(`../../packages/core/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@civic-os\/core$/, replacement: coreSource('index.ts') },
      { find: /^@civic-os\/core\/testing$/, replacement: coreSource('testing/index.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/index.ts'],
    },
  },
});
