/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs (MCP): the execute_action condition evaluator.
 *  - _example/conditions.actions.json and _shared/conditions.matrix.json:
 *    evaluateCondition over EXACTLY the condition / record inputs of the
 *    frontend artifacts of the same name (records are recovered from the
 *    frontend's result labels), so results can be compared key by key.
 *  - _example/mcp.conditions-describe.json (MCP-only): describeConditionFailure
 *    text for every input the evaluator rejects.
 *  - _example/mcp.actions-execute.json (MCP-only): every conditional action run
 *    end to end through the real execute_action and get_record tools against a
 *    record shaped the way the MCP actually fetches it (its own
 *    buildSelectString embeds), once satisfying all conditions and once
 *    violating each condition kind. This is the production consequence of the
 *    evaluator's missing `.id` extraction on FK-embedded objects.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionCondition, SchemaEntityAction, SchemaProperty } from '../../interfaces.js';
import { describeConditionFailure, evaluateCondition } from '../../tools/execute-action.js';
import { propertyToSelectString } from '../../select-builder.js';
import {
  adminVariant, checkGolden, compactStringify, expectNoOrphans, listExamples, loadFrontendArtifact, parseLabel,
} from './golden-io.js';
import { BASE, bootMcp, bootVariant, callTool, makeServer, restoreFetch, routesFrom, type CapturedRequest, type McpContext } from './mcp-harness.js';
import { EntityPropertyType } from '@civic-os/core';

afterEach(() => restoreFetch());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

const THROWS = (e: unknown) => `__throws:${(e as Error)?.name ?? 'Error'}__`;

function safeEval(cond: unknown, rec: unknown): boolean | string {
  try {
    return evaluateCondition(cond as ActionCondition, rec as Record<string, unknown>);
  } catch (e) {
    return THROWS(e);
  }
}

function safeDescribe(cond: unknown, rec: unknown): string {
  try {
    return describeConditionFailure(cond as ActionCondition, rec as Record<string, unknown>);
  } catch (e) {
    return THROWS(e);
  }
}

/** Frontend result label -> record (the frontend writes `<null data>` / `<undefined data>` for the non-object cases). */
function recordFromLabel(label: string): Rec {
  if (label === '<null data>') return null;
  if (label === '<undefined data>') return undefined;
  return parseLabel(label);
}

// ---------------------------------------------------------------------------
// Satisfying / violating records in the MCP's own fetch shape
// ---------------------------------------------------------------------------

function leaves(c: Rec): Rec[] {
  if (!c) return [];
  if (Array.isArray(c.or)) return c.or.flatMap(leaves);
  if (Array.isArray(c.and)) return c.and.flatMap(leaves);
  return [c];
}

function other(v: unknown): unknown {
  if (typeof v === 'number') return v + 1000;
  if (typeof v === 'string') return `${v}_other`;
  if (typeof v === 'boolean') return !v;
  return 'other';
}

/** A database value for which the leaf holds (want=true) or fails (want=false). */
function dbValue(leaf: Rec, want: boolean): unknown {
  const v = leaf.value;
  switch (leaf.operator) {
    case 'eq': return want ? v : other(v);
    case 'ne': return want ? other(v) : v;
    case 'in': return want ? (Array.isArray(v) ? v[0] : v) : other(Array.isArray(v) ? v[0] : v);
    case 'is_null': return want ? null : 1;
    case 'is_not_null': return want ? 1 : null;
    case 'gt': return typeof v === 'number' ? (want ? v + 1 : v) : v;
    case 'gte': return typeof v === 'number' ? (want ? v : v - 1) : v;
    case 'lt': return typeof v === 'number' ? (want ? v - 1 : v) : v;
    case 'lte': return typeof v === 'number' ? (want ? v : v + 1) : v;
    default: return v;
  }
}

/** Top-level field list inside the outermost parentheses of an embed select, or null for a scalar select. */
function embedFields(select: string): string[] | null {
  const open = select.indexOf('(');
  if (open < 0 || !select.endsWith(')')) return null;
  const inner = select.slice(open + 1, -1);
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(f => f.replace(/\(.*$/, '').replace(/^[^:]*:/, '').replace(/!.*$/, ''));
}

/**
 * Apply one leaf's database value to a record the way PostgREST would return
 * it for the MCP's select: an embedded FK column comes back as an object (or
 * null), a scalar column as the value, a field that is not a column of the
 * entity is not returned at all.
 */
function applyLeaf(rec: Rec, leaf: Rec, want: boolean, props: SchemaProperty[]): string {
  const parts = String(leaf.field).split('.');
  const root = parts[0];
  const prop = props.find(p => p.column_name === root);
  if (!prop) return 'absent';
  const select = propertyToSelectString(prop);
  const fields = embedFields(select);
  const value = dbValue(leaf, want);
  if (!fields) {
    rec[root] = parts.length === 1 ? value : value;
    return parts.length === 1 ? 'scalar' : 'scalar-dotted';
  }
  if (parts.length === 1) {
    // The FK column itself holds `value`; the embed is null when the FK is null.
    rec[root] = value === null ? null
      : { ...Object.fromEntries(fields.map(f => [f, f === 'display_name' ? 'N' : null])), id: value };
    return 'embed';
  }
  const base = rec[root] && typeof rec[root] === 'object'
    ? rec[root]
    : Object.fromEntries(fields.map(f => [f, f === 'id' ? 1 : f === 'display_name' ? 'N' : null]));
  let cur = base;
  for (const key of parts.slice(1, -1)) cur = (cur[key] ??= {});
  cur[parts[parts.length - 1]] = value;
  rec[root] = base;
  return fields.includes(parts[1]) ? 'embed-dotted' : 'embed-dotted-unselected';
}

/** Record for which `cond` holds (want=true) or fails (want=false); OR satisfies via its first branch. */
function shapeRecord(rec: Rec, cond: Rec, want: boolean, props: SchemaProperty[], roots: Record<string, string>): void {
  if (Array.isArray(cond?.or)) {
    if (want) shapeRecord(rec, cond.or[0], true, props, roots);
    else for (const c of cond.or) shapeRecord(rec, c, false, props, roots);
    return;
  }
  if (Array.isArray(cond?.and)) {
    cond.and.forEach((c: Rec, i: number) => shapeRecord(rec, c, want || i > 0, props, roots));
    return;
  }
  roots[cond.field] = applyLeaf(rec, cond, want, props);
}

function classify(outcome: { toolError?: string; thrown?: string; invalidInput?: string[] }): string {
  const t = outcome.toolError ?? outcome.thrown ?? '';
  if (outcome.invalidInput) return 'invalid-input';
  if (!t) return 'executed';
  if (t.includes('is not available for this record')) return 'not-available';
  if (t.includes('is disabled')) return 'disabled';
  if (t.startsWith('Missing required parameter')) return 'passed-conditions (missing required parameter)';
  if (t.startsWith('You do not have permission')) return 'no-permission';
  return `other: ${t}`;
}

function getRecordListing(text: string | undefined, action: SchemaEntityAction): string {
  if (text === undefined) return 'error';
  const line = text.split('\n').find(l => l.includes(`(\`${action.action_name}\`)`));
  if (!line) return 'hidden';
  return line.includes('*(disabled:') ? 'listed-disabled' : 'listed';
}

/**
 * Stub routes for one action run, matched exactly: the action's RPC (POST),
 * the entity's row (GET on the table path), the notes teaser (GET
 * entity_notes). Anything else answers 404, so a renamed RPC or path shows up
 * in the golden instead of being served.
 */
async function runAction(ctx: McpContext, server: ReturnType<typeof makeServer>, action: SchemaEntityAction, record: Rec) {
  const rpcUrl = `<PGRST>/rpc/${action.rpc_function}`;
  ctx.backend.responder = (req: CapturedRequest) => {
    const pathname = decodeURIComponent(new URL(req.url.replace('<PGRST>', BASE)).pathname);
    if (req.method === 'POST' && req.url === rpcUrl) return { status: 200, body: { success: true, message: 'ok' } };
    if (req.method === 'GET' && pathname === `/${action.table_name}`) return { status: 200, body: [structuredClone(record)] };
    if (req.method === 'GET' && pathname === '/entity_notes') return { status: 200, body: [], headers: { 'Content-Range': '*/0' } };
    return { status: 404, body: { code: 'PGRST205', message: `unexpected request ${req.method} ${req.url}`, details: null, hint: null } };
  };
  const exec = await callTool(ctx, server, 'execute_action', { entity: action.table_name, id: 1, action: action.action_name });
  const get = await callTool(ctx, server, 'get_record', { entity: action.table_name, id: 1 }, { keepText: true });
  return {
    executeAction: classify(exec),
    ...(exec.toolError && classify(exec) !== 'passed-conditions (missing required parameter)' ? { executeActionText: exec.toolError } : {}),
    rpcCalled: exec.requests.some(r => r.method === 'POST'),
    getRecordListing: getRecordListing(get.toolError ? undefined : get.text, action),
    executeRequests: exec.requests,
    getRecordRequests: get.requests,
  };
}

async function actionsArtifact(ctx: McpContext) {
  const server = makeServer(ctx);
  const out: Record<string, unknown> = {};
  const selects: Record<string, string> = {};
  for (const action of ctx.cache.actions) {
    const kinds = (['visibility_condition', 'enabled_condition'] as const).filter(k => action[k]);
    if (!kinds.length) continue;
    const props = ctx.cache.getProperties(action.table_name);
    const roots: Record<string, string> = {};
    const satisfyAll: Rec = {};
    for (const k of kinds) shapeRecord(satisfyAll, action[k], true, props, roots);
    const cases: Record<string, unknown> = {};
    cases['satisfies all conditions'] = { record: satisfyAll, ...(await runAction(ctx, server, action, satisfyAll)) };
    for (const k of kinds) {
      const rec: Rec = {};
      for (const other of kinds) if (other !== k) shapeRecord(rec, action[other], true, props, {});
      shapeRecord(rec, action[k], false, props, {});
      cases[`violates ${k}`] = { record: rec, ...(await runAction(ctx, server, action, rec)) };
    }
    // The select the condition-check fetch uses (same for every action of the table).
    const fetch = (cases['satisfies all conditions'] as { executeRequests: CapturedRequest[] }).executeRequests.find(r => r.method === 'GET');
    if (fetch) selects[action.table_name] = fetch.decoded.find(d => d.startsWith('select='))?.slice(7) ?? '<none>';
    out[`${action.table_name}.${action.action_name}`] = {
      conditions: Object.fromEntries(kinds.map(k => [k, action[k]])),
      leafShapes: roots,
      canExecute: action.can_execute,
      showOnDetail: action.show_on_detail,
      cases,
    };
  }
  return { conditionFetchSelect: selects, actions: out };
}

const synProp = (column: string, sort: number, extra: Record<string, unknown>) => ({
  table_name: 'tasks', column_name: column, display_name: column, description: null, sort_order: sort,
  data_type: 'character varying', udt_name: 'varchar', udt_schema: 'pg_catalog',
  join_schema: null, join_table: null, join_column: null, geography_type: null,
  is_nullable: true, is_updatable: true, is_identity: false, is_generated: false, is_self_referencing: false,
  column_default: null, show_on_list: true, show_on_create: true, show_on_edit: true, show_on_detail: true,
  sortable: true, filterable: false, validation_rules: [], ...extra,
});
const synAction = (id: number, name: string, rpc: string, extra: Record<string, unknown>) => ({
  id, table_name: 'tasks', action_name: name, display_name: name[0].toUpperCase() + name.slice(1), description: null, rpc_function: rpc,
  icon: null, button_style: 'primary', sort_order: id, requires_confirmation: false, confirmation_message: null,
  visibility_condition: null, enabled_condition: null, disabled_tooltip: null, default_success_message: null, default_navigate_to: null,
  refresh_after_action: true, show_on_detail: true, can_execute: true, parameters: [], ...extra,
});
/** Synthetic schema: an entity without timestamp columns, with notes, a Status FK and a User FK. */
const SYN = {
  entities: [{ table_name: 'tasks', display_name: 'Tasks', description: null, sort_order: 1, insert: true, select: true, update: true, delete: true, enable_notes: true }],
  properties: [
    synProp('id', 1, { data_type: 'integer', udt_name: 'int4', is_identity: true, is_updatable: false }),
    synProp('display_name', 2, {}),
    synProp('status_id', 3, { data_type: 'integer', udt_name: 'int4', join_schema: 'metadata', join_table: 'statuses', join_column: 'id', status_entity_type: 'task' }),
    synProp('owner', 4, { data_type: 'uuid', udt_name: 'uuid', join_schema: 'metadata', join_table: 'civic_os_users', join_column: 'id' }),
  ],
  actions: [
    synAction(1, 'start', 'start_task', {
      visibility_condition: { field: 'status_id', operator: 'ne', value: 3 },
      enabled_condition: { field: 'status_id.status_key', operator: 'eq', value: 'open' },
    }),
    synAction(2, 'assign', 'assign_task', {
      visibility_condition: { or: [{ field: 'owner', operator: 'is_null' }, { field: 'display_name', operator: 'eq', value: 'x' }] },
      disabled_tooltip: 'Only unassigned tasks',
      parameters: [{ id: 1, param_name: 'p_owner', display_name: 'Owner', param_type: 'user', required: true, sort_order: 1 }],
    }),
    synAction(3, 'close', 'close_task', { enabled_condition: { and: [{ field: 'status_id', operator: 'in', value: [1, 2] }, { field: 'display_name', operator: 'is_not_null' }] }, disabled_tooltip: 'Open or started tasks only' }),
  ],
  statuses: [
    { id: 1, entity_type: 'task', display_name: 'Open', status_key: 'open', sort_order: 1, color: null, is_initial: true, is_terminal: false },
    { id: 2, entity_type: 'task', display_name: 'Started', status_key: 'started', sort_order: 2, color: null, is_initial: false, is_terminal: false },
    { id: 3, entity_type: 'task', display_name: 'Done', status_key: 'done', sort_order: 3, color: null, is_initial: false, is_terminal: true },
  ],
};

describe('golden (mcp): condition evaluator', () => {
  for (const example of listExamples()) {
    it(`${example}: action conditions over the frontend's records`, () => {
      const fe = loadFrontendArtifact(`${example}/_example/conditions.actions.json`);
      const conditions = fe.conditions.map((c: Rec) => {
        const results: Record<string, boolean | string> = {};
        for (const label of Object.keys(c.results)) results[label] = safeEval(c.condition, recordFromLabel(label));
        return { condition: c.condition, usedBy: c.usedBy, results };
      });
      checkGolden(`${example}/_example/conditions.actions.json`, { conditions });

      const describeOut = fe.conditions.map((c: Rec) => {
        const failures: Record<string, string> = {};
        for (const label of Object.keys(c.results)) {
          const rec = recordFromLabel(label);
          if (safeEval(c.condition, rec) !== true) failures[label] = safeDescribe(c.condition, rec);
        }
        return { condition: c.condition, usedBy: c.usedBy, failures };
      });
      checkGolden(`${example}/_example/mcp.conditions-describe.json`, { conditions: describeOut });
    });

    it(`${example}: conditional actions end to end in the MCP fetch shape`, async () => {
      const ctx = await bootVariant(adminVariant(example));
      checkGolden(`${example}/_example/mcp.actions-execute.json`, await actionsArtifact(ctx));
    });
  }

  it('conditional actions on a synthetic entity without timestamp columns', async () => {
    // The examples' conditional actions all sit on entities that have created_at / updated_at,
    // so a change to which columns the condition fetch selects could hide behind the select's
    // de-duplication; this entity has neither (and enables notes, and has a required parameter).
    const ctx = await bootMcp(routesFrom({
      'schema_entities?order=sort_order.asc,display_name.asc': SYN.entities,
      'schema_properties?order=table_name.asc,sort_order.asc': SYN.properties,
      'schema_entity_actions?order=table_name.asc,sort_order.asc': SYN.actions,
      'statuses?order=entity_type.asc,sort_order.asc,display_name.asc': SYN.statuses,
      'categories?order=entity_type.asc,sort_order.asc,display_name.asc': [],
      'status_transitions': { __status: 404, __body: { code: '42P01', message: 'relation does not exist' } },
      'constraint_messages': [],
      'schema_cache_versions': [{ cache_name: 'entities', version: '1' }, { cache_name: 'properties', version: '1' }],
    }));
    const syntheticTypes = Object.fromEntries(ctx.cache.properties.map(p => [`${p.table_name}.${p.column_name}`, EntityPropertyType[p.type ?? 0]]));
    checkGolden('_shared/mcp.actions-execute.json', { synthetic: SYN, syntheticTypes, ...(await actionsArtifact(ctx)) });
  });

  it('operator x value x data matrix, dot paths and compounds (frontend inputs)', () => {
    const fe = loadFrontendArtifact('_shared/conditions.matrix.json');
    const matrix: Record<string, Record<string, boolean | string>> = {};
    for (const [key, row] of Object.entries(fe.matrix as Record<string, Record<string, boolean>>)) {
      const sp = key.indexOf(' ');
      const opLabel = key.slice(0, sp);
      const op = opLabel === '<empty>' ? '' : opLabel;
      const cv = parseLabel(key.slice(sp + 1));
      const out: Record<string, boolean | string> = {};
      for (const dataLabel of Object.keys(row)) {
        const rec = dataLabel === '<missing>' ? {} : { f: parseLabel(dataLabel) };
        out[dataLabel] = safeEval({ field: 'f', operator: op, value: cv }, rec);
      }
      matrix[key] = out;
    }
    const dotted: Record<string, boolean | string> = {};
    for (const key of Object.keys(fe.dotted)) {
      const at = key.indexOf(' @ ');
      dotted[key] = safeEval({ field: key.slice(0, at), operator: 'eq', value: 1 }, parseLabel(key.slice(at + 3)));
    }
    // Same literal inputs as the frontend spec's `compound` block; the key set is checked against the frontend artifact.
    const compound: Record<string, boolean | string> = {
      or: safeEval({ or: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 2 }] }, { a: 0, b: 2 }),
      orNone: safeEval({ or: [] }, { a: 1 }),
      andAll: safeEval({ and: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 2 }] }, { a: 1, b: 2 }),
      andNone: safeEval({ and: [] }, { a: 1 }),
      nullCondition: safeEval(null, null),
      undefinedConditionNullData: safeEval(undefined, undefined),
      conditionNullData: safeEval({ field: 'a', operator: 'eq', value: 1 }, null),
    };
    expect(Object.keys(compound).sort()).toEqual(Object.keys(fe.compound).sort());
    checkGolden('_shared/conditions.matrix.json', { operators: fe.operators, matrix, dotted, compound });
  });

  it('extra operator x value x data cells the frontend matrix lacks (MCP-only inputs)', () => {
    // Empty strings, whitespace, "null"/"0" strings, falsy values and id-bearing
    // objects with falsy ids. The ledger checks these against its model of both
    // evaluators (the frontend model is anchored on every frontend golden cell).
    const ops = ['eq', 'ne', 'in', 'is_null', 'is_not_null', 'gt', 'lte'];
    const values: unknown[] = [1, 0, '', null, 'a', [''], ['a', 1]];
    const data: unknown[] = ['', ' ', 'null', '0', 0, false, null, { id: '' }, { id: 0 }, undefined];
    const matrix: Record<string, Record<string, boolean | string>> = {};
    for (const op of ops) {
      for (const v of values) {
        const row: Record<string, boolean | string> = {};
        for (const d of data) {
          row[d === undefined ? '<missing>' : compactStringify(d)] = safeEval({ field: 'f', operator: op, value: v }, d === undefined ? {} : { f: d });
        }
        matrix[`${op} ${compactStringify(v)}`] = row;
      }
    }
    checkGolden('_shared/mcp.conditions-extra.json', { matrix });
  });

  it('labels round-trip (inputs recovered from the frontend artifacts are exact)', () => {
    const fe = loadFrontendArtifact('_shared/conditions.matrix.json');
    for (const key of Object.keys(fe.dotted)) {
      const at = key.indexOf(' @ ');
      expect(compactStringify(parseLabel(key.slice(at + 3)))).toBe(key.slice(at + 3));
    }
  });

  it('no orphan condition golden files', () => {
    expectNoOrphans(rel => /\/(conditions\.[a-z-]+|mcp\.conditions-[a-z-]+|mcp\.actions-execute)\.json$/.test(rel));
  });
});
