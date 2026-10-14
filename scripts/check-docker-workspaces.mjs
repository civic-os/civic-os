#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Guards the Dockerfiles against npm-workspace drift.
 *
 *   docker/frontend/Dockerfile: `npm ci` needs every workspace manifest
 *   (packages/<name>/package.json) at its repo-relative path before it runs,
 *   or the install fails (or silently diverges from the lockfile). Docker's
 *   COPY flattens globs, so each manifest needs its own COPY line.
 *
 *   docker/mcp-server/Dockerfile: the MCP server depends on workspace
 *   packages through `file:` links (e.g. file:../../packages/core). Before
 *   `bun install`, each linked package's package.json and src/ must be copied
 *   so that the link resolves from the MCP directory exactly as in the repo.
 *
 * Usage: node scripts/check-docker-workspaces.mjs   (exit 1 on drift)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { readJson, repoRoot, workspacePackages, DEP_FIELDS } from './lib/workspaces.mjs';

/** Parse a Dockerfile into instructions (continuations joined, comments dropped). */
function parseDockerfile(relPath) {
  const lines = readFileSync(join(repoRoot, relPath), 'utf8').split('\n');
  const instructions = [];
  let buffer = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (buffer === '' && (line === '' || line.startsWith('#'))) continue;
    if (line.startsWith('#')) continue; // comment inside a continuation
    if (line.endsWith('\\')) {
      buffer += line.slice(0, -1) + ' ';
      continue;
    }
    buffer += line;
    const [keyword, ...rest] = buffer.split(/\s+/);
    instructions.push({ keyword: keyword.toUpperCase(), args: rest.join(' ').trim() });
    buffer = '';
  }
  return instructions;
}

/**
 * Walk the first build stage up to the first RUN matching `installPattern` and
 * return that RUN's WORKDIR plus every COPY (from the build context) before it.
 */
function copiesBeforeInstall(relPath, installPattern) {
  const instructions = parseDockerfile(relPath);
  let workdir = '/';
  const copies = [];
  for (const ins of instructions) {
    if (ins.keyword === 'FROM' && copies.length > 0) break;
    if (ins.keyword === 'WORKDIR') workdir = posix.resolve(workdir, ins.args);
    if (ins.keyword === 'COPY' || ins.keyword === 'ADD') {
      const parts = ins.args.split(/\s+/).filter((p) => !p.startsWith('--'));
      if (ins.args.split(/\s+/).some((p) => p.startsWith('--from='))) continue;
      const dest = parts.pop();
      copies.push({ sources: parts, dest, workdir });
    }
    if (ins.keyword === 'RUN' && installPattern.test(ins.args)) return { workdir, copies };
  }
  throw new Error(`${relPath}: no RUN instruction matching ${installPattern} found`);
}

const globToRegExp = (glob) =>
  new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');

/** Container path where repo file `target` lands, or null if no COPY places it. */
function landingPaths(copies, target) {
  const landed = [];
  for (const { sources, dest, workdir } of copies) {
    const destAbs = posix.resolve(workdir, dest);
    const destIsDir = dest.endsWith('/') || dest === '.' || sources.length > 1;
    for (const rawSource of sources) {
      const source = rawSource.replace(/^\.\//, '').replace(/\/$/, '');
      if (/[*?]/.test(source)) {
        if (globToRegExp(source).test(target)) landed.push(posix.join(destAbs, posix.basename(target)));
      } else if (source === target) {
        landed.push(destIsDir ? posix.join(destAbs, posix.basename(target)) : destAbs);
      } else if ((source === '.' || existsSync(join(repoRoot, source))) && (source === '.' || statSync(join(repoRoot, source)).isDirectory())) {
        const prefix = source === '.' ? '' : `${source}/`;
        if (target.startsWith(prefix)) landed.push(posix.join(destAbs, target.slice(prefix.length)));
      }
    }
  }
  return landed;
}

const problems = [];
const report = [];

// --- Frontend: every workspace manifest before `npm ci`.
{
  const dockerfile = 'docker/frontend/Dockerfile';
  const { workdir, copies } = copiesBeforeInstall(dockerfile, /\bnpm\s+ci\b/);
  for (const pkg of workspacePackages()) {
    const manifest = `${pkg.relDir}/package.json`;
    const expected = posix.join(workdir, manifest);
    const landed = landingPaths(copies, manifest);
    if (!landed.includes(expected)) {
      problems.push(`${dockerfile}: ${manifest} is not copied to ${expected} before \`npm ci\` (add: COPY ${manifest} ./${pkg.relDir}/)`);
    } else {
      report.push(`${dockerfile}: ${manifest} -> ${expected}`);
    }
  }
}

// --- MCP server: every file: workspace dependency before `bun install`.
{
  const dockerfile = 'docker/mcp-server/Dockerfile';
  const mcpDir = 'tools/mcp-server';
  const { workdir, copies } = copiesBeforeInstall(dockerfile, /\bbun\s+install\b/);
  const mcpManifest = `${mcpDir}/package.json`;
  if (!landingPaths(copies, mcpManifest).includes(posix.join(workdir, 'package.json'))) {
    problems.push(`${dockerfile}: ${mcpManifest} must be copied into the \`bun install\` WORKDIR (${workdir})`);
  }
  const manifest = readJson(join(repoRoot, mcpManifest));
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
      const repoPath = posix.normalize(posix.join(mcpDir, spec.slice('file:'.length)));
      const containerPath = posix.resolve(workdir, spec.slice('file:'.length));
      const required = [
        { file: `${repoPath}/package.json`, at: `${containerPath}/package.json` },
        { file: `${repoPath}/src/index.ts`, at: `${containerPath}/src/index.ts`, label: `${repoPath}/src/` },
      ];
      for (const { file, at, label } of required) {
        if (!landingPaths(copies, file).includes(at)) {
          problems.push(`${dockerfile}: ${label ?? file} (for ${name} ${spec}) is not copied to ${label ? posix.dirname(at) + '/' : at} before \`bun install\``);
        } else {
          report.push(`${dockerfile}: ${label ?? file} -> ${label ? posix.dirname(at) + '/' : at}`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('check:docker-workspaces failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const line of report) console.log(`  ${line}`);
console.log('check:docker-workspaces ok');
