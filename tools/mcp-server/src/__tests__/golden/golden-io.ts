/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden-output I/O for the MCP server (SDK program, P0.3).
 *
 * The MCP golden tests (`*.golden.test.ts` in this folder) feed the committed
 * raw metadata fixtures (`tests/golden/raw/`) through the CURRENT MCP server
 * code and compare the result byte-for-byte with the committed files under
 * `tests/golden/derived/mcp/`. Where a frontend golden artifact exists for the
 * same function, the MCP artifact has the same name and JSON shape, and its
 * inputs are read from that frontend artifact so both sides see identical
 * inputs. Files are written only when GOLDEN_UPDATE=1
 * (scripts/golden/derive-mcp.sh); a missing, changed or orphan file fails a
 * normal run.
 *
 * The serializer below is a verbatim copy of src/app/testing/golden/golden-io.ts
 * (the MCP server must not import from src/app); both trees must stay
 * byte-compatible so `diff -r` between them is meaningful.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      fs.existsSync(path.join(dir, 'tests/golden/raw/MANIFEST.json')) &&
      fs.existsSync(path.join(dir, 'tools/mcp-server/package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`repo root (tests/golden/raw) not found above ${fileURLToPath(import.meta.url)}`);
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot();
export const RAW_ROOT = path.join(REPO_ROOT, 'tests/golden/raw');
export const FRONTEND_ROOT = path.join(REPO_ROOT, 'tests/golden/derived/frontend');
export const DERIVED_ROOT = path.join(REPO_ROOT, 'tests/golden/derived/mcp');
const DERIVED_REL = 'tests/golden/derived/mcp';

export function isUpdateMode(): boolean {
  return process.env['GOLDEN_UPDATE'] === '1';
}

// ---------------------------------------------------------------------------
// Deterministic serialization (copy of the frontend serializer)
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
    expect.fail(`golden artifact missing: ${DERIVED_REL}/${relPath} (run scripts/golden/derive-mcp.sh)`);
  }
  const expected = fs.readFileSync(file, 'utf8');
  const same = expected === actual;
  expect(
    same,
    same ? '' : `golden mismatch: ${DERIVED_REL}/${relPath}: ${firstDifference(expected, actual)}`,
  ).toBe(true);
}

/**
 * Fail if a committed artifact owned by this test file (selected by `owns`)
 * was not produced during the run. Call from a final test in the file.
 * In update mode, owned files that were not produced are deleted instead.
 */
export function expectNoOrphans(owns: (relPath: string) => boolean): void {
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
  if (isUpdateMode()) {
    for (const rel of orphans) fs.rmSync(path.join(DERIVED_ROOT, rel));
    return;
  }
  expect(orphans, 'orphan golden files (no longer produced)').toEqual([]);
}

// ---------------------------------------------------------------------------
// Raw fixtures and frontend artifacts (inputs)
// ---------------------------------------------------------------------------

export interface Variant {
  example: string;
  /** e.g. testadmin, anon.es */
  variant: string;
  role: string;
  locale: string;
  dir: string;
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

export function adminVariant(example: string): Variant {
  const v = listVariants(example).find(x => x.variant === 'testadmin');
  if (!v) throw new Error(`no testadmin variant for ${example}`);
  return v;
}

/** Fresh deep copy of a raw endpoint fixture (the MCP cache mutates `type` onto properties). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadRaw<T = any>(v: Variant, endpoint: string): T {
  return JSON.parse(fs.readFileSync(path.join(v.dir, `${endpoint}.json`), 'utf8'));
}

export function hasRaw(v: Variant, endpoint: string): boolean {
  return fs.existsSync(path.join(v.dir, `${endpoint}.json`));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadExampleMeta(example: string): any {
  return JSON.parse(fs.readFileSync(path.join(RAW_ROOT, example, 'meta.json'), 'utf8'));
}

/**
 * Read a committed frontend golden artifact. The MCP goldens take their inputs
 * (condition records, error payloads, query inputs) from these files so both
 * sides are fed identical inputs; a missing file means the frontend goldens
 * have not been derived (scripts/golden/derive-frontend.sh).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadFrontendArtifact<T = any>(relPath: string): T {
  const file = path.join(FRONTEND_ROOT, relPath);
  if (!fs.existsSync(file)) {
    throw new Error(`frontend golden input missing: tests/golden/derived/frontend/${relPath} (run scripts/golden/derive-frontend.sh first)`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Inverse of compactStringify for labels written by the frontend goldens. */
export function parseLabel(label: string): unknown {
  return JSON.parse(label);
}
