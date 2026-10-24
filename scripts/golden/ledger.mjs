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
 * difference to a rule from scripts/golden/ledger-rules.mjs, and writes:
 *   docs/notes/SDK_DIVERGENCE_LEDGER.md   (for Daniel's per-row decision at gate 2)
 *   tests/golden/ledger.json             (machine-readable, same content)
 *
 * Decisions live in the committed file tests/golden/ledger-decisions.json, an
 * object keyed by row id: { "T-01": { "decision": "<short kind>", "detail":
 * "<one sentence>", "by": "Daniel", "date": "YYYY-MM-DD" } }. Each entry becomes
 * that row's `decision` in both outputs, so regenerating keeps it (a hand edit
 * to ledger.json would be lost). An id that names no ledger row fails the run
 * (exit 2) in both modes; rows without a decision are listed as a warning.
 * See scripts/golden/ledger-decisions.mjs.
 *
 *   node scripts/golden/ledger.mjs                 rewrite both files
 *   node scripts/golden/ledger.mjs --check         fail (exit 1) if either committed file is stale
 *   node scripts/golden/ledger.mjs --freeze=<sha>  run the engine, require the committed files to be
 *                                                   current, and stamp ledger.json as frozen at <sha>
 *
 * Frozen (gate 2 onward): once ledger.json carries `frozen`, the engine no
 * longer runs. P1.3 changes the frontend goldens on purpose and P1.4 deletes
 * the MCP code the rows cite, so recomputing would report every applied row as
 * unattributed. The committed rows, coverage and nondeterminism stay the record
 * the gate 2 decisions were made against; both modes only re-merge the live
 * decisions file and re-render. Resolution is proven elsewhere: by
 * tests/golden/approved-diffs/1.3.json (P1.3) and by an empty frontend-vs-MCP
 * golden diff (P1.4).
 *
 * Attribution is exact: a difference counts for a rule only when both golden
 * values equal the reference models in scripts/golden/ledger-models.mjs and
 * the rule's specific transformation turns one into the other. Anything else
 * (a golden value no model reproduces, or a gap no rule explains) is
 * unattributed and fails the run with exit 2, in both modes. The `.es`
 * variants are skipped: the MCP never receives translated metadata (N-05).
 * One MCP path no golden reaches (execute_action when the condition fetch
 * fails or finds no row, C-05) is exercised by running the real tool
 * in-process (probeExecuteAction) and held to the same models.
 * scripts/golden/ledger-mutation-check.sh proves the attribution is tight.
 * Output is deterministic (no timestamps, everything sorted).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RULES, AREAS, NONDETERMINISM } from './ledger-rules.mjs';
import { loadDecisions, validateDecisions, mergeDecisions } from './ledger-decisions.mjs';
import {
  STRUCTURAL, THROWS, MCP_FLAGS, CONDITION_RULES, attempt, conditionRules, decodeFeUrl, decodeParams, evaluate, feBase,
  feHybridSearchParams, feListSearchParams, feType, feViews, mcpDescribe, mcpExecuteAction, mcpGetRecordRequests, mcpType,
  feParse, feParseLookup, feRequest, feSelect, feSelectForList, feTotalPaginated, feTotalPreview, mcpClientError, mcpContentRange,
  mcpBuildSelect, mcpFilter, mcpGetRecord, mcpListRecords, mcpParse, mcpSelect, resolveAction, resolveCategory, resolveColumn, resolveEntity,
  resolveFk, resolveStatus, selectAlias, selectRule, splitSelect, typeRule, NameError,
} from './ledger-models.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FE = path.join(ROOT, 'tests/golden/derived/frontend');
const MCP = path.join(ROOT, 'tests/golden/derived/mcp');
const RAW = path.join(ROOT, 'tests/golden/raw');
const OUT_MD = path.join(ROOT, 'docs/notes/SDK_DIVERGENCE_LEDGER.md');
const OUT_JSON = path.join(ROOT, 'tests/golden/ledger.json');
/** LEDGER_DECISIONS_FILE points the run at another decisions file (the self-test uses it). */
const DECISIONS = process.env.LEDGER_DECISIONS_FILE ? path.resolve(process.env.LEDGER_DECISIONS_FILE) : path.join(ROOT, 'tests/golden/ledger-decisions.json');

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const isDir = p => fs.existsSync(p) && fs.statSync(p).isDirectory();
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Canonical JSON (sorted keys) for labels. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const ROLE_ORDER = ['anon', 'testuser', 'testeditor', 'testmanager', 'testadmin'];
const examples = () => fs.readdirSync(RAW).filter(d => isDir(path.join(RAW, d))).sort();
/** Role variants in production for both consumers (the `.es` variants are frontend-only). */
const variants = ex => fs.readdirSync(path.join(RAW, ex)).filter(d => isDir(path.join(RAW, ex, d)) && !d.includes('.'))
  .sort((x, y) => ROLE_ORDER.indexOf(x) - ROLE_ORDER.indexOf(y));
const allVariants = ex => fs.readdirSync(path.join(RAW, ex)).filter(d => isDir(path.join(RAW, ex, d))).sort();

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

const ruleById = new Map(RULES.map(r => [r.id, r]));
const BUCKETS = ['instances', 'effects', 'harnessOnly'];
const hits = new Map();
const unattributed = [];
const notes = new Map();
const diagnostics = { tieOrderArtifacts: 0, bothReject: 0, mappingArtifacts: 0, comparisons: {} };

function count(area) { diagnostics.comparisons[area] = (diagnostics.comparisons[area] ?? 0) + 1; }

/**
 * Record one difference explained by `ruleId`. Buckets: 'instances' (the rule
 * itself), 'effects' (a downstream difference it causes), 'harnessOnly' (a
 * difference only the golden harness produces, not the real app).
 */
function hit(ruleId, inst, kind = 'instances') {
  if (!ruleById.has(ruleId)) throw new Error(`unknown rule ${ruleId}`);
  if (!hits.has(ruleId)) hits.set(ruleId, Object.fromEntries(BUCKETS.map(b => [b, new Map()])));
  const bucket = hits.get(ruleId)[kind];
  const key = [inst.example ?? '', inst.entity ?? '', inst.subject ?? ''].join(' · ');
  if (!bucket.has(key)) bucket.set(key, { example: inst.example, entity: inst.entity, subject: inst.subject, detail: inst.detail, variants: new Set(), occurrences: 0 });
  const e = bucket.get(key);
  if (inst.variant) e.variants.add(inst.variant);
  e.occurrences++;
}
function miss(area, inst) { unattributed.push({ area, ...inst }); }
function note(ruleId, text) { notes.set(ruleId, [...(notes.get(ruleId) ?? []), text]); }

// ---------------------------------------------------------------------------
// Schema context for the MCP models
// ---------------------------------------------------------------------------

const schemaCache = new Map();
/** The MCP's view of one variant: .mcp fixtures (MCP order) with the MCP's detected types from its golden. */
function mcpSchema(ex, v) {
  const key = `${ex}|${v}`;
  if (schemaCache.has(key)) return schemaCache.get(key);
  const types = new Map();
  for (const [t, list] of Object.entries(readJson(path.join(MCP, ex, v, 'schema.properties.json')).entities)) {
    for (const p of list) types.set(`${t}.${p.column}`, p.type);
  }
  const props = readJson(path.join(RAW, ex, v, 'schema_properties.mcp.json')).map(p => ({ ...p, type: types.get(`${p.table_name}.${p.column_name}`) }));
  const byTable = new Map();
  for (const p of props) byTable.set(p.table_name, [...(byTable.get(p.table_name) ?? []), p]);
  const S = {
    entities: readJson(path.join(RAW, ex, v, 'schema_entities.mcp.json')),
    props: t => byTable.get(t) ?? [],
    actions: readJson(path.join(RAW, ex, v, 'schema_entity_actions.mcp.json')),
    statuses: readJson(path.join(RAW, ex, v, 'statuses.json')),
    categories: readJson(path.join(RAW, ex, v, 'categories.json')),
  };
  schemaCache.set(key, S);
  return S;
}

/** Rule assigned to each property / view difference by the property and view engines (used by the request engine). */
const propRule = new Map();
const viewRule = new Map();

// ---------------------------------------------------------------------------
// Engine 1: property types and select strings
// ---------------------------------------------------------------------------

function propertyEngine() {
  for (const ex of examples()) {
    for (const v of variants(ex)) {
      const fe = readJson(path.join(FE, ex, v, 'schema.properties.json')).entities;
      const mc = readJson(path.join(MCP, ex, v, 'schema.properties.json')).entities;
      const raw = new Map(readJson(path.join(RAW, ex, v, 'schema_properties.json')).map(p => [`${p.table_name}.${p.column_name}`, p]));
      for (const [table, list] of Object.entries(fe)) {
        const mIndex = new Map((mc[table] ?? []).map(m => [m.column, m]));
        for (const e of list) {
          count('property');
          const base = { example: ex, variant: v, entity: table, subject: e.column };
          const m = mIndex.get(e.column);
          mIndex.delete(e.column);
          const p = raw.get(`${table}.${e.column}`);
          if (!m) {
            if (e.type === 'ManyToMany' && !p) { hit('T-12', { ...base, detail: e.select }); propRule.set(`${ex}|${table}|${e.column}`, 'T-12'); }
            else miss('properties', { ...base, detail: 'property missing in MCP' });
            continue;
          }
          if (!p) { miss('properties', { ...base, detail: 'no raw property' }); continue; }
          if (e.type !== feType(p)) { miss('fe-model', { ...base, detail: `frontend type ${e.type}, model ${feType(p)}` }); continue; }
          if (m.type !== mcpType(p)) { miss('mcp-model', { ...base, detail: `MCP type ${m.type}, model ${mcpType(p)}` }); continue; }
          const feList = e.selectForList === '=' ? e.select : e.selectForList;
          if (e.select !== feSelect(e.type, p) || feList !== feSelectForList(e.type, p)) { miss('fe-model', { ...base, detail: `frontend select ${e.select} differs from the model` }); continue; }
          if (m.select !== mcpSelect(m.type, p)) { miss('mcp-model', { ...base, detail: `MCP select ${m.select} differs from the model ${mcpSelect(m.type, p)}` }); continue; }
          if (e.type !== m.type) {
            const r = typeRule(p, e.type, m.type);
            if (!r) { miss('type', { ...base, detail: `${e.type} -> ${m.type}` }); continue; }
            hit(r, { ...base, detail: `frontend ${e.type}, MCP ${m.type}` });
            propRule.set(`${ex}|${table}|${e.column}`, r);
            if (e.select !== m.select) hit(r, { ...base, subject: `${e.column} (select)`, detail: `frontend ${e.select} | MCP ${m.select}` }, 'effects');
          } else if (e.select !== m.select) {
            const r = selectRule(e.type, p, e.select, m.select);
            if (!r) { miss('select', { ...base, detail: `${e.select} | ${m.select}` }); continue; }
            hit(r, { ...base, detail: `frontend ${e.select} | MCP ${m.select}` });
            propRule.set(`${ex}|${table}|${e.column}`, r);
          }
        }
        for (const m of mIndex.values()) miss('properties', { example: ex, variant: v, entity: table, subject: m.column, detail: 'property only in MCP' });
      }
      for (const table of Object.keys(mc)) if (!(table in fe)) miss('properties', { example: ex, variant: v, entity: table, detail: 'table only in MCP' });
    }
  }
}

/**
 * The `.es` variants are non-production for the MCP (it never sends
 * Accept-Language) and are not attributed, but their MCP artifacts are still
 * produced: check them against the MCP models so they cannot drift unseen.
 */
function esModelEngine() {
  for (const ex of examples()) {
    for (const v of allVariants(ex).filter(x => x.includes('.'))) {
      const raw = new Map(readJson(path.join(RAW, ex, v, 'schema_properties.mcp.json')).map(p => [`${p.table_name}.${p.column_name}`, p]));
      for (const [table, list] of Object.entries(readJson(path.join(MCP, ex, v, 'schema.properties.json')).entities)) {
        for (const m of list) {
          count('es-model');
          const p = raw.get(`${table}.${m.column}`);
          if (!p || m.type !== mcpType(p) || m.select !== mcpSelect(m.type, p)) miss('mcp-model', { example: ex, variant: v, entity: table, subject: m.column, detail: 'MCP type/select differs from the model' });
        }
      }
      const props = readJson(path.join(RAW, ex, v, 'schema_properties.mcp.json'));
      for (const [table, views] of Object.entries(readJson(path.join(MCP, ex, v, 'schema.views.json')).entities)) {
        for (const view of ['list', 'detail', 'create', 'edit']) {
          count('es-model');
          const expected = mcpFilter(props.filter(x => x.table_name === table), view).map(x => x.column_name);
          if (!same(expected, views[view])) miss('mcp-model', { example: ex, variant: v, entity: table, subject: view, detail: 'MCP view differs from the model' });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 2: view property lists
// ---------------------------------------------------------------------------

function viewEngine() {
  for (const ex of examples()) {
    for (const v of variants(ex)) {
      const fe = readJson(path.join(FE, ex, v, 'schema.views.json')).entities;
      const mc = readJson(path.join(MCP, ex, v, 'schema.views.json')).entities;
      const feTypes = new Map();
      for (const [t, list] of Object.entries(readJson(path.join(FE, ex, v, 'schema.properties.json')).entities)) for (const p of list) feTypes.set(`${t}.${p.column}`, p.type);
      const raw = new Map(readJson(path.join(RAW, ex, v, 'schema_properties.json')).map(p => [`${p.table_name}.${p.column_name}`, p]));
      const ents = new Map(readJson(path.join(RAW, ex, v, 'schema_entities.json')).map(e => [e.table_name, e]));
      const S = mcpSchema(ex, v);
      // Frontend model: raw properties plus the M:M virtual properties, each with its frontend type.
      const virtual = readJson(path.join(FE, ex, v, 'schema.m2m.json')).virtualProperties ?? [];
      const feProps = new Map();
      for (const rp of readJson(path.join(RAW, ex, v, 'schema_properties.json'))) {
        feProps.set(rp.table_name, [...(feProps.get(rp.table_name) ?? []), { ...rp, type: feTypes.get(`${rp.table_name}.${rp.column_name}`) }]);
      }
      for (const vp of virtual) feProps.set(vp.table_name, [...(feProps.get(vp.table_name) ?? []), { ...vp, type: 'ManyToMany' }]);
      for (const [table, views] of Object.entries(fe)) {
        const model = feViews(feProps.get(table) ?? [], ents.get(table));
        for (const view of ['list', 'detail', 'create', 'edit', 'filter']) {
          count('fe-view-model');
          if (!same([...model[view]].sort(), [...views[view]].sort())) miss('fe-model', { example: ex, variant: v, entity: table, subject: view, detail: `frontend ${views[view].join()} | model ${model[view].join()}` });
        }
      }
      for (const [table, views] of Object.entries(mc)) {
        for (const view of ['list', 'detail', 'create', 'edit']) {
          const expected = mcpFilter(S.props(table), view).map(p => p.column_name);
          if (!same(expected, views[view])) miss('mcp-model', { example: ex, variant: v, entity: table, subject: view, detail: `MCP ${views[view].join()} | model ${expected.join()}` });
        }
      }
      for (const [table, views] of Object.entries(fe)) {
        const m = mc[table];
        if (!m) { miss('views', { example: ex, variant: v, entity: table, detail: 'entity missing in MCP' }); continue; }
        const ent = ents.get(table) ?? {};
        for (const view of ['list', 'detail', 'create', 'edit']) {
          count('view');
          const f = views[view];
          const g = m[view];
          const base = { example: ex, variant: v, entity: table };
          for (const col of f.filter(c => !g.includes(c))) {
            const p = raw.get(`${table}.${col}`);
            const inst = { ...base, subject: `${view}: ${col}`, detail: 'frontend only' };
            let r = null;
            if (!p && feTypes.get(`${table}.${col}`) === 'ManyToMany') r = 'T-12';
            else if (p && !feBase(view, p) && mcpFilter([p], view).length === 0) {
              if (view !== 'create' && STRUCTURAL.includes(col)) r = 'V-03';
              else if (view === 'list' && ent.show_map && ent.map_property_name === col) r = 'V-04';
            }
            if (!r) { miss('views', inst); continue; }
            hit(r, inst, r === 'T-12' ? 'effects' : 'instances');
            viewRule.set(`${ex}|${v}|${table}|${view}|${col}`, r);
          }
          for (const col of g.filter(c => !f.includes(c))) {
            const p = raw.get(`${table}.${col}`);
            const inst = { ...base, subject: `${view}: ${col}`, detail: 'MCP only' };
            let r = null;
            if (p && (view === 'create' || view === 'edit') && !p.is_generated && !p.is_identity && p[`show_on_${view}`] !== false) {
              if (col === 'created_at' || col === 'updated_at') r = 'V-01';
              else if (!p.is_updatable) r = 'V-02';
            }
            if (!r) { miss('views', inst); continue; }
            hit(r, inst);
            viewRule.set(`${ex}|${v}|${table}|${view}|${col}`, r);
          }
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

/** Check both goldens against the models and attribute a differing pair. */
function conditionCell(cond, rec, feResult, mcResult, inst, synthetic) {
  count('condition');
  const feModel = evaluate(cond, rec);
  const mcModel = evaluate(cond, rec, MCP_FLAGS);
  if (feResult !== undefined && feModel !== feResult) { miss('fe-model', { ...inst, detail: `frontend ${feResult}, model ${feModel}` }); return; }
  if (mcModel !== mcResult) { miss('mcp-model', { ...inst, detail: `MCP ${mcResult}, model ${mcModel}` }); return; }
  if (feModel === mcResult) return;
  const rules = conditionRules(cond, rec);
  if (!rules) { miss('conditions', { ...inst, detail: `frontend ${feModel}, MCP ${mcResult}: no rule explains it` }); return; }
  for (const r of rules) hit(r, { ...inst, example: synthetic ? '_shared' : inst.example, detail: `frontend ${feModel}, MCP ${mcResult}${rules.length > 1 ? ` (with ${rules.filter(x => x !== r).join(', ')})` : ''}` });
}

const recordOf = label => (label === '<null data>' ? null : label === '<undefined data>' ? undefined : JSON.parse(label));

function conditionEngine() {
  for (const ex of examples()) {
    const fe = readJson(path.join(FE, ex, '_example/conditions.actions.json')).conditions;
    const mc = readJson(path.join(MCP, ex, '_example/conditions.actions.json')).conditions;
    const mIndex = new Map(mc.map(c => [canon(c.condition), c]));
    if (mc.length !== fe.length) miss('conditions', { example: ex, detail: 'condition count differs' });
    for (const c of fe) {
      const m = mIndex.get(canon(c.condition));
      if (!m) { miss('conditions', { example: ex, subject: canon(c.condition), detail: 'condition missing in MCP' }); continue; }
      if (!same(m.usedBy, c.usedBy) || Object.keys(m.results).length !== Object.keys(c.results).length) miss('mcp-model', { example: ex, subject: canon(c.condition), detail: 'usedBy or record set differs' });
      for (const [label, r] of Object.entries(c.results)) {
        conditionCell(c.condition, recordOf(label), r, m.results[label], { example: ex, entity: c.usedBy.join(', '), subject: `${canon(c.condition)} @ ${label}` }, false);
      }
    }
  }
  const fe = readJson(path.join(FE, '_shared/conditions.matrix.json'));
  const mc = readJson(path.join(MCP, '_shared/conditions.matrix.json'));
  if (!same(mc.operators, fe.operators) || Object.keys(mc.matrix).length !== Object.keys(fe.matrix).length || Object.keys(mc.dotted).length !== Object.keys(fe.dotted).length) miss('mcp-model', { example: '_shared', subject: 'conditions.matrix', detail: 'operators or case set differs' });
  for (const [key, row] of Object.entries(fe.matrix)) {
    const sp = key.indexOf(' ');
    const op = key.slice(0, sp) === '<empty>' ? '' : key.slice(0, sp);
    const cv = JSON.parse(key.slice(sp + 1));
    for (const [dl, r] of Object.entries(row)) {
      const rec = dl === '<missing>' ? {} : { f: JSON.parse(dl) };
      conditionCell({ field: 'f', operator: op, value: cv }, rec, r, mc.matrix[key]?.[dl], { example: '_shared', entity: 'conditions.matrix', subject: `${key} @ ${dl}` }, true);
    }
  }
  for (const [key, r] of Object.entries(fe.dotted)) {
    const at = key.indexOf(' @ ');
    conditionCell({ field: key.slice(0, at), operator: 'eq', value: 1 }, JSON.parse(key.slice(at + 3)), r, mc.dotted[key], { example: '_shared', entity: 'conditions.dotted', subject: key }, true);
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
    if (!(key in compoundInputs)) { miss('conditions', { example: '_shared', subject: key, detail: 'compound case not modeled' }); continue; }
    const [cond, rec] = compoundInputs[key];
    conditionCell(cond, rec, r, mc.compound[key], { example: '_shared', entity: 'conditions.compound', subject: key }, true);
  }
  // describeConditionFailure for every record the MCP evaluator rejects (MCP-only artifact).
  for (const ex of examples()) {
    const fe = readJson(path.join(FE, ex, '_example/conditions.actions.json')).conditions;
    const desc = readJson(path.join(MCP, ex, '_example/mcp.conditions-describe.json')).conditions;
    if (desc.length !== fe.length) miss('mcp-model', { example: ex, detail: 'describe artifact condition count differs' });
    fe.forEach((c, i) => {
      count('condition-describe');
      const d = desc[i];
      const model = {};
      for (const label of Object.keys(c.results)) {
        const rec = recordOf(label);
        if (evaluate(c.condition, rec, MCP_FLAGS) !== true) model[label] = mcpDescribe(c.condition, rec);
      }
      if (!d || canon(d.condition) !== canon(c.condition) || !same(d.usedBy, c.usedBy) || canon(d.failures) !== canon(model)) {
        miss('mcp-model', { example: ex, subject: canon(c.condition), detail: 'describeConditionFailure output differs from the model' });
      }
    });
  }
  // MCP-only extra cells (empty strings, falsy values): the frontend side is the anchored model.
  const extra = readJson(path.join(MCP, '_shared/mcp.conditions-extra.json')).matrix;
  for (const [key, row] of Object.entries(extra)) {
    const sp = key.indexOf(' ');
    const cond = { field: 'f', operator: key.slice(0, sp), value: JSON.parse(key.slice(sp + 1)) };
    for (const [dl, r] of Object.entries(row)) {
      conditionCell(cond, dl === '<missing>' ? {} : { f: JSON.parse(dl) }, undefined, r, { example: '_shared', entity: 'mcp.conditions-extra', subject: `${key} @ ${dl}` }, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 4: conditional actions end to end (MCP-only artifact)
// ---------------------------------------------------------------------------

function predictAction(action, rec, flags, entities) {
  try {
    resolveEntity(entities, action.table_name);
  } catch (e) {
    if (e instanceof NameError) return { executeAction: `other: NameResolutionError: ${e.message}`, getRecordListing: 'error' };
    throw e;
  }
  const vis = action.visibility_condition ? evaluate(action.visibility_condition, rec, flags) : true;
  const en = action.enabled_condition ? evaluate(action.enabled_condition, rec, flags) : true;
  if (vis === THROWS || en === THROWS) return { executeAction: 'throws', getRecordListing: 'throws' };
  let executeAction;
  if (!action.can_execute) executeAction = 'no-permission';
  else if (!vis) executeAction = 'not-available';
  else if (!en) executeAction = 'disabled';
  else executeAction = (action.parameters ?? []).some(p => p.required) ? 'passed-conditions (missing required parameter)' : 'executed';
  let getRecordListing;
  if (!action.can_execute || !action.show_on_detail || !vis) getRecordListing = 'hidden';
  else getRecordListing = en ? 'listed' : 'listed-disabled';
  return { executeAction, getRecordListing };
}

function actionEngine() {
  let wronglyExecuted = 0;
  let wrongCases = 0;
  let exampleCases = 0;
  for (const ex of [...examples(), '_shared']) {
    let S;
    let art;
    if (ex === '_shared') {
      // Synthetic entity without timestamp columns (MCP-only inputs, model-checked only).
      art = readJson(path.join(MCP, '_shared/mcp.actions-execute.json'));
      const props = art.synthetic.properties.map(p => ({ ...p, type: art.syntheticTypes[`${p.table_name}.${p.column_name}`] }));
      S = { entities: art.synthetic.entities, props: t => props.filter(p => p.table_name === t), actions: art.synthetic.actions, statuses: art.synthetic.statuses, categories: [] };
      for (const p of props) if (p.type !== mcpType(p)) miss('mcp-model', { example: ex, subject: p.column_name, detail: `synthetic type ${p.type} vs model ${mcpType(p)}` });
    } else {
      S = mcpSchema(ex, 'testadmin');
      art = readJson(path.join(MCP, ex, '_example/mcp.actions-execute.json'));
    }
    for (const [name, a] of Object.entries(art.actions)) {
      const action = S.actions.find(x => `${x.table_name}.${x.action_name}` === name);
      if (!action) { miss('actions', { example: ex, subject: name, detail: 'action not in fixtures' }); continue; }
      const base = { example: ex, entity: action.table_name, subject: action.action_name };
      const kinds = ['visibility_condition', 'enabled_condition'].filter(k => action[k]);
      if (a.canExecute !== action.can_execute || a.showOnDetail !== action.show_on_detail
        || canon(a.conditions) !== canon(Object.fromEntries(kinds.map(k => [k, action[k]])))) {
        miss('mcp-model', { ...base, detail: 'recorded action metadata differs from the fixture' });
      }
      const fetchSelect = art.conditionFetchSelect[action.table_name];
      const modelSelect = mcpBuildSelect(S.props(action.table_name));
      if (S.entities.some(e => e.table_name === action.table_name) && fetchSelect !== modelSelect) {
        miss('mcp-model', { ...base, detail: `condition fetch select ${fetchSelect} | model ${modelSelect}` });
      }
      for (const [kase, out] of Object.entries(a.cases)) {
        count('action-case');
        const ex1 = mcpExecuteAction(action, out.record, S);
        const execObs = (out.executeRequests ?? []).map(r => ({ ...parseMcpRequest(r), ...(r.body !== undefined ? { body: r.body } : {}) }));
        const getObs = (out.getRecordRequests ?? []).map(r => parseMcpRequest(r));
        const textOk = (out.executeActionText ?? null) === (ex1.text ?? null);
        if (!same(canon(execObs), canon(ex1.requests)) || !textOk || out.rpcCalled !== ex1.requests.some(r => r.method === 'POST')
          || !same(canon(getObs), canon(mcpGetRecordRequests(action.table_name, S)))) {
          miss('mcp-model', { ...base, detail: `${kase}: execute_action / get_record requests or text differ from the model` });
          continue;
        }
        const mc = predictAction(action, out.record, MCP_FLAGS, S.entities);
        const obs = { executeAction: out.executeAction.startsWith('other: ') ? out.executeAction.split('\n')[0] : out.executeAction, getRecordListing: out.getRecordListing };
        if (obs.executeAction !== mc.executeAction || obs.getRecordListing !== mc.getRecordListing) {
          miss('mcp-model', { ...base, detail: `${kase}: observed ${obs.executeAction}/${obs.getRecordListing}, model ${mc.executeAction}/${mc.getRecordListing}` });
          continue;
        }
        if (mc.executeAction.startsWith('other: NameResolutionError: Entity')) {
          if (!S.entities.some(e => e.table_name === action.table_name)) hit('A-02', { ...base, detail: 'entity not in schema_entities: execute_action and get_record fail with "Entity not found"' });
          else miss('actions', { ...base, detail: mc.executeAction });
          continue;
        }
        if (ex !== '_shared') exampleCases++;
        const fe = predictAction(action, out.record, {}, S.entities);
        if (same(fe, mc)) continue;
        // A disagreement must come from a condition rule still open on main (C-01, the cause of A-01, is fixed).
        // The rule must cover one of the action's conditions (C-06: a malformed one), not merely reproduce the MCP result.
        const rule = Object.keys(CONDITION_RULES).find(id => [action.visibility_condition, action.enabled_condition].some(c => c && CONDITION_RULES[id].applies(c))
          && same(predictAction(action, out.record, CONDITION_RULES[id].flags, S.entities), mc));
        if (!rule) { miss('actions', { ...base, detail: `${kase}: no single open rule explains ${mc.executeAction}/${mc.getRecordListing}` }); continue; }
        const passed = o => o.executeAction === 'executed' || o.executeAction.startsWith('passed-conditions');
        if (ex !== '_shared' && passed(mc) && !passed(fe)) wronglyExecuted++;
        if (ex !== '_shared') wrongCases++;
        hit(rule, { ...base, detail: `${kase}: MCP ${mc.executeAction} / get_record ${mc.getRecordListing}; frontend evaluator ${fe.executeAction} / ${fe.getRecordListing}` }, 'effects');
      }
    }
  }
  note('A-01', `${wrongCases} of ${exampleCases} (action, case) pairs in the examples disagree with the frontend evaluator (${wronglyExecuted} would run an action the frontend blocks). Before b3f2eeb8: 38 disagreed, none wrongly executed.`);
}

// ---------------------------------------------------------------------------
// Engine 5: error messages
// ---------------------------------------------------------------------------

const SHARED_KINDS = ['network', 'permission', 'unique', 'notfound', 'auth'];
const FE_CONSTRAINT = ['check', 'check-named', 'exclusion', 'exclusion-named', 'constraint-lookup'];
const MCP_CONSTRAINT = ['check', 'check-named', 'exclusion-named', 'constraint-lookup'];

function errorRule(feKind, mcKind, code) {
  if (feKind === mcKind && SHARED_KINDS.includes(feKind)) return 'E-01';
  if (feKind === 'raise' && mcKind === 'raise' && code === 'P0001') return 'F-15';
  if ((code === '23514' || code === '23P01') && FE_CONSTRAINT.includes(feKind) && MCP_CONSTRAINT.includes(mcKind)) return 'E-03';
  if (feKind === 'fallback' && ['notnull', 'invalid-input', 'datetime', 'precondition'].includes(mcKind)) return 'F-04';
  if (feKind === 'fallback' && mcKind === 'fallback' && ['23503', 'PGRST116', 'PT503'].includes(code)) return 'F-17';
  if (feKind === 'fallback' && mcKind === 'fallback') return 'E-04';
  return null;
}

function errorEngine() {
  for (const ex of examples()) {
    const fe = readJson(path.join(FE, ex, '_example/errors.lookup.json'));
    const mc = readJson(path.join(MCP, ex, '_example/errors.lookup.json'));
    const messages = fe.constraintMessages;
    if (!same(messages, mc.constraintMessages)) miss('errors', { example: ex, detail: 'constraint messages differ' });
    const cases = [
      ...fe.results.map((r, i) => [r, mc.results[i], 'parseToHuman', undefined, undefined]),
      ...fe.results.map((r, i) => [r, mc.results[i], 'parseToHumanWithLookup', messages, messages]),
      ...fe.unloaded.map((r, i) => [r, mc.unloaded[i], 'parseToHumanWithLookup', undefined, []]),
    ];
    for (const [f, m, key, feMsgs, mcMsgs] of cases) {
      count('error');
      const p = f.payload;
      const inst = { example: ex, entity: key, subject: canon(p) };
      if (!m || canon(p) !== canon(m.payload)) { miss('errors', { ...inst, detail: 'payload mismatch' }); continue; }
      const [fk, ft] = key === 'parseToHuman' ? feParse(p) : feParseLookup(p, feMsgs);
      const [mk, mt] = mcpParse(p, mcMsgs);
      // The frontend spec writes an undefined result as '<undefined>' (P0001 without a message).
      if ((ft ?? '<undefined>') !== f[key]) { miss('fe-model', { ...inst, detail: `frontend ${JSON.stringify(f[key])}, model ${JSON.stringify(ft)}` }); continue; }
      if (mt !== m[key]) { miss('mcp-model', { ...inst, detail: `MCP ${JSON.stringify(m[key])}, model ${JSON.stringify(mt)}` }); continue; }
      if (ft === mt) continue;
      const r = errorRule(fk, mk, p.code);
      if (!r) { miss('errors', { ...inst, detail: `${fk} ${JSON.stringify(ft)} vs ${mk} ${JSON.stringify(mt)}` }); continue; }
      // Payloads without a constraint name behave the same in every example: count them once.
      const perExample = (p.code === '23514' || p.code === '23P01') && /constraint "[^"]+"/.test(`${p.message ?? ''} ${p.details ?? ''}`);
      hit(r, { ...inst, example: perExample ? ex : '_shared', detail: `frontend ${JSON.stringify(ft)}, MCP ${JSON.stringify(mt)}` });
    }
  }
  const fe = readJson(path.join(FE, '_shared/errors.data-parse-api-error.json'));
  const mc = readJson(path.join(MCP, '_shared/errors.data-parse-api-error.json'));
  for (const [name, f] of Object.entries(fe)) {
    count('error');
    const m = mc[name];
    const inst = { example: '_shared', entity: 'client', subject: name };
    if (!m?.input) { miss('errors', { ...inst, detail: 'case missing in MCP' }); continue; }
    const { response, feStatusText } = m.input;
    const body = response.text !== undefined ? response.text : response.body;
    const feErr = {
      httpCode: response.networkError ? 0 : response.status,
      code: body && typeof body === 'object' ? body.code : undefined,
      message: typeof body === 'string' ? body : (body?.message ?? feStatusText ?? 'Unknown Error'),
      details: body && typeof body === 'object' ? body.details : undefined,
    };
    const [fk, ft] = feParseLookup(feErr, undefined);
    if (f.error.httpCode !== feErr.httpCode || f.error.message !== feErr.message || f.error.humanMessage !== ft || f.error.code !== feErr.code) {
      miss('fe-model', { ...inst, detail: `frontend ${canon(f.error)} vs model ${canon({ ...feErr, humanMessage: ft })}` });
      continue;
    }
    const model = mcpClientError(response);
    if (m.thrown !== model.thrown || m.error.message !== model.message) { miss('mcp-model', { ...inst, detail: `MCP ${m.thrown} ${m.error.message} vs model ${model.thrown} ${model.message}` }); continue; }
    if (model.thrown === 'MaintenanceError') {
      if (m.error.mode !== model.mode) { miss('mcp-model', { ...inst, detail: 'maintenance mode differs' }); continue; }
      if (fk === 'fallback' && feErr.code === 'PT503') hit('F-17', { ...inst, detail: `frontend ${JSON.stringify(ft)}, MCP throws MaintenanceError (${model.mode})` });
      else miss('errors', { ...inst, detail: 'MaintenanceError without a frontend fallback' });
      continue;
    }
    const mcErr = { message: model.message, httpCode: model.httpCode, code: model.code, details: model.details, hint: model.hint };
    const [mk, mt] = mcpParse(mcErr, undefined);
    if (m.error.humanMessage !== mt || m.error.httpCode !== model.httpCode || m.error.code !== model.code) { miss('mcp-model', { ...inst, detail: `MCP humanMessage ${JSON.stringify(m.error.humanMessage)} vs model ${JSON.stringify(mt)}` }); continue; }
    if (ft !== mt) {
      const r = errorRule(fk, mk, feErr.code);
      if (r) hit(r, { ...inst, entity: 'client humanMessage', detail: `frontend ${JSON.stringify(ft)}, MCP ${JSON.stringify(mt)}` });
      else miss('errors', { ...inst, detail: `${fk} vs ${mk}` });
    }
    if (feErr.message !== model.message) {
      const noBodyMessage = response.networkError || typeof body === 'string' || !body?.message;
      if (noBodyMessage) hit('E-06', { ...inst, entity: 'client message', detail: `frontend ${JSON.stringify(feErr.message)}, MCP ${JSON.stringify(model.message)}` });
      else miss('errors', { ...inst, detail: 'message differs although the body has one' });
    }
  }
}

// ---------------------------------------------------------------------------
// Engine 6: request building
// ---------------------------------------------------------------------------

/** The frontend's special-character / pagination matrix inputs (data.golden.spec.ts), keyed by case name. */
function matrixInputs() {
  const nasty = ['a&b', 'a,b', 'a(b)', 'a b', '100%', '50%25', 'ñandú', '日本語', 'a=b', 'a#b', 'a+b', "o'brien", 'a"b', 'a/b', 'a?b', 'a;b', '\\', '*wild*', 'null', 'true', ' lead', 'trail ', '\n'];
  const out = {};
  const plain = q => ({ paginated: false, query: { key: 'items', ...q } });
  for (const v of nasty) {
    out[`filter eq ${JSON.stringify(v)}`] = plain({ fields: ['id'], filters: [{ column: 'name', operator: 'eq', value: v }] });
    out[`filter ilike ${JSON.stringify(v)}`] = plain({ fields: ['id'], filters: [{ column: 'name', operator: 'ilike', value: `*${v}*` }] });
    out[`search ${JSON.stringify(v)}`] = plain({ fields: ['id'], searchQuery: v });
  }
  out['in array with specials'] = plain({ fields: ['id'], filters: [{ column: 'c', operator: 'in', value: ['a,b', 'c d', '(e)', 1, null, ''] }] });
  out['in array of uuids'] = plain({ fields: ['id'], filters: [{ column: 'c', operator: 'in', value: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] }] });
  out['non-in operator with array value'] = plain({ fields: ['id'], filters: [{ column: 'c', operator: 'eq', value: [1, 2] }] });
  out['order with FK embed'] = plain({ fields: ['id'], orderField: 'owner(display_name)', orderDirection: 'desc' });
  out['entityId with specials'] = plain({ fields: ['id'], entityId: 'a&b=c' });
  out['no fields'] = plain({});
  out['empty fields'] = plain({ fields: [] });
  out['fields already containing id'] = plain({ fields: ['id', 'name'] });
  out['summary view skips id'] = plain({ fields: ['name'], isSummaryView: true });
  out['limit 0 is dropped'] = plain({ fields: ['id'], limit: 0 });
  out['everything at once'] = plain({
    fields: ['name', 'owner:users!owner(id,display_name)'], searchQuery: 'a b', orderField: 'name', entityId: '9',
    filters: [{ column: 'x', operator: 'eq', value: 'y' }], limit: 3, rawQueryParams: ['or=(a.eq.1)'],
  });
  for (const [page, pageSize] of [[1, 25], [2, 25], [10, 7], [1, 1], [0, 25], [-1, 25], [1, 0], [2.5, 10]]) {
    out[`pagination ${page}/${pageSize}`] = { paginated: true, query: { key: 'items', fields: ['id'], pagination: { page, pageSize } } };
  }
  return out;
}

function parseMcpRequest(r) {
  const rest = r.url.replace(/^<PGRST>\//, '');
  const q = rest.indexOf('?');
  return { method: r.method, path: decodeURIComponent(q < 0 ? rest : rest.slice(0, q)), decoded: r.decoded, headers: r.headers ?? {} };
}
const pairsOf = decoded => decoded.map(d => { const i = d.indexOf('='); return [d.slice(0, i), d.slice(i + 1)]; });
const stripEmbed = f => String(f).replace(/^([^()]+)\([^()]+\)$/, '$1');
/** ListPage.buildOrderField (list.page.ts:859-875). */
const feOrderField = (type, col) => (type === 'ForeignKeyName' || type === 'User' ? `${col}(display_name)` : col);

/** Check an observed MCP outcome against the model. Returns null when equal, else a description. */
function mcpDiff(obs, model) {
  if (same(obs.invalidInput ?? null, model.invalidInput ?? null) && (obs.thrown ?? null) === (model.thrown ?? null)
    && (obs.toolError ?? null) === (model.toolError ?? null)) {
    const o = (obs.requests ?? []).map(parseMcpRequest);
    const m = (model.requests ?? []).map(r => ({ method: r.method, path: r.path, decoded: r.decoded, headers: r.headers }));
    if (same(o, m)) return null;
    return `requests ${JSON.stringify(o)} vs model ${JSON.stringify(m)}`;
  }
  return `outcome ${canon({ i: obs.invalidInput, t: obs.thrown, e: obs.toolError })} vs model ${canon({ i: model.invalidInput, t: model.thrown, e: model.toolError })}`;
}

/**
 * Attribute every aspect in which the frontend's intended request differs from
 * the MCP request (both already checked against their models).
 * c: { base, feQuery, fe (feRequest result), mcInput, call, notes, model, S, ent, feTypes, viewKey, summaryView, synthetic }
 */
function compareRequests(c) {
  const { base, feQuery, fe, mcInput, call, model, S, ent } = c;
  const main = model.requests[model.requests.length - 1];
  const kind = c.synthetic ? 'synthetic' : 'example';
  const H = (rule, inst, bucket) => hit(rule, { ...base, ...inst, example: kind === 'synthetic' ? '_shared' : base.example }, bucket);
  const fParams = new Map();
  for (const [k, v] of fe.intended) fParams.set(k, [...(fParams.get(k) ?? []), v]);
  const mParams = new Map();
  for (const [k, v] of pairsOf(main.decoded)) mParams.set(k, [...(mParams.get(k) ?? []), v]);
  const handled = new Set(['select', 'order', 'id', 'limit']);

  // select
  const fs_ = fParams.get('select')?.[0];
  const ms = mParams.get('select')?.[0];
  const allProps = S.props(ent.table_name);
  const propByCol = new Map(allProps.map(p => [p.column_name, p]));
  if (fs_ === undefined) {
    if (!feQuery.fields && !mcInput.columns && call === 'list_records') H('Q-15', { detail: `frontend sends no select (every column); list_records has no all-columns mode, MCP select=${ms}` }, 'effects');
    else miss('queries', { ...base, detail: 'frontend has no select' });
  } else if (fs_ !== ms) {
    const fi = splitSelect(fs_);
    const mi = splitSelect(ms);
    const fA = new Map(fi.map(x => [selectAlias(x), x]));
    const mA = new Map(mi.map(x => [selectAlias(x), x]));
    for (const [a, item] of fA) {
      if (mA.has(a)) {
        const other = mA.get(a);
        if (other === item) continue;
        const r = propRule.get(`${base.example}|${ent.table_name}|${a}`);
        if (c.name === 'everything at once' && a === 'owner' && item === 'owner:users!owner(id,display_name)' && other === mcpSelect('User', propByCol.get('owner'))) diagnostics.mappingArtifacts++;
        else if (r && (r.startsWith('S-') || r.startsWith('T-'))) H(r, { subject: `${c.name}: ${a}`, detail: `frontend ${item} | MCP ${other}` }, 'effects');
        else miss('queries', { ...base, detail: `select item ${item} | ${other}` });
        continue;
      }
      if (a === 'id') {
        if (!propByCol.has('id') && !allProps.some(p => p.is_identity)) H('Q-11', { detail: `frontend appends id; the entity has no id column (MCP select=${ms})` }, c.summaryView ? 'harnessOnly' : 'instances');
        else miss('queries', { ...base, detail: 'frontend-only id on an entity with an id' });
        continue;
      }
      if (c.feTypes.get(a) === 'ManyToMany') { H('T-12', { subject: `${c.name}: ${a}`, detail: item }, 'effects'); continue; }
      const vr = c.viewKey && viewRule.get(`${c.viewKey}|list|${a}`);
      if (call === 'list_records' && !mcInput.columns && vr) { H(vr, { subject: `${c.name}: ${a}`, detail: item }, 'effects'); continue; }
      miss('queries', { ...base, detail: `select item only in frontend: ${item}` });
    }
    for (const [a, item] of mA) {
      if (fA.has(a)) continue;
      if (a === 'id' && item === 'id') {
        if ((propByCol.has('id') || allProps.some(p => p.is_identity)) && (feQuery.isSummaryView || call === 'get_record')) {
          H('Q-11', { detail: `MCP adds id (the entity has one); frontend select=${fs_}` });
        } else miss('queries', { ...base, detail: 'MCP-only id' });
        continue;
      }
      if (a === '' && ms.endsWith(',')) { H('Q-14', { detail: `MCP select=${ms}` }); continue; }
      if (call === 'get_record' && (a === 'created_at' || a === 'updated_at') && !propByCol.has(a)) { H('Q-12', { subject: `${c.name}: ${a}`, detail: `MCP selects ${a}; the entity has no such column` }); continue; }
      if (call === 'get_record' && propByCol.has(a) && item === mcpSelect(propByCol.get(a).type, propByCol.get(a))) { H('Q-13', { subject: `${c.name}: ${a}`, detail: item }); continue; }
      miss('queries', { ...base, detail: `select item only in MCP: ${item}` });
    }
    const fIds = fi.indexOf('id');
    const mIds = mi.indexOf('id');
    if (fIds === fi.length - 1 && mIds === 0 && fi.length > 1) H('Q-03', { detail: `frontend …,id | MCP id,…` });
  }

  // id parameter
  if (!same(fParams.get('id') ?? null, mParams.get('id') ?? null)) {
    if (call === 'list_records' && c.notes.some(n => n.includes('entityId'))) H('Q-15', { detail: `id=${fParams.get('id')} dropped (no entityId in list_records)` }, 'effects');
    else miss('queries', { ...base, detail: `id ${fParams.get('id')} | ${mParams.get('id')}` });
  }

  // order
  const fo = fParams.get('order')?.[0];
  const mo = mParams.get('order')?.[0];
  if (fo !== mo) {
    const searched = !!(feQuery.searchQuery && feQuery.searchQuery.trim());
    const dir = feQuery.orderDirection ?? 'asc';
    if (fo === undefined && searched && feQuery.orderField && mo === `${stripEmbed(feQuery.orderField)}.${dir}`) H('Q-06', { detail: `frontend drops order while searching, MCP order=${mo}` });
    else if (fo === undefined && !feQuery.orderField && model.trace?.defaultOrder) H('Q-01', { detail: `MCP order=${mo}` });
    else if (fo !== undefined && /\(display_name\)\.(asc|desc)$/.test(fo) && mo === fo.replace('(display_name)', '')) H('Q-04', { detail: `frontend order=${fo}, MCP order=${mo}` });
    else miss('queries', { ...base, detail: `order ${fo} | ${mo}` });
  }

  // search
  const mSearchKey = mcInput.search ? (ent.fulltext_search_column || ent.substring_search_column || 'display_name') : null;
  const feSearch = [];
  if (feQuery.searchQuery && feQuery.searchQuery.trim()) feSearch.push(['civic_os_text_search', `wfts.${feQuery.searchQuery.trim()}`]);
  if (c.name === 'hybrid search rawQueryParams') feSearch.push(...decodeParams(feListSearchParams('pot hole', c.feEnt)));
  for (const [k] of feSearch) handled.add(k);
  if (mSearchKey) handled.add(mSearchKey);
  const feSearchStr = feSearch.map(([k, v]) => `${k}=${v}`).join('&');
  const mcSearchStr = mSearchKey ? `${mSearchKey}=${mParams.get(mSearchKey)?.[mParams.get(mSearchKey).length - 1]}` : '';
  if (feSearchStr !== mcSearchStr) {
    const term = mcInput.search ?? '';
    const padded = term !== term.trim();
    if (padded) H('Q-07', { detail: `term ${JSON.stringify(term)}: frontend ${feSearchStr || '(none)'}, MCP ${mcSearchStr}` });
    if (feSearch.length && mSearchKey) H('Q-05', { detail: `frontend ${feSearchStr}, MCP ${mcSearchStr}` });
    else if (!padded) miss('queries', { ...base, detail: `search ${feSearchStr} | ${mcSearchStr}` });
  }

  // filters
  const steps = model.trace?.filters ?? [];
  const feFilters = (feQuery.filters ?? []).filter(f => !(f.value === null || f.value === undefined || f.value === ''));
  const skipped = steps.filter(s => s.input === '' || s.input === null);
  for (const s of skipped) H('Q-08', { subject: `${c.name}: ${s.column} ${s.expression}`, detail: `frontend skips the ${JSON.stringify(s.input)} value; MCP sends ${s.column}=${s.expression}` });
  const kept = steps.filter(s => !(s.input === '' || s.input === null));
  if (kept.length !== feFilters.length) miss('queries', { ...base, detail: `filter count frontend ${feFilters.length} vs MCP ${kept.length}` });
  kept.forEach((s, i) => {
    const f = feFilters[i];
    const feExpr = f && (f.operator === 'in' && Array.isArray(f.value) ? `in.(${f.value.join(',')})` : `${f.operator}.${f.value}`);
    if (!f || f.column !== s.column || feExpr !== s.expression) miss('queries', { ...base, detail: `filter ${f?.column}=${feExpr} | ${s.column}=${s.expression}` });
  });
  for (const col of model.trace?.grouped ?? []) {
    H('Q-09', { subject: `${c.name}: ${col}`, detail: `MCP and=${mParams.get('and')?.[0]}; frontend repeats ${col}` });
  }
  const filterCols = new Set(steps.map(s => s.column));
  for (const k of filterCols) handled.add(k);
  if ((model.trace?.grouped ?? []).length) handled.add('and');

  // limit / Range / headers / method
  const fl = fParams.get('limit')?.[0];
  const fh = fe.headers;
  const mh = main.headers;
  if (main.method !== 'GET') miss('queries', { ...base, detail: `MCP method ${main.method}` });
  if (!same(fh, mh)) {
    const limit = mcInput.limit ?? 25;
    const offset = mcInput.offset ?? 0;
    if (call === 'list_records' && Object.keys(fh).length === 0 && offset === 0 && mh.Range === `0-${limit - 1}` && (fl === undefined || Number(fl) === limit)) {
      H('Q-02', { detail: `frontend ${fl !== undefined ? `limit=${fl}` : 'no Range'}, MCP Range ${mh.Range} + Prefer count=exact` });
    } else miss('queries', { ...base, detail: `headers ${canon(fh)} | ${canon(mh)}` });
  } else if (fl !== undefined) miss('queries', { ...base, detail: `frontend limit=${fl} with equal headers` });

  // remaining parameters
  const keys = new Set([...fParams.keys(), ...mParams.keys()].filter(k => !handled.has(k)));
  for (const k of keys) {
    const fv = fParams.get(k) ?? [];
    const mv = mParams.get(k) ?? [];
    if (same(fv, mv)) continue;
    const raw = (feQuery.rawQueryParams ?? []).flatMap(r => [...new URLSearchParams(r)]).filter(([rk]) => rk === k).map(([, rv]) => rv);
    if (mv.length === 0 && same(fv, raw) && c.notes.some(n => n.includes('rawQueryParams') && n.includes('dropped'))) {
      H('Q-15', { subject: `${c.name}: ${k}`, detail: `${k}=${fv.join('|')} dropped (no raw parameter passthrough)` }, 'effects');
    } else miss('queries', { ...base, detail: `param ${k}: ${fv.join('|')} | ${mv.join('|')}` });
  }
}

function queryCase(c) {
  const { base, feGolden, feQuery, paginated, mq, S } = c;
  count('query');
  if (c.name === 'hybrid search rawQueryParams' && !same(feQuery.rawQueryParams, feListSearchParams('pot hole', c.feEnt))) {
    miss('fe-model', { ...base, detail: `frontend rawQueryParams ${JSON.stringify(feQuery.rawQueryParams)} | model ${JSON.stringify(feListSearchParams('pot hole', c.feEnt))}` });
    return;
  }
  const om = /^order (\S+) (asc|desc) \[(\w+)\]$/.exec(c.name);
  if (om && feQuery.orderField !== feOrderField(om[3], om[1])) {
    miss('fe-model', { ...base, detail: `frontend orderField ${feQuery.orderField} | model ${feOrderField(om[3], om[1])}` });
    return;
  }
  const fe = feRequest(feQuery, paginated);
  if (fe.url !== feGolden.url || !same(fe.headers, feGolden.headers ?? {})) {
    miss('fe-model', { ...base, detail: `frontend ${feGolden.url} ${canon(feGolden.headers)} vs model ${fe.url} ${canon(fe.headers)}` });
    return;
  }
  // Encoding: what PostgREST decodes from the frontend URL vs what the caller meant.
  const decoded = decodeFeUrl(fe.url);
  if (!same(decoded, fe.intended)) {
    const mcCase = mq.requests?.length ? pairsOf(parseMcpRequest(mq.requests[mq.requests.length - 1]).decoded) : [];
    const intendedKeys = new Set(fe.intended.map(([k]) => k));
    const mcIntact = fe.intended.filter(([k]) => k !== 'select').every(([k, v]) => mcCase.some(([mk, mv]) => mk === k && mv === v)) || mq.invalidInput;
    hit('F-01', { ...base, example: c.synthetic ? '_shared' : base.example, detail: `intended ${fe.intended.map(([k, v]) => `${k}=${v}`).join(' & ')}; PostgREST decodes ${decoded.map(([k, v]) => `${k}=${v}`).join(' & ')}${mcIntact ? '; MCP sends it intact' : ''}` });
    void intendedKeys;
  }
  if (mq.inexpressible) {
    if (c.name === 'edit' && mq.inexpressible.startsWith('edit-form read')) hit('Q-15', { ...base, detail: mq.inexpressible });
    else miss('queries', { ...base, detail: `inexpressible: ${mq.inexpressible}` });
    return;
  }
  const model = mq.call === 'get_record' ? mcpGetRecord(mq.input, S) : mcpListRecords(mq.input, S);
  if (model.unsupported) { miss('queries', { ...base, detail: model.unsupported }); return; }
  const d = mcpDiff(mq, model);
  if (d) { miss('mcp-model', { ...base, detail: d }); return; }
  const H = (rule, detail) => hit(rule, { ...base, example: c.synthetic ? '_shared' : base.example, detail });
  if (model.invalidInput) {
    const inv = model.invalidInput.join('; ');
    if (/^pagination /.test(c.name) && /^(offset|limit): too_small$/.test(inv)) H('F-02', `frontend Range ${fe.headers.Range}; MCP rejects (${inv})`);
    else if (c.name === 'limit 0 is dropped' && inv === 'limit: too_small') H('Q-10', `frontend drops limit 0; MCP rejects (${inv})`);
    else if (c.name === 'calendar overlap filter' && inv === 'limit: too_big') H('Q-10', `frontend page size ${feQuery.pagination?.pageSize}; MCP rejects (${inv})`);
    else if (c.name === 'in array with specials' && inv === 'filters.0.value: invalid_union') H('F-13', `frontend ${decodeFeUrl(fe.url).map(([k, v]) => `${k}=${v}`).join('&')}; MCP rejects the null item (${inv})`);
    else miss('queries', { ...base, detail: `invalid input ${inv}` });
    return;
  }
  if (model.thrown) {
    const colErr = /^NameResolutionError: (?:Column|Ambiguous column) "([^"]+)"/.exec(model.thrown);
    if (c.name === 'order with FK embed' && colErr && colErr[1] === 'owner(display_name)') H('Q-04', `frontend order=owner(display_name).desc; MCP ${model.thrown.slice(0, 80)}`);
    else if (colErr && !S.props(c.ent.table_name).some(p => p.column_name === colErr[1])) diagnostics.bothReject++;
    else miss('queries', { ...base, detail: model.thrown });
    return;
  }
  if (model.toolError && mq.call === 'list_records') {
    const step = model.trace.filters[model.trace.filters.length - 1];
    const prop = S.props(c.ent.table_name).find(p => p.column_name === step?.column);
    if (step?.error && step.input === '') H('Q-08', `frontend skips the empty value; MCP resolves "" as a name and fails: ${step.error.slice(0, 90)}`);
    else if (step?.error && prop?.type === 'User' && /^[0-9a-f-]{36}$/i.test(String(step.input))) H('N-04', step.error);
    else miss('queries', { ...base, detail: `tool error ${model.toolError}` });
    return;
  }
  compareRequests({ ...c, fe, mcInput: mq.input, call: mq.call, notes: mq.notes ?? [], model });
}

function queryEngine() {
  for (const ex of examples()) {
    const fe = readJson(path.join(FE, ex, '_example/data.queries.json')).entities;
    const mc = readJson(path.join(MCP, ex, '_example/data.queries.json')).entities;
    const S = mcpSchema(ex, 'testadmin');
    const feTypes = new Map();
    for (const [t, list] of Object.entries(readJson(path.join(FE, ex, 'testadmin/schema.properties.json')).entities)) for (const p of list) feTypes.set(p.column + '@' + t, p.type);
    const feEnts = new Map(readJson(path.join(RAW, ex, 'testadmin/schema_entities.json')).map(e => [e.table_name, e]));
    for (const [table, e] of Object.entries(fe)) {
      const m = mc[table];
      if (!m) { miss('queries', { example: ex, entity: table, detail: 'entity missing in MCP' }); continue; }
      const ent = S.entities.find(x => x.table_name === table);
      const feEnt = feEnts.get(table) ?? {};
      const types = new Map([...feTypes].filter(([k]) => k.endsWith('@' + table)).map(([k, v]) => [k.slice(0, k.lastIndexOf('@')), v]));
      e.queries.forEach((q, i) => {
        const mq = m.queries[i];
        const base = { example: ex, entity: table, subject: q.name };
        if (!mq || mq.name !== q.name) { miss('queries', { ...base, detail: 'query misaligned' }); return; }
        const f = q.input?.fields;
        const fields = typeof f === 'string' ? e.named[f.slice(1, -1)] : f;
        const feQuery = { ...q.input, key: table, ...(fields !== undefined ? { fields } : {}) };
        queryCase({
          base, name: q.name, feGolden: q.request, feQuery, paginated: q.call === 'getDataPaginated', mq, S, ent, feEnt, feTypes: types,
          viewKey: `${ex}|testadmin|${table}`, summaryView: !!(feEnt.is_view && !feEnt.insert), synthetic: false,
        });
      });
    }
  }
  // Shared special-character / pagination matrix over the synthetic schema.
  const fe = readJson(path.join(FE, '_shared/data.query-matrix.json'));
  const art = readJson(path.join(MCP, '_shared/data.query-matrix.json'));
  const types = art.syntheticTypes;
  const props = art.synthetic.properties.map(p => ({ ...p, type: types[`${p.table_name}.${p.column_name}`] }));
  const S = {
    entities: art.synthetic.entities, props: t => props.filter(p => p.table_name === t), actions: [], statuses: [], categories: [],
  };
  const inputs = matrixInputs();
  const missingCases = Object.keys(fe).filter(k => !(k in inputs));
  for (const k of missingCases) miss('queries', { example: '_shared', subject: k, detail: 'frontend matrix case has no modeled input' });
  for (const [name, feGolden] of Object.entries(fe)) {
    const spec = inputs[name];
    const mq = art.cases[name];
    if (!spec || !mq) continue;
    const ent = S.entities.find(x => x.table_name === (mq.input?.entity ?? 'items'));
    queryCase({
      base: { example: '_shared', entity: 'data.query-matrix', subject: name }, name, feGolden, feQuery: spec.query, paginated: spec.paginated,
      mq, S, ent, feEnt: ent, feTypes: new Map(), viewKey: null, summaryView: false, synthetic: true,
    });
  }
  // The frontend hybrid-search and order-field builders against their own goldens.
  const hy = readJson(path.join(FE, '_shared/data.hybrid-search.json'));
  const HYBRID_CONFIGS = {
    none: [undefined, undefined], 'fts only': ['civic_os_text_search', []], 'substring only': [null, ['display_name']],
    both: ['civic_os_text_search', ['display_name']], 'fts + two substring': ['fts', ['a', 'b']], 'two substring': [null, ['a', 'b']], 'empty fts string': ['', ['a']],
  };
  for (const [name, row] of Object.entries(hy.buildHybridSearchParams)) {
    if (!(name in HYBRID_CONFIGS)) { miss('fe-model', { example: '_shared', subject: name, detail: 'hybrid config not modeled' }); continue; }
    const [fts, cols] = HYBRID_CONFIGS[name];
    for (const [label, out] of Object.entries(row)) {
      count('fe-hybrid-model');
      const got = feHybridSearchParams(JSON.parse(label), fts, cols);
      if (!same(got, out)) miss('fe-model', { example: '_shared', entity: 'buildHybridSearchParams', subject: `${name} ${label}`, detail: `frontend ${JSON.stringify(out)} | model ${JSON.stringify(got)}` });
    }
  }
  const ENTITY_SEARCH = {
    fts: { fulltext_search_column: 'civic_os_text_search', substring_search_column: null },
    substring: { fulltext_search_column: null, substring_search_column: 'display_name' },
    both: { fulltext_search_column: 'civic_os_text_search', substring_search_column: 'display_name' },
    'legacy search_fields only': { fulltext_search_column: null, substring_search_column: null },
  };
  for (const [name, out] of Object.entries(hy.listPageBuildSearchParams)) {
    count('fe-hybrid-model');
    if (!(name in ENTITY_SEARCH) || !same(feListSearchParams('pot hole', ENTITY_SEARCH[name]), out)) miss('fe-model', { example: '_shared', entity: 'ListPage.buildSearchParams', subject: name, detail: JSON.stringify(out) });
  }
  for (const { type, order } of hy.listPageBuildOrderField) {
    count('fe-hybrid-model');
    if (feOrderField(type, 'col') !== order) miss('fe-model', { example: '_shared', entity: 'ListPage.buildOrderField', subject: type, detail: `frontend ${order} | model ${feOrderField(type, 'col')}` });
  }

  // Content-Range parsing.
  const fcr = readJson(path.join(FE, '_shared/data.content-range.json'));
  const mcr = readJson(path.join(MCP, '_shared/data.content-range.json')).paginated;
  for (const [h, f] of Object.entries(fcr.paginated)) {
    count('content-range');
    const header = h === 'null' ? null : h;
    const inst = { example: '_shared', entity: 'data.content-range', subject: JSON.stringify(h) };
    if (f.totalCount !== feTotalPaginated(header, f.data.length) || fcr.preview[h]?.totalCount !== feTotalPreview(header, fcr.preview[h]?.records?.length ?? 0)) {
      miss('fe-model', { ...inst, detail: 'frontend Content-Range parse differs from the model' });
      continue;
    }
    const model = mcpContentRange(header);
    const m = mcr[h];
    if (!same(m?.contentRange ?? null, model ?? null) || m?.totalCount !== model?.total) { miss('mcp-model', { ...inst, detail: `MCP ${canon(m)} vs model ${canon(model ?? null)}` }); continue; }
    if (f.totalCount !== (model?.total ?? undefined)) hit('Q-16', { ...inst, detail: `frontend totalCount ${f.totalCount}, MCP total ${model ? model.total : '(none)'}` });
  }
}

// ---------------------------------------------------------------------------
// Engine 7: name resolution
// ---------------------------------------------------------------------------

function nameEngine() {
  for (const ex of examples()) {
    for (const v of variants(ex)) {
      const n = readJson(path.join(MCP, ex, v, 'mcp.names.json'));
      const S = mcpSchema(ex, v);
      for (const e of S.entities) {
        count('name');
        const r = n.entities[e.table_name];
        const base = { example: ex, variant: v, entity: e.table_name };
        if (!r) { miss('names', { ...base, detail: 'entity missing' }); continue; }
        const firstWord = e.display_name.trim().split(/\s+/)[0] ?? '';
        const model = Object.fromEntries(Object.entries({
          byTableName: e.table_name, byDisplayName: e.display_name, byUpperDisplayName: e.display_name.toUpperCase(),
          byPaddedDisplayName: `  ${e.display_name}  `, byFirstWord: firstWord,
        }).map(([k, input]) => [k, attempt(() => resolveEntity(S.entities, input).table_name)]));
        model.displayName = e.display_name;
        if (!same(canon(model), canon(r))) { miss('mcp-model', { ...base, detail: `entity probes ${canon(r)} vs model ${canon(model)}` }); continue; }
        if (r.byTableName !== e.table_name) {
          if (e.table_name !== e.table_name.toLowerCase()) hit('N-01', { ...base, subject: 'by table name', detail: `${JSON.stringify(e.table_name)} -> ${r.byTableName.slice(0, 120)}` });
          else hit('N-06', { ...base, subject: 'entity by table name', detail: r.byTableName.slice(0, 120) });
        }
        for (const k of ['byDisplayName', 'byUpperDisplayName', 'byPaddedDisplayName']) {
          if (r[k] !== e.table_name) hit('N-06', { ...base, subject: `entity ${k}`, detail: `${JSON.stringify(e.display_name)} -> ${r[k].slice(0, 120)}` });
        }
      }
      // Columns and actions: recompute every probe; the artifact keeps anomalies only, plus counts.
      const colAnom = {};
      let colProbes = 0;
      let colSelf = 0;
      const actAnom = {};
      let actProbes = 0;
      let actSelf = 0;
      for (const e of S.entities) {
        const props = S.props(e.table_name);
        for (const p of props) {
          for (const [k, input] of Object.entries({ byColumnName: p.column_name, byDisplayName: p.display_name, byUpperDisplayName: p.display_name.toUpperCase() })) {
            colProbes++;
            const got = attempt(() => resolveColumn(props, e.table_name, input).column_name);
            if (got === p.column_name) colSelf++;
            else ((colAnom[e.table_name] ??= {})[p.column_name] ??= {})[k] = `${JSON.stringify(input)} -> ${got}`;
          }
        }
        const acts = S.actions.filter(a => a.table_name === e.table_name);
        for (const a of acts) {
          for (const [k, input] of Object.entries({ byActionName: a.action_name, byDisplayName: a.display_name })) {
            actProbes++;
            const got = attempt(() => resolveAction(acts, e.table_name, input).action_name);
            if (got === a.action_name) actSelf++;
            else ((actAnom[e.table_name] ??= {})[a.action_name] ??= {})[k] = `${JSON.stringify(input)} -> ${got}`;
          }
        }
      }
      if (!same(canon(colAnom), canon(n.columnAnomalies)) || colProbes !== n.columnCounts.probes || colSelf !== n.columnCounts.resolvedToSelf) miss('mcp-model', { example: ex, variant: v, detail: 'column resolution differs from the model' });
      else for (const [t, cols] of Object.entries(colAnom)) for (const [col, probes] of Object.entries(cols)) for (const [k, d] of Object.entries(probes)) hit('N-06', { example: ex, variant: v, entity: t, subject: `column ${col} ${k}`, detail: d.slice(0, 140) });
      if (!same(canon(actAnom), canon(n.actionAnomalies)) || actProbes !== n.actionCounts.probes || actSelf !== n.actionCounts.resolvedToSelf) miss('mcp-model', { example: ex, variant: v, detail: 'action resolution differs from the model' });
      else for (const [t, acts] of Object.entries(actAnom)) for (const [act, probes] of Object.entries(acts)) for (const [k, d] of Object.entries(probes)) hit('N-06', { example: ex, variant: v, entity: t, subject: `action ${act} ${k}`, detail: d.slice(0, 140) });
    }
    // Statuses and categories (testadmin).
    const S = mcpSchema(ex, 'testadmin');
    const sc = readJson(path.join(MCP, ex, '_example/mcp.names-status-category.json'));
    const statusModel = {};
    for (const s of S.statuses) {
      const probe = input => attempt(() => String(resolveStatus(S.statuses, s.entity_type, input)));
      (statusModel[s.entity_type] ??= {})[`${s.id} ${s.display_name}`] = {
        statusKey: s.status_key ?? null, byStatusKey: s.status_key ? probe(s.status_key) : null,
        byDisplayName: probe(s.display_name), byUpperDisplayName: probe(s.display_name.toUpperCase()), byPaddedDisplayName: probe(` ${s.display_name} `),
      };
    }
    const catModel = {};
    for (const c of S.categories) {
      const probe = input => attempt(() => String(resolveCategory(S.categories, c.entity_type, input)));
      (catModel[c.entity_type] ??= {})[`${c.id} ${c.display_name}`] = { byDisplayName: probe(c.display_name), byUpperDisplayName: probe(c.display_name.toUpperCase()), byPaddedDisplayName: probe(` ${c.display_name} `) };
    }
    count('name');
    if (!same(canon(statusModel), canon(sc.statuses))) { miss('mcp-model', { example: ex, detail: 'status resolution differs from the model' }); }
    else {
      for (const [et, rows] of Object.entries(statusModel)) {
        for (const [label, r] of Object.entries(rows)) {
          const id = label.split(' ')[0];
          if (r.statusKey && r.byStatusKey === id) hit('N-02', { example: ex, entity: et, subject: label, detail: `status_key ${JSON.stringify(r.statusKey)} resolves in the MCP; the import worker would report it as not found unless it equals the display name` });
          for (const k of ['byDisplayName', 'byUpperDisplayName', 'byPaddedDisplayName']) {
            if (r[k] !== id) hit('N-02', { example: ex, entity: et, subject: `${label} ${k}`, detail: `resolves to ${r[k]} because a status_key matches first` });
          }
        }
      }
    }
    if (!same(canon(catModel), canon(sc.categories))) miss('mcp-model', { example: ex, detail: 'category resolution differs from the model' });
    // Locale: what the frontend shows in another language and the MCP never sees (no Accept-Language).
    for (const v of allVariants(ex).filter(x => x.includes('.'))) {
      const en = new Map(readJson(path.join(RAW, ex, v.split('.')[0], 'schema_entities.json')).map(e => [e.table_name, e.display_name]));
      for (const e of readJson(path.join(RAW, ex, v, 'schema_entities.json'))) {
        if (en.get(e.table_name) !== e.display_name) hit('N-05', { example: ex, variant: v, entity: e.table_name, subject: 'display_name', detail: `${v.split('.')[1]} ${JSON.stringify(e.display_name)}; the MCP always gets ${JSON.stringify(en.get(e.table_name))}` });
      }
    }
  }
  // Foreign-key lookups and resolveData over the synthetic schema.
  const fk = readJson(path.join(MCP, '_shared/mcp.names-fk-requests.json'));
  const eqOf = d => d.find(x => x.startsWith('display_name=eq.'))?.slice('display_name=eq.'.length);
  const ilikeOf = d => d.find(x => x.startsWith('display_name=ilike.'))?.slice('display_name=ilike.'.length);
  let fallbackLookups = 0;
  let wildcardLookups = 0;
  const SCENARIOS = {
    'eq finds one': d => (eqOf(d) !== undefined ? [{ id: 7, display_name: eqOf(d) }] : []),
    'eq finds two': d => (eqOf(d) !== undefined ? [{ id: 7, display_name: 'A' }, { id: 9, display_name: 'A' }] : []),
    'eq none, ilike one': d => (ilikeOf(d) !== undefined ? [{ id: 8, display_name: 'pattern match' }] : []),
    'eq none, ilike two': d => (ilikeOf(d) !== undefined ? [{ id: 8, display_name: 'p1' }, { id: 10, display_name: 'p2' }] : []),
    'no match': () => [],
  };
  for (const [scenario, rows] of Object.entries(fk.resolveForeignKeyValue)) {
    for (const [nameKey, r] of Object.entries(rows)) {
      count('name');
      const name = JSON.parse(nameKey);
      const responder = SCENARIOS[scenario];
      if (!responder) { miss('names', { example: '_shared', subject: scenario, detail: 'scenario not modeled' }); continue; }
      const model = resolveFk('parents', name, responder);
      const result = model.error ? `ERR ${model.error}` : model.result;
      const reqs = model.requests.map(q => q.decoded.join('&'));
      if (result !== r.result || !same(reqs, r.requests)) { miss('mcp-model', { example: '_shared', entity: scenario, subject: nameKey, detail: `MCP ${canon(r)} vs model ${canon({ result, requests: reqs })}` }); continue; }
      // The recorded requests equal the model's (checked above), so every fallback is the model's escaped imatch.
      if (model.requests.length > 1) {
        fallbackLookups++;
        if (/[*%_]/.test(name)) wildcardLookups++;
      }
      // The scenario that sends both lookups shows the untrimmed name in each; the stub cannot show the outcome (it does not answer imatch).
      if (scenario === 'eq none, ilike one' && name !== name.trim()) hit('N-03', { example: '_shared', entity: 'resolveForeignKeyValue', subject: nameKey, detail: `lookups sent untrimmed: ${reqs.join(' then ')}; the import worker trims the cell first` });
    }
  }
  note('N-03', `${fallbackLookups} fallback lookups in mcp.names-fk-requests.json, ${wildcardLookups} of them for names containing *, % or _: every one is an anchored, escaped \`imatch\` (an exact case-insensitive match). Before b3f2eeb8 the fallback was \`ilike.<name>\` and the 3 wildcard names of the "eq none, ilike one" scenario resolved through a pattern match. Harness limit: the stub answers only \`ilike\` fallbacks, so the "ilike one / two" scenarios now end in "not found"; the fix is shown by the request shape, not by a matching response.`);
  const qm = readJson(path.join(MCP, '_shared/data.query-matrix.json'));
  const synthProps = qm.synthetic.properties.map(p => ({ ...p, type: qm.syntheticTypes[`${p.table_name}.${p.column_name}`] }));
  const items = synthProps.filter(p => p.table_name === 'items');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const [caseName, r] of Object.entries(fk.resolveData)) {
    count('name');
    const urls = [];
    const lookup = (table, value) => {
      const m = resolveFk(table, value, SCENARIOS['eq finds one']);
      for (const q of m.requests) urls.push(`<PGRST>/${q.path}?${new URLSearchParams(pairsOf(q.decoded)).toString()}`);
      if (m.error) throw new NameError(m.error);
      return m.result;
    };
    let result;
    try {
      result = {};
      for (const [key, value] of Object.entries(r.input)) {
        let prop;
        try { prop = resolveColumn(items, 'items', key); } catch (e) { if (e instanceof NameError) { result[key] = value; continue; } throw e; }
        if (value !== null && typeof value === 'string' && prop.type !== undefined) {
          if (prop.type === 'ForeignKeyName') result[prop.column_name] = /^\d+$/.test(value) ? parseInt(value, 10) : UUID.test(value) ? value : lookup(prop.join_table, value);
          else if (prop.type === 'User') result[prop.column_name] = UUID.test(value) ? value : lookup('civic_os_users', value);
          else result[prop.column_name] = value;
        } else result[prop.column_name] = value;
      }
    } catch (e) {
      if (!(e instanceof NameError)) throw e;
      result = `ERR ${e.message}`;
    }
    if (!same(canon(result), canon(r.result)) || !same(urls, r.requests)) miss('mcp-model', { example: '_shared', entity: 'resolveData', subject: caseName, detail: `MCP ${canon(r)} vs model ${canon({ result, requests: urls })}` });
  }
}

// ---------------------------------------------------------------------------
// Engine 8: rule computations, probes and evidence checks
// ---------------------------------------------------------------------------

function evidenceEngine() {
  for (const rule of RULES) {
    if (!rule.compute) continue;
    rule.compute({ hit, miss, note, readJson, ROOT, FE, MCP, RAW, examples, variants, allVariants, count });
  }
}

/**
 * The frontend's hand-built `_synthetic` golden variant
 * (src/app/testing/golden/synthetic-fixtures.ts) reaches getPropertyType
 * branches no example does. Its rows are TypeScript, so they are bundled with
 * esbuild (a root devDependency) and read here, and the frontend models are
 * checked against `derived/frontend/_synthetic/all/*` too.
 */
let feSynthetic = null;
async function loadFeSynthetic() {
  const src = path.join(ROOT, 'src/app/testing/golden/synthetic-fixtures.ts');
  if (!fs.existsSync(src) || !fs.existsSync(path.join(FE, '_synthetic/all/schema.properties.json'))) return null;
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error('esbuild not found: run npm ci in the repository root (the ledger bundles the frontend synthetic fixtures)');
  }
  const out = path.join(os.tmpdir(), `ledger-synthetic-${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [src], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  try {
    const mod = await import(pathToFileURL(out).href);
    return mod.syntheticVariant().inline;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/**
 * execute_action when the condition fetch fails or finds no row (C-05). No
 * golden reaches that path: the golden stub always serves the row. So the
 * ledger bundles the real tools/mcp-server/src/tools/execute-action.ts with
 * esbuild (zod, used only for the input schema, is stubbed; everything else
 * is the MCP's own code), registers the tool against an in-process server,
 * and runs it against a scripted client. probeEngine compares each run with
 * `mcpExecuteAction` and with the frontend, which never offers an action
 * whose record has not loaded. The control cases serve the row, so a probe
 * that cannot reach the RPC fails too.
 */
const EA_SRC = 'tools/mcp-server/src/tools/execute-action.ts';
const PROBE_TABLE = 'probe_items';
const PROBE = {
  entities: [{ table_name: PROBE_TABLE, display_name: 'Probe items' }],
  props: [
    { table_name: PROBE_TABLE, column_name: 'id', type: 'IntegerNumber', is_identity: true },
    { table_name: PROBE_TABLE, column_name: 'status', type: 'TextShort' },
  ],
  actions: [{
    table_name: PROBE_TABLE, action_name: 'approve', display_name: 'Approve', can_execute: true, show_on_detail: true,
    visibility_condition: { field: 'status', operator: 'eq', value: 'open' }, enabled_condition: null, parameters: [], rpc_function: 'approve_probe_item',
  }],
};
const PROBE_CASES = [
  ['record fetch fails', { error: { message: 'permission denied for table probe_items', httpCode: 403, code: '42501' } }],
  ['record fetch finds no row', { rows: [] }],
  ['row served, condition holds (control)', { rows: [{ id: 1, status: 'open' }] }],
  ['row served, condition fails (control)', { rows: [{ id: 1, status: 'closed' }] }],
];
let probeRuns = null;
async function probeExecuteAction() {
  const src = path.join(ROOT, EA_SRC);
  const srcText = fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '';
  const zodNames = [...new Set([...srcText.matchAll(/\bz\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]))].sort();
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error('esbuild not found: run npm ci in the repository root (the ledger bundles execute-action.ts for the C-05 probe)');
  }
  const out = path.join(os.tmpdir(), `ledger-execute-action-${process.pid}.mjs`);
  const stub = {
    name: 'ledger-probe-stubs',
    setup(build) {
      build.onResolve({ filter: /^zod$/ }, a => ({ path: a.path, namespace: 'ledger-stub' }));
      // The MCP server imports EntityPropertyType from the core; resolve it to the core source.
      build.onResolve({ filter: /^@civic-os\/core$/ }, () => ({ path: path.join(ROOT, 'packages/core/src/index.ts') }));
      build.onResolve({ filter: /^[^./]/ }, a => ({ errors: [{ text: `the C-05 probe has no stub for the runtime import "${a.path}"` }] }));
      build.onLoad({ filter: /.*/, namespace: 'ledger-stub' }, () => ({
        loader: 'js',
        contents: `const c = new Proxy(function () {}, { get: () => c, apply: () => c });\n${zodNames.map(n => `export const ${n} = c;`).join('\n')}\nexport default c;\n`,
      }));
    },
  };
  try {
    await esbuild.build({
      stdin: { contents: `export { registerExecuteAction } from './tools/execute-action.ts';\nexport { PostgRESTRequestError } from './postgrest-client.ts';\nexport { EntityPropertyType } from '@civic-os/core';\n`, resolveDir: path.join(ROOT, 'tools/mcp-server/src'), loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', plugins: [stub],
    });
    const mod = await import(pathToFileURL(out).href);
    const runs = [];
    for (const [kase, spec] of PROBE_CASES) {
      const requests = [];
      let handler = null;
      const server = { registerTool: (name, _config, h) => { if (name === 'execute_action') handler = h; } };
      const client = {
        get: async (table, params) => {
          requests.push({ method: 'GET', path: table, decoded: Object.entries(params).map(([k, v]) => `${k}=${v}`), headers: {} });
          if (spec.error) throw new mod.PostgRESTRequestError(spec.error.message, spec.error.httpCode, spec.error.code);
          return { data: spec.rows };
        },
        post: async (p, body) => {
          requests.push({ method: 'POST', path: p, decoded: [], headers: {}, body });
          return { data: { message: 'probe RPC called' } };
        },
      };
      const cache = {
        ensureFreshForUser: async () => {},
        getPropertiesForUser: (_key, table) => PROBE.props.filter(p => p.table_name === table).map(p => ({ ...p, type: mod.EntityPropertyType[p.type] })),
        constraintMessages: [],
      };
      const resolver = {
        resolveEntity: name => resolveEntity(PROBE.entities, name),
        resolveAction: (table, name) => resolveAction(PROBE.actions.filter(a => a.table_name === table), table, name),
      };
      try {
        mod.registerExecuteAction(server, client, cache, resolver);
        if (!handler) throw new Error('registerExecuteAction did not register execute_action');
        const result = await handler({ entity: PROBE_TABLE, id: 1, action: 'approve' });
        runs.push({ kase, spec, isError: result?.isError === true, text: result?.content?.[0]?.text ?? null, requests });
      } catch (e) {
        runs.push({ kase, spec, failure: `threw ${e?.name ?? 'error'}: ${e?.message ?? e}`, requests });
      }
    }
    return runs;
  } catch (e) {
    return [{ kase: 'bundle', failure: `could not bundle or load ${EA_SRC}: ${String(e?.message ?? e).split('\n')[0]}` }];
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Compare the probe runs with the MCP model and the frontend (C-05). */
function executeActionProbeEngine() {
  const S = { entities: PROBE.entities, props: t => PROBE.props.filter(p => p.table_name === t), actions: PROBE.actions };
  const action = PROBE.actions[0];
  const seen = [];
  for (const run of probeRuns ?? [{ kase: 'not run', failure: 'probeExecuteAction did not run' }]) {
    count('action-probe');
    const inst = { example: '_shared', entity: 'execute_action probe', subject: run.kase };
    if (run.failure) { miss('mcp-model', { ...inst, detail: run.failure }); continue; }
    const record = run.spec.rows?.[0];
    const model = mcpExecuteAction(action, record, S, run.spec.error ?? null);
    const rpcCalled = run.requests.some(r => r.method === 'POST');
    const modelRpc = model.requests.some(r => r.method === 'POST');
    const outcome = rpcCalled && !run.isError ? 'executed' : run.isError ? 'refused' : 'other';
    if (!same(canon(run.requests), canon(model.requests)) || (model.text ?? null) !== (run.isError ? run.text : null) || rpcCalled !== modelRpc) {
      miss('mcp-model', { ...inst, detail: `observed ${outcome}${rpcCalled ? ' (RPC called)' : ''}: ${JSON.stringify(run.text)} | model ${model.outcome}: ${JSON.stringify(model.text ?? null)}` });
      continue;
    }
    // The frontend evaluates the same condition against the record it loaded; with none loaded it offers no action.
    const feOffers = evaluate(action.visibility_condition, record ?? null) === true;
    if (rpcCalled !== feOffers) { miss('actions', { ...inst, detail: `MCP ${outcome}, the frontend ${feOffers ? 'offers' : 'does not offer'} the action: no open rule explains it` }); continue; }
    seen.push(`${run.kase}: ${model.outcome}${rpcCalled ? ' (RPC called)' : ' (no RPC)'}`);
  }
  note('C-05', `execute_action probe (the real ${EA_SRC}, bundled and run in-process against a scripted client; the goldens never reach this path): ${seen.join('; ')}.`);
}

function feSyntheticEngine() {
  if (!feSynthetic) return;
  const rows = feSynthetic.schema_properties;
  const fe = readJson(path.join(FE, '_synthetic/all/schema.properties.json')).entities;
  for (const [table, list] of Object.entries(fe)) {
    for (const e of list) {
      count('fe-synthetic-model');
      if (e.type === 'ManyToMany') continue;
      const p = rows.find(r => r.table_name === table && r.column_name === e.column);
      const inst = { example: '_synthetic', entity: table, subject: e.column };
      if (!p) { miss('fe-model', { ...inst, detail: 'synthetic row not found' }); continue; }
      const feList = e.selectForList === '=' ? e.select : e.selectForList;
      if (e.type !== feType(p) || e.select !== feSelect(e.type, p) || feList !== feSelectForList(e.type, p)) {
        miss('fe-model', { ...inst, detail: `frontend ${e.type} ${e.select} | model ${feType(p)} ${feSelect(feType(p), p)}` });
      }
    }
  }
  const types = new Map();
  for (const [t, list] of Object.entries(fe)) for (const e of list) types.set(`${t}.${e.column}`, e.type);
  const virtual = readJson(path.join(FE, '_synthetic/all/schema.m2m.json')).virtualProperties ?? [];
  const views = readJson(path.join(FE, '_synthetic/all/schema.views.json')).entities;
  const ents = new Map(feSynthetic.schema_entities.map(e => [e.table_name, e]));
  for (const [table, v] of Object.entries(views)) {
    const props = [
      ...rows.filter(r => r.table_name === table).map(r => ({ ...r, type: types.get(`${table}.${r.column_name}`) })),
      ...virtual.filter(x => x.table_name === table).map(x => ({ ...x, type: 'ManyToMany' })),
    ];
    const model = feViews(props, ents.get(table));
    for (const view of ['list', 'detail', 'create', 'edit', 'filter']) {
      count('fe-synthetic-model');
      if (!same([...model[view]].sort(), [...v[view]].sort())) miss('fe-model', { example: '_synthetic', entity: table, subject: view, detail: `frontend ${v[view].join()} | model ${model[view].join()}` });
    }
  }
}

/**
 * Which type-detection branches no fixture property reaches on either side:
 * those are anchored by the transcriptions in ledger-models.mjs (and the
 * probes) only. Computed, so it shrinks as fixtures grow (P0.5's timestamp column).
 */
function transcriptionOnly() {
  const ALL_TYPES = ['Unknown', 'TextShort', 'TextLong', 'Boolean', 'Date', 'DateTime', 'DateTimeLocal', 'Money', 'IntegerNumber', 'DecimalNumber',
    'ForeignKeyName', 'User', 'GeoPoint', 'Color', 'Email', 'Telephone', 'TimeSlot', 'File', 'FileImage', 'FilePDF', 'Payment', 'Status',
    'Category', 'RecurringTimeSlot', 'PhotoGallery', 'GeoPolygon', 'Markdown'];
  const feSeen = new Set();
  const mcSeen = new Set();
  const udts = new Set();
  const geo = new Set();
  for (const ex of examples()) {
    for (const v of variants(ex)) {
      for (const p of readJson(path.join(RAW, ex, v, 'schema_properties.json'))) {
        feSeen.add(feType(p));
        mcSeen.add(mcpType(p));
        udts.add(p.udt_name);
        if (p.udt_name === 'geography') geo.add(p.geography_type);
      }
    }
  }
  // The frontend's synthetic variant reaches more frontend branches (not MCP ones: the MCP never sees those rows).
  for (const p of feSynthetic?.schema_properties ?? []) feSeen.add(feType(p));
  const probes = readJson(path.join(MCP, '_shared/mcp.type-probes.json'));
  const probeUdts = new Set(probes.probes.map(p => ({ ...probes.base, ...p.input }).udt_name));
  const probeGeo = new Set(probes.probes.map(p => ({ ...probes.base, ...p.input })).filter(p => p.udt_name === 'geography').map(p => String(p.geography_type)));
  return {
    frontendTypes: ALL_TYPES.filter(t => !feSeen.has(t)),
    mcpTypes: ALL_TYPES.filter(t => !mcSeen.has(t)),
    udts: [...probeUdts].filter(u => !udts.has(u)).sort(),
    geographyTypes: [...probeGeo].filter(g => !geo.has(g === 'null' ? null : g)).sort(),
  };
}

function probeEngine() {
  const art = readJson(path.join(MCP, '_shared/mcp.type-probes.json'));
  const declared = new Map();
  for (const rule of RULES) for (const [name, feT] of Object.entries(rule.probes ?? {})) declared.set(name, [rule.id, feT]);
  for (const p of art.probes) {
    count('type-probe');
    const prop = { ...art.base, ...p.input };
    const inst = { example: '_shared', entity: 'mcp.type-probes', subject: p.name };
    const feT = feType(prop);
    if (p.type !== mcpType(prop) || p.select !== mcpSelect(p.type, prop)) { miss('mcp-model', { ...inst, detail: `probe ${p.type} ${p.select} vs model ${mcpType(prop)} ${mcpSelect(mcpType(prop), prop)}` }); continue; }
    const dec = declared.get(p.name);
    if (dec && dec[1] !== feT) { miss('probes', { ...inst, detail: `${dec[0]} declares frontend ${dec[1]}, the frontend model gives ${feT}` }); continue; }
    if (feT === p.type) {
      if (dec) miss('probes', { ...inst, detail: `${dec[0]} names a probe on which both sides agree (${feT})` });
      continue;
    }
    const r = typeRule(prop, feT, p.type);
    if (!r || (dec && dec[0] !== r)) { miss('probes', { ...inst, detail: `frontend ${feT}, MCP ${p.type}: ${r ? `rule ${r}, catalogue says ${dec?.[0]}` : 'no rule'}` }); continue; }
    hit(r, { ...inst, detail: `MCP ${p.type} (select ${p.select}); frontend (model of schema.service.ts:633-692) ${feT}` });
  }
  for (const name of declared.keys()) if (!art.probes.some(p => p.name === name)) miss('probes', { example: '_shared', subject: name, detail: 'declared probe missing' });
}

function verifyEvidence() {
  const failures = [];
  for (const rule of RULES) {
    for (const chk of rule.checks ?? []) {
      const file = path.join(ROOT, chk.file);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      for (const s of chk.contains ?? []) {
        if (text === null || !text.includes(s)) failures.push(`${rule.id}: ${chk.file} does not contain ${JSON.stringify(s)}`);
      }
      // `absent`: code a fix removed; finding it again means the fix regressed.
      for (const s of chk.absent ?? []) {
        if (text === null) failures.push(`${rule.id}: ${chk.file} is missing`);
        else if (text.includes(s)) failures.push(`${rule.id}: ${chk.file} contains ${JSON.stringify(s)} again (removed by ${rule.fixedIn ?? 'the fix'})`);
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
  const entities = new Set();
  for (const [, e] of entries) {
    byExample[e.example] = (byExample[e.example] ?? 0) + 1;
    occurrences += e.occurrences;
    if (e.example === '_shared') synthetic++;
    else entities.add(`${e.example}|${e.entity}`);
  }
  const picked = [];
  const seen = new Set();
  for (const [, e] of entries) if (!seen.has(e.example) && picked.length < 3) { picked.push(e); seen.add(e.example); }
  for (const [, e] of entries) if (picked.length < 3 && !picked.includes(e)) picked.push(e);
  return {
    count: entries.length - synthetic,
    synthetic,
    entities: entities.size,
    occurrences,
    byExample,
    examples: picked.map(e => ({
      example: e.example, entity: e.entity, subject: e.subject, detail: e.detail,
      ...(e.variants.size ? { variants: [...e.variants].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b) || cmp(a, b)) } : {}),
    })),
  };
}

function build() {
  propertyEngine();
  feSyntheticEngine();
  esModelEngine();
  viewEngine();
  conditionEngine();
  actionEngine();
  executeActionProbeEngine();
  errorEngine();
  queryEngine();
  nameEngine();
  evidenceEngine();
  probeEngine();
  const evidenceFailures = verifyEvidence();
  const rows = RULES.map(rule => {
    const h = hits.get(rule.id) ?? Object.fromEntries(BUCKETS.map(b => [b, new Map()]));
    const { compute, checks, probes, ...rest } = rule;
    return {
      ...rest,
      instances: summarize(h.instances),
      ...(h.effects.size ? { effects: summarize(h.effects) } : {}),
      ...(h.harnessOnly.size ? { harnessOnly: summarize(h.harnessOnly) } : {}),
      ...(notes.has(rule.id) ? { computedNotes: notes.get(rule.id) } : {}),
      status: rule.status ?? 'open',
      // Rows changed on main list their live anchors (present / absent code) next to the history they replaced.
      ...(rule.status && rule.status !== 'open' ? { anchors: checks ?? [] } : {}),
      decision: rule.decision ?? null,
    };
  });
  return { rows, evidenceFailures };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const md = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const STATUS_LABEL = { open: 'open', 'fixed-on-main': 'fixed on main', 'partially-fixed-on-main': 'partially fixed on main', 'changed-on-main': 'changed on main' };
/** Inline code that may itself contain backticks. */
const code = t => (String(t).includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``);
/** A multi-line anchor is shown on one line (line breaks and their indentation become one space); the JSON copy keeps it exact. */
const oneLine = t => String(t).replace(/\s*\n\s*/g, ' ').trim();
const anchorLine = a => [
  ...(a.contains ?? []).map(t => `${code(a.file)} contains ${code(oneLine(t))}`),
  ...(a.absent ?? []).map(t => `${code(a.file)} no longer contains ${code(oneLine(t))}`),
].join('; ');
const exLine = e => `${e.example}${e.entity ? ` · ${e.entity}` : ''}${e.subject ? ` · ${e.subject}` : ''}${e.variants ? ` [${e.variants.join(', ')}]` : ''}: ${e.detail}`;

function renderMarkdown(doc) {
  const { rows, coverage, latentNondeterminism, remedy, frozen } = doc;
  const L = [];
  const byRec = {};
  for (const r of rows) byRec[r.recommendation] = (byRec[r.recommendation] ?? 0) + 1;
  L.push('# SDK divergence ledger');
  L.push('');
  L.push('> Generated by `node scripts/golden/ledger.mjs` from `tests/golden/derived/frontend/`, `tests/golden/derived/mcp/` and `tests/golden/raw/`. Do not edit by hand: change the rule catalogue (`scripts/golden/ledger-rules.mjs`), the reference models (`scripts/golden/ledger-models.mjs`) or the goldens and regenerate. Machine-readable copy: `tests/golden/ledger.json`.');
  L.push('');
  if (frozen) {
    L.push(`> **Frozen at ${frozen.gate}** (${frozen.date}, from the ledger generated at commit \`${frozen.commit}\`). The rows, instance counts and coverage below are the record the ${frozen.gate} decisions were made against; the engine no longer runs, because P1.3 changes the frontend goldens on purpose and P1.4 deletes the MCP code the rows cite. Regenerating only re-merges \`tests/golden/ledger-decisions.json\`. Resolution is proven by \`tests/golden/approved-diffs/1.3.json\` (each applied row's golden changes) and, after P1.4, by an empty diff between the frontend and MCP golden trees.`);
    L.push('');
  }
  L.push('## How to decide');
  L.push('');
  L.push('Each row is one rule on which the generic app (frontend) and the MCP server interpret the metadata contract differently, or a frontend quirk the golden outputs captured. Attribution is exact: a difference is counted for a row only when both golden values equal the reference models of the cited code and the row\'s transformation turns one into the other; any other difference fails the ledger run, so the rows account for every computed divergence. `scripts/golden/ledger-mutation-check.sh` proves this by mutating the MCP and the frontend code and requiring the run to fail.');
  L.push('');
  L.push('Counting: an instance is one distinct example / entity / subject (property, view entry, condition and record, payload, query case and aspect, action); `occurrences` counts it once per role variant. `synthetic` instances come from fixed input sets (the `_shared` matrices, payload sets and type probes) rather than from example metadata. `effects` are downstream differences a rule causes elsewhere (a select string that differs because the type differs). `harness-only` instances arise only from the golden harness\'s inputs, not from the real app. Rows with 0 instances in examples are latent: the evidence is the cited code plus synthetic inputs. The `.es` variants are excluded: the MCP never receives translated metadata (N-05).');
  L.push('');
  L.push('Daniel decides per row at gate 2. Recommendations:');
  L.push('');
  L.push('- `adopt-frontend`: the core implements the frontend behavior; the MCP output changes (an approved golden diff in P1.3).');
  L.push('- `adopt-mcp`: the MCP rule is strictly better; the core implements it and the frontend output changes as an approved golden diff in P1.3.');
  L.push('- `mcp-bug` / `frontend-bug`: the side named is wrong; fix it there (the core gets the correct behavior).');
  L.push('- `needs-decision`: a real trade-off; the row states the options.');
  L.push('');
  L.push('Record the decision in `tests/golden/ledger-decisions.json` (keyed by row id; the generator merges it into the `decision` field of `tests/golden/ledger.json`, which is never edited by hand); P1.3 turns every `adopt-mcp` decision and every fixed bug into an entry in `tests/golden/approved-diffs/`. Tie-order differences between the two trees are capture artifacts, not rows (see Coverage).');
  L.push('');
  L.push('## Summary');
  L.push('');
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  L.push(`${rows.length} rows: ${Object.entries(byRec).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => `${v} \`${k}\``).join(', ')}.`);
  L.push('');
  L.push(`Status: ${Object.entries(byStatus).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => `${v} ${STATUS_LABEL[k] ?? k}`).join(', ')}. A row fixed on main keeps its id, recommendation and history; its anchors check that the fix is present and the removed code is gone, and its instances count what still differs (0 when fully fixed).`);
  L.push('');
  L.push('| ID | Area | Rule | Recommendation | Decision | Status | Instances |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const i = r.instances;
    const parts = i.count ? [`${i.count}`] : r.latent && r.status === 'open' ? ['0 (latent)'] : [];
    if (i.synthetic) parts.push(`${parts.length ? '+' : ''}${i.synthetic} synthetic`);
    if (!parts.length) parts.push('0');
    if (r.effects) parts.push(`+${r.effects.count + r.effects.synthetic} effects`);
    if (r.harnessOnly) parts.push(`+${r.harnessOnly.count} harness-only`);
    L.push(`| [${r.id}](#${r.id.toLowerCase()}) | ${md(r.area)} | ${md(r.rule)} | \`${r.recommendation}\` | ${r.decision ? `\`${r.decision.decision}\`` : ''} | ${STATUS_LABEL[r.status] ?? r.status}${r.fixedIn ? ` (\`${r.fixedIn}\`)` : ''} | ${parts.join(', ')} |`);
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
      if (r.status !== 'open') {
        L.push(`- Status: ${STATUS_LABEL[r.status] ?? r.status} in \`${r.fixedIn}\`. ${r.fix}`);
        L.push(`- Anchors: ${r.anchors.map(anchorLine).join('; ')}`);
      }
      L.push(`- Frontend: ${r.frontend}`);
      L.push(`- MCP: ${r.mcp}`);
      L.push(`- Evidence: ${r.evidence.map(e => `\`${e}\``).join(', ')}`);
      if (r.unit) L.push(`- Unit: ${r.unit}`);
      const i = r.instances;
      const head = i.count ? `${i.count} in examples (${i.entities} entities)` : r.status !== 'open' && !i.synthetic ? `0 remaining${r.latent ? ` (latent: ${r.latent})` : ''}` : r.latent ? `0 in examples (latent: ${r.latent})` : 'inputs are synthetic by construction';
      const synth = i.synthetic ? `; ${i.synthetic} synthetic` : '';
      if (i.count || i.synthetic) {
        L.push(`- Instances: ${head}${synth}; ${i.occurrences} occurrences; by example: ${Object.entries(i.byExample).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        for (const e of i.examples) L.push(`  - ${exLine(e)}`);
      } else {
        L.push(`- Instances: ${head}`);
      }
      for (const n of r.computedNotes ?? []) L.push(`- Computed: ${n}`);
      if (r.effects) {
        L.push(`- Effects: ${r.effects.count + r.effects.synthetic} downstream differences (${r.effects.occurrences} occurrences); by example: ${Object.entries(r.effects.byExample).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        for (const e of r.effects.examples) L.push(`  - ${exLine(e)}`);
      }
      if (r.harnessOnly) {
        L.push(`- Harness-only: ${r.harnessOnly.count} (not produced by the real app); by example: ${Object.entries(r.harnessOnly.byExample).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        for (const e of r.harnessOnly.examples) L.push(`  - ${exLine(e)}`);
      }
      L.push(`- If the frontend behavior is adopted: ${r.impact.adoptFrontend}`);
      L.push(`- If the MCP behavior is adopted: ${r.impact.adoptMcp}`);
      L.push(`- Recommendation: \`${r.recommendation}\`. ${r.reason}`);
      if (r.decision) L.push(`- Decision: \`${r.decision.decision}\` (${r.decision.by}, ${r.decision.date}). ${r.decision.detail}`);
      // History: a past-tense summary, then the row as the last ledger before the fix stated it (verbatim).
      for (const h of r.history ?? []) {
        L.push(`- History (before \`${h.before}\`): ${h.summary}`);
        L.push(`  - Row text before the fix (verbatim):`);
        L.push(`    - Rule: ${h.rule}`);
        L.push(`    - Frontend: ${h.frontend}`);
        L.push(`    - MCP: ${h.mcp}`);
        L.push(`    - Evidence: ${h.evidence.map(e => `\`${e}\``).join(', ')}`);
        if (h.unit) L.push(`    - Unit: ${h.unit}`);
        if (h.latent) L.push(`    - Latent: ${h.latent}`);
        L.push(`    - Anchors (history, not checked): ${h.anchors.length ? h.anchors.map(anchorLine).join('; ') : 'none'}`);
        L.push(`    - Recommendation: \`${h.recommendation}\`. ${h.reason}`);
        L.push(`  - Instances before the fix: ${h.instances}`);
      }
    }
  }
  L.push('');
  L.push('## Latent nondeterminism');
  L.push('');
  L.push(NONDETERMINISM.intro);
  for (const item of latentNondeterminism) {
    L.push('');
    L.push(`### ${item.title}`);
    L.push('');
    L.push(`- Evidence: ${item.evidence}`);
    L.push(`- Computed: ${item.computed.summary}`);
    for (const ex of item.computed.examples) L.push(`  - ${ex}`);
    L.push(`- User-visible effect: ${item.effect}`);
  }
  L.push('');
  L.push(`Suggested remedy (for Daniel to decide, not implemented): ${remedy}`);
  L.push('');
  L.push('## Coverage');
  L.push('');
  L.push(`Comparisons made: ${Object.entries(coverage.comparisons).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => `${k} ${v}`).join(', ')}. Unattributed differences: ${coverage.unattributed}.`);
  L.push('');
  const tx = coverage.transcriptionOnly;
  L.push(`Type detection anchored by transcription only (no raw fixture property, and on the frontend side no row of the frontend's \`_synthetic\` golden variant, reaches the branch; the type probes and the transcriptions in \`ledger-models.mjs\` are the only evidence): frontend result types ${tx.frontendTypes.join(', ') || 'none'}; MCP result types ${tx.mcpTypes.join(', ') || 'none'}; udt values in no raw fixture ${tx.udts.join(', ') || 'none'} (float4 / float8 share the numeric branch on both sides, jsonb / citext the Unknown or FK fallback; the frontend synthetic variant covers some of these on the frontend side only); geography types ${tx.geographyTypes.join(', ') || 'none'}.`);
  L.push('');
  L.push(`Not rows: ${coverage.tieOrderArtifacts} view-order differences confined to \`sort_order\` ties (capture artifacts); ${coverage.bothReject} frontend queries that name a column the entity lacks, which both sides reject (PostgREST on the frontend side, name resolution on the MCP side); ${coverage.mappingArtifacts} select difference caused by a hand-written embed in a frontend matrix input.`);
  L.push('');
  L.push('Harness limits: the MCP golden stub answers every data request with an empty result (or the record under test) and cannot reject a select, so an embed PostgREST would refuse (for example a FK hint through a metadata view, S-02) is not proven to work by these goldens; the request-equivalence harness (P0.4) covers live behavior.');
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

/** The engine's document (everything except decisions), or exit 2 when attribution or evidence fails. */
async function computeDoc() {
  feSynthetic = await loadFeSynthetic();
  probeRuns = await probeExecuteAction();
  const { rows, evidenceFailures } = build();
  let failed = false;
  if (unattributed.length) {
    console.error(`${unattributed.length} unattributed difference(s):`);
    const byArea = {};
    for (const u of unattributed) (byArea[u.area] ??= []).push(u);
    for (const [area, list] of Object.entries(byArea)) {
      console.error(`  ${area}: ${list.length}`);
      for (const u of list.slice(0, 15)) console.error(`    ${[u.example, u.variant, u.entity, u.subject].filter(Boolean).join(' · ')}: ${String(u.detail).slice(0, 400)}`);
    }
    failed = true;
  }
  if (evidenceFailures.length) {
    console.error('evidence checks failed:');
    for (const f of evidenceFailures) console.error(`  ${f}`);
    failed = true;
  }
  if (failed) process.exit(2);
  return {
    generatedBy: 'scripts/golden/ledger.mjs',
    inputs: { frontend: rel(FE), mcp: rel(MCP), raw: rel(RAW) },
    rows,
    latentNondeterminism: nondeterminismJson(),
    remedy: NONDETERMINISM.remedy,
    coverage: {
      comparisons: diagnostics.comparisons, unattributed: unattributed.length, tieOrderArtifacts: diagnostics.tieOrderArtifacts,
      bothReject: diagnostics.bothReject, mappingArtifacts: diagnostics.mappingArtifacts,
      transcriptionOnly: transcriptionOnly(),
    },
  };
}

async function main() {
  const check = process.argv.includes('--check');
  const freezeAt = process.argv.find(a => a.startsWith('--freeze='))?.slice('--freeze='.length);
  if (freezeAt !== undefined && !/^[0-9a-f]{40}$/.test(freezeAt)) { console.error('--freeze needs a full 40-character commit sha'); process.exit(2); }
  const committed = fs.existsSync(OUT_JSON) ? readJson(OUT_JSON) : null;
  let decisions;
  try { decisions = loadDecisions(DECISIONS); } catch (e) { console.error(e.message); process.exit(2); }
  const problems = validateDecisions(decisions);
  let base;
  if (committed?.frozen && freezeAt === undefined) {
    base = { ...committed, rows: committed.rows.map(r => ({ ...r, decision: null })) };
  } else {
    base = await computeDoc();
    if (freezeAt !== undefined) {
      const { rows: merged } = mergeDecisions(base.rows, decisions);
      const current = { ...base, rows: merged };
      if (!committed || stable(current) !== stable({ ...committed, frozen: undefined }) || fs.readFileSync(OUT_MD, 'utf8') !== renderMarkdown(current)) {
        console.error('the committed ledger is stale; regenerate it (node scripts/golden/ledger.mjs) before freezing');
        process.exit(2);
      }
      base.frozen = { gate: 'Gate 2', date: new Date().toISOString().slice(0, 10), commit: freezeAt };
    }
  }
  const { rows, unknown, undecided } = mergeDecisions(base.rows, decisions);
  const doc = { ...base, rows };
  const json = stable(doc);
  const text = renderMarkdown(doc);
  let failed = false;
  if (unknown.length) {
    console.error(`${rel(DECISIONS)} names ${unknown.length} row id(s) that are not in the ledger: ${unknown.join(', ')}`);
    failed = true;
  }
  if (problems.length) {
    console.error(`${rel(DECISIONS)} is malformed:`);
    for (const p of problems) console.error(`  ${p}`);
    failed = true;
  }
  if (failed) process.exit(2);
  if (undecided.length) console.warn(`warning: ${undecided.length} ledger row(s) have no decision: ${undecided.join(', ')}`);
  const mode = doc.frozen ? ` (frozen at ${doc.frozen.gate})` : '';
  if (check) {
    const stale = [];
    if (!fs.existsSync(OUT_JSON) || fs.readFileSync(OUT_JSON, 'utf8') !== json) stale.push(rel(OUT_JSON));
    if (!fs.existsSync(OUT_MD) || fs.readFileSync(OUT_MD, 'utf8') !== text) stale.push(rel(OUT_MD));
    if (stale.length) {
      console.error(`stale ledger (run node scripts/golden/ledger.mjs): ${stale.join(', ')}`);
      process.exit(1);
    }
    console.log(`ledger up to date${mode}: ${rows.length} rows`);
    return;
  }
  fs.writeFileSync(OUT_JSON, json);
  fs.writeFileSync(OUT_MD, text);
  console.log(`wrote ${rel(OUT_MD)} and ${rel(OUT_JSON)}${mode}: ${rows.length} rows`);
}

await main();
