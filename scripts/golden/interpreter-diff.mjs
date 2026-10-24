#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Gate 3 "one interpreter" check for the derived golden trees.
 *
 *   node scripts/golden/interpreter-diff.mjs [--manifest tests/golden/interpreter-manifest.json]
 *        [--frontend <dir>] [--mcp <dir>] [--json <out>] [--draft <out>]
 *
 * The frontend and MCP harnesses record different projections of what the same
 * core computes, so a literal `diff -r` of tests/golden/derived/{frontend,mcp}
 * cannot be the proof. The rule: compare every field that BOTH trees record.
 *
 *   - Only .json files take part, paired by relative path. Other files are skipped.
 *   - Objects: only keys present on both sides are compared; keys on one side are
 *     counted per file as `shapeOnly` and never fail.
 *   - Arrays of objects are matched by an identity key when every element on both
 *     sides carries the same one (column_name, table_name, name, key, id, label,
 *     case), else by index. An element on one side only is a difference at
 *     <array pointer>/<id or index>.
 *   - Arrays of scalars and other leaves: deep equality, except that two strings
 *     starting with `<PGRST>/` (recorded request URLs) are compared as path plus
 *     decoded query parameters grouped by key (order kept within a key, ignored
 *     between keys).
 *
 * A difference must be covered by a `consumerPolicy` manifest entry that names a
 * decided ledger row keeping per-consumer behavior. Files on one side only need a
 * `oneSided` entry with a reason; a shared file with no compared leaf needs a
 * `noOverlap` entry. Stale entries fail.
 *
 * Manifest (tests/golden/interpreter-manifest.json):
 *   oneSided:       [{ side: "frontend"|"mcp", pattern: "<glob>", reason }]
 *   noOverlap:      [{ file: "<glob>", reason }]
 *   consumerPolicy: [{ row: "E-01", file: "<glob>", pointer: "<regex source>", reason }]
 *   align:          [{ side, file: "<glob>", from: "<regex>", to: "<replacement>", pick?: "lastRequestToEntity", reason }]
 *   ignore:         [{ file: "<glob>", pointer: "<regex source>", reason }]
 *   caseOneSided:   [{ row: "Q-15", file: "<glob>", pointer: "<regex source>", reason }]
 * Globs match relative paths; `*` stays inside a segment, `**` crosses segments.
 *
 * align: restructures ONE side's parsed JSON before the walk so that the two
 * harnesses' differently shaped records line up. Each rule is applied in manifest
 * order to every file of that side matching `file`. Every node whose pointer
 * matches `from` (anchored: the whole pointer) is removed and re-inserted at
 * pointer.replace(from, to) ($1 style groups; parents are created as objects).
 * With `pick: "lastRequestToEntity"` the matched node must be an array of
 * recorded requests ({url,...}); the element placed at `to` is the LAST request
 * whose URL path (after `<PGRST>/`, before `?`) equals the table named by the
 * sibling `input.entity` of the array's parent. Earlier requests (FK name
 * lookups) are dropped; with no such request nothing is placed. A rule that
 * matches no node in any file of its side is stale and fails.
 *
 * ignore: harness metadata that is not interpreter output (e.g. the `call` label).
 * A node whose pointer (after align) matches is not compared and not a difference;
 * ignored nodes are counted separately. An entry that matches no node present on
 * both sides is stale and fails.
 *
 * caseOneSided: like ignore, but for a CASE the MCP cannot express at all (raw
 * parameters, entityId, calendar ranges: ledger Q-15). It names a decided ledger row,
 * is reported per row, and its nodes are not value differences. Stale entries fail.
 *
 * Exit codes: 0 pass, 1 fail (offenders listed), 2 invalid input (unreadable
 * tree or manifest, malformed manifest, row unknown to the ledger or undecided).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDecisions, mergeDecisions } from './ledger-decisions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const IDENTITY_KEYS = ['column_name', 'table_name', 'name', 'key', 'id', 'label', 'case'];

class InvalidInput extends Error {}

// ---------------------------------------------------------------- helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrim = (v) => v === null || typeof v !== 'object';
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** Glob to RegExp over relative paths. `**` crosses segments, `*` does not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The identity key shared by every element of both arrays, or null. */
function identityKey(a, b) {
  const all = [...a, ...b];
  if (!all.length || !all.every(isObj)) return null;
  for (const k of IDENTITY_KEYS) {
    const ok = (arr) => {
      const seen = new Set();
      for (const e of arr) {
        const v = e[k];
        if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') || seen.has(String(v))) return false;
        seen.add(String(v));
      }
      return true;
    };
    if (ok(a) && ok(b)) return k;
  }
  return null;
}

const isPgrstUrl = (v) => typeof v === 'string' && v.startsWith('<PGRST>/');

/**
 * Canonical form of a recorded request URL: the path plus the DECODED query
 * parameters grouped by key. Values of one key keep their order (duplicates such
 * as `select=a&select=b` are order-sensitive); the order between different keys
 * is ignored, as PostgREST does.
 */
function canonicalUrl(u) {
  const q = u.indexOf('?');
  const base = q < 0 ? u : u.slice(0, q);
  const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
  const groups = {};
  for (const kv of (q < 0 ? '' : u.slice(q + 1)).split('&').filter(Boolean)) {
    const i = kv.indexOf('=');
    const k = dec(i < 0 ? kv : kv.slice(0, i));
    (groups[k] ??= []).push(i < 0 ? null : dec(kv.slice(i + 1)));
  }
  return JSON.stringify([base, Object.keys(groups).sort().map((k) => [k, groups[k]])]);
}

/**
 * Compares two parsed documents. Returns { compared, shapeOnly, diffs } where
 * each diff is { pointer, kind: 'value'|'type'|'missing', frontend, mcp }.
 */
export function compareDocs(fe, mc, { ignore = () => -1 } = {}) {
  const st = { compared: 0, shapeOnly: 0, ignored: 0, ignoredBy: new Set(), ignoredCount: new Map(), diffs: [] };
  const hit = (i) => { st.ignored++; st.ignoredBy.add(i); st.ignoredCount.set(i, (st.ignoredCount.get(i) ?? 0) + 1); };
  const diff = (pointer, kind, a, b) => {
    const i = ignore(pointer);
    if (i >= 0) { hit(i); return; }
    st.diffs.push({ pointer, kind, frontend: a, mcp: b });
  };
  const walk = (a, b, ptr) => {
    const ig = ignore(ptr);
    if (ig >= 0) { hit(ig); return; }
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(a)) {
        if (Object.hasOwn(b, k)) walk(a[k], b[k], `${ptr}/${esc(k)}`);
        else st.shapeOnly++;
      }
      for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) st.shapeOnly++;
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if ([...a, ...b].every(isPrim)) {
        st.compared++;
        if (!deepEqual(a, b)) diff(ptr, 'value', a, b);
        return;
      }
      const key = identityKey(a, b);
      if (key) {
        const mb = new Map(b.map((e) => [String(e[key]), e]));
        const ma = new Map(a.map((e) => [String(e[key]), e]));
        for (const [id, e] of ma) {
          if (mb.has(id)) walk(e, mb.get(id), `${ptr}/${esc(id)}`);
          else diff(`${ptr}/${esc(id)}`, 'missing', e, undefined);
        }
        for (const [id, e] of mb) if (!ma.has(id)) diff(`${ptr}/${esc(id)}`, 'missing', undefined, e);
        return;
      }
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (i >= a.length) diff(`${ptr}/${i}`, 'missing', undefined, b[i]);
        else if (i >= b.length) diff(`${ptr}/${i}`, 'missing', a[i], undefined);
        else walk(a[i], b[i], `${ptr}/${i}`);
      }
      return;
    }
    st.compared++;
    if (!(isPgrstUrl(a) && isPgrstUrl(b) ? canonicalUrl(a) === canonicalUrl(b) : deepEqual(a, b))) diff(ptr, (isPrim(a) && isPrim(b)) ? 'value' : 'type', a, b);
  };
  walk(fe, mc, '');
  return st;
}

// ------------------------------------------------------------------ align

const unesc = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');
const segs = (ptr) => (ptr === '' ? [] : ptr.slice(1).split('/').map(unesc));

function getAt(doc, ptr) {
  let n = doc;
  for (const s of segs(ptr)) { if (n === null || typeof n !== 'object') return undefined; n = n[s]; }
  return n;
}

function removeAt(doc, ptr) {
  const last = segs(ptr).at(-1);
  const parent = getAt(doc, parentPtr(ptr));
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete parent[last];
}

function setAt(doc, ptr, value) {
  const s = segs(ptr);
  let n = doc;
  for (const k of s.slice(0, -1)) {
    if (n[k] === undefined || n[k] === null || typeof n[k] !== 'object') n[k] = {};
    n = n[k];
  }
  n[s.at(-1)] = value;
}

/** Every object and array node pointer of a document, parents before children. */
function nodePointers(doc) {
  const out = [];
  const rec = (n, ptr) => {
    if (n === null || typeof n !== 'object') return;
    out.push(ptr);
    for (const k of Object.keys(n)) rec(n[k], `${ptr}/${esc(k)}`);
  };
  rec(doc, '');
  return out;
}

const parentPtr = (ptr) => ptr.slice(0, ptr.lastIndexOf('/'));
const requestTable = (url) => String(url ?? '').replace(/^<PGRST>\//, '').split('?')[0];

/**
 * Applies one align rule to a document in place. Returns the number of nodes it
 * matched. Pointers are collected first and processed deepest-last so earlier
 * moves do not invalidate later ones (indices only matter inside arrays that the
 * rule itself edits, so matches inside one array are processed right to left).
 */
export function applyAlign(doc, rule) {
  const from = new RegExp(`^(?:${rule.from})$`);
  const hits = nodePointers(doc).filter((p) => from.test(p));
  let n = 0;
  for (const ptr of [...hits].reverse()) {
    const node = getAt(doc, ptr);
    if (node === undefined) continue;
    const target = ptr.replace(from, rule.to);
    let value = node;
    if (rule.pick === 'lastRequestToEntity') {
      const entity = getAt(doc, `${parentPtr(ptr)}/input/entity`);
      const list = Array.isArray(node) ? node : [];
      value = [...list].reverse().find((r) => isObj(r) && requestTable(r.url) === entity);
    }
    removeAt(doc, ptr);
    if (value !== undefined) setAt(doc, target, value);
    n++;
  }
  return n;
}

function listFiles(dir) {
  const out = [];
  const rec = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (e.isDirectory()) rec(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
      else if (e.isFile()) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  try { rec(dir, ''); } catch (e) { throw new InvalidInput(`cannot read tree ${dir}: ${e.message}`); }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new InvalidInput(`${file} is not readable JSON: ${e.message}`); }
}

// --------------------------------------------------------------- manifest

export function validateManifest(m, { ledgerRows, decisions }) {
  const problems = [];
  if (!isObj(m)) throw new InvalidInput('manifest must be an object');
  for (const k of Object.keys(m)) if (!['oneSided', 'noOverlap', 'consumerPolicy', 'align', 'ignore', 'caseOneSided'].includes(k)) problems.push(`unknown top-level key "${k}"`);
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  const list = (name, fn) => {
    const arr = m[name] ?? [];
    if (!Array.isArray(arr)) { problems.push(`${name} must be an array`); return []; }
    arr.forEach((e, i) => {
      if (!isObj(e)) { problems.push(`${name}[${i}] must be an object`); return; }
      fn(e, `${name}[${i}]`);
    });
    return arr;
  };
  list('oneSided', (e, w) => {
    if (e.side !== 'frontend' && e.side !== 'mcp') problems.push(`${w}.side must be "frontend" or "mcp"`);
    if (!str(e.pattern)) problems.push(`${w}.pattern must be a non-empty string`);
    if (!str(e.reason)) problems.push(`${w}.reason must be a non-empty string`);
  });
  list('noOverlap', (e, w) => {
    if (!str(e.file)) problems.push(`${w}.file must be a non-empty string`);
    if (!str(e.reason)) problems.push(`${w}.reason must be a non-empty string`);
  });
  const regexOk = (v, w, name) => {
    if (!str(v)) { problems.push(`${w}.${name} must be a regex source`); return; }
    try { new RegExp(v); } catch (x) { problems.push(`${w}.${name} is not a valid regex: ${x.message}`); }
  };
  list('align', (e, w) => {
    if (e.side !== 'frontend' && e.side !== 'mcp') problems.push(`${w}.side must be "frontend" or "mcp"`);
    if (!str(e.file)) problems.push(`${w}.file must be a non-empty string`);
    regexOk(e.from, w, 'from');
    if (typeof e.to !== 'string') problems.push(`${w}.to must be a string`);
    if (e.pick !== undefined && e.pick !== 'lastRequestToEntity') problems.push(`${w}.pick must be "lastRequestToEntity"`);
    if (!str(e.reason)) problems.push(`${w}.reason must be a non-empty string`);
  });
  list('ignore', (e, w) => {
    if (!str(e.file)) problems.push(`${w}.file must be a non-empty string`);
    regexOk(e.pointer, w, 'pointer');
    if (!str(e.reason)) problems.push(`${w}.reason must be a non-empty string`);
  });
  const ids = new Set(ledgerRows.map((r) => r.id));
  const decided = new Set(Object.keys(decisions));
  for (const r of ledgerRows) if (r.decision) decided.add(r.id);
  list('caseOneSided', (e, w) => {
    if (!str(e.row)) problems.push(`${w}.row must be a ledger row id`);
    else if (!ids.has(e.row)) problems.push(`${w}.row "${e.row}" is not a ledger row`);
    else if (!decided.has(e.row)) problems.push(`${w}.row "${e.row}" has no decision`);
    if (!str(e.file)) problems.push(`${w}.file must be a non-empty string`);
    regexOk(e.pointer, w, 'pointer');
    if (!str(e.reason)) problems.push(`${w}.reason must be a non-empty string`);
  });
  list('consumerPolicy', (e, w) => {
    if (!str(e.row)) problems.push(`${w}.row must be a ledger row id`);
    else if (!ids.has(e.row)) problems.push(`${w}.row "${e.row}" is not a ledger row`);
    else if (!decided.has(e.row)) problems.push(`${w}.row "${e.row}" has no decision`);
    if (!str(e.file)) problems.push(`${w}.file must be a non-empty string`);
    if (!str(e.pointer)) problems.push(`${w}.pointer must be a regex source`);
    else { try { new RegExp(e.pointer); } catch (x) { problems.push(`${w}.pointer is not a valid regex: ${x.message}`); } }
    if (!str(e.reason)) problems.push(`${w}.reason must be a non-empty string`);
  });
  if (problems.length) throw new InvalidInput(`invalid manifest:\n  ${problems.join('\n  ')}`);
  return {
    oneSided: m.oneSided ?? [], noOverlap: m.noOverlap ?? [], consumerPolicy: m.consumerPolicy ?? [],
    align: m.align ?? [], ignore: m.ignore ?? [], caseOneSided: m.caseOneSided ?? [],
  };
}

// -------------------------------------------------------------------- run

export function run({ manifest, frontend, mcp, ledger, decisions }) {
  const ledgerDoc = readJson(ledger);
  const dec = loadDecisions(decisions);
  const { rows } = mergeDecisions(ledgerDoc.rows, dec);
  const man = validateManifest(manifest, { ledgerRows: rows, decisions: dec });

  const fe = listFiles(frontend), mc = listFiles(mcp);
  const isJson = (f) => f.endsWith('.json');
  const skipped = { frontend: fe.filter((f) => !isJson(f)), mcp: mc.filter((f) => !isJson(f)) };
  const feJ = new Set(fe.filter(isJson)), mcJ = new Set(mc.filter(isJson));
  const shared = [...feJ].filter((f) => mcJ.has(f));
  const oneSided = {
    frontend: [...feJ].filter((f) => !mcJ.has(f)),
    mcp: [...mcJ].filter((f) => !feJ.has(f)),
  };

  const alignRules = man.align.map((e) => ({ e, fre: globToRegExp(e.file), hits: 0, files: 0 }));
  const ignoreRules = [...man.ignore, ...man.caseOneSided].map((e) => ({ e, fre: globToRegExp(e.file), pre: new RegExp(e.pointer), used: false, n: 0 }));
  const aligned = (side, dir, f) => {
    const doc = readJson(path.join(dir, f));
    for (const r of alignRules) {
      if (r.e.side !== side || !r.fre.test(f)) continue;
      r.files++;
      r.hits += applyAlign(doc, r.e);
    }
    return doc;
  };

  const files = [];
  const diffs = [];
  let ignored = 0;
  for (const f of shared) {
    const fileIgnore = ignoreRules.filter((x) => x.fre.test(f));
    const ign = (ptr) => fileIgnore.findIndex((x) => x.pre.test(ptr));
    const r = compareDocs(aligned('frontend', frontend, f), aligned('mcp', mcp, f), { ignore: ign });
    r.ignoredBy.forEach((i) => { fileIgnore[i].used = true; fileIgnore[i].n += r.ignoredCount.get(i); });
    ignored += r.ignored;
    files.push({ file: f, compared: r.compared, shapeOnly: r.shapeOnly, ignored: r.ignored, differences: r.diffs.length });
    for (const d of r.diffs) diffs.push({ file: f, ...d });
  }

  const caseByRow = {};
  for (const x of ignoreRules) if (x.e.row) caseByRow[x.e.row] = (caseByRow[x.e.row] ?? 0) + x.n;
  const failures = {
    oneSidedUncovered: [], staleOneSided: [], staleNoOverlap: [], noOverlapMissing: [], uncovered: [], staleConsumerPolicy: [],
    staleAlign: alignRules.filter((x) => x.hits === 0).map((x) => ({ side: x.e.side, file: x.e.file, from: x.e.from })),
    staleIgnore: ignoreRules.filter((x) => !x.used).map((x) => ({ file: x.e.file, pointer: x.e.pointer })),
  };

  // one-sided files
  const osRe = man.oneSided.map((e) => ({ e, re: globToRegExp(e.pattern), used: false }));
  for (const side of ['frontend', 'mcp']) {
    for (const f of oneSided[side]) {
      const hit = osRe.filter((x) => x.e.side === side && x.re.test(f));
      hit.forEach((x) => { x.used = true; });
      if (!hit.length) failures.oneSidedUncovered.push({ side, file: f });
    }
  }
  osRe.filter((x) => !x.used).forEach((x) => failures.staleOneSided.push({ side: x.e.side, pattern: x.e.pattern }));

  // no-overlap
  const zero = files.filter((f) => f.compared === 0).map((f) => f.file);
  const noRe = man.noOverlap.map((e) => ({ e, re: globToRegExp(e.file), used: false }));
  for (const f of zero) {
    const hit = noRe.filter((x) => x.re.test(f));
    hit.forEach((x) => { x.used = true; });
    if (!hit.length) failures.noOverlapMissing.push(f);
  }
  noRe.filter((x) => !x.used).forEach((x) => failures.staleNoOverlap.push({ file: x.e.file }));

  // consumer policy
  const cpRe = man.consumerPolicy.map((e) => ({ e, fre: globToRegExp(e.file), pre: new RegExp(e.pointer), used: 0 }));
  const covered = {};
  for (const d of diffs) {
    const hit = cpRe.filter((x) => x.fre.test(d.file) && x.pre.test(d.pointer));
    hit.forEach((x) => { x.used++; });
    if (hit.length) {
      d.row = hit[0].e.row;
      covered[d.row] = (covered[d.row] ?? 0) + 1;
    } else {
      d.row = null;
      failures.uncovered.push({ file: d.file, pointer: d.pointer, kind: d.kind, frontend: d.frontend, mcp: d.mcp });
    }
  }
  cpRe.filter((x) => !x.used).forEach((x) => failures.staleConsumerPolicy.push({ row: x.e.row, file: x.e.file, pointer: x.e.pointer }));

  const failCount = Object.values(failures).reduce((n, a) => n + a.length, 0);
  return {
    pass: failCount === 0,
    summary: {
      sharedFiles: shared.length,
      comparedLeaves: files.reduce((n, f) => n + f.compared, 0),
      differences: diffs.length,
      coveredByRow: Object.fromEntries(Object.entries(covered).sort()),
      uncovered: failures.uncovered.length,
      shapeOnly: files.reduce((n, f) => n + f.shapeOnly, 0),
      ignoredNodes: ignored,
      caseOneSidedByRow: caseByRow,
      oneSided: { frontend: oneSided.frontend.length, mcp: oneSided.mcp.length },
      noOverlapFiles: zero.length,
      skippedNonJson: { frontend: skipped.frontend.length, mcp: skipped.mcp.length },
    },
    failures, files, differences: diffs, oneSided, skipped, zeroOverlap: zero,
  };
}

/** A manifest skeleton listing every uncovered item, rows and reasons left null. */
export function buildDraft(report) {
  const group = (items, keyOf) => {
    const m = new Map();
    for (const it of items) { const k = keyOf(it); if (!m.has(k)) m.set(k, it); }
    return [...m.values()];
  };
  const base = (f) => f.split('/').pop();
  const globFor = (f, all) => {
    const same = all.filter((x) => base(x) === base(f));
    return same.length > 1 ? `**/${base(f)}` : f;
  };
  const osAll = { frontend: report.oneSided.frontend, mcp: report.oneSided.mcp };
  return {
    oneSided: group(report.failures.oneSidedUncovered.map((o) => ({
      side: o.side, pattern: globFor(o.file, osAll[o.side]), reason: null,
    })), (e) => `${e.side}|${e.pattern}`),
    noOverlap: group(report.failures.noOverlapMissing.map((f) => ({ file: globFor(f, report.zeroOverlap), reason: null })), (e) => e.file),
    consumerPolicy: group(report.failures.uncovered.map((u) => ({
      row: null,
      file: globFor(u.file, report.files.map((f) => f.file)),
      pointer: `^${u.pointer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      reason: null,
    })), (e) => `${e.file}|${e.pointer}`),
  };
}

// -------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = {
    manifest: path.join(ROOT, 'tests/golden/interpreter-manifest.json'),
    frontend: path.join(ROOT, 'tests/golden/derived/frontend'),
    mcp: path.join(ROOT, 'tests/golden/derived/mcp'),
    ledger: path.join(ROOT, 'tests/golden/ledger.json'),
    decisions: path.join(ROOT, 'tests/golden/ledger-decisions.json'),
    json: null, draft: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || !(a.slice(2) in o)) throw new InvalidInput(`unknown argument ${a}`);
    if (i + 1 >= argv.length) throw new InvalidInput(`${a} needs a value`);
    o[a.slice(2)] = path.resolve(argv[++i]);
  }
  return o;
}

function show(v) {
  const s = v === undefined ? '(absent)' : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function main() {
  let o, report;
  try {
    o = parseArgs(process.argv.slice(2));
    report = run({ manifest: readJson(o.manifest), frontend: o.frontend, mcp: o.mcp, ledger: o.ledger, decisions: o.decisions });
  } catch (e) {
    if (e instanceof InvalidInput || /not valid JSON|must be an object/.test(e.message)) {
      console.error(`interpreter-diff: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  if (o.json) fs.writeFileSync(o.json, `${JSON.stringify(report, null, 2)}\n`);
  if (o.draft) fs.writeFileSync(o.draft, `${JSON.stringify(buildDraft(report), null, 2)}\n`);

  const s = report.summary, f = report.failures;
  const lim = (arr, fn) => { arr.slice(0, 25).forEach(fn); if (arr.length > 25) console.log(`    ... ${arr.length - 25} more (see --json)`); };
  if (!report.pass) {
    console.log('FAIL: interpreter check');
    if (f.oneSidedUncovered.length) { console.log(`  one-sided files with no oneSided entry (${f.oneSidedUncovered.length}):`); lim(f.oneSidedUncovered, (x) => console.log(`    [${x.side}] ${x.file}`)); }
    if (f.noOverlapMissing.length) { console.log(`  shared files with no compared leaf and no noOverlap entry, so they prove nothing (${f.noOverlapMissing.length}):`); lim(f.noOverlapMissing, (x) => console.log(`    ${x}`)); }
    if (f.uncovered.length) {
      console.log(`  differences no consumerPolicy entry covers (${f.uncovered.length}):`);
      lim(f.uncovered, (x) => console.log(`    ${x.file}#${x.pointer}  frontend=${show(x.frontend)}  mcp=${show(x.mcp)}`));
      const by = new Map();
      for (const x of f.uncovered) {
        const k = `${x.file.split('/').pop()} ${x.pointer.split('/').pop()}`;
        by.set(k, (by.get(k) ?? 0) + 1);
      }
      console.log('  uncovered by file and last pointer segment:');
      [...by].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(`    ${String(n).padStart(5)}  ${k}`));
    }
    if (f.staleOneSided.length) { console.log(`  stale oneSided entries (${f.staleOneSided.length}):`); lim(f.staleOneSided, (x) => console.log(`    [${x.side}] ${x.pattern}`)); }
    if (f.staleNoOverlap.length) { console.log(`  stale noOverlap entries (${f.staleNoOverlap.length}):`); lim(f.staleNoOverlap, (x) => console.log(`    ${x.file}`)); }
    if (f.staleAlign.length) { console.log(`  stale align entries (${f.staleAlign.length}):`); lim(f.staleAlign, (x) => console.log(`    [${x.side}] ${x.file} ${x.from}`)); }
    if (f.staleIgnore.length) { console.log(`  stale ignore entries (${f.staleIgnore.length}):`); lim(f.staleIgnore, (x) => console.log(`    ${x.file} ${x.pointer}`)); }
    if (f.staleConsumerPolicy.length) { console.log(`  stale consumerPolicy entries (${f.staleConsumerPolicy.length}):`); lim(f.staleConsumerPolicy, (x) => console.log(`    ${x.row} ${x.file} ${x.pointer}`)); }
  } else console.log('PASS: interpreter check');
  console.log(`  shared files:    ${s.sharedFiles} (${s.comparedLeaves} leaves compared, ${s.noOverlapFiles} with no overlap)`);
  console.log(`  differences:     ${s.differences} (${s.differences - s.uncovered} covered, ${s.uncovered} uncovered)`);
  console.log(`  covered by row:  ${Object.entries(s.coveredByRow).map(([r, n]) => `${r}=${n}`).join(' ') || '(none)'}`);
  console.log(`  shapeOnly keys:  ${s.shapeOnly}`);
  console.log(`  ignored nodes:   ${s.ignoredNodes} (of which case-level one-sided: ${Object.entries(s.caseOneSidedByRow).map(([r, n]) => `${r}=${n}`).join(' ') || 'none'})`);
  console.log(`  one-sided files: frontend ${s.oneSided.frontend}, mcp ${s.oneSided.mcp}`);
  console.log(`  skipped non-json: frontend ${s.skippedNonJson.frontend}, mcp ${s.skippedNonJson.mcp}`);
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
