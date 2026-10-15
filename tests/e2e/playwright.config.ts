/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from '@playwright/test';
import path from 'node:path';

const example = process.env.E2E_EXAMPLE || 'pothole';
const artifactDir = process.env.E2E_ARTIFACT_DIR || path.join(import.meta.dirname, '.artifacts', 'adhoc', example);

export default defineConfig({
  testDir: './flows',
  // Flows within an example share created records and must run in file order, one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: path.join(artifactDir, 'test-results'),
  use: {
    browserName: 'chromium',
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'auth', testMatch: /auth\.setup\.ts$/ },
    { name: 'flows', testMatch: new RegExp(`/${example}\\.spec\\.ts$`), dependencies: ['auth'] },
  ],
});
