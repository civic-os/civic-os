#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * node lib/cli.mjs normalize --raw <dir> --out <dir> --meta <json> [--strict]
 *                           --strict (record mode): refuse, exit 3, when a flow has requests outside any step
 * node lib/cli.mjs compare   --baseline <dir> --current <dir> [--report <file>] [--approved <file> --example <name> [--ledger <file>]]
 *                           --emit-approved <out> --example <name> [--phase <p>] [--approved <existing>]: write every approvable
 *                           difference for --example as a draft entry ("row": null), keeping the rows of still-matching
 *                           entries of <existing> (default: <out> itself) and all other entries; exit 1 only on hard failures
 *                           --approved: pass only when the differences exactly equal the file's harness entries for
 *                           --example (format: scripts/golden/approved-diff.mjs; exit 2 when the file is invalid)
 * node lib/cli.mjs visual    --base <dir> --current <dir> --report-dir <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRun, describeUnattributed } from './normalize.mjs';
import { compareRuns, emitHarness } from './compare.mjs';
import { compareScreenshotTrees } from './visual.mjs';
import { HARNESS_VERSION } from './config.mjs';
import { loadApproved, readApprovedRaw } from '../../../scripts/golden/approved-diff.mjs';

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
  let options = {};
  if (a['emit-approved']) {
    if (typeof a['emit-approved'] !== 'string' || typeof a.example !== 'string') {
      console.error('--emit-approved needs a file and --example <name>');
      process.exit(2);
    }
    const out = path.resolve(a['emit-approved']);
    let existing;
    try {
      existing = readApprovedRaw(path.resolve(typeof a.approved === 'string' ? a.approved : out));
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
    const first = compareRuns(readDir(a.baseline), readDir(a.current));
    const r = emitHarness(first.items, existing?.harness ?? [], a.example);
    const phase = typeof a.phase === 'string' ? a.phase : existing?.phase;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeJson(out, { ...(phase !== undefined ? { phase } : {}), golden: existing?.golden ?? [], harness: r.harness });
    // Hard failures are whatever remains with the drafts treated as approved.
    const rest = compareRuns(readDir(a.baseline), readDir(a.current), { approved: r.harness, example: a.example });
    // A draft run is never a gate result: relabel the drafts and the verdict so a log can't read as PASS.
    const text = rest.render()
      .replaceAll('INFO APPROVED (unattributed)', 'INFO DRAFT')
      .replace(/^RESULT: (PASS|FAIL)$/m, (_, v) => `DRAFT EMITTED (not a gate result): ${v === 'PASS' ? 'no hard failures' : 'hard failures remain'}`);
    if (a.report) fs.writeFileSync(a.report, text + '\n');
    console.log(text);
    console.log(`emitted ${r.kept + r.added} ${a.example} entries to ${a['emit-approved']}: ${r.kept} matched (rows kept), ${r.added} new (row null), ${r.dropped} existing entries dropped (no longer observed)`);
    process.exit(rest.failures.length ? 1 : 0);
  }
  if (a.approved) {
    if (typeof a.approved !== 'string' || typeof a.example !== 'string') {
      console.error('--approved needs a file and --example <name>');
      process.exit(2);
    }
    try {
      const ledger = typeof a.ledger === 'string' ? a.ledger : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../golden/ledger.json');
      options = { approved: loadApproved(path.resolve(a.approved), null, ledger).harness, example: a.example };
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
  }
  const report = compareRuns(readDir(a.baseline), readDir(a.current), options);
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
