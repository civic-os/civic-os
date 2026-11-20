/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { MenuEntry, MenuNodeRow } from '../model/menu.js';
import { buildMenu, MAX_MENU_DEPTH, MENU_HEADING_KEY, menuBranchKeys, menuDashboardKey, menuPlacementAllowed, validateMenuTree } from './build-menu.js';

type E = { table_name: string; display_name: string; sort_order: number };
const ent = (table_name: string, sort_order = 0, display_name = table_name.toUpperCase()): E => ({ table_name, display_name, sort_order });

const entityNode = (key: string, over: Partial<MenuNodeRow> = {}): MenuNodeRow => ({
  node_key: key,
  node_kind: 'entity',
  target_key: key,
  display_name: null,
  icon: null,
  parent_node_key: null,
  sort_order: null,
  is_hidden: false,
  collapsed_by_default: false,
  dashboard_id: null,
  dashboard_display_name: null,
  ...over,
});
const heading = (key: string, over: Partial<MenuNodeRow> = {}): MenuNodeRow => ({
  node_key: key,
  node_kind: 'heading',
  target_key: null,
  display_name: key.toUpperCase(),
  icon: null,
  parent_node_key: null,
  sort_order: null,
  is_hidden: false,
  collapsed_by_default: false,
  dashboard_id: null,
  dashboard_display_name: null,
  ...over,
});

/** A dashboard node the caller can see (title `D<id>`), unless `dashboard_display_name` is overridden to null. */
const dashboardNode = (id: number, over: Partial<MenuNodeRow> = {}): MenuNodeRow => ({
  node_key: `dashboard:${id}`,
  node_kind: 'dashboard',
  target_key: null,
  display_name: null,
  icon: null,
  parent_node_key: null,
  sort_order: null,
  is_hidden: false,
  collapsed_by_default: false,
  dashboard_id: id,
  dashboard_display_name: `D${id}`,
  ...over,
});

/** Compact rendering: `key[child,child]`. */
const shape = (entries: readonly MenuEntry[]): string[] =>
  entries.map(e => (e.children.length ? `${e.key}[${shape(e.children).join(',')}]` : e.key));

describe('buildMenu', () => {
  it('without nodes lists the entities by sort_order, ties in input (database) order', () => {
    const entities = [ent('a', 1), ent('b', 1), ent('c', 0)];
    expect(shape(buildMenu(entities, []))).toEqual(['c', 'a', 'b']);
  });

  it('breaks unplaced entity ties by the database collation order of the input, not by code point', () => {
    // en_US sorts 'timeslots' before 'time_slot' (punctuation is ignored at the first level)
    const entities = [ent('timeslots', 0), ent('time_slot', 0)];
    expect(shape(buildMenu(entities, []))).toEqual(['timeslots', 'time_slot']);
  });

  it('breaks node ties by key in code point order, like the revert (COLLATE "C"), whatever the entity order', () => {
    const entities = [ent('timeslots', 0), ent('time_slot', 0), ent('b', 9), ent('a', 1)];
    const nodes = [entityNode('timeslots', { sort_order: 0 }), entityNode('time_slot', { sort_order: 0 }),
      entityNode('b', { sort_order: 5 }), entityNode('a', { sort_order: 5 })];
    expect(shape(buildMenu(entities, nodes))).toEqual(['time_slot', 'timeslots', 'a', 'b']);
  });

  it('treats a missing entity sort_order as 0, like the view\'s COALESCE', () => {
    const entities = [{ table_name: 'z', display_name: 'Z' } as E, ent('a', 1)];
    expect(shape(buildMenu(entities, []))).toEqual(['z', 'a']);
  });

  it('unplaced entities carry their own label, no icon and are not collapsed', () => {
    expect(buildMenu([ent('a', 0, 'Alpha')], [])).toEqual([
      { key: 'a', kind: 'entity', label: 'Alpha', tableName: 'a', collapsedByDefault: false, children: [] },
    ]);
  });

  it('root nodes with sort_order copied from metadata.entities reproduce the schema_entities order', () => {
    const entities = [ent('c', -5), ent('a', 0), ent('b', 0), ent('d', 7)];
    const copied = entities.map(e => entityNode(e.table_name, { sort_order: e.sort_order }));
    expect(shape(buildMenu(entities, copied))).toEqual(shape(buildMenu(entities, [])));
    expect(shape(buildMenu(entities, copied))).toEqual(['c', 'a', 'b', 'd']);
    // Node order in the input does not matter
    expect(shape(buildMenu(entities, [...copied].reverse()))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('copied nodes with a NULL sort_order sort as 0', () => {
    const entities = [ent('a', 0), ent('b', 0)];
    expect(shape(buildMenu(entities, [entityNode('b'), entityNode('a', { sort_order: 0 })]))).toEqual(['a', 'b']);
  });

  it('lists unplaced entities after the root nodes, whatever their sort_order', () => {
    const entities = [ent('a', 0), ent('b', 5), ent('c', 10), ent('d', 1)];
    const nodes = [heading('grp', { sort_order: 30 }), entityNode('a', { parent_node_key: 'grp' }), entityNode('c', { sort_order: 10 })];
    // b (5) and d (1) sort below both root nodes by sort_order, but trail them, in their own order
    expect(shape(buildMenu(entities, nodes))).toEqual(['c', 'grp[a]', 'd', 'b']);
  });

  it('orders unplaced entities by (sort_order, table_name) after the root nodes', () => {
    const nodes = [heading('grp', { sort_order: 0 }), entityNode('z', { parent_node_key: 'grp' })];
    expect(shape(buildMenu([ent('m', 0), ent('z', 0)], nodes))).toEqual(['grp[z]', 'm']);
    expect(shape(buildMenu([ent('b', 0), ent('a', 0), ent('z', 0)], nodes))).toEqual(['grp[z]', 'b', 'a']);
  });

  it('a hidden root node does not move the unplaced entities', () => {
    const entities = [ent('a', 2), ent('b', 1), ent('h', 0)];
    expect(shape(buildMenu(entities, [entityNode('h', { is_hidden: true })]))).toEqual(['b', 'a']);
  });

  it('orders siblings by (sort_order, node_key), NULL as 0', () => {
    const entities = [ent('a'), ent('b'), ent('c'), ent('d')];
    const nodes = [
      heading('g'),
      entityNode('d', { parent_node_key: 'g', sort_order: 2 }),
      entityNode('c', { parent_node_key: 'g', sort_order: 1 }),
      entityNode('b', { parent_node_key: 'g' }),
      entityNode('a', { parent_node_key: 'g', sort_order: 1 }),
    ];
    expect(shape(buildMenu(entities, nodes))).toEqual(['g[b,a,c,d]']);
  });

  it('nests an entity under an entity and under a heading', () => {
    const entities = [ent('clients'), ent('consents'), ent('referrals')];
    const nodes = [
      heading('clientele', { display_name: 'Clients' }),
      entityNode('clients', { parent_node_key: 'clientele', sort_order: 1 }),
      entityNode('consents', { parent_node_key: 'clients' }),
      entityNode('referrals', { parent_node_key: 'clientele', sort_order: 2 }),
    ];
    const menu = buildMenu(entities, nodes);
    expect(shape(menu)).toEqual(['clientele[clients[consents],referrals]']);
    expect(menu[0]).toMatchObject({ kind: 'heading', label: 'Clients', collapsedByDefault: false });
    expect(menu[0].children[0]).toMatchObject({ kind: 'entity', tableName: 'clients', label: 'CLIENTS' });
  });

  it('prefers the node label, falls back to the entity label, and ignores a blank override', () => {
    const entities = [ent('a', 0, 'Alpha'), ent('b', 0, 'Beta'), ent('c', 0, 'Gamma')];
    const menu = buildMenu(entities, [
      entityNode('a', { display_name: 'All A', sort_order: 1 }),
      entityNode('b', { sort_order: 2 }),
      entityNode('c', { display_name: '  ', sort_order: 3 }),
    ]);
    expect(menu.map(m => m.label)).toEqual(['All A', 'Beta', 'Gamma']);
  });

  it('labels a heading without display_name by its key', () => {
    const menu = buildMenu([ent('a')], [heading('grp', { display_name: null }), entityNode('a', { parent_node_key: 'grp' })]);
    expect(menu[0].label).toBe('grp');
  });

  it('passes the icon and collapsedByDefault from the node', () => {
    const menu = buildMenu([ent('a')], [heading('g', { icon: 'folder', collapsed_by_default: true }), entityNode('a', { parent_node_key: 'g', icon: 'star', collapsed_by_default: true })]);
    expect(menu[0]).toMatchObject({ icon: 'folder', collapsedByDefault: true });
    expect(menu[0].children[0]).toMatchObject({ icon: 'star', collapsedByDefault: true });
    expect('icon' in buildMenu([ent('a')], [entityNode('a')])[0]).toBe(false);
  });

  it('is_hidden hides the node and its whole subtree, and the entity is not shown as unplaced', () => {
    const entities = [ent('clients'), ent('consents'), ent('other')];
    const nodes = [entityNode('clients', { is_hidden: true }), entityNode('consents', { parent_node_key: 'clients' })];
    expect(shape(buildMenu(entities, nodes))).toEqual(['other']);
  });

  it('a hidden heading hides its entities without making them unplaced', () => {
    const entities = [ent('a'), ent('b')];
    const nodes = [heading('g', { is_hidden: true }), entityNode('a', { parent_node_key: 'g' })];
    expect(shape(buildMenu(entities, nodes))).toEqual(['b']);
  });

  it('a hidden child does not hide its siblings or parent', () => {
    const nodes = [heading('g'), entityNode('a', { parent_node_key: 'g' }), entityNode('b', { parent_node_key: 'g', is_hidden: true })];
    expect(shape(buildMenu([ent('a'), ent('b')], nodes))).toEqual(['g[a]']);
  });

  it('drops an entity node whose target is not eligible and lifts its children in place', () => {
    const entities = [ent('a'), ent('b'), ent('c')];
    const nodes = [
      heading('g'),
      entityNode('a', { parent_node_key: 'g', sort_order: 1 }),
      entityNode('junction', { parent_node_key: 'g', sort_order: 2 }),
      entityNode('b', { parent_node_key: 'junction', sort_order: 2 }),
      entityNode('c', { parent_node_key: 'junction', sort_order: 1 }),
    ];
    expect(shape(buildMenu(entities, nodes))).toEqual(['g[a,c,b]']);
  });

  it('lifts through several dropped levels', () => {
    const nodes = [
      entityNode('x'),
      entityNode('y', { parent_node_key: 'x' }),
      entityNode('b', { parent_node_key: 'y' }),
    ];
    expect(shape(buildMenu([ent('b')], nodes))).toEqual(['b']);
  });

  it('a node with a null target is dropped like an unknown one', () => {
    const nodes = [entityNode('a', { target_key: null }), entityNode('b', { parent_node_key: 'a' })];
    expect(shape(buildMenu([ent('b')], nodes))).toEqual(['b']);
  });

  it('drops headings with no visible descendant, recursively', () => {
    const entities = [ent('a')];
    const nodes = [
      heading('empty'),
      heading('outer'),
      heading('inner', { parent_node_key: 'outer' }),
      entityNode('gone', { parent_node_key: 'inner' }),
      entityNode('a', { is_hidden: true }),
    ];
    expect(buildMenu(entities, nodes)).toEqual([]);
  });

  it('keeps a heading whose only descendant was lifted from a dropped entity node', () => {
    const nodes = [heading('g'), entityNode('gone', { parent_node_key: 'g' }), entityNode('a', { parent_node_key: 'gone' })];
    expect(shape(buildMenu([ent('a')], nodes))).toEqual(['g[a]']);
  });

  it('treats an orphan (missing parent) as a root node', () => {
    const nodes = [entityNode('a', { parent_node_key: 'nope', sort_order: 1 }), entityNode('b')];
    expect(shape(buildMenu([ent('a'), ent('b')], nodes))).toEqual(['b', 'a']);
  });

  it('does not loop or throw on a cycle: the first node of it (in input order) becomes a root', () => {
    const nodes = [entityNode('a', { parent_node_key: 'b', sort_order: 1 }), entityNode('b', { parent_node_key: 'a', sort_order: 2 }), entityNode('c', { parent_node_key: 'b', sort_order: 3 })];
    expect(shape(buildMenu([ent('a'), ent('b'), ent('c')], nodes))).toEqual(['a[b[c]]']);
    expect(shape(buildMenu([ent('a')], [entityNode('a', { parent_node_key: 'a' })]))).toEqual(['a']);
  });

  it('renders depth beyond the cap rather than failing', () => {
    const nodes = [heading('h1'), heading('h2', { parent_node_key: 'h1' }), heading('h3', { parent_node_key: 'h2' }), heading('h4', { parent_node_key: 'h3' }), entityNode('a', { parent_node_key: 'h4' })];
    expect(shape(buildMenu([ent('a')], nodes))).toEqual(['h1[h2[h3[h4[a]]]]']);
  });

  it('shows a duplicated entity once and ignores a duplicated node key', () => {
    const nodes = [entityNode('a', { sort_order: 1 }), entityNode('a2', { target_key: 'a', sort_order: 2 }), entityNode('a', { sort_order: 9 })];
    expect(shape(buildMenu([ent('a')], nodes))).toEqual(['a']);
  });

  it('an entity absent from the entities and with no node is not invented', () => {
    expect(buildMenu([], [])).toEqual([]);
    expect(buildMenu([], [heading('g')])).toEqual([]);
  });

  it('keeps one entry per duplicated entity in the input', () => {
    expect(shape(buildMenu([ent('a'), ent('a')], []))).toEqual(['a']);
  });
});

describe('buildMenu with dashboards', () => {
  it('renders a dashboard node the caller can see, labelled by its node label or the dashboard title', () => {
    const menu = buildMenu([ent('a')], [
      heading('g'),
      entityNode('a', { parent_node_key: 'g', sort_order: 1 }),
      dashboardNode(7, { parent_node_key: 'g', sort_order: 2 }),
      dashboardNode(8, { parent_node_key: 'g', sort_order: 3, display_name: 'Reports', icon: 'monitoring' }),
      dashboardNode(9, { parent_node_key: 'g', sort_order: 4, display_name: '  ' }),
    ]);
    expect(shape(menu)).toEqual(['g[a,dashboard:7,dashboard:8,dashboard:9]']);
    expect(menu[0].children[1]).toEqual({
      key: 'dashboard:7', kind: 'dashboard', label: 'D7', dashboardId: 7, collapsedByDefault: false, children: [],
    });
    expect(menu[0].children[2]).toMatchObject({ label: 'Reports', icon: 'monitoring', dashboardId: 8 });
    expect(menu[0].children[3].label).toBe('D9');
  });

  it('drops a dashboard node the caller cannot see, or a hidden one, and never lists dashboards without a node', () => {
    const nodes = [heading('g'), dashboardNode(7, { parent_node_key: 'g', dashboard_display_name: null }), dashboardNode(8, { is_hidden: true })];
    expect(buildMenu([], nodes)).toEqual([]);
    expect(shape(buildMenu([ent('a')], nodes))).toEqual(['a']);
  });

  it('a dashboard node under an entity node is a child of that entity', () => {
    const menu = buildMenu([ent('cases')], [entityNode('cases'), dashboardNode(3, { parent_node_key: 'cases' })]);
    expect(shape(menu)).toEqual(['cases[dashboard:3]']);
  });

  it('lifts the children of a dashboard node the caller cannot see, and keeps those of one they can (bad data)', () => {
    const nodes = [dashboardNode(1, { dashboard_display_name: null }), entityNode('a', { parent_node_key: 'dashboard:1' })];
    expect(shape(buildMenu([ent('a')], nodes))).toEqual(['a']);
    const seen = [dashboardNode(1), entityNode('a', { parent_node_key: 'dashboard:1' })];
    expect(shape(buildMenu([ent('a')], seen))).toEqual(['dashboard:1[a]']);
  });

  it('a heading opens a dashboard the caller can see, and stays a plain heading otherwise', () => {
    const linked = buildMenu([ent('a')], [heading('g', { dashboard_id: 4, dashboard_display_name: 'Staff' }), entityNode('a', { parent_node_key: 'g' })]);
    expect(linked[0]).toMatchObject({ kind: 'heading', label: 'G', dashboardId: 4 });
    const unseen = buildMenu([ent('a')], [heading('g', { dashboard_id: 4 }), entityNode('a', { parent_node_key: 'g' })]);
    expect(unseen[0].label).toBe('G');
    expect('dashboardId' in unseen[0]).toBe(false);
  });

  it('keeps a linked heading with no visible children, and drops it when the caller cannot see its dashboard', () => {
    expect(buildMenu([], [heading('g', { dashboard_id: 4, dashboard_display_name: 'Staff' })])).toEqual([
      { key: 'g', kind: 'heading', label: 'G', dashboardId: 4, collapsedByDefault: false, children: [] },
    ]);
    expect(buildMenu([], [heading('g', { dashboard_id: 4 })])).toEqual([]);
    expect(buildMenu([], [heading('g', { dashboard_id: 4, dashboard_display_name: 'Staff', is_hidden: true })])).toEqual([]);
  });

  it('a linked heading keeps its parent heading', () => {
    const nodes = [heading('outer'), heading('inner', { parent_node_key: 'outer', dashboard_id: 2, dashboard_display_name: 'X' })];
    expect(shape(buildMenu([], nodes))).toEqual(['outer[inner]']);
  });

  it('links each dashboard once, in depth-first order (bad data)', () => {
    const menu = buildMenu([], [
      heading('g', { sort_order: 1, dashboard_id: 5, dashboard_display_name: 'Five' }),
      dashboardNode(5, { parent_node_key: 'g' }),
      dashboardNode(5, { node_key: 'dup', sort_order: 2 }),
    ]);
    expect(menu).toEqual([{ key: 'g', kind: 'heading', label: 'G', dashboardId: 5, collapsedByDefault: false, children: [] }]);
  });

  it('treats rows from a server without the dashboard columns as having no dashboard', () => {
    const legacy = { ...heading('g'), dashboard_id: undefined, dashboard_display_name: undefined } as unknown as MenuNodeRow;
    expect(buildMenu([ent('a')], [legacy, entityNode('a', { parent_node_key: 'g' })])[0]).not.toHaveProperty('dashboardId');
  });
});

describe('validateMenuTree', () => {
  const codes = (nodes: MenuNodeRow[], entities?: { table_name: string }[]) => validateMenuTree(nodes, entities).map(e => `${e.code}:${e.nodeKey}`);

  it('accepts a valid tree', () => {
    const nodes = [heading('g'), entityNode('a', { parent_node_key: 'g' }), entityNode('b', { parent_node_key: 'a' }), heading('h', { parent_node_key: 'g' }), entityNode('c', { parent_node_key: 'h' })];
    expect(validateMenuTree(nodes, [ent('a'), ent('b'), ent('c')])).toEqual([]);
    expect(validateMenuTree([])).toEqual([]);
  });

  it('accepts depth 3 and rejects depth 4', () => {
    const ok = [heading('h1'), heading('h2', { parent_node_key: 'h1' }), entityNode('a', { parent_node_key: 'h2' })];
    expect(codes(ok)).toEqual([]);
    const deep = [...ok, entityNode('b', { parent_node_key: 'a' })];
    expect(codes(deep)).toEqual(['depth:b']);
  });

  it('rejects a heading under an entity node, and accepts an entity under an entity', () => {
    expect(codes([entityNode('a'), heading('h', { parent_node_key: 'a' })])).toEqual(['parent-kind:h']);
    expect(codes([entityNode('a'), entityNode('b', { parent_node_key: 'a' })])).toEqual([]);
  });

  it('reports unknown parents', () => {
    expect(codes([entityNode('a', { parent_node_key: 'ghost' })])).toEqual(['unknown-parent:a']);
  });

  it('reports every node of a cycle and does not also report depth', () => {
    const nodes = [entityNode('a', { parent_node_key: 'b' }), entityNode('b', { parent_node_key: 'a' }), entityNode('c', { parent_node_key: 'b' })];
    expect(codes(nodes)).toEqual(['cycle:a', 'cycle:b', 'cycle:c']);
    expect(codes([entityNode('a', { parent_node_key: 'a' })])).toEqual(['cycle:a']);
  });

  it('reports duplicate entity nodes and duplicate keys', () => {
    expect(codes([entityNode('a'), entityNode('a2', { target_key: 'a' })])).toEqual(['entity-key:a2', 'duplicate-entity:a2']);
    expect(codes([entityNode('a'), entityNode('a')])).toEqual(['duplicate-key:a']);
  });

  it('checks the entity key and the heading key, label and target', () => {
    expect(codes([entityNode('a', { target_key: 'b' })])).toEqual(['entity-key:a']);
    expect(codes([entityNode('a', { target_key: null })])).toEqual(['entity-key:a']);
    for (const bad of ['Bad', '1x', 'a-b', '_a', 'a b', '']) {
      expect(codes([heading(bad)])).toContain(`heading-key:${bad}`);
    }
    expect(codes([heading('ok_1')])).toEqual([]);
    expect(codes([heading('g', { display_name: null })])).toEqual(['heading-label:g']);
    expect(codes([heading('g', { display_name: ' ' })])).toEqual(['heading-label:g']);
    expect(codes([heading('g', { target_key: 'a' })])).toEqual(['heading-target:g']);
  });

  it('reports unknown targets only when entities are given', () => {
    const nodes = [entityNode('a'), entityNode('b')];
    expect(codes(nodes)).toEqual([]);
    expect(codes(nodes, [ent('a')])).toEqual(['unknown-target:b']);
  });

  it('accepts dashboard nodes at the root, under a heading and under an entity, and a linked heading', () => {
    const nodes = [
      heading('g', { dashboard_id: 1 }),
      dashboardNode(2, { parent_node_key: 'g' }),
      entityNode('a'),
      dashboardNode(3, { parent_node_key: 'a' }),
      dashboardNode(4),
    ];
    expect(codes(nodes)).toEqual([]);
  });

  it('rejects anything under a dashboard node', () => {
    expect(codes([dashboardNode(1), entityNode('a', { parent_node_key: 'dashboard:1' }), heading('h', { parent_node_key: 'dashboard:1' }), dashboardNode(2, { parent_node_key: 'dashboard:1' })]))
      .toEqual(['dashboard-children:a', 'dashboard-children:h', 'dashboard-children:dashboard:2']);
  });

  it('checks the dashboard key, the missing dashboard, a target on a dashboard node and a dashboard on an entity node', () => {
    expect(codes([dashboardNode(1, { node_key: 'dash_1' })])).toEqual(['dashboard-key:dash_1']);
    expect(codes([dashboardNode(1, { dashboard_id: null })])).toEqual(['dashboard-key:dashboard:1']);
    expect(codes([dashboardNode(1, { target_key: 'a' })])).toEqual(['dashboard-key:dashboard:1']);
    expect(codes([entityNode('a', { dashboard_id: 1 })])).toEqual(['dashboard-key:a']);
  });

  it('reports a dashboard placed twice, as a node or as a heading link', () => {
    expect(codes([heading('g', { dashboard_id: 1 }), dashboardNode(1), heading('h', { dashboard_id: 1 })]))
      .toEqual(['duplicate-dashboard:dashboard:1', 'duplicate-dashboard:h']);
  });

  it('reports several problems on one node, in node order', () => {
    const nodes = [heading('Bad', { display_name: null }), entityNode('x', { parent_node_key: 'Bad' })];
    expect(codes(nodes)).toEqual(['heading-key:Bad', 'heading-label:Bad']);
  });
});

describe('placement rules', () => {
  it('caps the menu at three levels', () => {
    expect(MAX_MENU_DEPTH).toBe(3);
  });

  it('heading keys are lowercase snake case starting with a letter', () => {
    for (const ok of ['a', 'reports', 'client_intake_2', 'h_2024']) expect(MENU_HEADING_KEY.test(ok)).toBe(true);
    for (const bad of ['', '2024', '_a', 'A', 'a-b', 'a b', 'é']) expect(MENU_HEADING_KEY.test(bad)).toBe(false);
  });

  it('a heading sits at the root or under a heading; an entity or dashboard node sits anywhere but under a dashboard', () => {
    expect(menuPlacementAllowed('heading', null)).toBe(true);
    expect(menuPlacementAllowed('heading', 'heading')).toBe(true);
    expect(menuPlacementAllowed('heading', 'entity')).toBe(false);
    expect(menuPlacementAllowed('entity', null)).toBe(true);
    expect(menuPlacementAllowed('entity', 'heading')).toBe(true);
    expect(menuPlacementAllowed('entity', 'entity')).toBe(true);
    expect(menuPlacementAllowed('dashboard', null)).toBe(true);
    expect(menuPlacementAllowed('dashboard', 'heading')).toBe(true);
    expect(menuPlacementAllowed('dashboard', 'entity')).toBe(true);
    for (const kind of ['heading', 'entity', 'dashboard'] as const) expect(menuPlacementAllowed(kind, 'dashboard')).toBe(false);
  });

  it('a dashboard node key is dashboard:<id>', () => {
    expect(menuDashboardKey(12)).toBe('dashboard:12');
  });
});

describe('menuBranchKeys', () => {
  const menu = buildMenu(
    [ent('clients'), ent('consents'), ent('reports'), ent('loose')],
    [
      heading('clientele'),
      entityNode('clients', { parent_node_key: 'clientele' }),
      entityNode('consents', { parent_node_key: 'clients' }),
      heading('rep'),
      entityNode('reports', { parent_node_key: 'rep' }),
    ],
  );

  it('returns the ancestors outermost first', () => {
    expect(menuBranchKeys(menu, 'consents')).toEqual(['clientele', 'clients']);
    expect(menuBranchKeys(menu, 'clients')).toEqual(['clientele']);
    expect(menuBranchKeys(menu, 'reports')).toEqual(['rep']);
  });

  it('finds a dashboard entry or a heading that opens the dashboard', () => {
    const withDashboards = buildMenu([ent('cases')], [
      heading('mod', { dashboard_id: 1, dashboard_display_name: 'Module' }),
      entityNode('cases', { parent_node_key: 'mod' }),
      dashboardNode(2, { parent_node_key: 'cases' }),
    ]);
    expect(menuBranchKeys(withDashboards, { dashboardId: 2 })).toEqual(['mod', 'cases']);
    expect(menuBranchKeys(withDashboards, { dashboardId: 1 })).toEqual([]);
    expect(menuBranchKeys(withDashboards, { dashboardId: 9 })).toEqual([]);
    // A table name never matches a dashboard entry
    expect(menuBranchKeys(withDashboards, 'dashboard:2')).toEqual([]);
  });

  it('returns [] for a root entry or a table that is not in the menu', () => {
    expect(menuBranchKeys(menu, 'loose')).toEqual([]);
    expect(menuBranchKeys(menu, 'nope')).toEqual([]);
    expect(menuBranchKeys([], 'a')).toEqual([]);
  });
});
