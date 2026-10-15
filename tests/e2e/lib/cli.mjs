#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * node lib/cli.mjs normalize --raw <dir> --out <dir> --meta <json> [--strict]
 *                           --strict (record mode): refuse, exit 3, when a flow has requests outside any step
 * node lib/cli.mjs compare   --baseline <dir> --current <dir> [--report <file>]
 * node lib/cli.mjs visual    --base <dir> --current <dir> --report-dir <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeRun, describeUnattributed } from './normalize.mjs';
import { compareRuns } from './compare.mjs';
import { compareScreenshotTrees } from './visual.mjs';
import { HARNESS_VERSION } from './config.mjs';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readDir(dir) {
  const meta = fs.existsSync(path.join(dir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : {};
  const flows = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'meta.json').sort()) {
    flows.set(f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return { meta, flows };
}

const [cmd, ...rest] = process.argv.slice(2);
const a = args(rest);

if (cmd === 'normalize') {
  const rawFiles = fs.readdirSync(a.raw).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const fkFile = path.join(a.raw, '_foreign-keys.json');
  const foreignKeys = fs.existsSync(fkFile) ? JSON.parse(fs.readFileSync(fkFile, 'utf8')) : [];
  if (!foreignKeys.length) console.warn('warning: no _foreign-keys.json in raw dir; created ids in FK columns will not be masked');
  const gfFile = path.join(a.raw, '_guided-forms.json');
  const guidedForms = fs.existsSync(gfFile) ? JSON.parse(fs.readFileSync(gfFile, 'utf8')) : [];
  const usersFile = path.join(a.raw, '_users.json');
  const users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')) : [];
  if (!users.length) console.warn('warning: no _users.json in raw dir; role user ids will be numbered like any other UUID');
  if (!rawFiles.length) {
    console.error(`no raw recordings in ${a.raw}`);
    process.exit(2);
  }
  const raws = rawFiles.map((f) => JSON.parse(fs.readFileSync(path.join(a.raw, f), 'utf8')));
  const docs = normalizeRun(raws, foreignKeys, guidedForms, users);
  const outside = docs.flatMap((d) => describeUnattributed(d).map((l) => `[${d.flow}] ${l}`));
  if (outside.length) {
    console.error(`UNATTRIBUTED: ${outside.length} request(s) started outside any step:\n  ${outside.join('\n  ')}`);
    if (a.strict) {
      console.error('refusing to write baselines that contain unattributed requests (--strict)');
      process.exit(3);
    }
  }
  fs.mkdirSync(a.out, { recursive: true });
  for (const f of fs.readdirSync(a.out).filter((x) => x.endsWith('.json'))) fs.rmSync(path.join(a.out, f));
  docs.forEach((doc, i) => writeJson(path.join(a.out, rawFiles[i]), doc));
  const meta = { ...(a.meta ? JSON.parse(a.meta) : {}), harness: HARNESS_VERSION, flows: rawFiles.map((f) => f.replace(/\.json$/, '')) };
  writeJson(path.join(a.out, 'meta.json'), meta);
  const total = docs.reduce((n, d) => n + d.steps.reduce((m, s) => m + s.postgrest.length, 0), 0);
  console.log(`normalized ${docs.length} flows, ${docs.reduce((n, d) => n + d.steps.length, 0)} steps, ${total} distinct PostgREST requests -> ${a.out}`);
} else if (cmd === 'compare') {
  const report = compareRuns(readDir(a.baseline), readDir(a.current));
  const text = report.render();
  if (a.report) fs.writeFileSync(a.report, text + '\n');
  console.log(text);
  process.exit(report.failures.length ? 1 : 0);
} else if (cmd === 'visual') {
  const { failed, text } = compareScreenshotTrees(a.base, a.current, a['report-dir']);
  console.log(text);
  process.exit(failed.length ? 1 : 0);
} else {
  console.error('usage: cli.mjs normalize|compare|visual ...');
  process.exit(2);
}
