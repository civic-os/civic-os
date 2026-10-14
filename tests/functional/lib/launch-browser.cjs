/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Shared Chromium launcher for the Playwright-based functional scripts.
 *
 * `playwright-core` ships no browser. Each playwright-core release expects one
 * specific managed Chromium revision, and developer machines routinely have a
 * different revision (or none) in their Playwright cache, so a bare
 * `chromium.launch()` fails with "Executable doesn't exist". Selection order:
 *
 *   1. CHROMIUM_EXECUTABLE=/path/to/chrome   explicit binary
 *   2. Playwright's managed Chromium         (npx playwright-core install chromium)
 *   3. The system Google Chrome              (channel "chrome")
 */

const { chromium } = require('playwright-core');

async function launchBrowser(options = {}) {
  const base = { headless: true, ...options };
  if (process.env.CHROMIUM_EXECUTABLE) {
    return chromium.launch({ ...base, executablePath: process.env.CHROMIUM_EXECUTABLE });
  }
  try {
    return await chromium.launch(base);
  } catch (managedError) {
    try {
      return await chromium.launch({ ...base, channel: 'chrome' });
    } catch (chromeError) {
      throw new Error(
        'No usable Chromium. Set CHROMIUM_EXECUTABLE, run "npx playwright-core install chromium", ' +
        `or install Google Chrome.\n  managed: ${String(managedError.message).split('\n')[0]}` +
        `\n  chrome:  ${String(chromeError.message).split('\n')[0]}`
      );
    }
  }
}

module.exports = { launchBrowser };
