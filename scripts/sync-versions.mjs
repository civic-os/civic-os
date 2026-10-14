#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Lockstep versions for everything that ships with a Civic OS release:
 * the root app (civic-os), every workspace package (packages/*), and the
 * MCP server (tools/mcp-server). The root package.json version is the source
 * of truth (`npm version` bumps it, then `postversion` runs this script).
 *
 * Rules:
 *   - root, packages/*, and tools/mcp-server have the same version;
 *   - internal @civic-os/* dependency specs are pinned to exactly that version
 *     (file:/link:/workspace: specs are exempt; they are local links);
 *   - lockfile metadata for these packages carries the same version.
 *
 * Usage:
 *   node scripts/sync-versions.mjs          # rewrite manifests + lockfiles to the root version
 *   node scripts/sync-versions.mjs --check  # report drift, exit 1 if any (npm run check:versions)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEP_FIELDS, readJson, rel, repoRoot, workspacePackages } from './lib/workspaces.mjs';

const check = process.argv.includes('--check');
const rootManifestPath = join(repoRoot, 'package.json');
const version = readJson(rootManifestPath).version;
const LOCAL_SPEC = /^(file|link|workspace):/;

const issues = [];
const changedFiles = new Set();

/** Load JSON, apply edits via `mutate(obj, report)`, write back in npm's format if changed. */
function edit(absPath, mutate) {
  if (!existsSync(absPath)) return;
  const original = readFileSync(absPath, 'utf8');
  const obj = JSON.parse(original);
  mutate(obj, (where, actual, fix) => {
    issues.push(`${rel(absPath)}: ${where} is ${JSON.stringify(actual)}, expected ${JSON.stringify(version)}`);
    fix();
  });
  const next = JSON.stringify(obj, null, 2) + '\n';
  if (next !== original) {
    changedFiles.add(rel(absPath));
    if (!check) writeFileSync(absPath, next);
  }
}

function syncManifest(obj, report) {
  if (obj.version !== version) report('"version"', obj.version, () => { obj.version = version; });
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(obj[field] ?? {})) {
      if (!name.startsWith('@civic-os/') || LOCAL_SPEC.test(spec)) continue;
      if (spec !== version) report(`${field}["${name}"]`, spec, () => { obj[field][name] = version; });
    }
  }
}

/** Lockfile metadata: the lock's own version plus entries for our packages. */
function syncLock(lockPath, entryKeys) {
  edit(lockPath, (lock, report) => {
    if (lock.version !== version) report('"version"', lock.version, () => { lock.version = version; });
    for (const key of entryKeys) {
      const entry = lock.packages?.[key];
      if (!entry) continue;
      if (entry.version !== version) report(`packages["${key}"].version`, entry.version, () => { entry.version = version; });
      for (const field of DEP_FIELDS) {
        for (const [name, spec] of Object.entries(entry[field] ?? {})) {
          if (!name.startsWith('@civic-os/') || LOCAL_SPEC.test(spec)) continue;
          if (spec !== version) report(`packages["${key}"].${field}["${name}"]`, spec, () => { entry[field][name] = version; });
        }
      }
    }
  });
}

const workspaces = workspacePackages();
for (const pkg of workspaces) edit(pkg.manifestPath, syncManifest);
syncLock(join(repoRoot, 'package-lock.json'), ['', ...workspaces.map((p) => p.relDir)]);

const mcpDir = join(repoRoot, 'tools', 'mcp-server');
edit(join(mcpDir, 'package.json'), syncManifest);
// The MCP lockfile records linked workspace packages under their relative path (e.g. "../../packages/core").
syncLock(join(mcpDir, 'package-lock.json'), ['', ...workspaces.map((p) => `../../${p.relDir}`)]);

if (check) {
  if (issues.length > 0) {
    console.error(`check:versions failed (release version ${version} from package.json):`);
    for (const i of issues) console.error(`  - ${i}`);
    console.error('Fix: npm run sync-versions');
    process.exit(1);
  }
  console.log(`check:versions ok: root, ${workspaces.map((p) => p.manifest.name).join(', ')}, and @civic-os/mcp-server are at ${version}.`);
} else {
  console.log(changedFiles.size === 0
    ? `sync-versions: everything already at ${version}.`
    : `sync-versions: set ${version} in ${[...changedFiles].join(', ')}.`);
}
