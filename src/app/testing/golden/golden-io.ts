/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/// <reference types="node" />

/**
 * Golden-output I/O for the SDK program (P0.2b).
 *
 * The golden specs (`*.golden.spec.ts` in this folder) feed the committed raw
 * metadata fixtures (`tests/golden/raw/`) through the CURRENT frontend code and
 * compare the result byte-for-byte with the committed files under
 * `tests/golden/derived/frontend/`. They write only when GOLDEN_UPDATE=1
 * (scripts/golden/derive-frontend.sh); a missing file, a changed file and an
 * orphan file all fail a normal run. See docs/development/TESTING.md
 * ("Golden outputs").
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
export const RAW_ROOT = path.join(ROOT, 'tests/golden/raw');
export const DERIVED_ROOT = path.join(ROOT, 'tests/golden/derived/frontend');

export function isUpdateMode(): boolean {
  return process.env['GOLDEN_UPDATE'] === '1';
}

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

const INLINE_MAX = 240;

/** Replace values JSON cannot carry so that nothing is silently dropped. */
function normalize(value: unknown): unknown {
  if (value === undefined) return '__undefined__';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '__NaN__';
    if (value === Infinity) return '__Infinity__';
    if (value === -Infinity) return '__-Infinity__';
    if (Object.is(value, -0)) return '__-0__';
    return value;
  }
  if (typeof value === 'bigint') return `__bigint:${value}__`;
  if (typeof value === 'function') return '__function__';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '__InvalidDate__' : `__Date:${value.toISOString()}__`;
  }
  if (value instanceof RegExp) return `__RegExp:${value.toString()}__`;
  if (value instanceof Set) return { __Set__: [...value].map(normalize) };
  if (value instanceof Map) return { __Map__: [...value.entries()].map(([k, v]) => [normalize(k), normalize(v)]) };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      // An own key whose value is undefined is dropped, as JSON.stringify would.
      if (v === undefined) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}

function render(value: unknown, indent: string): string {
  if (isPrimitive(value)) return JSON.stringify(value);
  const inline = JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
  const flatOk =
    (Array.isArray(value) && value.every(isPrimitive)) ||
    (!Array.isArray(value) && Object.values(value as object).every(isPrimitive));
  if (flatOk && inline.length <= INLINE_MAX) {
    // JSON.stringify(.., 1) puts spaces inside brackets; tighten for stability.
    return Array.isArray(value)
      ? `[${(value as unknown[]).map(v => JSON.stringify(v)).join(', ')}]`
      : `{${Object.entries(value as object).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
  }
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map(v => inner + render(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as object);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${render(v, inner)}`).join(',\n')}\n${indent}}`;
}

/**
 * Stable text form: keys sorted recursively, 2-space indent, short flat
 * arrays/objects inline, trailing newline. Still valid JSON.
 */
export function stableStringify(value: unknown): string {
  return render(normalize(value), '') + '\n';
}

/** Single-line canonical JSON (keys sorted), for use as an object key / label. */
export function compactStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

// ---------------------------------------------------------------------------
// Compare / write
// ---------------------------------------------------------------------------

const visited = new Set<string>();

function firstDifference(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i++) {
    if (e[i] !== a[i]) {
      const lo = Math.max(0, i - 2);
      const ctx = (lines: string[]) => lines.slice(lo, i + 3).map((l, j) => `${lo + j + 1}: ${l}`).join('\n');
      return `first difference at line ${i + 1}\n--- committed\n${ctx(e)}\n--- actual\n${ctx(a)}`;
    }
  }
  return 'content differs';
}

/** Compare (or, with GOLDEN_UPDATE=1, write) one artifact. relPath is relative to DERIVED_ROOT. */
export function checkGolden(relPath: string, value: unknown): void {
  const file = path.join(DERIVED_ROOT, relPath);
  const actual = stableStringify(value);
  visited.add(relPath);
  if (isUpdateMode()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  if (!fs.existsSync(file)) {
    expect.fail(`golden artifact missing: tests/golden/derived/frontend/${relPath} (run scripts/golden/derive-frontend.sh)`);
  }
  const expected = fs.readFileSync(file, 'utf8');
  const same = expected === actual;
  expect(
    same,
    same ? '' : `golden mismatch: tests/golden/derived/frontend/${relPath}: ${firstDifference(expected, actual)}`
  ).toBe(true);
}

/**
 * Fail if a committed artifact owned by this spec (selected by `owns`) was not
 * produced during the run. Call from an `afterAll`-style final test.
 */
export function expectNoOrphans(owns: (relPath: string) => boolean): void {
  if (isUpdateMode()) return;
  const orphans: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        const rel = path.relative(DERIVED_ROOT, full).split(path.sep).join('/');
        if (rel.endsWith('.json') && owns(rel) && !visited.has(rel)) orphans.push(rel);
      }
    }
  };
  if (fs.existsSync(DERIVED_ROOT)) walk(DERIVED_ROOT);
  expect(orphans, 'orphan golden files (no longer produced)').toEqual([]);
}

// ---------------------------------------------------------------------------
// Raw fixtures
// ---------------------------------------------------------------------------

export interface Variant {
  example: string;
  /** e.g. testadmin, anon.es */
  variant: string;
  role: string;
  locale: string;
  dir: string;
  /** In-memory endpoint bodies (the hand-built `_synthetic` variant); takes precedence over `dir`. */
  inline?: Record<string, unknown>;
}

const ROLE_ORDER = ['anon', 'testuser', 'testeditor', 'testmanager', 'testadmin'];

export function listExamples(): string[] {
  return fs.readdirSync(RAW_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

export function listVariants(example: string): Variant[] {
  const base = path.join(RAW_ROOT, example);
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort((x, y) => {
      const [rx, lx = ''] = x.split('.');
      const [ry, ly = ''] = y.split('.');
      return lx.localeCompare(ly) || ROLE_ORDER.indexOf(rx) - ROLE_ORDER.indexOf(ry);
    })
    .map(v => {
      const [role, locale = 'en'] = v.split('.');
      return { example, variant: v, role, locale, dir: path.join(base, v) };
    });
}

export function listAllVariants(): Variant[] {
  return listExamples().flatMap(listVariants);
}

/** Fresh deep copy of a raw endpoint fixture (services mutate their inputs). */
export function loadRaw<T = any>(v: Variant, endpoint: string): T {
  if (v.inline) return structuredClone(v.inline[endpoint]) as T;
  return JSON.parse(fs.readFileSync(path.join(v.dir, `${endpoint}.json`), 'utf8'));
}

export function hasRaw(v: Variant, endpoint: string): boolean {
  if (v.inline) return endpoint in v.inline;
  return fs.existsSync(path.join(v.dir, `${endpoint}.json`));
}

export function listRawEndpoints(v: Variant, prefix: string): string[] {
  return fs.readdirSync(v.dir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

export const TIME_ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'] as const;

/**
 * Run `fn` with process.env.TZ switched to `tz`, restoring the original in a
 * finally block. Node re-reads TZ on assignment (proved by the first test in
 * transforms.golden.spec.ts), so no test depends on the machine zone.
 */
export function withTimeZone<T>(tz: string, fn: () => T): T {
  const original = process.env['TZ'];
  process.env['TZ'] = tz;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  }
}

/**
 * Run `compute` under every zone; collapse to {"*": out} when identical so
 * zone-independent results are not repeated four times.
 */
export function acrossZones(compute: () => unknown): Record<string, unknown> {
  const byZone: Record<string, unknown> = {};
  for (const tz of TIME_ZONES) byZone[tz] = withTimeZone(tz, compute);
  const first = stableStringify(byZone[TIME_ZONES[0]]);
  return TIME_ZONES.every(tz => stableStringify(byZone[tz]) === first) ? { '*': byZone[TIME_ZONES[0]] } : byZone;
}

/** Safe file/key segment for a zone name. */
export function tzSlug(tz: string): string {
  return tz.replace(/\//g, '-');
}
