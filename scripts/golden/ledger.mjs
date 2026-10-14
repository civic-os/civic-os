#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * SDK divergence ledger (P0.3).
 *
 * Reads the frontend and MCP golden trees (tests/golden/derived/{frontend,mcp})
 * plus the raw fixtures, diffs every shared artifact, attributes each
 * difference to exactly one rule from scripts/golden/ledger-rules.mjs, and
 * writes:
 *   docs/notes/SDK_DIVERGENCE_LEDGER.md   (for Daniel's per-row decision at gate 2)
 *   tests/golden/ledger.json             (machine-readable, same content)
 *
 *   node scripts/golden/ledger.mjs            rewrite both files
 *   node scripts/golden/ledger.mjs --check    fail (exit 1) if either committed file is stale
 *
 * Any difference no rule explains is reported as unattributed and fails the
 * run (exit 2): the ledger must account for every computed divergence.
 * Output is deterministic (no timestamps, everything sorted).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, AREAS, NONDETERMINISM } from './ledger-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FE = path.join(ROOT, 'tests/golden/derived/frontend');
const MCP = path.join(ROOT, 'tests/golden/derived/mcp');
const RAW = path.join(ROOT, 'tests/golden/raw');
const OUT_MD = path.join(ROOT, 'docs/notes/SDK_DIVERGENCE_LEDGER.md');
const OUT_JSON = path.join(ROOT, 'tests/golden/ledger.json');

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const isDir = p => fs.existsSync(p) && fs.statSync(p).isDirectory();
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Canonical JSON (sorted keys) for labels. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const ROLE_ORDER = ['anon', 'testuser', 'testeditor', 'testmanager', 'testadmin'];
const examples = () => fs.readdirSync(RAW).filter(d => isDir(path.join(RAW, d))).sort();
const variants = ex => fs.readdirSync(path.join(RAW, ex)).filter(d => isDir(path.join(RAW, ex, d))).sort((x, y) => {
  const [rx, lx = ''] = x.split('.');
  const [ry, ly = ''] = y.split('.');
  return cmp(lx, ly) || ROLE_ORDER.indexOf(rx) - ROLE_ORDER.indexOf(ry);
});

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

const ruleById = new Map(RULES.map(r => [r.id, r]));
const hits = new Map();
const unattributed = [];
const diagnostics = { tieOrderArtifacts: 0, comparisons: {} };

function count(area) { diagnostics.comparisons[area] = (diagnostics.comparisons[area] ?? 0) + 1; }

/** Record one difference explained by `ruleId`. kind 'instances' = the rule itself, 'effects' = a downstream difference it causes. */
function hit(ruleId, inst, kind = 'instances') {
  if (!ruleById.has(ruleId)) throw new Error(`unknown rule ${ruleId}`);
  if (!hits.has(ruleId)) hits.set(ruleId, { instances: new Map(), effects: new Map() });
  const bucket = hits.get(ruleId)[kind];
  const key = [inst.example ?? '', inst.entity ?? '', inst.subject ?? ''].join(' · ');
  if (!bucket.has(key)) bucket.set(key, { example: inst.example, entity: inst.entity, subject: inst.subject, detail: inst.detail, variants: new Set(), occurrences: 0 });
  const e = bucket.get(key);
  if (inst.variant) e.variants.add(inst.variant);
  e.occurrences++;
}

function miss(area, inst) {
  unattributed.push({ area, ...inst });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SYSTEM_TYPES = ['User', 'File', 'FileImage', 'FilePDF', 'Payment', 'PhotoGallery'];
const STATUSY = ['Status', 'Category'];
const INT = ['int4', 'int8'];

/** Which type-detection rule explains fe -> mcp for raw property p (null if none). */
function classifyType(p, fe, mc) {
  if (!p) return null;
  const { udt_name: udt, join_table: jt, join_column: jc, join_schema: js } = p;
  if ((fe === 'FileImage' && mc === 'File') || (fe === 'File' && mc === 'FileImage')) return 'T-06';
  if (STATUSY.includes(mc) && !STATUSY.includes(fe)) return !INT.includes(udt) ? 'T-02' : (!jt ? 'T-01' : null);
  if (STATUSY.includes(fe) && !STATUSY.includes(mc)) return jc != null && !jt ? 'T-01' : null;
  if (SYSTEM_TYPES.includes(mc) && !SYSTEM_TYPES.includes(fe)) {
    if (jt === 'civic_os_users_private') return 'T-04';
    if (jt === 'transactions' && js !== 'payments' && udt === 'uuid') return 'T-05';
    if (udt !== 'uuid') return 'T-03';
    return null;
  }
  if (udt === 'geography') return 'T-07';
  if (udt === 'int2') return 'T-08';
  if (udt === 'bpchar') return 'T-10';
  if (udt === 'uuid') return 'T-09';
  if (fe === 'ForeignKeyName' || mc === 'ForeignKeyName') {
    if (jc != null && !jt) return 'T-01';
    if (mc === 'ForeignKeyName' && !INT.includes(udt)) return 'T-11';
  }
  return null;
}

function classifySelect(e, m, p) {
  switch (e.type) {
    case 'User': return 'S-03';
    case 'File': case 'FileImage': case 'FilePDF': return 'S-04';
    case 'Payment': return 'S-05';
    case 'PhotoGallery': return e.selectForList !== '=' && m.select === e.selectForList ? 'S-06' : null;
    case 'ForeignKeyName':
      if (!p) return null;
      if (p.join_schema !== 'public') return 'S-02';
      if (p.join_column !== 'id') return 'S-01';
      return null;
    default: return null;
  }
}

/** Split a PostgREST select value into top-level items (parentheses-aware). */
function splitSelect(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s ?? '') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur !== '' || out.length) out.push(cur);
  return out;
}
const alias = item => item.split(':')[0].split('!')[0].split('(')[0];

/** Parse a recorded frontend URL (`<PGRST>/path?query`, not encoded) the way PostgREST decodes it. */
function parseFeUrl(url) {
  const rest = url.replace(/^<PGRST>\//, '');
  const q = rest.indexOf('?');
  const pathPart = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? '' : rest.slice(q + 1);
  const params = [...new URLSearchParams(query).entries()].map(([k, v]) => [k, v]);
  return { path: pathPart, params };
}
function parseMcpRequest(r) {
  const rest = r.url.replace(/^<PGRST>\//, '');
  const q = rest.indexOf('?');
  return { path: decodeURIComponent(q < 0 ? rest : rest.slice(0, q)), params: r.decoded.map(d => { const i = d.indexOf('='); return [d.slice(0, i), d.slice(i + 1)]; }) };
}

// ---------------------------------------------------------------------------
// Engine 1: property types and select strings (per variant)
// ---------------------------------------------------------------------------

function propertyEngine() {
  for (const ex of examples()) {
    for (const v of variants(ex)) {
      const fePath = path.join(FE, ex, v, 'schema.properties.json');
      const mcPath = path.join(MCP, ex, v, 'schema.properties.json');
      if (!fs.existsSync(fePath) || !fs.existsSync(mcPath)) { miss('properties', { example: ex, variant: v, detail: 'artifact missing on one side' }); continue; }
      const fe = readJson(fePath).entities;
      const mc = readJson(mcPath).entities;
      const raw = new Map(readJson(path.join(RAW, ex, v, 'schema_properties.json')).map(p => [`${p.table_name}.${p.column_name}`, p]));
      for (const [table, list] of Object.entries(fe)) {
        const mIndex = new Map((mc[table] ?? []).map(m => [m.column, m]));
        for (const e of list) {
          count('property');
          const base = { example: ex, variant: v, entity: table, subject: e.column };
          const m = mIndex.get(e.column);
          mIndex.delete(e.column);
          if (!m) {
            if (e.type === 'ManyToMany') hit('T-12', { ...base, detail: e.select });
            else miss('properties', { ...base, detail: 'property missing in MCP' });
            continue;
          }
          const p = raw.get(`${table}.${e.column}`);
          let typeRule = null;
          if (e.type !== m.type) {
            typeRule = classifyType(p, e.type, m.type);
            if (typeRule) hit(typeRule, { ...base, detail: `frontend ${e.type}, MCP ${m.type}` });
            else miss('type', { ...base, detail: `${e.type} -> ${m.type}` });
          }
          if (e.select !== m.select) {
            if (e.type !== m.type) {
              if (typeRule) hit(typeRule, { ...base, subject: `${e.column} (select)`, detail: `frontend ${e.select} | MCP ${m.select}` }, 'effects');
            } else {
              const r = classifySelect(e, m, p);
              if (r) hit(r, { ...base, detail: `frontend ${e.select} | MCP ${m.select}` });
              else miss('select', { ...base, detail: `${e.select} | ${m.select}` });
            }
          }
        }
        for (const m of mIndex.values()) miss('properties', { example: ex, variant: v, entity: table, subject: m.column, detail: 'property only in MCP' });
      }
      for (const table of Object.keys(mc)) if (!(table in fe)) miss('properties', { example: ex, variant: v, entity: table, detail: 'table only in MCP' });
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 2: view property lists (per variant)
// ---------------------------------------------------------------------------

const STRUCTURAL = ['display_name', 'status_id', 'submitted_at'];

function viewEngine() {
  for (const ex of examples()) {
    for (const v of variants(ex)) {
      const fe = readJson(path.join(FE, ex, v, 'schema.views.json')).entities;
      const mc = readJson(path.join(MCP, ex, v, 'schema.views.json')).entities;
      const feProps = readJson(path.join(FE, ex, v, 'schema.properties.json')).entities;
      const raw = new Map(readJson(path.join(RAW, ex, v, 'schema_properties.json')).map(p => [`${p.table_name}.${p.column_name}`, p]));
      const ents = new Map(readJson(path.join(RAW, ex, v, 'schema_entities.json')).map(e => [e.table_name, e]));
      for (const [table, views] of Object.entries(fe)) {
        const m = mc[table];
        if (!m) { miss('views', { example: ex, variant: v, entity: table, detail: 'entity missing in MCP' }); continue; }
        const feType = new Map((feProps[table] ?? []).map(p => [p.column, p.type]));
        for (const view of ['list', 'detail', 'create', 'edit']) {
          count('view');
          const f = views[view];
          const g = m[view];
          const base = { example: ex, variant: v, entity: table };
          for (const col of f.filter(c => !g.includes(c))) {
            const p = raw.get(`${table}.${col}`);
            const inst = { ...base, subject: `${view}: ${col}`, detail: 'frontend only' };
            if (feType.get(col) === 'ManyToMany') hit('T-12', inst, 'effects');
            else if (view !== 'create' && STRUCTURAL.includes(col) && p) hit('V-03', inst);
            else if (view === 'list' && ents.get(table)?.map_property_name === col) hit('V-04', inst);
            else miss('views', inst);
          }
          for (const col of g.filter(c => !f.includes(c))) {
            const p = raw.get(`${table}.${col}`);
            const inst = { ...base, subject: `${view}: ${col}`, detail: 'MCP only' };
            if ((view === 'create' || view === 'edit') && (col === 'created_at' || col === 'updated_at')) hit('V-01', inst);
            else if ((view === 'create' || view === 'edit') && p && p.is_updatable === false) hit('V-02', inst);
            else miss('views', inst);
          }
          // Order of the shared columns: differences confined to sort_order ties are capture artifacts (not rows).
          const shared = f.filter(c => g.includes(c));
          const gShared = g.filter(c => f.includes(c));
          if (shared.join() !== gShared.join()) {
            const key = c => [raw.get(`${table}.${c}`)?.sort_order ?? 0, c];
            const norm = arr => [...arr].sort((a, b) => cmp(key(a)[0], key(b)[0]) || cmp(key(a)[1], key(b)[1])).join();
            if (norm(shared) === norm(gShared)) diagnostics.tieOrderArtifacts++;
            else miss('views', { ...base, subject: `${view}: order`, detail: `${shared.join()} | ${gShared.join()}` });
          }
        }
      }
      for (const table of Object.keys(mc)) if (!(table in fe)) miss('views', { example: ex, variant: v, entity: table, detail: 'entity only in MCP' });
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 3: condition evaluator
// ---------------------------------------------------------------------------

const KNOWN_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'in', 'is_null', 'is_not_null'];

function leaves(c) {
  if (!c || typeof c !== 'object') return [];
  if (Array.isArray(c.or)) return c.or.flatMap(leaves);
  if (Array.isArray(c.and)) return c.and.flatMap(leaves);
  return [c];
}

function resolveDot(rec, field) {
  let cur = rec;
  for (const part of String(field).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Which evaluator rule explains a differing result for `cond` on `rec` (rec null/undefined allowed). */
function classifyCondition(cond, rec) {
  if (cond === null || cond === undefined) return 'C-06';
  if (rec === null || rec === undefined) return 'C-05';
  for (const leaf of leaves(cond)) {
    const field = String(leaf.field);
    const raw = resolveDot(rec, field);
    if (!field.includes('.') && raw !== null && typeof raw === 'object' && 'id' in raw) return 'C-01';
    if (!KNOWN_OPS.includes(leaf.operator)) return 'C-04';
    if (['gt', 'lt', 'gte', 'lte'].includes(leaf.operator) && !(typeof raw === 'number' && typeof leaf.value === 'number')) return 'C-03';
    // eslint-disable-next-line eqeqeq
    if ((leaf.operator === 'eq' || leaf.operator === 'ne') && (raw == leaf.value) !== (raw === leaf.value)) return 'C-02';
  }
  return null;
}

function conditionEngine() {
  for (const ex of examples()) {
    const fe = readJson(path.join(FE, ex, '_example/conditions.actions.json')).conditions;
    const mc = readJson(path.join(MCP, ex, '_example/conditions.actions.json')).conditions;
    const mIndex = new Map(mc.map(c => [canon(c.condition), c]));
    for (const c of fe) {
      const m = mIndex.get(canon(c.condition));
      if (!m) { miss('conditions', { example: ex, subject: canon(c.condition), detail: 'condition missing in MCP' }); continue; }
      for (const [label, r] of Object.entries(c.results)) {
        count('condition');
        if (m.results[label] === r) continue;
        const rec = label === '<null data>' ? null : label === '<undefined data>' ? undefined : JSON.parse(label);
        const rule = classifyCondition(c.condition, rec);
        const inst = { example: ex, entity: c.usedBy.join(', '), subject: `${canon(c.condition)} @ ${label}`, detail: `frontend ${r}, MCP ${m.results[label]}` };
        if (rule) hit(rule, inst); else miss('conditions', inst);
      }
    }
  }
  const fe = readJson(path.join(FE, '_shared/conditions.matrix.json'));
  const mc = readJson(path.join(MCP, '_shared/conditions.matrix.json'));
  for (const [key, row] of Object.entries(fe.matrix)) {
    const sp = key.indexOf(' ');
    const op = key.slice(0, sp) === '<empty>' ? '' : key.slice(0, sp);
    const cv = JSON.parse(key.slice(sp + 1));
    for (const [dl, r] of Object.entries(row)) {
      count('condition');
      const got = mc.matrix[key]?.[dl];
      if (got === r) continue;
      const rec = dl === '<missing>' ? {} : { f: JSON.parse(dl) };
      const rule = classifyCondition({ field: 'f', operator: op, value: cv }, rec);
      const inst = { example: '_shared', entity: 'conditions.matrix', subject: `${key} @ ${dl}`, detail: `frontend ${r}, MCP ${got}` };
      if (rule) hit(rule, inst); else miss('conditions', inst);
    }
  }
  for (const [key, r] of Object.entries(fe.dotted)) {
    count('condition');
    if (mc.dotted[key] === r) continue;
    const at = key.indexOf(' @ ');
    const rule = classifyCondition({ field: key.slice(0, at), operator: 'eq', value: 1 }, JSON.parse(key.slice(at + 3)));
    const inst = { example: '_shared', entity: 'conditions.dotted', subject: key, detail: `frontend ${r}, MCP ${mc.dotted[key]}` };
    if (rule) hit(rule, inst); else miss('conditions', inst);
  }
  const compoundInputs = {
    or: [{ or: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 2 }] }, { a: 0, b: 2 }],
    orNone: [{ or: [] }, { a: 1 }],
    andAll: [{ and: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 2 }] }, { a: 1, b: 2 }],
    andNone: [{ and: [] }, { a: 1 }],
    nullCondition: [null, null],
    undefinedConditionNullData: [undefined, undefined],
    conditionNullData: [{ field: 'a', operator: 'eq', value: 1 }, null],
  };
  for (const [key, r] of Object.entries(fe.compound)) {
    count('condition');
    if (mc.compound[key] === r) continue;
    const [cond, rec] = compoundInputs[key] ?? [];
    const rule = key in compoundInputs ? classifyCondition(cond, rec) : null;
    const inst = { example: '_shared', entity: 'conditions.compound', subject: key, detail: `frontend ${r}, MCP ${mc.compound[key]}` };
    if (rule) hit(rule, inst); else miss('conditions', inst);
  }
}

// ---------------------------------------------------------------------------
// Engine 4: conditional actions end to end (MCP-only artifact)
// ---------------------------------------------------------------------------

const PASSED = ['executed', 'passed-conditions (missing required parameter)'];

function actionEngine() {
  for (const ex of examples()) {
    const art = readJson(path.join(MCP, ex, '_example/mcp.actions-execute.json'));
    for (const [name, a] of Object.entries(art.actions)) {
      const [table, action] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
      for (const [kase, out] of Object.entries(a.cases)) {
        count('action-case');
        const base = { example: ex, entity: table, subject: action };
        if (out.executeAction.startsWith('other: NameResolutionError: Entity')) { hit('A-02', { ...base, detail: out.executeAction.slice(7, 80) }); continue; }
        const expectPass = kase === 'satisfies all conditions';
        const passed = PASSED.includes(out.executeAction);
        const expectedListing = expectPass ? 'listed' : kase === 'violates visibility_condition' ? 'hidden' : 'listed-disabled';
        const listingOk = !a.showOnDetail || out.getRecordListing === expectedListing
          // a violated enabled condition that shares its field with the visibility condition also hides the action
          || (kase === 'violates enabled_condition' && out.getRecordListing === 'hidden' && out.executeAction === 'not-available');
        if (passed !== expectPass || !listingOk) {
          const roots = Object.values(a.leafShapes);
          const why = roots.includes('embed') ? 'plain condition field on an FK-embedded column' : roots.join(',');
          hit('A-01', { ...base, detail: `${kase}: execute_action ${out.executeAction}, get_record ${out.getRecordListing} (${why})` });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 5: error messages
// ---------------------------------------------------------------------------

const F04_CODES = ['23503', '23502', '22P02', '22007', '22008', 'PGRST116', 'PGRST301', 'PT503'];

function classifyError(payload, fe, mc) {
  const code = payload.code;
  if (code === '23514' || code === '23P01') return 'E-03';
  if (F04_CODES.includes(code) && fe === 'System Error') return 'F-04';
  if (fe === 'System Error' && typeof mc === 'string' && mc.startsWith('Error: ')) return 'E-04';
  return 'E-01';
}

function errorEngine() {
  for (const ex of examples()) {
    const fe = readJson(path.join(FE, ex, '_example/errors.lookup.json'));
    const mc = readJson(path.join(MCP, ex, '_example/errors.lookup.json'));
    const pairs = [
      ...fe.results.map((r, i) => [r, mc.results[i], ['parseToHuman', 'parseToHumanWithLookup']]),
      ...fe.unloaded.map((r, i) => [r, mc.unloaded[i], ['parseToHumanWithLookup']]),
    ];
    for (const [f, m, keys] of pairs) {
      if (!m || canon(f.payload) !== canon(m.payload)) { miss('errors', { example: ex, detail: `payload mismatch ${canon(f.payload)}` }); continue; }
      // Payloads without a constraint name behave the same in every example: count them once.
      // Only check / exclusion violations are looked up in the example's constraint_messages.
      const perExample = (f.payload.code === '23514' || f.payload.code === '23P01')
        && /constraint "[^"]+"/.test(`${f.payload.message ?? ''} ${f.payload.details ?? ''}`);
      for (const k of keys) {
        count('error');
        if (f[k] === m[k]) continue;
        const rule = classifyError(f.payload, f[k], m[k]);
        hit(rule, { example: perExample ? ex : '_shared', entity: k, subject: canon(f.payload), detail: `frontend ${JSON.stringify(f[k])}, MCP ${JSON.stringify(m[k])}` });
      }
    }
  }
  const fe = readJson(path.join(FE, '_shared/errors.data-parse-api-error.json'));
  const mc = readJson(path.join(MCP, '_shared/errors.data-parse-api-error.json'));
  for (const [name, f] of Object.entries(fe)) {
    const m = mc[name];
    count('error');
    if (!m) { miss('errors', { example: '_shared', subject: name, detail: 'case missing in MCP' }); continue; }
    if (m.thrown === 'MaintenanceError') {
      hit('F-04', { example: '_shared', entity: 'client', subject: name, detail: `frontend ${JSON.stringify(f.error.humanMessage)}, MCP throws MaintenanceError (${m.error.mode})` });
      continue;
    }
    if (f.error.humanMessage !== m.error.humanMessage) {
      const rule = classifyError({ code: f.error.code, httpCode: f.error.httpCode }, f.error.humanMessage, m.error.humanMessage);
      hit(rule, { example: '_shared', entity: 'client humanMessage', subject: name, detail: `frontend ${JSON.stringify(f.error.humanMessage)}, MCP ${JSON.stringify(m.error.humanMessage)}` });
    }
    if (f.error.message !== m.error.message) {
      hit('E-06', { example: '_shared', entity: 'client message', subject: name, detail: `frontend ${JSON.stringify(f.error.message)}, MCP ${JSON.stringify(m.error.message)}` });
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 6: request building
// ---------------------------------------------------------------------------

const SEARCH_PARAM = /^(civic_os_text_search|.*)$/;
const isSearchValue = v => /^(wfts(\([a-z]+\))?|ilike)\./.test(v);

/**
 * Compare one frontend request with the MCP's main request and attribute every
 * aspect that differs. `ctx` carries the example, entity, case name and the
 * frontend property types (for select attribution).
 */
function compareRequests(feReq, mcReq, ctx) {
  const f = parseFeUrl(feReq.url);
  const m = parseMcpRequest(mcReq);
  const base = { example: ctx.example, entity: ctx.entity, subject: ctx.name };
  const fParams = new Map();
  for (const [k, v] of f.params) fParams.set(k, [...(fParams.get(k) ?? []), v]);
  const mParams = new Map();
  for (const [k, v] of m.params) mParams.set(k, [...(mParams.get(k) ?? []), v]);
  const fh = feReq.headers ?? {};
  const mh = mcReq.headers ?? {};
  const searched = ctx.input?.searchQuery !== undefined && String(ctx.input.searchQuery).trim() !== '';

  // select
  const fs_ = fParams.get('select')?.[0];
  const ms = mParams.get('select')?.[0];
  if (fs_ !== ms) {
    const fi = splitSelect(fs_ ?? '');
    const mi = splitSelect(ms ?? '');
    const fSet = new Set(fi);
    const mSet = new Set(mi);
    const onlyF = fi.filter(x => !mSet.has(x));
    const onlyM = mi.filter(x => !fSet.has(x));
    if (!onlyF.length && !onlyM.length) hit('Q-03', { ...base, detail: `frontend ${fs_} | MCP ${ms}` });
    if (fs_ === undefined && ms !== undefined) hit('Q-15', { ...base, detail: `frontend sends no select (every column); list_records has no all-columns mode, MCP select=${ms}` });
    else {
      const mAlias = new Map(onlyM.map(x => [alias(x), x]));
      for (const item of onlyF) {
        const a = alias(item);
        const t = ctx.types?.get(a);
        if (mAlias.has(a)) {
          const other = mAlias.get(a);
          mAlias.delete(a);
          const r = ctx.selectRule?.(a, item, other);
          if (r) hit(r, { ...base, subject: `${ctx.name}: ${a}`, detail: `frontend ${item} | MCP ${other}` }, 'effects');
          else miss('queries', { ...base, detail: `select item differs: ${item} | ${other}` });
        } else if (t === 'ManyToMany') hit('T-12', { ...base, subject: `${ctx.name}: ${a}`, detail: item }, 'effects');
        else if (STRUCTURAL.includes(a)) hit('V-03', { ...base, subject: `${ctx.name}: ${a}`, detail: item }, 'effects');
        else if (ctx.mapProperty === a) hit('V-04', { ...base, subject: `${ctx.name}: ${a}`, detail: item }, 'effects');
        else if (a === 'id') hit('Q-11', { ...base, detail: `frontend appends id, MCP does not (entity has no id property): MCP select=${ms}` });
        else miss('queries', { ...base, detail: `select item only in frontend: ${item}` });
      }
      for (const [a, item] of mAlias) {
        if (ctx.call === 'get_record' && (a === 'created_at' || a === 'updated_at') && !ctx.types?.has(a)) hit('Q-12', { ...base, subject: `${ctx.name}: ${a}`, detail: item });
        else if (ctx.call === 'get_record') hit('Q-13', { ...base, subject: `${ctx.name}: ${a}`, detail: item });
        else if (a === 'id' && ms === 'id,') hit('Q-14', { ...base, detail: `MCP select=${ms}` });
        else if (a === 'id') hit('Q-11', { ...base, detail: `MCP adds id, frontend does not: frontend select=${fs_}` });
        else if (a === '' && ms?.endsWith(',')) hit('Q-14', { ...base, detail: `MCP select=${ms}` });
        else miss('queries', { ...base, detail: `select item only in MCP: ${item}` });
      }
    }
  }

  // order
  const fo = fParams.get('order')?.[0];
  const mo = mParams.get('order')?.[0];
  if (fo !== mo) {
    if (fo === undefined && searched && ctx.input?.orderField) hit('Q-06', { ...base, detail: `frontend drops order while searching, MCP order=${mo}` });
    else if (fo === undefined) hit('Q-01', { ...base, detail: `MCP order=${mo}` });
    else if (/\(/.test(fo) && mo === fo.replace(/\([^)]*\)/, '')) hit('Q-04', { ...base, detail: `frontend order=${fo}, MCP order=${mo}` });
    else miss('queries', { ...base, detail: `order ${fo} | ${mo}` });
  }

  // limit / Range / Prefer
  const fr = fh['Range'];
  const mr = mh['Range'];
  const fl = fParams.get('limit')?.[0];
  if (fr !== mr || fl !== undefined) {
    if (fr === undefined && mr !== undefined) hit('Q-02', { ...base, detail: `frontend ${fl !== undefined ? `limit=${fl}` : 'no Range'}, MCP Range ${mr}` });
    else if (fr !== undefined && mr !== undefined && fr !== mr) miss('queries', { ...base, detail: `Range ${fr} | ${mr}` });
  }
  if ((fh['Prefer'] ?? '') !== (mh['Prefer'] ?? '') && !(fr === undefined && mr !== undefined)) miss('queries', { ...base, detail: `Prefer ${fh['Prefer']} | ${mh['Prefer']}` });

  // remaining parameters: search and filters
  const skip = new Set(['select', 'order', 'limit', 'offset']);
  const keys = new Set([...fParams.keys(), ...mParams.keys()].filter(k => !skip.has(k)));
  for (const k of keys) {
    const fv = fParams.get(k) ?? [];
    const mv = mParams.get(k) ?? [];
    if (fv.join('\u0000') === mv.join('\u0000')) continue;
    const anySearch = [...fv, ...mv].some(isSearchValue) || (k === 'or' && fv.some(v => /wfts|ilike/.test(v)));
    if (anySearch && ctx.input?.searchQuery !== undefined && String(ctx.input.searchQuery).trim() === '') hit('Q-07', { ...base, detail: `${k}: frontend ${fv.join('|') || '(none)'}, MCP ${mv.join('|') || '(none)'}` });
    else if (anySearch || ctx.name === 'hybrid search rawQueryParams') hit('Q-05', { ...base, detail: `${k}: frontend ${fv.join('|') || '(none)'}, MCP ${mv.join('|') || '(none)'}` });
    else if (k === 'and' && mv.length && !fv.length) hit('Q-09', { ...base, detail: `MCP and=${mv[0]}, frontend repeats the column parameter` });
    else if (ctx.rawDropped && fv.length && !mv.length) hit('Q-15', { ...base, detail: `${k}=${fv.join('|')} dropped (rawQueryParams)` }, 'effects');
    else if (fv.length > mv.length && mParams.has('and')) { /* repeated params grouped into and=() (Q-09) */ }
    else if (fv.length < mv.length || (fv.length === mv.length && ctx.emptyValues)) hit('Q-08', { ...base, detail: `${k}: frontend ${fv.join('|') || '(none)'}, MCP ${mv.join('|')}` });
    else if (ctx.encodingCase) hit('F-01', { ...base, detail: `${k}: frontend ${fv.join('|') || '(none)'}, MCP ${mv.join('|') || '(none)'}` });
    else miss('queries', { ...base, detail: `param ${k}: ${fv.join('|')} | ${mv.join('|')}` });
  }
}

function mainRequest(q, table) {
  const reqs = (q.requests ?? []).filter(r => r.method === 'GET' && parseMcpRequest(r).path === table);
  return reqs[reqs.length - 1];
}

function queryEngine() {
  for (const ex of examples()) {
    const fe = readJson(path.join(FE, ex, '_example/data.queries.json')).entities;
    const mc = readJson(path.join(MCP, ex, '_example/data.queries.json')).entities;
    const feProps = readJson(path.join(FE, ex, 'testadmin/schema.properties.json')).entities;
    const ents = new Map(readJson(path.join(RAW, ex, 'testadmin/schema_entities.json')).map(e => [e.table_name, e]));
    for (const [table, e] of Object.entries(fe)) {
      const m = mc[table];
      if (!m) { miss('queries', { example: ex, entity: table, detail: 'entity missing in MCP' }); continue; }
      const types = new Map((feProps[table] ?? []).map(p => [p.column, p.type]));
      const selects = new Map((feProps[table] ?? []).map(p => [p.column, p]));
      const selectRule = (a, feItem, mcItem) => {
        const p = selects.get(a);
        if (!p) return null;
        const r = classifySelect({ ...p, select: feItem }, { select: mcItem }, readRawProp(ex, table, a));
        if (r) return r;
        if (p.type === 'PhotoGallery') return 'S-06';
        return null;
      };
      e.queries.forEach((q, i) => {
        count('query');
        const mq = m.queries[i];
        const base = { example: ex, entity: table, subject: q.name };
        if (!mq || mq.name !== q.name) { miss('queries', { ...base, detail: 'query missing / misaligned in MCP' }); return; }
        if (mq.inexpressible) {
          hit('Q-15', { ...base, detail: mq.inexpressible });
          return;
        }
        if (mq.invalidInput) {
          if (mq.invalidInput.some(s => s.startsWith('limit'))) hit('Q-10', { ...base, detail: `MCP rejects input: ${mq.invalidInput.join('; ')}` });
          else miss('queries', { ...base, detail: `invalid input ${mq.invalidInput.join('; ')}` });
          return;
        }
        if (mq.toolError || mq.thrown) {
          const t = mq.toolError ?? mq.thrown;
          const colErr = /^NameResolutionError: (?:Column|Ambiguous column) "([^"]+)"/.exec(t);
          if (/not found in civic_os_users/.test(t)) hit('N-04', { ...base, detail: t.slice(0, 120) });
          else if (/(^|Status |Category )"" not found/.test(t)) hit('Q-08', { ...base, detail: `frontend skips the empty filter value; MCP resolves "" as a name: ${t.slice(0, 100)}` });
          else if (colErr && !types.has(colErr[1])) { diagnostics.bothReject = (diagnostics.bothReject ?? 0) + 1; return; }
          else if (/^Record #/.test(t)) { /* get_record against the stub's empty table: compare the request below */ }
          else miss('queries', { ...base, detail: `tool error ${t.slice(0, 160)}` });
          if (!/^Record #/.test(t)) return;
        }
        const req = mainRequest(mq, table);
        if (!req) { miss('queries', { ...base, detail: 'no MCP request to the entity' }); return; }
        const notes = mq.notes ?? [];
        compareRequests(q.request, req, {
          example: ex, entity: table, name: q.name, call: mq.call, input: q.input, types, selectRule,
          mapProperty: ents.get(table)?.map_property_name,
          rawDropped: notes.some(n => n.startsWith('rawQueryParams') && n.includes('dropped')),
          emptyValues: q.name.startsWith('filters with'),
        });
      });
    }
  }

  // Shared special-character / pagination matrix.
  const fe = readJson(path.join(FE, '_shared/data.query-matrix.json'));
  const mc = readJson(path.join(MCP, '_shared/data.query-matrix.json')).cases;
  for (const [name, feReq] of Object.entries(fe)) {
    count('query');
    const mq = mc[name];
    const base = { example: '_shared', entity: 'data.query-matrix', subject: name };
    if (!mq) { miss('queries', { ...base, detail: 'case missing in MCP' }); continue; }
    if (mq.invalidInput) {
      if (/^pagination /.test(name)) hit('F-02', { ...base, detail: `frontend Range ${feReq.headers.Range}; MCP rejects (${mq.invalidInput.join('; ')})` });
      else if (name === 'limit 0 is dropped') hit('Q-10', { ...base, detail: `frontend drops limit 0; MCP rejects (${mq.invalidInput.join('; ')})` });
      else if (name === 'in array with specials') hit('F-13', { ...base, detail: `frontend ${feReq.url.split('&').slice(1).join('&')}; MCP rejects a null array item (${mq.invalidInput.join('; ')})` });
      else miss('queries', { ...base, detail: `invalid input ${mq.invalidInput.join('; ')}` });
      continue;
    }
    if (mq.thrown) {
      if (name === 'order with FK embed') hit('Q-04', { ...base, detail: `frontend order=owner(display_name).desc; MCP ${mq.thrown.slice(0, 90)}` });
      else miss('queries', { ...base, detail: mq.thrown });
      continue;
    }
    const req = mq.call === 'get_record' ? mq.requests.find(r => r.method === 'GET') : mainRequest(mq, mq.input.entity === 'summary_items' ? 'summary_items' : 'items');
    if (!req) { miss('queries', { ...base, detail: 'no MCP request' }); continue; }
    const f = parseFeUrl(feReq.url);
    // Intended filter / id value (what the caller asked for), to detect the frontend's unencoded values.
    let intended = null;
    let m;
    if ((m = /^filter (eq|ilike) (.+)$/.exec(name))) intended = ['name', m[1] === 'eq' ? `eq.${JSON.parse(m[2])}` : `ilike.*${JSON.parse(m[2])}*`];
    if (name === 'entityId with specials') intended = ['id', 'eq.a&b=c'];
    if (intended) {
      const fv = f.params.filter(([k]) => k === intended[0]).map(([, v]) => v);
      const extra = f.params.filter(([k]) => !['select', intended[0]].includes(k));
      const mv = parseMcpRequest(req).params.filter(([k]) => k === intended[0]).map(([, v]) => v);
      if (fv.join() !== intended[1] || extra.length) {
        hit('F-01', { ...base, detail: `intended ${intended[0]}=${intended[1]}; frontend sends ${f.params.map(([k, v]) => `${k}=${v}`).join(' & ')}; MCP ${mv.join() === intended[1] ? 'sends it intact' : `sends ${mv.join()}`}` });
      }
      // The remaining aspects (default order, Range) are attributed below as effects.
      compareRequests({ ...feReq, url: `<PGRST>/${f.path}?select=${f.params.find(([k]) => k === 'select')?.[1] ?? ''}` }, { ...req, decoded: parseMcpRequest(req).params.filter(([k]) => k !== intended[0]).map(([k, v]) => `${k}=${v}`) }, { example: '_shared', entity: 'data.query-matrix', name, call: mq.call, input: {} });
      continue;
    }
    const searchCase = /^search /.exec(name);
    compareRequests(feReq, req, {
      example: '_shared', entity: 'data.query-matrix', name, call: mq.call,
      input: searchCase ? { searchQuery: JSON.parse(name.slice(7)) } : name === 'everything at once' ? { searchQuery: 'a b', orderField: 'name' } : {},
      selectRule: () => 'Q-15', rawDropped: name === 'everything at once',
    });
  }

  // Content-Range parsing.
  const fcr = readJson(path.join(FE, '_shared/data.content-range.json')).paginated;
  const mcr = readJson(path.join(MCP, '_shared/data.content-range.json')).paginated;
  for (const [h, f] of Object.entries(fcr)) {
    count('content-range');
    const mt = mcr[h]?.totalCount;
    if (f.totalCount !== mt) hit('Q-16', { example: '_shared', entity: 'data.content-range', subject: JSON.stringify(h), detail: `frontend totalCount ${f.totalCount}, MCP total ${mt === undefined ? '(none)' : mt}` });
  }
}

const rawPropCache = new Map();
function readRawProp(ex, table, column) {
  const key = `${ex}`;
  if (!rawPropCache.has(key)) rawPropCache.set(key, new Map(readJson(path.join(RAW, ex, 'testadmin/schema_properties.json')).map(p => [`${p.table_name}.${p.column_name}`, p])));
  return rawPropCache.get(key).get(`${table}.${column}`);
}

// ---------------------------------------------------------------------------
// Engine 7: name resolution (MCP-only artifacts + raw fixtures)
// ---------------------------------------------------------------------------

function nameEngine() {
  for (const ex of examples()) {
    for (const v of variants(ex)) {
      const n = readJson(path.join(MCP, ex, v, 'mcp.names.json'));
      for (const [table, r] of Object.entries(n.entities)) {
        count('name');
        const base = { example: ex, variant: v, entity: table };
        if (r.byTableName !== table) {
          if (table !== table.toLowerCase()) hit('N-01', { ...base, subject: 'by table name', detail: `${JSON.stringify(table)} -> ${r.byTableName.slice(0, 120)}` });
          else hit('N-06', { ...base, subject: 'by table name', detail: r.byTableName.slice(0, 120) });
        }
        for (const k of ['byDisplayName', 'byUpperDisplayName', 'byPaddedDisplayName']) {
          if (r[k] !== table) hit('N-06', { ...base, subject: k, detail: `${JSON.stringify(r.displayName)} -> ${r[k].slice(0, 120)}` });
        }
      }
      for (const [table, cols] of Object.entries(n.columnAnomalies)) {
        for (const [col, probes] of Object.entries(cols)) {
          for (const [k, d] of Object.entries(probes)) hit('N-06', { example: ex, variant: v, entity: table, subject: `column ${col} ${k}`, detail: d.slice(0, 140) });
        }
      }
      for (const [table, acts] of Object.entries(n.actionAnomalies)) {
        for (const [act, probes] of Object.entries(acts)) {
          for (const [k, d] of Object.entries(probes)) hit('N-06', { example: ex, variant: v, entity: table, subject: `action ${act} ${k}`, detail: d.slice(0, 140) });
        }
      }
    }
    const sc = readJson(path.join(MCP, ex, '_example/mcp.names-status-category.json'));
    for (const [et, rows] of Object.entries(sc.statuses)) {
      for (const [label, r] of Object.entries(rows)) {
        count('name');
        const id = label.split(' ')[0];
        if (r.statusKey && r.byStatusKey === id) hit('N-02', { example: ex, entity: et, subject: label, detail: `status_key ${JSON.stringify(r.statusKey)} resolves (MCP); the import worker matches display names only` });
        if (r.byDisplayName !== id) hit('N-02', { example: ex, entity: et, subject: `${label} (display name)`, detail: `display name resolves to ${r.byDisplayName}` });
      }
    }
    // Locale: display names differ between en and es fixtures (the MCP never sends Accept-Language).
    for (const v of variants(ex).filter(x => x.endsWith('.es'))) {
      const es = readJson(path.join(RAW, ex, v, 'schema_entities.json'));
      const en = new Map(readJson(path.join(RAW, ex, v.replace('.es', ''), 'schema_entities.json')).map(e => [e.table_name, e.display_name]));
      for (const e of es) {
        if (en.get(e.table_name) !== e.display_name) hit('N-05', { example: ex, variant: v, entity: e.table_name, subject: 'display_name', detail: `en ${JSON.stringify(en.get(e.table_name))}, es ${JSON.stringify(e.display_name)}` });
      }
    }
  }
  const fk = readJson(path.join(MCP, '_shared/mcp.names-fk-requests.json'));
  for (const [scenario, rows] of Object.entries(fk.resolveForeignKeyValue)) {
    if (scenario !== 'eq none, ilike one') continue;
    for (const [name, r] of Object.entries(rows)) {
      const raw = JSON.parse(name);
      if (/[*%_]/.test(raw)) hit('N-03', { example: '_shared', entity: 'resolveForeignKeyValue', subject: name, detail: `requests ${r.requests.join(' then ')} -> ${r.result}` });
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 8: rules with evidence checks and source scans
// ---------------------------------------------------------------------------

function evidenceEngine() {
  for (const rule of RULES) {
    if (!rule.compute) continue;
    rule.compute({ hit, miss, readJson, ROOT, FE, MCP, RAW, examples, variants, count });
  }
}

/**
 * Type-detection probes: the MCP result comes from mcp.type-probes.json; the
 * frontend result is the one the rule cites from code. A probe on which both
 * agree is a catalogue error (the rule would not be a divergence).
 */
function probeEngine() {
  const probes = new Map(readJson(path.join(MCP, '_shared/mcp.type-probes.json')).probes.map(p => [p.name, p]));
  for (const rule of RULES) {
    for (const [name, feType] of Object.entries(rule.probes ?? {})) {
      count('type-probe');
      const p = probes.get(name);
      if (!p) { miss('probes', { example: '_shared', entity: rule.id, subject: name, detail: 'probe missing from mcp.type-probes.json' }); continue; }
      if (p.type === feType) { miss('probes', { example: '_shared', entity: rule.id, subject: name, detail: `MCP and frontend (from code) agree on ${feType}` }); continue; }
      hit(rule.id, { example: '_shared', entity: 'mcp.type-probes', subject: name, detail: `MCP ${p.type} (select ${p.select}); frontend (from code) ${feType}` });
    }
  }
}

/** Every rule's `checks` (file must contain each string) must hold; a stale citation fails the run. */
function verifyEvidence() {
  const failures = [];
  for (const rule of RULES) {
    for (const chk of rule.checks ?? []) {
      const file = path.join(ROOT, chk.file);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      for (const s of chk.contains) {
        if (text === null || !text.includes(s)) failures.push(`${rule.id}: ${chk.file} does not contain ${JSON.stringify(s)}`);
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

function summarize(bucket) {
  const entries = [...bucket.entries()].sort(([a], [b]) => cmp(a, b));
  const byExample = {};
  let occurrences = 0;
  let synthetic = 0;
  for (const [, e] of entries) {
    byExample[e.example] = (byExample[e.example] ?? 0) + 1;
    occurrences += e.occurrences;
    if (e.example === '_shared') synthetic++;
  }
  // Three concrete examples, preferring distinct examples.
  const picked = [];
  const seen = new Set();
  for (const [, e] of entries) if (!seen.has(e.example) && picked.length < 3) { picked.push(e); seen.add(e.example); }
  for (const [, e] of entries) if (picked.length < 3 && !picked.includes(e)) picked.push(e);
  return {
    count: entries.length - synthetic,
    synthetic,
    occurrences,
    byExample,
    examples: picked.map(e => ({
      example: e.example, entity: e.entity, subject: e.subject, detail: e.detail,
      ...(e.variants.size ? { variants: [...e.variants].sort((a, b) => ROLE_ORDER.indexOf(a.split('.')[0]) - ROLE_ORDER.indexOf(b.split('.')[0]) || cmp(a, b)) } : {}),
    })),
  };
}

function build() {
  propertyEngine();
  viewEngine();
  conditionEngine();
  actionEngine();
  errorEngine();
  queryEngine();
  nameEngine();
  evidenceEngine();
  probeEngine();
  const evidenceFailures = verifyEvidence();
  const rows = RULES.map(rule => {
    const h = hits.get(rule.id) ?? { instances: new Map(), effects: new Map() };
    const { compute, checks, ...rest } = rule;
    return {
      ...rest,
      instances: summarize(h.instances),
      ...(h.effects.size ? { effects: summarize(h.effects) } : {}),
      decision: null,
    };
  });
  return { rows, evidenceFailures };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const md = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderMarkdown(rows) {
  const L = [];
  const byRec = {};
  for (const r of rows) byRec[r.recommendation] = (byRec[r.recommendation] ?? 0) + 1;
  L.push('# SDK divergence ledger');
  L.push('');
  L.push('> Generated by `node scripts/golden/ledger.mjs` from `tests/golden/derived/frontend/`, `tests/golden/derived/mcp/` and `tests/golden/raw/`. Do not edit by hand: change the rule catalogue (`scripts/golden/ledger-rules.mjs`) or the goldens and regenerate. Machine-readable copy: `tests/golden/ledger.json`.');
  L.push('');
  L.push('## How to decide');
  L.push('');
  L.push('Each row is one rule on which the generic app (frontend) and the MCP server interpret the metadata contract differently, or a frontend quirk the golden outputs captured. Instance counts are computed from the goldens: an instance is one distinct example / entity / subject (property, view entry, condition and record, payload, query case, action); `occurrences` counts it once per role variant it appears in. `effects` are downstream differences the rule causes elsewhere (for example a select string that differs because the type differs). Rows with 0 instances are latent: no example exercises them today, and the evidence is the cited code plus, for type detection, the MCP output in `tests/golden/derived/mcp/_shared/mcp.type-probes.json`.');
  L.push('');
  L.push('Daniel decides per row at gate 2. Recommendations:');
  L.push('');
  L.push('- `adopt-frontend`: the core implements the frontend behavior; the MCP output changes (an approved golden diff in P1.3).');
  L.push('- `adopt-mcp`: the MCP rule is strictly better; the core implements it and the frontend output changes as an approved golden diff in P1.3.');
  L.push('- `mcp-bug` / `frontend-bug`: the side named is wrong; fix it there (the core gets the correct behavior).');
  L.push('- `needs-decision`: a real trade-off; the row states the options.');
  L.push('');
  L.push('Record the decision in the `decision` field of `tests/golden/ledger.json` (or tell the lead); P1.3 turns every `adopt-mcp` decision and every fixed bug into an entry in `tests/golden/approved-diffs/`. Tie-order differences between the two trees are capture artifacts, not rows (see Coverage).');
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push(`${rows.length} rows: ${Object.entries(byRec).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => `${v} \`${k}\``).join(', ')}.`);
  L.push('');
  L.push('| ID | Area | Rule | Recommendation | Instances |');
  L.push('|---|---|---|---|---|');
  for (const r of rows) {
    const i = r.instances;
    // Rows whose comparison inputs are synthetic by construction (fixed payload / query / transform sets) have no
    // example-derived count; they are not latent, so they read "N synthetic" instead of "0".
    const parts = i.count ? [`${i.count}`] : r.latent ? ['0 (latent)'] : [];
    if (i.synthetic) parts.push(`${parts.length ? '+' : ''}${i.synthetic} synthetic`);
    if (!parts.length) parts.push('0');
    if (r.effects) parts.push(`+${r.effects.count + r.effects.synthetic} effects`);
    L.push(`| [${r.id}](#${r.id.toLowerCase()}) | ${md(r.area)} | ${md(r.rule)} | \`${r.recommendation}\` | ${parts.join(', ')} |`);
  }
  for (const area of AREAS) {
    const inArea = rows.filter(r => r.area === area.name);
    if (!inArea.length) continue;
    L.push('');
    L.push(`## ${area.name}`);
    if (area.intro) { L.push(''); L.push(area.intro); }
    for (const r of inArea) {
      L.push('');
      L.push(`### ${r.id}`);
      L.push('');
      L.push(`**${r.rule}**`);
      L.push('');
      L.push(`- Frontend: ${r.frontend}`);
      L.push(`- MCP: ${r.mcp}`);
      L.push(`- Evidence: ${r.evidence.map(e => `\`${e}\``).join(', ')}`);
      const i = r.instances;
      const head = i.count ? `${i.count} in examples` : r.latent ? `0 in examples (latent: ${r.latent})` : 'inputs are synthetic by construction';
      const synth = i.synthetic ? `; ${i.synthetic} synthetic (\`_shared\` matrices, payload sets and probes)` : '';
      if (i.count || i.synthetic) {
        L.push(`- Instances: ${head}${synth}; ${i.occurrences} occurrences; by example: ${Object.entries(i.byExample).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        for (const e of i.examples) L.push(`  - ${e.example}${e.entity ? ` · ${e.entity}` : ''}${e.subject ? ` · ${e.subject}` : ''}${e.variants ? ` [${e.variants.join(', ')}]` : ''}: ${e.detail}`);
      } else {
        L.push(`- Instances: ${head}`);
      }
      if (r.effects) {
        L.push(`- Effects: ${r.effects.count + r.effects.synthetic} downstream differences (${r.effects.occurrences} occurrences); by example: ${Object.entries(r.effects.byExample).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        for (const e of r.effects.examples) L.push(`  - ${e.example}${e.entity ? ` · ${e.entity}` : ''}${e.subject ? ` · ${e.subject}` : ''}: ${e.detail}`);
      }
      L.push(`- If the frontend behavior is adopted: ${r.impact.adoptFrontend}`);
      L.push(`- If the MCP behavior is adopted: ${r.impact.adoptMcp}`);
      L.push(`- Recommendation: \`${r.recommendation}\`. ${r.reason}`);
    }
  }
  L.push('');
  L.push('## Latent nondeterminism');
  L.push('');
  L.push(NONDETERMINISM.intro);
  for (const item of NONDETERMINISM.items) {
    const data = item.compute({ readJson, RAW, examples, variants });
    L.push('');
    L.push(`### ${item.title}`);
    L.push('');
    L.push(`- Evidence: ${item.evidence}`);
    L.push(`- Computed: ${data.summary}`);
    for (const ex of data.examples) L.push(`  - ${ex}`);
    L.push(`- User-visible effect: ${item.effect}`);
  }
  L.push('');
  L.push(`Suggested remedy (for Daniel to decide, not implemented): ${NONDETERMINISM.remedy}`);
  L.push('');
  L.push('## Coverage');
  L.push('');
  L.push(`Comparisons made: ${Object.entries(diagnostics.comparisons).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => `${k} ${v}`).join(', ')}. Unattributed differences: ${unattributed.length}. View-order differences confined to \`sort_order\` ties (capture artifacts, not rows): ${diagnostics.tieOrderArtifacts}.`);
  L.push('');
  return L.join('\n');
}

function nondeterminismJson() {
  return NONDETERMINISM.items.map(item => {
    const data = item.compute({ readJson, RAW, examples, variants });
    return { title: item.title, evidence: item.evidence, effect: item.effect, computed: data };
  });
}

const stable = v => JSON.stringify(v, (k, val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) return Object.fromEntries(Object.keys(val).sort().map(key => [key, val[key]]));
  return val;
}, 2) + '\n';

function main() {
  const check = process.argv.includes('--check');
  const { rows, evidenceFailures } = build();
  const json = stable({
    generatedBy: 'scripts/golden/ledger.mjs',
    inputs: { frontend: rel(FE), mcp: rel(MCP), raw: rel(RAW) },
    rows,
    latentNondeterminism: nondeterminismJson(),
    remedy: NONDETERMINISM.remedy,
    coverage: { comparisons: diagnostics.comparisons, unattributed: unattributed.length, tieOrderArtifacts: diagnostics.tieOrderArtifacts },
  });
  const text = renderMarkdown(rows);
  let failed = 0;
  if (unattributed.length) {
    console.error(`${unattributed.length} unattributed difference(s):`);
    const byArea = {};
    for (const u of unattributed) (byArea[u.area] ??= []).push(u);
    for (const [area, list] of Object.entries(byArea)) {
      console.error(`  ${area}: ${list.length}`);
      for (const u of list.slice(0, 15)) console.error(`    ${[u.example, u.variant, u.entity, u.subject].filter(Boolean).join(' · ')}: ${u.detail}`);
    }
    failed = 2;
  }
  if (evidenceFailures.length) {
    console.error('evidence checks failed:');
    for (const f of evidenceFailures) console.error(`  ${f}`);
    failed = 2;
  }
  if (check) {
    const stale = [];
    if (!fs.existsSync(OUT_JSON) || fs.readFileSync(OUT_JSON, 'utf8') !== json) stale.push(rel(OUT_JSON));
    if (!fs.existsSync(OUT_MD) || fs.readFileSync(OUT_MD, 'utf8') !== text) stale.push(rel(OUT_MD));
    if (stale.length) {
      console.error(`stale ledger (run node scripts/golden/ledger.mjs): ${stale.join(', ')}`);
      process.exit(1);
    }
    console.log(`ledger up to date: ${rows.length} rows`);
    process.exit(failed);
  }
  if (failed) process.exit(failed);
  fs.writeFileSync(OUT_JSON, json);
  fs.writeFileSync(OUT_MD, text);
  console.log(`wrote ${rel(OUT_MD)} and ${rel(OUT_JSON)}: ${rows.length} rows`);
}

main();
