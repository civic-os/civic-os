/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Self-test for scripts/sync-versions.mjs (npm run versions:selftest).
 *
 * Runs the real script against a copy of the files it reads, so a drifted
 * src/app/config/version.ts (issue #106) is caught by --check and fixed by
 * the default mode, without touching the checkout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppVersion, renderAppVersionFile } from './lib/app-version.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

/** A temporary tree holding the files sync-versions reads, at their repo-relative paths. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-versions-'));
  const copy = (relPath) => {
    mkdirSync(dirname(join(dir, relPath)), { recursive: true });
    cpSync(join(repoRoot, relPath), join(dir, relPath), { recursive: true });
  };
  copy('scripts');
  for (const f of ['package.json', 'package-lock.json', 'tools/mcp-server/package.json',
    'tools/mcp-server/package-lock.json', 'src/app/config/version.ts']) copy(f);
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const pattern of root.workspaces ?? []) {
    const base = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    for (const name of pattern.endsWith('/*') ? readdirSync(join(repoRoot, base)) : ['']) {
      const manifest = join(base, name, 'package.json');
      if (existsSync(join(repoRoot, manifest))) copy(manifest);
    }
  }
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'sync-versions.mjs'), ...args], { encoding: 'utf8' });
}

const versionTs = (dir) => join(dir, 'src/app/config/version.ts');

test('renderAppVersionFile and readAppVersion round-trip', () => {
  assert.equal(readAppVersion(renderAppVersionFile('1.2.3')), '1.2.3');
  assert.equal(readAppVersion('export const OTHER = 1;'), undefined);
});

test('the checked-in version.ts matches package.json', () => {
  assert.equal(readAppVersion(readFileSync(join(repoRoot, 'src/app/config/version.ts'), 'utf8')), rootVersion);
});

test('--check passes when version.ts is current', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, '--check');
  assert.equal(result.status, 0, result.stderr);
});

test('--check fails on a stale version.ts and names the fix', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(versionTs(dir), renderAppVersionFile('0.0.1'));
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/app\/config\/version\.ts: APP_VERSION is "0\.0\.1"/);
  assert.match(result.stderr, /Fix: npm run sync-versions/);
  assert.equal(readAppVersion(readFileSync(versionTs(dir), 'utf8')), '0.0.1', '--check must not write');
});

test('sync-versions rewrites a stale version.ts', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(versionTs(dir), renderAppVersionFile('0.0.1'));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /src\/app\/config\/version\.ts/);
  assert.equal(readFileSync(versionTs(dir), 'utf8'), renderAppVersionFile(rootVersion));
  assert.equal(run(dir, '--check').status, 0);
});
