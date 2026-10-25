#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Approved-diff gate for the derived golden trees.
 *
 *   node scripts/golden/approved-diff.mjs --phase <p> --tree frontend|mcp [--base <git-ref>] [--file <path>] [--root <dir>] [--emit <out.json>]
 *
 * `golden:check` demands byte equality. A phase that changes outputs on purpose
 * (one change per approved ledger row) cannot pass it. This script compares the
 * derived tree in the working copy with the same tree at --base (default HEAD),
 * read with `git ls-tree` / `git show`, flattens every JSON file to leaf
 * pointers (added and removed files and leaves included), and passes only when
 * the observed differences EXACTLY equal the phase's approved entries for that
 * tree. An observed difference with no entry is UNAPPROVED; an entry that did
 * not occur is APPROVED BUT ABSENT. Either fails (exit 1). Invalid input
 * (unreadable file, wrong phase, row unknown to the ledger or without a
 * decision) exits 2.
 *
 * Workflow: regenerate with `npm run golden:derive` / `npm run golden:derive:mcp`,
 * run this script with --base <pre-change ref>, commit only on PASS. After that
 * commit plain `golden:check` is byte-equal again.
 *
 * Draft workflow (hundreds of observed diffs cannot be written by hand):
 *   1. derive:     npm run golden:derive / golden:derive:mcp (the tree in the working copy changes)
 *   2. emit:       approved-diff.mjs --phase <p> --tree <t> --base <pre-change ref> [--file <existing>] --emit <out.json>
 *                  writes every observed difference as an entry with "row": null, exits 0, and prints counts.
 *                  Entries of --file that still match an observed difference keep their row; entries for the
 *                  other tree and all harness entries are carried over untouched. Run once per tree, feeding
 *                  the output back as --file.
 *   3. attribute:  edit the draft and set every "row" to a ledger row id (the lead decides which row owns which diff).
 *   4. check:      approved-diff.mjs --phase <p> --tree <t> --base <ref> against tests/golden/approved-diffs/<p>.json.
 *   5. commit:     only on PASS.
 * A draft with a "row": null entry is rejected by the check (and by the harness) with exit 2,
 * "unattributed draft entry", so an emitted draft can never pass as a gate unedited.
 *
 * Approved file, one per phase: tests/golden/approved-diffs/<phase>.json
 *
 *   {
 *     "phase": "1.3",
 *     "golden": [
 *       { "row": "S-02", "tree": "frontend", "file": "pothole/select-strings.json",
 *         "pointer": "/issues/0/select", "before": "...", "after": "..." }
 *     ],
 *     "harness": [
 *       { "row": "F-01", "example": "pothole", "flow": "<flow>", "step": "<step>", "kind": "CHANGED",
 *         "method": "GET", "path": "/issues", "before": { ... }, "after": { ... } }
 *     ]
 *   }
 *
 * `file` is relative to tests/golden/derived/<tree>/. `pointer` is an RFC 6901
 * pointer to a leaf (a scalar, null, or an empty object or array). `before` and
 * `after` are JSON values; a leaf that was added has no `before`, a removed one
 * has no `after`. Values compare with a stable stringify, so key order does not
 * matter. The `harness` entries are read by tests/e2e/lib/compare.mjs (see
 * tests/e2e/README.md). Every entry's `row` must exist in tests/golden/ledger.json
 * with a non-null decision.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../..');

export function stableStringify(v) {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

const esc = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Map of RFC 6901 pointer -> leaf value. Scalars, null, {} and [] are leaves. */
export function flatten(value, pointer = '', out = new Map()) {
  if (Array.isArray(value) && value.length) value.forEach((v, i) => flatten(v, `${pointer}/${i}`, out));
  else if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
    for (const k of Object.keys(value)) flatten(value[k], `${pointer}/${esc(k)}`, out);
  } else out.set(pointer, value);
  return out;
}

/**
 * @param {Map<string, any>} base  file -> parsed JSON
 * @param {Map<string, any>} cur   file -> parsed JSON
 * @returns {{file: string, pointer: string, before?: any, after?: any}[]}
 */
export function diffTrees(base, cur) {
  const diffs = [];
  for (const file of new Set([...base.keys(), ...cur.keys()])) {
    const b = base.has(file) ? flatten(base.get(file)) : new Map();
    const c = cur.has(file) ? flatten(cur.get(file)) : new Map();
    for (const p of new Set([...b.keys(), ...c.keys()])) {
      const inB = b.has(p);
      const inC = c.has(p);
      if (inB && inC && stableStringify(b.get(p)) === stableStringify(c.get(p))) continue;
      const d = { file, pointer: p };
      if (inB) d.before = b.get(p);
      if (inC) d.after = c.get(p);
      diffs.push(d);
    }
  }
  return diffs;
}

const keyOf = (o) =>
  stableStringify({
    file: o.file,
    pointer: o.pointer,
    before: 'before' in o ? o.before : undefined,
    after: 'after' in o ? o.after : undefined,
    has: ['before' in o, 'after' in o],
  });

/** Pure set comparison. Returns the observed diffs without an entry and the entries that did not occur. */
export function matchApproved(diffs, entries) {
  // Multiset: each entry approves at most one difference, so duplicate entries need duplicate differences.
  const left = new Map();
  for (const e of entries) left.set(keyOf(e), (left.get(keyOf(e)) ?? 0) + 1);
  const unapproved = [];
  for (const d of diffs) {
    const k = keyOf(d);
    if (left.get(k) > 0) left.set(k, left.get(k) - 1);
    else unapproved.push(d);
  }
  const absent = [];
  const matched = [];
  for (const e of entries) {
    const k = keyOf(e);
    if (left.get(k) > 0) {
      left.set(k, left.get(k) - 1);
      absent.push(e);
    } else matched.push(e);
  }
  return { unapproved, absent, matched };
}

const HARNESS_KINDS = ['CHANGED', 'MISSING', 'EXTRA', 'KEYCLOAK', 'MINIO'];

/** Loads and validates an approved-diffs file. Throws Error with a message (the caller exits 2). */
export function loadApproved(file, phase, ledgerFile) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read approved diffs ${file}: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} must be an object`);
  if (phase != null && String(doc.phase) !== String(phase)) {
    throw new Error(`${file} is for phase ${JSON.stringify(doc.phase)}, not ${JSON.stringify(phase)}`);
  }
  const golden = doc.golden ?? [];
  const harness = doc.harness ?? [];
  if (!Array.isArray(golden) || !Array.isArray(harness)) throw new Error(`${file}: "golden" and "harness" must be arrays`);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const rows = new Map(ledger.rows.map((r) => [r.id, r]));
  const problems = [];
  const check = (list, name, need) =>
    list.forEach((e, i) => {
      const at = `${name}[${i}]`;
      if (!e || typeof e !== 'object') {
        problems.push(`${at}: must be an object`);
        return;
      }
      if (e.row === null) problems.push(`${at}: unattributed draft entry (row is null; set it to a ledger row id)`);
      else if (typeof e.row !== 'string' || !rows.has(e.row)) problems.push(`${at}: row ${JSON.stringify(e.row)} is not a row of the ledger`);
      else if (rows.get(e.row).decision == null) problems.push(`${at}: row ${e.row} has no decision in the ledger`);
      for (const k of need) if (typeof e[k] !== 'string' || !e[k]) problems.push(`${at}: "${k}" must be a non-empty string`);
    });
  check(golden, 'golden', ['tree', 'file']);
  check(harness, 'harness', ['example', 'flow']);
  golden.forEach((e, i) => {
    if (typeof e?.pointer !== 'string') problems.push(`golden[${i}]: "pointer" must be a string`);
    if (e && !('before' in e) && !('after' in e)) problems.push(`golden[${i}]: needs "before" and/or "after"`);
  });
  harness.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const at = `harness[${i}]`;
    if (!HARNESS_KINDS.includes(e.kind)) {
      problems.push(`${at}: unknown kind ${JSON.stringify(e.kind)}`);
      return;
    }
    if (e.kind === 'KEYCLOAK' || e.kind === 'MINIO') {
      if (typeof e.step !== 'string') problems.push(`${at}: "step" must be a string`);
      if (!('before' in e) || !('after' in e)) problems.push(`${at}: ${e.kind} needs "before" and "after"`);
      return;
    }
    for (const k of ['step', 'method', 'path']) if (typeof e[k] !== 'string') problems.push(`${at}: "${k}" must be a string`);
    if (e.kind === 'CHANGED' && !('before' in e && 'after' in e)) problems.push(`${at}: CHANGED needs "before" and "after"`);
    if (e.kind === 'MISSING' && (!('before' in e) || 'after' in e)) problems.push(`${at}: MISSING has only "before"`);
    if (e.kind === 'EXTRA' && ('before' in e || !('after' in e))) problems.push(`${at}: EXTRA has only "after"`);
  });
  if (problems.length) throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
  return { phase: doc.phase, golden, harness };
}

/** Reads an approved-diffs file without validating rows (drafts allowed). Missing file: null. */
export function readApprovedRaw(file) {
  if (!fs.existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read approved diffs ${file}: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} must be an object`);
  if (!Array.isArray(doc.golden ?? []) || !Array.isArray(doc.harness ?? [])) throw new Error(`${file}: "golden" and "harness" must be arrays`);
  return doc;
}

/**
 * Draft entries for `tree`: every observed difference, with the row of a still-matching existing entry
 * (the existing entry object is reused) or null. Entries of other trees are kept in front, unchanged.
 */
export function emitGolden({ tree, diffs, existing }) {
  const mine = existing.filter((e) => e.tree === tree);
  const others = existing.filter((e) => e.tree !== tree);
  const { matched } = matchApproved(diffs, mine);
  const pool = new Map();
  for (const e of matched) {
    const k = keyOf(e);
    pool.set(k, [...(pool.get(k) ?? []), e]);
  }
  const fresh = [];
  const kept = [];
  for (const d of diffs) {
    const hit = pool.get(keyOf(d))?.shift();
    if (hit) kept.push(hit);
    else fresh.push({ row: null, tree, ...d });
  }
  return { golden: [...others, ...kept, ...fresh], kept: kept.length, added: fresh.length, dropped: mine.length - matched.length };
}

// Readers --------------------------------------------------------------------

/** Parsed *.json files under dir, keyed by path relative to dir. */
export function readDirTree(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.json')) out.set(path.relative(dir, p).split(path.sep).join('/'), JSON.parse(fs.readFileSync(p, 'utf8')));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Parsed *.json files of `treePath` at `ref`, keyed by path relative to treePath. */
export function readGitTree(root, ref, treePath) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  const names = git('ls-tree', '-r', '--name-only', '-z', ref, '--', treePath).split('\0').filter((n) => n.endsWith('.json'));
  if (!names.length) throw new Error(`no JSON files under ${treePath} at ${ref}: wrong --base ref? (the derived trees exist from phase 0 on)`);
  const out = new Map();
  for (const n of names) out.set(n.slice(treePath.length + 1), JSON.parse(git('show', `${ref}:${n}`)));
  return out;
}

const show = (v) => {
  const s = v === undefined ? '(absent)' : stableStringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};
const line = (e) => `  ${e.file} ${e.pointer || '(root)'}\n    before: ${show('before' in e ? e.before : undefined)}\n    after:  ${show('after' in e ? e.after : undefined)}`;

/** @returns {{code: number, text: string}} */
export function check({ tree, entries, base, cur, phase }) {
  const diffs = diffTrees(base, cur);
  const { unapproved, absent } = matchApproved(diffs, entries);
  if (!unapproved.length && !absent.length) {
    return { code: 0, text: `PASS approved-diff phase ${phase} tree ${tree}: ${diffs.length} difference(s), all approved, none absent` };
  }
  const out = [];
  if (unapproved.length) out.push(`UNAPPROVED (${unapproved.length}):`, ...unapproved.map(line));
  if (absent.length) out.push(`APPROVED BUT ABSENT (${absent.length}):`, ...absent.map((e) => `  [${e.row}]\n${line(e)}`));
  out.push(`FAIL approved-diff phase ${phase} tree ${tree}: ${unapproved.length} unapproved, ${absent.length} approved but absent`);
  return { code: 1, text: out.join('\n') };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const die = (m) => {
    console.error(m);
    process.exit(2);
  };
  if (!a.phase || typeof a.phase !== 'string') die('usage: approved-diff.mjs --phase <p> --tree frontend|mcp [--base <git-ref>] [--file <path>] [--root <dir>] [--emit <out.json>]');
  if (a.tree !== 'frontend' && a.tree !== 'mcp') die('--tree must be frontend or mcp');
  const root = path.resolve(a.root || DEFAULT_ROOT);
  const file = path.resolve(root, typeof a.file === 'string' ? a.file : `tests/golden/approved-diffs/${a.phase}.json`);
  const emit = typeof a.emit === 'string';
  let approved;
  try {
    if (emit) {
      const raw = readApprovedRaw(file);
      if (raw && String(raw.phase) !== a.phase) throw new Error(`${file} is for phase ${JSON.stringify(raw.phase)}, not ${JSON.stringify(a.phase)}`);
      approved = { golden: raw?.golden ?? [], harness: raw?.harness ?? [] };
    } else approved = loadApproved(file, a.phase, path.join(root, 'tests/golden/ledger.json'));
  } catch (e) {
    die(e.message);
  }
  const treePath = `tests/golden/derived/${a.tree}`;
  let base;
  let cur;
  try {
    base = readGitTree(root, typeof a.base === 'string' ? a.base : 'HEAD', treePath);
    cur = readDirTree(path.join(root, treePath));
  } catch (e) {
    die(`cannot read the trees: ${e.message}`);
  }
  if (emit) {
    const r = emitGolden({ tree: a.tree, diffs: diffTrees(base, cur), existing: approved.golden });
    const out = path.resolve(root, a.emit);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ phase: a.phase, golden: r.golden, harness: approved.harness }, null, 2) + '\n');
    console.log(`emitted ${r.kept + r.added} ${a.tree} entries to ${a.emit}: ${r.kept} matched (rows kept), ${r.added} new (row null), ${r.dropped} existing entries dropped (no longer observed)`);
    process.exit(0);
  }
  const entries = approved.golden.filter((e) => e.tree === a.tree);
  const { code, text } = check({ tree: a.tree, entries, base, cur, phase: a.phase });
  (code ? console.error : console.log)(text);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
