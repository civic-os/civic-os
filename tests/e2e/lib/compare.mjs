/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Compares a normalized run against committed baselines.
 *
 *   SEMANTIC  (fails): decoded, param-order-insensitive request multisets per
 *                      step, Keycloak OIDC call counts, MinIO call patterns.
 *   RAW       (warns): exact URL strings (param order, percent-encoding) and
 *                      body key order, for requests that are semantically equal.
 *   UNATTRIBUTED (fails): any PostgREST or MinIO request that started outside a
 *                      named step, in either run. Such a request cannot be
 *                      compared step by step, so it is never silently accepted.
 */

import { stableStringify, describeUnattributed } from './normalize.mjs';

function withoutRaw(entry) {
  const { raw, n, ...rest } = entry;
  return rest;
}

function describeRequest(e) {
  const q = Object.entries(e.query)
    .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}=${x}`).join('&') : `${k}=${v}`))
    .join('&');
  return `${e.method} ${e.path}${q ? '?' + q : ''} -> ${e.status}`;
}

function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function valueDiff(label, a, b, out) {
  const sa = typeof a === 'string' ? a : stableStringify(a);
  const sb = typeof b === 'string' ? b : stableStringify(b);
  if (sa === sb) return;
  out.push(`        ${label}:`);
  out.push(`          baseline: ${sa === undefined ? '(absent)' : sa}`);
  out.push(`          current:  ${sb === undefined ? '(absent)' : sb}`);
  if (typeof sa === 'string' && typeof sb === 'string' && sa.length > 60 && sb.length > 60) {
    const i = firstDiffIndex(sa, sb);
    out.push(`          first difference at char ${i}: ...${sa.slice(Math.max(0, i - 25), i + 25)}... vs ...${sb.slice(Math.max(0, i - 25), i + 25)}...`);
  }
}

/** Field-level explanation of how a current request differs from the closest baseline request. */
function explainPair(b, c, out) {
  const keys = new Set([...Object.keys(b.query), ...Object.keys(c.query)]);
  for (const k of [...keys].sort()) valueDiff(`query.${k}`, b.query[k], c.query[k], out);
  const hk = new Set([...Object.keys(b.headers), ...Object.keys(c.headers)]);
  for (const k of [...hk].sort()) valueDiff(`header.${k}`, b.headers[k], c.headers[k], out);
  valueDiff('body', b.body, c.body, out);
  valueDiff('status', b.status, c.status, out);
}

function similarity(b, c) {
  let score = 0;
  for (const k of Object.keys(b.query)) if (k in c.query) score += stableStringify(b.query[k]) === stableStringify(c.query[k]) ? 2 : 1;
  if (stableStringify(b.body) === stableStringify(c.body)) score += 2;
  return score;
}

export function compareSteps(flowName, bSteps, cSteps, report) {
  const bNames = bSteps.map((s) => s.name);
  const cNames = cSteps.map((s) => s.name);
  if (stableStringify(bNames) !== stableStringify(cNames)) {
    report.fail(`[${flowName}] step list differs\n    baseline: ${bNames.join(' | ')}\n    current:  ${cNames.join(' | ')}`);
  }
  const cByName = new Map(cSteps.map((s) => [s.name, s]));
  for (const bs of bSteps) {
    const cs = cByName.get(bs.name);
    if (!cs) continue;
    const where = `[${flowName}] step "${bs.name}"`;

    // PostgREST multiset.
    const bMap = new Map(bs.postgrest.map((e) => [stableStringify(withoutRaw(e)), e]));
    const cMap = new Map(cs.postgrest.map((e) => [stableStringify(withoutRaw(e)), e]));
    const missing = [...bMap.keys()].filter((k) => !cMap.has(k)).map((k) => bMap.get(k));
    const extra = [...cMap.keys()].filter((k) => !bMap.has(k)).map((k) => cMap.get(k));
    // Each group is the text of one difference plus its structured item.
    const groups = [];
    const add = (lines, item) => {
      groups.push({ lines, item });
      report.items.push(item);
    };
    const base = { flow: flowName, step: bs.name };
    for (const [k, be] of bMap) {
      const ce = cMap.get(k);
      if (ce && String(ce.n) !== String(be.n)) {
        // Only a read's COUNT is approvable (see sameItem); `request` pins which read.
        add([`    COUNT ${describeRequest(be)}: baseline n=${be.n}, current n=${ce.n}`], { ...base, kind: 'COUNT', method: be.method, path: be.path, request: withoutRaw(be), before: be.n, after: ce.n });
      }
      if (ce && stableStringify(ce.raw) !== stableStringify(be.raw)) {
        report.warn(`${where} RAW ${describeRequest(be)}\n      baseline raw: ${stableStringify(be.raw)}\n      current raw:  ${stableStringify(ce.raw)}`);
      }
    }
    const usedExtra = new Set();
    for (const m of missing) {
      const candidates = extra.filter((e, i) => !usedExtra.has(i) && e.method === m.method && e.path === m.path);
      if (candidates.length) {
        const best = candidates.reduce((a, e) => (similarity(m, e) > similarity(m, a) ? e : a));
        usedExtra.add(extra.indexOf(best));
        const lines = [`    CHANGED ${m.method} ${m.path}`];
        explainPair(m, best, lines);
        add(lines, { ...base, kind: 'CHANGED', method: m.method, path: m.path, before: withoutRaw(m), after: withoutRaw(best) });
      } else {
        const lines = [`    MISSING (in baseline, not sent now) n=${m.n}: ${describeRequest(m)}`];
        if (m.body != null) lines.push(`        body: ${stableStringify(m.body)}`);
        add(lines, { ...base, kind: 'MISSING', method: m.method, path: m.path, before: withoutRaw(m) });
      }
    }
    extra.forEach((e, i) => {
      if (usedExtra.has(i)) return;
      const lines = [`    EXTRA (sent now, not in baseline) n=${e.n}: ${describeRequest(e)}`];
      if (e.body != null) lines.push(`        body: ${stableStringify(e.body)}`);
      add(lines, { ...base, kind: 'EXTRA', method: e.method, path: e.path, after: withoutRaw(e) });
    });

    // Keycloak counts and MinIO patterns.
    if (stableStringify(bs.keycloak) !== stableStringify(cs.keycloak)) {
      add([`    KEYCLOAK counts differ\n      baseline: ${stableStringify(bs.keycloak)}\n      current:  ${stableStringify(cs.keycloak)}`], { ...base, kind: 'KEYCLOAK', before: bs.keycloak, after: cs.keycloak });
    }
    if (stableStringify(bs.minio) !== stableStringify(cs.minio)) {
      add([`    MINIO calls differ\n      baseline: ${stableStringify(bs.minio)}\n      current:  ${stableStringify(cs.minio)}`], { ...base, kind: 'MINIO', before: bs.minio, after: cs.minio });
    }
    // Differences an approved-diffs entry covers become INFO lines; the rest still fail.
    const kept = [];
    for (const g of groups) {
      const row = report.approvals ? report.approvals.take(g.item) : null;
      if (row) {
        report.approvedCount++;
        report.info(`APPROVED ${row} ${where} ${g.item.kind}${g.item.method ? ` ${g.item.method} ${g.item.path}` : ''}`);
      } else kept.push(g);
    }
    if (kept.length) report.fail(`${where}\n${kept.flatMap((g) => g.lines).join('\n')}`);
  }
}

/**
 * The harness entries of an approved-diffs file (see scripts/golden/approved-diff.mjs)
 * for one example. Each entry approves at most one observed difference, and only
 * when flow, step, kind, method, path and before/after all match exactly.
 * A COUNT is approvable only for a GET, and only when its `request` matches too;
 * a write sent a different number of times, step list differences, missing or
 * new flows and UNATTRIBUTED requests cannot be approved.
 */
export class Approvals {
  constructor(entries, example) {
    this.entries = entries.filter((e) => e.example === example).map((e) => ({ e, used: false }));
  }
  /** Marks and returns the row id of the entry approving `item`, or null. */
  take(item) {
    const hit = this.entries.find((x) => !x.used && sameItem(x.e, item));
    if (!hit) return null;
    hit.used = true;
    return hit.e.row ?? '(unattributed)';
  }
  unused() {
    return this.entries.filter((x) => !x.used).map((x) => x.e);
  }
}

function sameItem(e, item) {
  if (e.flow !== item.flow || e.step !== item.step || e.kind !== item.kind) return false;
  if (item.kind === 'COUNT') {
    if (item.method !== 'GET' || e.method !== 'GET' || e.path !== item.path) return false;
    return stableStringify(e.request) === stableStringify(item.request) && String(e.before) === String(item.before) && String(e.after) === String(item.after);
  }
  if (item.method !== undefined && (e.method !== item.method || e.path !== item.path)) return false;
  for (const side of ['before', 'after']) {
    if ((side in e) !== (item[side] !== undefined)) return false;
    if (side in e && stableStringify(e[side]) !== stableStringify(item[side])) return false;
  }
  return true;
}

/**
 * Draft harness entries for `example` from the structured items of a compare run: every approvable
 * difference, with the row of a still-matching existing entry (that entry object is reused) or null.
 * Entries of other examples are kept in front, unchanged. COUNT items are emitted for GETs only.
 */
export function emitHarness(items, existing, example) {
  const others = existing.filter((e) => e.example !== example);
  const approvals = new Approvals(existing, example);
  const entries = [];
  let kept = 0;
  let added = 0;
  for (const item of items) {
    if (item.kind === 'COUNT' && item.method !== 'GET') continue;
    const hit = approvals.entries.find((x) => !x.used && sameItem(x.e, item));
    if (hit) {
      hit.used = true;
      entries.push(hit.e);
      kept++;
      continue;
    }
    const e = { row: null, example, flow: item.flow, step: item.step, kind: item.kind };
    if (item.method !== undefined) Object.assign(e, { method: item.method, path: item.path });
    if (item.request !== undefined) e.request = item.request;
    if (item.before !== undefined) e.before = item.before;
    if (item.after !== undefined) e.after = item.after;
    entries.push(e);
    added++;
  }
  return { harness: [...others, ...entries], kept, added, dropped: approvals.unused().length };
}

export class Report {
  constructor() {
    this.failures = [];
    this.warnings = [];
    this.infos = [];
    /** Structured form of every semantic difference found by compareSteps. */
    this.items = [];
    /** Set by compareRuns when approved diffs are in force. */
    this.approvals = null;
    this.approvedCount = 0;
  }
  fail(s) {
    this.failures.push(s);
  }
  warn(s) {
    this.warnings.push(s);
  }
  info(s) {
    this.infos.push(s);
  }
  render() {
    const out = [];
    for (const s of this.infos) out.push(`INFO ${s}`);
    for (const s of this.warnings) out.push(`WARN ${s}`);
    for (const s of this.failures) out.push(`FAIL ${s}`);
    out.push('');
    out.push(`Semantic differences: ${this.failures.length}. Raw-only warnings: ${this.warnings.length}.${this.approvals ? ` Approved differences: ${this.approvedCount}.` : ''}`);
    out.push(this.failures.length ? 'RESULT: FAIL' : 'RESULT: PASS');
    return out.join('\n');
  }
}

/**
 * @param {{meta: object, flows: Map<string, object>}} baseline
 * @param {{meta: object, flows: Map<string, object>}} current
 * @param {{approved?: object[], example?: string}} [options] approved: the `harness` entries of an
 *   approved-diffs file. With it, the run passes only when the observed differences exactly equal
 *   the entries for `example`.
 */
export function compareRuns(baseline, current, options = {}) {
  const report = new Report();
  if (options.approved) report.approvals = new Approvals(options.approved, options.example);
  const bm = baseline.meta || {};
  const cm = current.meta || {};
  if (bm.harness !== cm.harness) report.warn(`harness version differs: baseline ${bm.harness}, current ${cm.harness}`);
  report.info(`baseline recorded at ${bm.baseSha} (example tree ${bm.exampleTree}); current ${cm.baseSha} (example tree ${cm.exampleTree})`);
  if (bm.exampleTree !== cm.exampleTree || bm.migrationsTree !== cm.migrationsTree) {
    report.warn('example or migrations tree differs from the baseline; diffs may come from instance or schema changes, not the app');
  }
  const names = new Set([...baseline.flows.keys(), ...current.flows.keys()]);
  for (const name of [...names].sort()) {
    const b = baseline.flows.get(name);
    const c = current.flows.get(name);
    if (!b) {
      report.fail(`[${name}] flow has no baseline (new flow; the lead must re-record)`);
      continue;
    }
    if (!c) {
      report.fail(`[${name}] flow missing from current run`);
      continue;
    }
    compareSteps(name, b.steps, c.steps, report);
    for (const [label, doc] of [['current run', c], ['baseline', b]]) {
      const lines = describeUnattributed(doc);
      if (lines.length) {
        report.fail(`[${name}] UNATTRIBUTED requests in the ${label}, started outside any step:\n${lines.map((l) => `    ${l}`).join('\n')}`);
      }
    }
  }
  if (report.approvals) {
    for (const e of report.approvals.unused()) {
      report.fail(`APPROVED BUT ABSENT ${e.row} [${e.flow}] step "${e.step}" ${e.kind}${e.method ? ` ${e.method} ${e.path}` : ''}`);
    }
  }
  return report;
}
