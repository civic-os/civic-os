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
 *
 * Analytics: the development environment enables Matomo for stats.civic-os.org,
 * so every browser run would otherwise report test traffic. The host is
 * unresolvable in every launched browser (all contexts and pages). Set
 * CIVIC_OS_ALLOW_ANALYTICS=true to opt out.
 */

const { chromium } = require('playwright-core');

const BLOCKED_ANALYTICS_HOSTS = ['stats.civic-os.org'];

async function launchBrowser(options = {}) {
  const args = [...(options.args || [])];
  if (process.env.CIVIC_OS_ALLOW_ANALYTICS !== 'true') {
    const rules = BLOCKED_ANALYTICS_HOSTS.map(h => `MAP ${h} ~NOTFOUND`).join(', ');
    args.push(`--host-resolver-rules=${rules}`);
  }
  const base = { headless: true, ...options, args };
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
