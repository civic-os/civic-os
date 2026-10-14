/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Shared helpers for the SDK workspace check scripts (check-spdx, sync-versions,
 * check-boundaries, check-docker-workspaces, api-report, check-dogfood).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repo-relative POSIX path. */
export function rel(absPath) {
  return relative(repoRoot, absPath).split(sep).join('/');
}

export function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, 'utf8'));
}

/**
 * Workspace packages declared by the root package.json `workspaces` field.
 * Supports the two pattern forms npm workspaces use here: `dir/*` and `dir`.
 * @returns {{ dir: string, relDir: string, manifestPath: string, manifest: any }[]}
 */
export function workspacePackages() {
  const root = readJson(join(repoRoot, 'package.json'));
  const dirs = [];
  for (const pattern of root.workspaces ?? []) {
    if (pattern.endsWith('/*') && !pattern.slice(0, -2).includes('*')) {
      const base = join(repoRoot, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(base, entry.name, 'package.json'))) {
          dirs.push(join(base, entry.name));
        }
      }
    } else if (!pattern.includes('*')) {
      if (existsSync(join(repoRoot, pattern, 'package.json'))) dirs.push(join(repoRoot, pattern));
    } else {
      throw new Error(`Unsupported workspace pattern "${pattern}" in package.json; extend scripts/lib/workspaces.mjs.`);
    }
  }
  return dirs.sort().map((dir) => {
    const manifestPath = join(dir, 'package.json');
    return { dir, relDir: rel(dir), manifestPath, manifest: readJson(manifestPath) };
  });
}

/** Non-workspace npm projects under tools/ (each has its own lockfile). */
export function toolPackages() {
  const base = join(repoRoot, 'tools');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, 'package.json')))
    .map((e) => join(base, e.name))
    .sort()
    .map((dir) => {
      const manifestPath = join(dir, 'package.json');
      return { dir, relDir: rel(dir), manifestPath, manifest: readJson(manifestPath) };
    });
}

/**
 * Files git knows about (tracked plus untracked-but-not-ignored), repo-relative.
 * Using git keeps node_modules, dist, and other ignored output out of scans.
 */
export function repoFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((f) => existsSync(join(repoRoot, f)))
    .sort();
}

export const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** Source extensions that must carry a license header. */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css', '.scss'];
