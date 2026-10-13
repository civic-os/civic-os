#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Timezone matrix for the workspace package test suites. Value transforms
 * (DateTime / DateTimeLocal) are integrity-critical (docs/development/
 * DATETIME_HANDLING.md), so every package suite runs under:
 *   UTC                  no offset
 *   America/New_York     negative offset with DST
 *   Asia/Kolkata         half-hour offset, no DST
 *   Australia/Lord_Howe  half-hour DST shift
 *
 * Before each run the script proves the platform honours TZ (known January and
 * July offsets); packages/core/src/timezone.test.ts then proves vitest's
 * workers inherit the main process timezone.
 *
 * Usage: node scripts/test-packages-tz.mjs   (exit 1 if any run fails)
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rel, repoRoot, workspacePackages } from './lib/workspaces.mjs';

// Minutes from Date#getTimezoneOffset for 2026-01-15 and 2026-07-15.
const MATRIX = {
  'UTC': [0, 0],
  'America/New_York': [300, 240],
  'Asia/Kolkata': [-330, -330],
  'Australia/Lord_Howe': [-660, -630],
};

const vitest = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const packages = workspacePackages().filter((p) => ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'].some((f) => existsSync(join(p.dir, f))));
const failures = [];

for (const [tz, expected] of Object.entries(MATRIX)) {
  const env = { ...process.env, TZ: tz };
  const probe = spawnSync(process.execPath, ['-e',
    'console.log(JSON.stringify([new Date(2026, 0, 15).getTimezoneOffset(), new Date(2026, 6, 15).getTimezoneOffset()]))'], { env, encoding: 'utf8' });
  const actual = probe.stdout.trim();
  if (actual !== JSON.stringify(expected)) {
    failures.push(`${tz}: platform reports offsets ${actual || probe.stderr.trim()}, expected ${JSON.stringify(expected)} (is full ICU / tzdata available?)`);
    continue;
  }
  for (const pkg of packages) {
    console.log(`\n=== ${pkg.manifest.name} under TZ=${tz} (offsets ${actual}) ===`);
    const run = spawnSync(vitest, ['run', '--root', pkg.dir], { env, stdio: 'inherit', cwd: repoRoot });
    if (run.status !== 0) failures.push(`${pkg.manifest.name} (${rel(pkg.dir)}) failed under TZ=${tz}`);
  }
}

if (failures.length > 0) {
  console.error('\ntest:packages:tz failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\ntest:packages:tz ok: ${packages.length} package suite(s) x ${Object.keys(MATRIX).length} timezones.`);
