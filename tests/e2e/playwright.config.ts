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
    // Data-integrity suite (pothole only; run-integrity.sh). Not part of the equivalence flows.
    {
      name: 'integrity',
      testDir: import.meta.dirname,
      testMatch: /\/tests\/e2e\/integrity\.spec\.ts$/,
      testIgnore: ['**/node_modules/**', '**/.artifacts/**'],
      // Each test takes well under a minute; this bounds a failed test's teardown.
      timeout: 3 * 60_000,
      // Saving a retain-on-failure trace stalls a failed test until the timeout here
      // (Playwright 1.59.1 against the dev server; not caused by the fake clock).
      // A failure keeps error-context.md (ARIA snapshot) and a screenshot instead.
      use: { trace: 'off', screenshot: 'only-on-failure' },
      dependencies: ['auth'],
    },
  ],
});
