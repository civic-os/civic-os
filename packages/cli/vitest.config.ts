/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests import @civic-os/core from its sources, so they never need core's dist.
  resolve: { conditions: ['@civic-os/source'] },
  test: {
    root: import.meta.dirname,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
