/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTree, flattenTree } from './index.js';

type Row = { id: number | string | null; parent_id?: number | string | null; name?: string };
const cols = { key: 'id', parent: 'parent_id' } as const;

// General(1) > Youth(2) > Teens(3); General(1) > Adults(4); Other(5)
const programs: Row[] = [
  { id: 1, parent_id: null, name: 'General' },
  { id: 2, parent_id: 1, name: 'Youth' },
  { id: 4, parent_id: 1, name: 'Adults' },
  { id: 3, parent_id: 2, name: 'Teens' },
  { id: 5, parent_id: null, name: 'Other' },
];

describe('buildTree', () => {
  it('indexes roots, children in input order, levels, ancestors and descendants', () => {
    const t = buildTree(programs, cols);
    expect(t.roots).toEqual([1, 5]);
    expect(t.size).toBe(5);
    expect(t.node(1)).toMatchObject({ level: 1, ancestors: [], children: [2, 4], descendantCount: 3, orphan: false, cycle: false });
    expect(t.node(3)).toMatchObject({ level: 3, ancestors: [1, 2], children: [], descendantCount: 0 });
    expect(t.descendants(1)).toEqual([2, 3, 4]);
    expect(t.descendants(3)).toEqual([]);
    expect(t.node(99)).toBeUndefined();
    expect(t.descendants(99)).toEqual([]);
  });

  it('compares keys by string form', () => {
    const t = buildTree([{ id: '1', parent_id: null }, { id: 2, parent_id: '1' }], cols);
    expect(t.node(1)?.children).toEqual([2]);
    expect(t.node('2')?.ancestors).toEqual(['1']);
  });

  it('treats a missing parent column as a root and skips rows without a key or with a duplicate key', () => {
    const t = buildTree([{ id: 1 }, { id: null, parent_id: 1 }, { id: 1, parent_id: 7 }, { id: 2, parent_id: undefined }], cols);
    expect(t.roots).toEqual([1, 2]);
    expect(t.size).toBe(2);
  });

  it('makes orphans roots (a parent hidden by RLS) and keeps their subtrees', () => {
    const t = buildTree([{ id: 2, parent_id: 9 }, { id: 3, parent_id: 2 }], cols);
    expect(t.roots).toEqual([2]);
    expect(t.node(2)).toMatchObject({ orphan: true, level: 1 });
    expect(t.node(3)).toMatchObject({ orphan: false, level: 2, ancestors: [2] });
  });

  it('breaks cycles without looping: rows on a cycle become roots, rows hanging below stay below', () => {
    const t = buildTree([
      { id: 1, parent_id: 3 }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 },  // 1 > 2 > 3 > 1
      { id: 4, parent_id: 2 },                                                    // hangs below the cycle
      { id: 5, parent_id: 5 },                                                    // its own parent
      { id: 6, parent_id: null },
    ], cols);
    expect(t.roots).toEqual([1, 2, 3, 5, 6]);
    for (const k of [1, 2, 3, 5]) expect(t.node(k)?.cycle).toBe(true);
    expect(t.node(4)).toMatchObject({ cycle: false, level: 2, ancestors: [2] });
    expect(t.size).toBe(6);
  });

  it('does not mark a row that only leads into a cycle', () => {
    const t = buildTree([{ id: 9, parent_id: 1 }, { id: 1, parent_id: 2 }, { id: 2, parent_id: 1 }], cols);
    expect(t.node(9)).toMatchObject({ cycle: false, level: 2 });
    expect(t.node(1)?.cycle).toBe(true);
    expect(t.node(2)?.cycle).toBe(true);
  });
});

describe('flattenTree', () => {
  const t = buildTree(programs, cols);
  const keys = (rows: ReturnType<typeof flattenTree>) => rows.map((r) => r.key);

  it('shows roots only by default', () => {
    const rows = flattenTree(t);
    expect(keys(rows)).toEqual([1, 5]);
    expect(rows[0]).toEqual({ key: 1, level: 1, setSize: 2, posInSet: 1, hasChildren: true, expanded: false });
    expect(rows[1]).toMatchObject({ hasChildren: false, expanded: false, posInSet: 2 });
  });

  it('expands the given rows, or all', () => {
    expect(keys(flattenTree(t, { expanded: new Set([1]) }))).toEqual([1, 2, 4, 5]);
    expect(keys(flattenTree(t, { expanded: new Set(['1', 2]) }))).toEqual([1, 2, 3, 4, 5]);
    const all = flattenTree(t, { expanded: 'all' });
    expect(keys(all)).toEqual([1, 2, 3, 4, 5]);
    expect(all.find((r) => r.key === 3)).toMatchObject({ level: 3, setSize: 1, posInSet: 1 });
    expect(all.find((r) => r.key === 4)).toMatchObject({ level: 2, setSize: 2, posInSet: 2 });
  });

  it('with matches, shows matches and their ancestors, opened, and marks each', () => {
    const rows = flattenTree(t, { matches: new Set([3, 5]) });
    expect(keys(rows)).toEqual([1, 2, 3, 5]);
    expect(rows.map((r) => r.match)).toEqual(['context', 'context', 'match', 'match']);
    expect(rows[0]).toMatchObject({ expanded: true, setSize: 2 });
    expect(rows[1]).toMatchObject({ expanded: true, setSize: 1, posInSet: 1 });
    expect(rows[2]).toMatchObject({ expanded: false, hasChildren: false });
  });

  it('with matches, a matching parent whose children do not match stays closed', () => {
    const rows = flattenTree(t, { matches: new Set([1]), expanded: 'all' });
    expect(keys(rows)).toEqual([1]);
    expect(rows[0]).toMatchObject({ match: 'match', hasChildren: true, expanded: false, setSize: 1 });
  });

  it('ignores unknown match keys and returns nothing for no matches', () => {
    expect(flattenTree(t, { matches: new Set([42]) })).toEqual([]);
    expect(keys(flattenTree(t, { matches: new Set(['4', 42]) }))).toEqual([1, 4]);
  });
});
