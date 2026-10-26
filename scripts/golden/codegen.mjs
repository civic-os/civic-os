#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Generated-types snapshots (P1.5c).
 *
 * Runs the built civic-os CLI (`gen types --from-fixture`) on the admin variant of every raw capture
 * listed in tests/golden/raw/MANIFEST.json and writes tests/golden/codegen/<example>.ts.
 *
 *   node scripts/golden/codegen.mjs           rewrite the snapshots
 *   node scripts/golden/codegen.mjs --check   exit 1 if any snapshot differs, printing the first differing lines
 *
 * Needs `npm run build:packages` first (the CLI runs from packages/cli/dist).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const check = process.argv.includes('--check');
const bin = join(root, 'packages', 'cli', 'dist', 'bin.js');
const outDir = join(root, 'tests', 'golden', 'codegen');

if (!existsSync(bin)) {
  console.error('packages/cli/dist/bin.js is missing: run `npm run build:packages` first');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(root, 'tests', 'golden', 'raw', 'MANIFEST.json'), 'utf8'));
let failed = 0;
if (!check) mkdirSync(outDir, { recursive: true });

for (const example of Object.keys(manifest.examples).sort()) {
  const r = spawnSync(process.execPath, [bin, 'gen', 'types', '--from-fixture', `tests/golden/raw/${example}/testadmin`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`${example}: generator failed\n${r.stderr}`);
    process.exit(1);
  }
  const file = join(outDir, `${example}.ts`);
  if (!check) {
    writeFileSync(file, r.stdout);
    continue;
  }
  const have = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (have === r.stdout) continue;
  failed++;
  if (have === null) {
    console.error(`${example}: tests/golden/codegen/${example}.ts is missing`);
    continue;
  }
  const a = have.split('\n');
  const b = r.stdout.split('\n');
  const i = a.findIndex((line, n) => line !== b[n]);
  const at = i === -1 ? Math.min(a.length, b.length) : i;
  console.error(`${example}: differs at line ${at + 1}\n  committed: ${a[at] ?? '(end of file)'}\n  generated: ${b[at] ?? '(end of file)'}`);
}

if (check && failed) {
  console.error(`${failed} snapshot(s) stale: run \`node scripts/golden/codegen.mjs\``);
  process.exit(1);
}
console.log(check ? 'codegen snapshots are current' : 'codegen snapshots written');
