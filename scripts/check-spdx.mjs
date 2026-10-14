#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * License-boundary header check (see docs/notes/FRONTEND_SDK_DESIGN.md,
 * "Licensing and publishing").
 *
 *   1. Every source file under packages/** carries the Apache-2.0 header
 *      (Civic OS copyright line + Apache SPDX identifier) near the top, and
 *      never an AGPL identifier.
 *   2. No source file outside packages/ carries the Apache SPDX identifier:
 *      the app, MCP server, scripts, and backend stay AGPL-3.0-or-later.
 *
 * Usage: node scripts/check-spdx.mjs   (exit 1 with a per-file report on failure)
 */

import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { repoFiles, repoRoot, SOURCE_EXTENSIONS } from './lib/workspaces.mjs';

// Built from parts so this script does not match its own patterns.
const SPDX = 'SPDX-License-Identifier:';
const APACHE_ID = new RegExp(`${SPDX}\\s*Apache-2\\.0\\b`);
const AGPL_ID = new RegExp(`${SPDX}\\s*AGPL`);
const COPYRIGHT = /Copyright \(C\) 2023-20\d\d Civic OS, L3C/;
const HEADER_LINES = 12;

// Outside packages/, also scan shell, YAML, SQL, Go, and Python for a stray Apache identifier.
const OUTSIDE_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, '.sh', '.yml', '.yaml', '.sql', '.go', '.py']);

const problems = [];
let packageFiles = 0;
let outsideFiles = 0;

for (const file of repoFiles()) {
  const ext = extname(file);
  const inPackages = file.startsWith('packages/');
  if (inPackages ? !SOURCE_EXTENSIONS.includes(ext) : !OUTSIDE_EXTENSIONS.has(ext)) continue;

  const text = readFileSync(join(repoRoot, file), 'utf8');
  if (inPackages) {
    packageFiles++;
    const head = text.split('\n').slice(0, HEADER_LINES).join('\n');
    if (!APACHE_ID.test(head)) problems.push(`${file}: missing Apache-2.0 SPDX identifier in the first ${HEADER_LINES} lines`);
    if (!COPYRIGHT.test(head)) problems.push(`${file}: missing "Copyright (C) 2023-YYYY Civic OS, L3C" in the first ${HEADER_LINES} lines`);
    if (AGPL_ID.test(text)) problems.push(`${file}: AGPL SPDX identifier inside an Apache-2.0 package`);
  } else {
    outsideFiles++;
    if (APACHE_ID.test(text)) problems.push(`${file}: Apache-2.0 SPDX identifier outside packages/ (app, MCP, and tooling stay AGPL-3.0-or-later)`);
  }
}

if (problems.length > 0) {
  console.error(`check:spdx failed (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check:spdx ok: ${packageFiles} Apache-2.0 file(s) under packages/, ${outsideFiles} file(s) outside packages/ free of Apache headers.`);
