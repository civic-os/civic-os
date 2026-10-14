#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Emits a docker compose override that lets an example stack run on the ALT Docker
 * slot: every container_name is reset (so it cannot collide with a stack on the standard
 * slot) and every published host port is shifted by +30000.
 *
 *   node scripts/golden/alt-ports-override.mjs <example> > override.yml
 *
 * Reads the effective config via `docker compose config` (needs the example's .env).
 * Requires Compose >= 2.24 (`!reset` / `!override`). Example files are never edited.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const example = process.argv[2];
if (!example) { console.error('usage: alt-ports-override.mjs <example>'); process.exit(2); }
const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'examples', example);
const cfg = JSON.parse(execFileSync('docker', ['compose', '-p', `sdk-alt-${example}`, 'config', '--format', 'json'], {
  cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}));

const lines = ['services:'];
for (const [name, svc] of Object.entries(cfg.services ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
  const ports = svc.ports ?? [];
  if (!svc.container_name && !ports.length) continue;
  lines.push(`  ${name}:`);
  if (svc.container_name) lines.push('    container_name: !reset null');
  if (ports.length) {
    lines.push('    ports: !override');
    for (const p of ports) {
      const host = Number(p.published) + 30000;
      lines.push(`      - "${host}:${p.target}${p.protocol && p.protocol !== 'tcp' ? '/' + p.protocol : ''}"`);
    }
  }
}
process.stdout.write(lines.join('\n') + '\n');
