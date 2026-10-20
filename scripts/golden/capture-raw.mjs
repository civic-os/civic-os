#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Raw metadata-contract capture (SDK P0.1).
 *
 * Captures what the frontend (SchemaService et al.) and the MCP server
 * (schema-cache.ts) read from PostgREST at bootstrap, for every role, as
 * canonical JSON under tests/golden/raw/<example>/<role>[.<locale>]/.
 *
 * Assumes the example stack is already up (see capture-all.sh).
 *
 *   node scripts/golden/capture-raw.mjs --example pothole [--example ...] | --all
 *   node scripts/golden/capture-raw.mjs --all --check     # diff against committed fixtures
 *
 * Regeneration is explicit; nothing here runs as part of the test suite.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskClockDates } from './volatile.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW_DIR = join(REPO, 'tests', 'golden', 'raw');

const ALL_EXAMPLES = [
  'pothole', 'community-center', 'staff-portal', 'neighborhood-hub',
  'client-intake', 'mottpark', 'broader-impacts', 'storymap',
];
const ROLES = ['anon', 'testuser', 'testeditor', 'testmanager', 'testadmin'];
/** Extra locale variants: example -> locales captured in addition to the default. */
const EXTRA_LOCALES = { pothole: ['es'] };

const POSTGREST = process.env.POSTGREST_URL ?? 'http://localhost:3000/';
const KEYCLOAK_TOKEN_URL = process.env.KEYCLOAK_TOKEN_URL
  ?? 'http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/token';
const KEYCLOAK_CLIENT = 'civic-os-dev-client';

/**
 * Static endpoints. `file` is the fixture name, `path` the PostgREST path+query
 * exactly as the consumer sends it. `consumer` documents provenance.
 *
 * Where the frontend sends a per-table request (schema_entity_actions with
 * table_name=eq.X) we capture the unfiltered view once; the per-table result is
 * the filter of that capture, ordered by sort_order.
 */
const STATIC_ENDPOINTS = [
  { file: 'schema_entities', path: 'schema_entities', consumer: 'frontend schema.service getSchema()' },
  { file: 'schema_entities.mcp', path: 'schema_entities?order=sort_order.asc,display_name.asc', consumer: 'mcp schema-cache fetchEntities()' },
  { file: 'schema_properties', path: 'schema_properties', consumer: 'frontend schema.service getProperties()' },
  { file: 'schema_properties.mcp', path: 'schema_properties?order=table_name.asc,sort_order.asc', consumer: 'mcp schema-cache fetchProperties()' },
  { file: 'schema_m2m_properties', path: 'schema_m2m_properties', consumer: 'frontend schema.service getProperties()' },
  { file: 'schema_entity_actions', path: 'schema_entity_actions', consumer: 'frontend schema.service getEntityActions() (unfiltered; app filters per table_name)' },
  { file: 'schema_entity_actions.mcp', path: 'schema_entity_actions?order=table_name.asc,sort_order.asc', consumer: 'mcp schema-cache fetchActions()' },
  { file: 'constraint_messages', path: 'constraint_messages', consumer: 'frontend + mcp' },
  { file: 'static_text', path: 'static_text', consumer: 'frontend schema.service getStaticText()' },
  { file: 'schema_guided_forms', path: 'schema_guided_forms', consumer: 'frontend schema.service getGuidedFormDefinitions()' },
  { file: 'schema_guided_form_steps', path: 'schema_guided_form_steps', consumer: 'frontend schema.service getGuidedFormSteps()' },
  { file: 'schema_cache_versions', path: 'schema_cache_versions', consumer: 'frontend version.service + mcp' },
  { file: 'photo_gallery_config', path: 'photo_gallery_config', consumer: 'frontend gallery.service (unfiltered; app filters by table_name/column_name)' },
  { file: 'user_profile_extensions', path: 'user_profile_extensions?order=sort_order,table_name', consumer: 'frontend profile.service' },
  { file: 'statuses', path: 'statuses?order=entity_type.asc,sort_order.asc,display_name.asc', consumer: 'mcp schema-cache fetchStatuses()' },
  { file: 'categories', path: 'categories?order=entity_type.asc,sort_order.asc,display_name.asc', consumer: 'mcp schema-cache fetchCategories()' },
  { file: 'status_transitions', path: 'status_transitions', consumer: 'mcp schema-cache fetchTransitions()' },
  { file: 'rpc.get_current_user_permissions', path: 'rpc/get_current_user_permissions', body: {}, consumer: 'frontend auth.service' },
];

/**
 * Row-order policy per fixture.
 *
 * `server`: the keys the server (view ORDER BY, function ORDER BY, or the consumer's own
 * `order=`) sorts by. Row order as returned is PRESERVED; only runs of rows that tie on these
 * keys are canonicalized (by `tie` keys, then the row's JSON), because order within a tie is plan
 * order, differs between boots, and is not part of the contract. Server order of the non-tied rows
 * (including collation-dependent text order) is kept exactly, so `--check` catches regressions.
 *
 * `server: null`: neither the server nor the consumer defines an order; the array is sorted by the
 * natural key `tie` (NULLs last, JSON as final tie-break). orderSource in meta.json says which.
 */
const ORDER = {
  // view: ORDER BY COALESCE(sort_order, 0), table_name
  schema_entities: { server: ['sort_order', 'table_name'], tie: [] },
  'schema_entities.mcp': { server: ['sort_order', 'display_name'], tie: ['table_name'] },
  schema_properties: { server: null, tie: ['table_name', 'column_name'] },
  'schema_properties.mcp': { server: ['table_name', 'sort_order'], tie: ['column_name'] },
  schema_m2m_properties: { server: null, tie: ['table_name', 'column_name'] },
  // view: ORDER BY table_name, sort_order
  schema_entity_actions: { server: ['table_name', 'sort_order'], tie: ['id'] },
  'schema_entity_actions.mcp': { server: ['table_name', 'sort_order'], tie: ['id'] },
  constraint_messages: { server: null, tie: ['constraint_name', 'table_name', 'column_name'] },
  static_text: { server: null, tie: ['table_name', 'sort_order', 'id'] },
  schema_guided_forms: { server: null, tie: ['guided_form_key'] },
  // view: ORDER BY guided_form_key, step_order
  schema_guided_form_steps: { server: ['guided_form_key', 'step_order'], tie: ['id'] },
  schema_cache_versions: { server: null, tie: ['cache_name'] },
  photo_gallery_config: { server: null, tie: ['table_name', 'column_name', 'id'] },
  // consumer: order=sort_order,table_name
  user_profile_extensions: { server: ['sort_order', 'table_name'], tie: [] },
  // consumer (mcp): order=entity_type.asc,sort_order.asc,display_name.asc
  statuses: { server: ['entity_type', 'sort_order', 'display_name'], tie: ['id'] },
  categories: { server: ['entity_type', 'sort_order', 'display_name'], tie: ['id'] },
  status_transitions: { server: null, tie: [] },
  'rpc.get_current_user_permissions': { server: null, tie: ['table_name', 'permission'] },
  'rpc.get_translations_for_locale': { server: null, tie: ['source_type', 'source_key'] },
};
/** Dynamic per-entity-type RPC fixtures. */
function orderFor(file) {
  if (file in ORDER) return ORDER[file];
  // functions: ORDER BY sort_order, display_name
  if (file.startsWith('rpc.get_statuses_for_entity.') || file.startsWith('rpc.get_categories_for_entity.')) {
    return { server: ['sort_order', 'display_name'], tie: ['id'] };
  }
  // function: ORDER BY st.sort_order, fs.sort_order, ts.sort_order. The last two are not output columns,
  // so ties cannot be recognized from the rows: the server order is kept verbatim (no canonicalization).
  if (file.startsWith('rpc.get_status_transitions_for_entity.')) {
    return { verbatim: true, server: ['st.sort_order', 'fs.sort_order', 'ts.sort_order'], tie: [] };
  }
  return null;
}
/** Row-creation/modification timestamps are boot-time values on every metadata row. */
const GLOBAL_MASK = ['created_at', 'updated_at'];
const MASKS = {
  // Volatile timestamps; consumers only compare them for equality against a cached copy.
  schema_cache_versions: ['version'],
};
const MASK_VALUE = '__MASKED__';

/**
 * Privacy redactions applied to string values of static_text rows. mottpark's payment
 * instructions name the individual to pay, with a payment handle, phone and email.
 * The fixtures keep the structure and the surrounding text, not the personal data.
 * Rules match by shape and context, never by the literal values, so this script does not
 * itself carry the data it removes.
 */
const REDACTIONS = [
  ['person-name', /(?<=\b(?:[Pp]ay|[Pp]ayable to) )[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[REDACTED NAME]'],
  ['person-name', /(?<=\bContact )[A-Z][a-z]+(?= at\b)/g, '[REDACTED NAME]'],
  ['payment-handle', /\$[A-Za-z][A-Za-z0-9_]{2,}\b/g, '[REDACTED HANDLE]'],
  ['phone', /\b\d{3}-\d{3}-\d{4}\b/g, '[REDACTED PHONE]'],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED EMAIL]'],
];
const REDACTED_FILES = new Set(['static_text']);

// --------------------------------------------------------------------------

function parseArgs(argv) {
  const examples = [];
  let all = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--example') examples.push(argv[++i]);
    else if (a === '--all') all = true;
    else if (a === '--check') check = true;
    else if (a === '--help' || a === '-h') { usage(0); }
    else usage(2, `unknown argument: ${a}`);
  }
  if (all) examples.splice(0, examples.length, ...ALL_EXAMPLES);
  if (!examples.length) usage(2, 'specify --example <name> or --all');
  for (const e of examples) if (!ALL_EXAMPLES.includes(e)) usage(2, `unknown example: ${e}`);
  return { examples, check, all };
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('usage: capture-raw.mjs (--example <name>... | --all) [--check]');
  process.exit(code);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

const canonical = (v) => JSON.stringify(sortKeys(v), null, 2) + '\n';

function cmpValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

async function getToken(user) {
  const body = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT, username: user, password: user, grant_type: 'password',
  });
  const res = await fetch(KEYCLOAK_TOKEN_URL, { method: 'POST', body });
  if (!res.ok) throw new Error(`token for ${user}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function call(ep, headers) {
  const res = await fetch(POSTGREST + ep.path, {
    method: ep.body === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', ...(ep.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: ep.body === undefined ? undefined : JSON.stringify(ep.body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text === '' ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function redactStrings(v, counts) {
  if (typeof v === 'string') {
    let out = v;
    for (const [label, re, rep] of REDACTIONS) {
      out = out.replace(re, () => { counts[label] = (counts[label] ?? 0) + 1; return rep; });
    }
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => redactStrings(x, counts));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactStrings(x, counts)]));
  return v;
}

/** Apply masking, redaction and sorting to a 200 body; returns { body, sorted, masked, redacted }. */
function normalize(file, body) {
  let sorted = null;
  const clock = maskClockDates(body);
  body = clock.value;
  const masked = [];
  const redacted = {};
  if (Array.isArray(body)) {
    const mask = [...GLOBAL_MASK, ...(MASKS[file] ?? [])];
    body = body.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const r = { ...row };
      for (const f of mask) if (f in r) { r[f] = MASK_VALUE; if (!masked.includes(f)) masked.push(f); }
      return r;
    });
    if (REDACTED_FILES.has(file)) body = redactStrings(body, redacted);
    const spec = orderFor(file);
    if (spec?.verbatim) {
      sorted = { orderSource: 'server', serverKeys: spec.server, tieKeys: [],
        note: 'server ORDER BY includes non-output columns; row order kept verbatim, no canonicalization' };
    } else if (spec) {
      const cmpTie = (x, y) => {
        for (const k of spec.tie) { const c = cmpValues(x?.[k], y?.[k]); if (c) return c; }
        const xs = canonical(x), ys = canonical(y);
        return xs < ys ? -1 : xs > ys ? 1 : 0;
      };
      if (spec.server) {
        const kv = (r) => JSON.stringify(spec.server.map((k) => r?.[k] ?? null));
        const out = [];
        let run = [];
        const flush = () => { run.sort(cmpTie); out.push(...run); run = []; };
        for (const row of body) {
          if (run.length && kv(run[0]) !== kv(row)) flush();
          run.push(row);
        }
        flush();
        body = out;
      } else {
        body = [...body].sort(cmpTie);
      }
      sorted = { orderSource: spec.server ? 'server' : 'natural-key', serverKeys: spec.server, tieKeys: spec.tie,
        note: spec.server ? 'row order preserved as returned; order within runs tied on serverKeys is canonicalized and is not contract'
          : 'no defined order from server or consumer; sorted by tieKeys' };
    }
  }
  return { body, sorted, masked, redacted, clockMasked: clock.count };
}

function distinct(rows, field) {
  const s = new Set();
  if (Array.isArray(rows)) for (const r of rows) if (r && r[field]) s.add(r[field]);
  return s;
}

function safe(name) {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function captureVariant(example, role, locale, token, outDir, meta) {
  const dirName = locale ? `${role}.${locale}` : role;
  const dir = join(outDir, example, dirName);
  mkdirSync(dir, { recursive: true });
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (locale) headers['Accept-Language'] = locale;

  const record = { statuses: {}, files: [] };
  meta.variants[dirName] = record;

  if (token) {
    const r = await call({ path: 'rpc/refresh_current_user', body: {} }, headers);
    record.refreshCurrentUser = r.status;
  }

  const results = {};
  const endpoints = [...STATIC_ENDPOINTS];
  if (locale) {
    endpoints.push({
      file: 'rpc.get_translations_for_locale', path: 'rpc/get_translations_for_locale',
      body: { p_locale: locale }, consumer: 'frontend translation.service',
    });
  }

  const run = async (ep) => {
    const r = await call(ep, headers);
    record.statuses[ep.file] = r.status;
    let content;
    if (r.status === 200) {
      const n = normalize(ep.file, r.body);
      content = n.body;
      results[ep.file] = n.body;
      if (n.sorted) meta.ordering[ep.file.replace(/^(rpc\.get_(?:statuses|categories|status_transitions)_for_entity)\..*$/, '$1.<entity_type>')] = n.sorted;
      if (n.clockMasked) {
        meta.clockDateMasks[ep.file] = { field: 'default_value', placeholder: '<CURRENT_DATE>', note: 'server-rendered CURRENT_DATE default; masked when within one day of capture time' };
      }
      for (const [label, count] of Object.entries(n.redacted)) {
        meta.redactions[ep.file] ??= {};
        meta.redactions[ep.file][label] = (meta.redactions[ep.file][label] ?? 0) + count;
      }
      for (const f of n.masked) {
        meta.maskedFields[ep.file] ??= [];
        if (!meta.maskedFields[ep.file].includes(f)) meta.maskedFields[ep.file].push(f);
      }
    } else {
      content = { __status: r.status, __body: r.body };
    }
    writeFileSync(join(dir, `${safe(ep.file)}.json`), canonical(content));
    record.files.push(`${safe(ep.file)}.json`);
  };

  for (const ep of endpoints) await run(ep);

  // Distinct status / category entity types (this role's properties plus the
  // statuses/categories views, whichever this role can see).
  const statusTypes = new Set([
    ...distinct(results.schema_properties, 'status_entity_type'),
    ...distinct(results['schema_properties.mcp'], 'status_entity_type'),
    ...distinct(results.statuses, 'entity_type'),
  ]);
  const categoryTypes = new Set([
    ...distinct(results.schema_properties, 'category_entity_type'),
    ...distinct(results['schema_properties.mcp'], 'category_entity_type'),
    ...distinct(results.categories, 'entity_type'),
  ]);
  record.statusEntityTypes = [...statusTypes].sort();
  record.categoryEntityTypes = [...categoryTypes].sort();
  for (const t of record.statusEntityTypes) {
    await run({ file: `rpc.get_statuses_for_entity.${t}`, path: 'rpc/get_statuses_for_entity', body: { p_entity_type: t } });
  }
  // Admin page's transitions endpoint (the MCP's `status_transitions` view does not exist on these instances).
  for (const t of record.statusEntityTypes) {
    await run({ file: `rpc.get_status_transitions_for_entity.${t}`, path: 'rpc/get_status_transitions_for_entity', body: { p_entity_type: t } });
  }
  for (const t of record.categoryEntityTypes) {
    await run({ file: `rpc.get_categories_for_entity.${t}`, path: 'rpc/get_categories_for_entity', body: { p_entity_type: t } });
  }
  record.files.sort();
}

function treeHash(path) {
  try {
    return execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch { return null; }
}

async function captureExample(example, outDir) {
  const meta = {
    example,
    examplesTreeHash: treeHash(`examples/${example}`),
    migrationsTreeHash: treeHash('postgres/migrations'),
    endpoints: STATIC_ENDPOINTS.map((e) => ({ file: e.file, path: e.path, method: e.body === undefined ? 'GET' : 'POST', consumer: e.consumer })),
    maskValue: MASK_VALUE,
    maskedFields: {},
    ordering: {},
    clockDateMasks: {},
    redactions: {},
    variants: {},
    capturedAt: new Date().toISOString(),
  };
  // Fresh dir so deleted endpoints don't linger.
  rmSync(join(outDir, example), { recursive: true, force: true });
  mkdirSync(join(outDir, example), { recursive: true });

  const tokens = { anon: null };
  for (const role of ROLES.slice(1)) tokens[role] = await getToken(role);

  for (const role of ROLES) {
    await captureVariant(example, role, null, tokens[role], outDir, meta);
  }
  for (const locale of EXTRA_LOCALES[example] ?? []) {
    for (const role of ROLES) {
      await captureVariant(example, role, locale, tokens[role], outDir, meta);
    }
  }
  writeFileSync(join(outDir, example, 'meta.json'), canonical(meta));
  console.log(`captured ${example}: ${Object.keys(meta.variants).length} variants`);
}

function buildManifest(outDir) {
  const manifest = { examples: {} };
  for (const ex of readdirSync(outDir).sort()) {
    const exDir = join(outDir, ex);
    if (!statSync(exDir).isDirectory()) continue;
    const variants = {};
    for (const v of readdirSync(exDir).sort()) {
      const vDir = join(exDir, v);
      if (!statSync(vDir).isDirectory()) continue;
      variants[v] = readdirSync(vDir).filter((f) => f.endsWith('.json')).sort();
    }
    manifest.examples[ex] = { variants };
  }
  return manifest;
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

function comparableContent(path, rel) {
  let txt = readFileSync(path, 'utf8');
  if (rel.endsWith('meta.json')) {
    const m = JSON.parse(txt);
    delete m.capturedAt; // informational
    delete m.examplesTreeHash; // reported as a warning, not a failure
    delete m.migrationsTreeHash;
    txt = canonical(m);
  }
  return txt;
}

function runCheck(examples, all, tmp) {
  let diffs = 0;
  const files = new Set();
  for (const ex of examples) {
    for (const base of [RAW_DIR, tmp]) {
      const exDir = join(base, ex);
      if (existsSync(exDir)) for (const f of walk(exDir, base)) files.add(f);
    }
  }
  if (all) files.add('MANIFEST.json');
  for (const rel of [...files].sort()) {
    const a = join(RAW_DIR, rel);
    const b = join(tmp, rel);
    const ea = existsSync(a);
    const eb = existsSync(b);
    if (!ea || !eb) {
      console.error(`DIFF ${rel}: ${ea ? 'missing from fresh capture' : 'missing from committed fixtures'}`);
      diffs++;
    } else if (comparableContent(a, rel) !== comparableContent(b, rel)) {
      console.error(`DIFF ${rel}: content differs`);
      diffs++;
    }
  }
  for (const ex of examples) {
    const a = join(RAW_DIR, ex, 'meta.json');
    const b = join(tmp, ex, 'meta.json');
    if (existsSync(a) && existsSync(b)) {
      const ma = JSON.parse(readFileSync(a, 'utf8'));
      const mb = JSON.parse(readFileSync(b, 'utf8'));
      if (ma.examplesTreeHash !== mb.examplesTreeHash) console.warn(`WARN ${ex}: examples tree hash changed since fixtures were captured`);
      if (ma.migrationsTreeHash !== mb.migrationsTreeHash) console.warn(`WARN ${ex}: postgres/migrations tree hash changed since fixtures were captured`);
    }
  }
  return diffs;
}

async function main() {
  const { examples, check, all } = parseArgs(process.argv.slice(2));
  const outDir = check ? mkdtempSync(join(tmpdir(), 'golden-raw-')) : RAW_DIR;
  mkdirSync(outDir, { recursive: true });
  try {
    for (const ex of examples) await captureExample(ex, outDir);
    if (check) {
      // MANIFEST of the fresh capture only meaningful for a full run.
      if (all) writeFileSync(join(outDir, 'MANIFEST.json'), canonical(buildManifest(outDir)));
      const diffs = runCheck(examples, all, outDir);
      if (diffs) { console.error(`--check FAILED: ${diffs} differing file(s)`); process.exitCode = 1; }
      else console.log('--check OK: zero diff');
    } else {
      writeFileSync(join(RAW_DIR, 'MANIFEST.json'), canonical(buildManifest(RAW_DIR)));
    }
  } finally {
    if (check) rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
