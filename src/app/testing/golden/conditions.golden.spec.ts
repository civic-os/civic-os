/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs: the two condition evaluators.
 *  - utils/condition-evaluator.ts evaluateCondition / extractConditionFieldNames
 *    over every visibility/enabled condition in each example's actions;
 *  - GuidedFormService.evaluateCondition / getEffectiveSteps / getLockedFields
 *    over each example's guided-form step conditions.
 * Conditions do not vary by role (ROLE_VARIANCE.md), so these are per example.
 */
import { TestBed } from '@angular/core/testing';
import { evaluateCondition, extractConditionFieldNames } from '../../utils/condition-evaluator';
import { GuidedFormService } from '../../services/guided-form.service';
import { ActionCondition } from '../../interfaces/entity';
import { GuidedFormCondition, GuidedFormStep } from '../../interfaces/guided-form';
import { checkGolden, expectNoOrphans, listExamples, listVariants, loadRaw, compactStringify } from './golden-io';
import { configureHttpTesting } from './schema-harness';

const label = (v: unknown) => compactStringify(v);

function leaves(c: any): any[] {
  if (!c) return [];
  if (Array.isArray(c.or)) return c.or.flatMap(leaves);
  if (Array.isArray(c.and)) return c.and.flatMap(leaves);
  return [c];
}

function altValue(v: any): any {
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'string') return v + '_x';
  if (typeof v === 'boolean') return !v;
  if (Array.isArray(v)) return v.length ? '__not_in__' : 'x';
  return 'x';
}
const matchValue = (leaf: any) => (Array.isArray(leaf.value) ? leaf.value[0] : leaf.value);

/** record fragments that exercise one leaf in flat / FK-embedded / dot-path shapes */
function fragments(leaf: any): any[] {
  const parts = String(leaf.field).split('.');
  const mv = matchValue(leaf);
  const av = altValue(leaf.value);
  const out: any[] = [];
  const nest = (val: any) => parts.slice().reverse().reduce((acc, key, i) => (i === 0 ? { [key]: val } : { [key]: acc }), null as any);
  if (parts.length === 1) {
    const f = parts[0];
    for (const val of [mv, av, null]) out.push({ [f]: val });
    out.push({});
    out.push({ [f]: { id: mv, display_name: 'N', status_key: typeof mv === 'string' ? mv : 'k' } });
    out.push({ [f]: { id: av, display_name: 'N' } });
    out.push({ [f]: { id: null } });
    out.push({ [f]: { other: 1 } });
    if (typeof mv === 'number') out.push({ [f]: String(mv) });
  } else {
    out.push(nest(mv), nest(av), nest(null), {});
    out.push({ [parts[0]]: 3 }, { [parts[0]]: null });
    // embedded FK object that also carries id (PostgREST embed shape)
    const withId = nest(mv);
    withId[parts[0]] = { id: 3, ...withId[parts[0]] };
    out.push(withId);
  }
  return out;
}

function recordsFor(cond: any): any[] {
  const ls = leaves(cond);
  const recs: any[] = [];
  for (const l of ls) recs.push(...fragments(l));
  // all-match / all-alt combinations (flat shape per leaf, deep-merged by first segment)
  const merge = (pick: (l: any) => any) => ls.reduce((acc, l) => Object.assign(acc, pick(l)), {} as any);
  recs.push(merge(l => fragments(l)[0]));
  recs.push(merge(l => fragments(l)[1]));
  const seen = new Set<string>();
  return recs.filter(r => { const k = label(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

function evaluateAll(cond: ActionCondition | null) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const results: Record<string, boolean> = {};
    for (const rec of recordsFor(cond)) results[label(rec)] = evaluateCondition(cond, rec);
    results['<null data>'] = evaluateCondition(cond, null);
    results['<undefined data>'] = evaluateCondition(cond, undefined);
    return { fieldNames: extractConditionFieldNames(cond), results, warnCalls: warn.mock.calls.length };
  } finally {
    warn.mockRestore();
  }
}

describe('golden: condition evaluators', () => {
  for (const example of listExamples()) {
    const admin = listVariants(example).find(v => v.variant === 'testadmin')!;

    it(`${example}: action visibility/enabled conditions`, () => {
      const actions: any[] = loadRaw(admin, 'schema_entity_actions');
      const byCondition = new Map<string, { condition: ActionCondition; actions: string[] }>();
      for (const a of actions) {
        for (const kind of ['visibility_condition', 'enabled_condition'] as const) {
          const c = a[kind];
          if (!c) continue;
          const k = label(c);
          if (!byCondition.has(k)) byCondition.set(k, { condition: c, actions: [] });
          byCondition.get(k)!.actions.push(`${a.table_name}.${a.action_name}:${kind}`);
        }
      }
      const out = [...byCondition.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => ({
        condition: v.condition,
        usedBy: v.actions.sort(),
        ...evaluateAll(v.condition),
      }));
      checkGolden(`${example}/_example/conditions.actions.json`, { conditions: out });
    });

    it(`${example}: guided-form step conditions`, () => {
      const steps: GuidedFormStep[] = loadRaw(admin, 'schema_guided_form_steps');
      if (!steps.length) {
        checkGolden(`${example}/_example/conditions.guided-forms.json`, { steps: [] });
        return;
      }
      configureHttpTesting();
      const svc = TestBed.inject(GuidedFormService);
      const conds: GuidedFormCondition[] = steps.flatMap(s => s.conditions);
      const perCondition = conds.map(c => {
        const base = c.value;
        const num = base !== null && base !== '' && !Number.isNaN(Number(base)) ? Number(base) : undefined;
        const records: any[] = [
          { [c.field]: base }, { [c.field]: num }, { [c.field]: { id: num ?? base, display_name: 'N' } },
          { [c.field]: { id: base } }, { [c.field]: base + '_x' }, { [c.field]: 0 }, { [c.field]: true },
          { [c.field]: null }, { [c.field]: { id: null } }, { [c.field]: { other: 1 } }, {},
        ];
        const results: Record<string, boolean> = {};
        for (const r of records) results[label(r)] = svc.evaluateCondition(c, r);
        results['<null parent>'] = svc.evaluateCondition(c, null);
        return { condition: c, results };
      });
      const matchAll: any = {};
      const matchNone: any = {};
      for (const c of conds) {
        matchAll[c.field] = c.operator === 'eq' ? (c.value as string) : c.operator === 'is_not_null' ? 1 : null;
        matchNone[c.field] = c.operator === 'eq' ? 'zzz' : c.operator === 'is_null' ? 1 : null;
      }
      const effective: Record<string, unknown> = {};
      const progressAll = steps.map((s, i) => ({ id: i, guided_form_key: s.guided_form_key, parent_id: 1, step_key: s.step_key }));
      for (const [name, rec] of [['empty', {}], ['matchAll', matchAll], ['matchNone', matchNone]] as const) {
        effective[`${name}/noProgress`] = svc.getEffectiveSteps(steps, rec, []);
        effective[`${name}/allDone`] = svc.getEffectiveSteps(steps, rec, progressAll as any);
      }
      checkGolden(`${example}/_example/conditions.guided-forms.json`, {
        perCondition,
        effectiveSteps: effective,
        lockedFields: [...svc.getLockedFields(steps)].sort(),
      });
    });
  }

  it('evaluateCondition operator x value x data matrix and field-name extraction', () => {
    const ops = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'in', 'is_null', 'is_not_null', 'between', 'EQ', ''];
    const condValues: any[] = [1, 0, '1', 'a', true, null, [1, 2], ['a'], [], 1.5, -1];
    const data: any[] = [1, 0, '1', 'a', true, false, null, undefined, 2, 1.5, -1, [1, 2], { id: 1 }, { id: '1' }, { id: null }, {}, 'x'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const matrix: Record<string, Record<string, boolean>> = {};
    let warnCalls = 0;
    try {
      for (const op of ops) {
        for (const cv of condValues) {
          const row: Record<string, boolean> = {};
          for (const d of data) {
            const rec: any = d === undefined ? {} : { f: d };
            row[d === undefined ? '<missing>' : label(d)] = evaluateCondition({ field: 'f', operator: op as any, value: cv }, rec);
          }
          matrix[`${op || '<empty>'} ${label(cv)}`] = row;
        }
      }
      warnCalls = warn.mock.calls.length;
    } finally {
      warn.mockRestore();
    }

    const dotted: Record<string, boolean> = {};
    const dottedCases: Array<[string, any]> = [
      ['a.b', { a: { b: 1 } }], ['a.b', { a: 5 }], ['a.b', { a: null }], ['a.b', { a: 'str' }], ['a.b', {}],
      ['a.b', { a: [ { b: 1 } ] }], ['a.0', { a: [1] }], ['a.b.c', { a: { b: { c: 1 } } }], ['a.b.c', { a: { b: null } }],
      ['a.length', { a: [1, 2] }], ['a.id', { a: { id: 1 } }], ['a', { a: { id: 1, b: 1 } }], ['a', { a: { b: 1 } }],
      ['', { '': 1 }], ['a.', { a: { '': 1 } }],
    ];
    for (const [field, rec] of dottedCases) {
      dotted[`${field} @ ${label(rec)}`] = evaluateCondition({ field, operator: 'eq', value: 1 }, rec);
    }

    const shapes: any[] = [
      null, undefined, { field: 'a', operator: 'eq', value: 1 }, { field: 'a.b.c', operator: 'eq', value: 1 },
      { or: [] }, { and: [] }, { or: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b.c', operator: 'eq', value: 2 }] },
      { and: [{ or: [{ field: 'x', operator: 'eq', value: 1 }, { field: 'y.z', operator: 'ne', value: 2 }] }, { field: 'w', operator: 'gt', value: 0 }] },
      { or: 'not-an-array', field: 'q', operator: 'eq', value: 1 },
    ];
    const extracted = shapes.map(s => ({ condition: s === undefined ? '<undefined>' : s, fieldNames: extractConditionFieldNames(s) }));
    const compound = {
      or: evaluateCondition({ or: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 2 }] } as any, { a: 0, b: 2 }),
      orNone: evaluateCondition({ or: [] } as any, { a: 1 }),
      andAll: evaluateCondition({ and: [{ field: 'a', operator: 'eq', value: 1 }, { field: 'b', operator: 'eq', value: 2 }] } as any, { a: 1, b: 2 }),
      andNone: evaluateCondition({ and: [] } as any, { a: 1 }),
      nullCondition: evaluateCondition(null, null),
      undefinedConditionNullData: evaluateCondition(undefined, undefined),
      conditionNullData: evaluateCondition({ field: 'a', operator: 'eq', value: 1 }, null),
    };
    checkGolden('_shared/conditions.matrix.json', { operators: ops, matrix, warnCalls, dotted, extracted, compound });
  });

  it('GuidedFormService.evaluateCondition operator matrix', () => {
    configureHttpTesting();
    const svc = TestBed.inject(GuidedFormService);
    const ops = ['eq', 'neq', 'is_null', 'is_not_null', 'gt', ''];
    const condValues: Array<string | null> = ['23', 'abc', '', null, 'true', '1.0'];
    const data: any[] = [23, '23', 'abc', true, 0, null, undefined, { id: 23 }, { id: '23' }, { id: null }, { x: 1 }, [], 1];
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const op of ops) {
      for (const cv of condValues) {
        const row: Record<string, boolean> = {};
        for (const d of data) {
          const rec = d === undefined ? {} : { f: d };
          row[d === undefined ? '<missing>' : label(d)] = svc.evaluateCondition(
            { id: 1, condition_type: 'skip_if', field: 'f', operator: op as any, value: cv }, rec);
        }
        matrix[`${op || '<empty>'} ${label(cv)}`] = row;
      }
    }
    checkGolden('_shared/conditions.guided-form-matrix.json', {
      matrix,
      nullParent: svc.evaluateCondition({ id: 1, condition_type: 'skip_if', field: 'f', operator: 'neq', value: '1' }, null),
    });
  });

  it('no orphan conditions.* golden files', () => {
    expectNoOrphans(rel => /\/conditions\.[a-z-]+\.json$/.test(rel));
  });
});
