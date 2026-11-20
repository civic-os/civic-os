/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * The sidebar menu rules (docs/notes/MENU_CONFIGURATION_DESIGN.md), kept here
 * so the app, the menu editor and any other client interpret the node tree the
 * same way. Everything is pure and total: bad data (cycles, orphans, depth
 * beyond the cap, duplicates) never throws and never loops, it degrades.
 *
 * Ordering. Siblings sort by (`sort_order`, key), a NULL `sort_order` counting
 * as 0. This is the key of the view's
 * `ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name`
 * (v0.58.0 `schema_entities`), so a menu of root entity nodes copied from
 * `metadata.entities` reproduces the entity order. The database orders
 * `table_name` with its collation, so two entity keys compare by their position
 * in `entities` (which arrives in that order); any comparison involving a
 * heading key falls back to code point.
 */

import type { SchemaEntityTable } from '../model/entity.js';
import type { MenuEntry, MenuNodeRow } from '../model/menu.js';

/** The slice of an entity the menu needs: the caller's eligible (non-junction) entities. */
type MenuEntity = Pick<SchemaEntityTable, 'table_name' | 'display_name' | 'sort_order'>;

/**
 * Deepest allowed nesting, the root level being 1. Mirrors the database trigger.
 *
 * @consumer app
 */
export const MAX_MENU_DEPTH = 3;

/**
 * The shape of a heading key, `^[a-z][a-z0-9_]*$`. Mirrors the database trigger.
 *
 * @consumer app
 */
export const MENU_HEADING_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Whether a node of `kind` may sit under a parent of `parentKind` (`null` for
 * the root): nothing sits under a dashboard node; otherwise a heading sits at
 * the root or under a heading, and an entity or dashboard node sits anywhere.
 * Mirrors the database trigger; depth is checked separately.
 *
 * @consumer app
 */
export function menuPlacementAllowed(kind: MenuNodeRow['node_kind'], parentKind: MenuNodeRow['node_kind'] | null): boolean {
  if (parentKind === 'dashboard') return false;
  return kind !== 'heading' || parentKind === null || parentKind === 'heading';
}

/**
 * The node key of a dashboard node, `dashboard:<id>`. Mirrors the database CHECK.
 *
 * @consumer app
 */
export function menuDashboardKey(dashboardId: number): string {
  return `dashboard:${dashboardId}`;
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type OrderKey = { sort: number | null | undefined; key: string };

/** Sibling nodes: (`sort_order` ?? 0, key in code point order), as the revert and `COLLATE "C"` order them. */
function compareNodes(a: OrderKey, b: OrderKey): number {
  return (a.sort ?? 0) - (b.sort ?? 0) || codePointCompare(a.key, b.key);
}

/**
 * Unplaced entities: (`sort_order` ?? 0, then their rank in the input), so ties keep the database
 * collation order of `schema_entities`, which code point order does not reproduce.
 */
function entityComparator(rank: ReadonlyMap<string, number>): (a: OrderKey, b: OrderKey) => number {
  return (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0);
}

function labelOf(nodeLabel: string | null | undefined, fallback: string): string {
  return nodeLabel != null && nodeLabel.trim() !== '' ? nodeLabel : fallback;
}

/**
 * The effective parent of each node: its `parent_node_key`, or `null` (root)
 * when that parent is absent from the data or the node is where a cycle is broken.
 */
function effectiveParents(nodes: readonly MenuNodeRow[]): Map<string, string | null> {
  const byKey = new Map<string, MenuNodeRow>();
  for (const n of nodes) if (!byKey.has(n.node_key)) byKey.set(n.node_key, n);
  const parents = new Map<string, string | null>();
  for (const [key, node] of byKey) {
    const parent = node.parent_node_key;
    parents.set(key, parent != null && byKey.has(parent) ? parent : null);
  }
  // Nodes on a cycle never reach a root: break each cycle at its first node in input order, which becomes a root
  for (const key of byKey.keys()) {
    const seen = new Set<string>();
    let cursor: string | null = key;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    if (cursor === key) parents.set(key, null);
  }
  return parents;
}

/**
 * Builds the visible menu tree.
 *
 * `entities` are the caller's eligible menu entities (non-junction, in
 * `schema_entities` order). Rules:
 * - `is_hidden` removes a node and its whole subtree (an entity with a hidden node is not unplaced).
 * - An entity node whose target is not in `entities`, or a dashboard node whose row carries no
 *   `dashboard_display_name` (the caller cannot see the dashboard), is dropped and its children take its place.
 * - A heading opens its dashboard (`dashboardId`) when its row carries both `dashboard_id` and
 *   `dashboard_display_name`. A heading with no visible descendant and no such link is dropped.
 * - Dashboards without a node are not in the menu (unlike entities).
 * - Siblings sort by (`sort_order`, key in code point order). Entities with no node follow the root
 *   nodes, sorted among themselves by (entity `sort_order`, `table_name` in database collation,
 *   which is their order in `entities`).
 * - Label: the node's `display_name`, else the entity's. `collapsedByDefault` comes from the node.
 *
 * @consumer app
 */
export function buildMenu(entities: readonly MenuEntity[], nodes: readonly MenuNodeRow[]): MenuEntry[] {
  const entityByTable = new Map<string, MenuEntity>();
  const rank = new Map<string, number>();
  for (const e of entities) {
    if (entityByTable.has(e.table_name)) continue;
    rank.set(e.table_name, entityByTable.size);
    entityByTable.set(e.table_name, e);
  }
  const compareEntities = entityComparator(rank);

  const unique: MenuNodeRow[] = [];
  const seenKeys = new Set<string>();
  for (const n of nodes) {
    if (seenKeys.has(n.node_key)) continue;
    seenKeys.add(n.node_key);
    unique.push(n);
  }

  const parents = effectiveParents(unique);
  const childrenOf = new Map<string | null, MenuNodeRow[]>();
  for (const n of unique) {
    const parent = parents.get(n.node_key) ?? null;
    const list = childrenOf.get(parent);
    if (list) list.push(n);
    else childrenOf.set(parent, [n]);
  }
  const sortNodes = (list: MenuNodeRow[]): MenuNodeRow[] =>
    [...list].sort((a, b) => compareNodes({ sort: a.sort_order, key: a.node_key }, { sort: b.sort_order, key: b.node_key }));

  // Entities that have a node, hidden or not, are placed (or deliberately hidden)
  const withNode = new Set<string>();
  for (const n of unique) if (n.node_kind === 'entity' && n.target_key != null) withNode.add(n.target_key);

  const emitted = new Set<string>();
  const emittedDashboards = new Set<number>();
  /** The node's dashboard, when the caller can see it and no earlier entry links to it. */
  const visibleDashboard = (node: MenuNodeRow): number | undefined => {
    const id = node.dashboard_id;
    if (id == null || node.dashboard_display_name == null || emittedDashboards.has(id)) return undefined;
    emittedDashboards.add(id);
    return id;
  };
  const build = (node: MenuNodeRow): MenuEntry[] => {
    if (node.is_hidden) return [];
    if (node.node_kind === 'heading') {
      const dashboardId = visibleDashboard(node);
      const children = sortNodes(childrenOf.get(node.node_key) ?? []).flatMap(build);
      if (children.length === 0 && dashboardId === undefined) return [];
      return [
        {
          key: node.node_key,
          kind: 'heading',
          label: labelOf(node.display_name, node.node_key),
          ...(dashboardId !== undefined ? { dashboardId } : {}),
          ...(node.icon ? { icon: node.icon } : {}),
          collapsedByDefault: node.collapsed_by_default,
          children,
        },
      ];
    }
    if (node.node_kind === 'dashboard') {
      const dashboardId = visibleDashboard(node);
      const children = sortNodes(childrenOf.get(node.node_key) ?? []).flatMap(build);
      if (dashboardId === undefined) return children;
      return [
        {
          key: node.node_key,
          kind: 'dashboard',
          label: labelOf(node.display_name, node.dashboard_display_name ?? node.node_key),
          dashboardId,
          ...(node.icon ? { icon: node.icon } : {}),
          collapsedByDefault: node.collapsed_by_default,
          children,
        },
      ];
    }
    const children = sortNodes(childrenOf.get(node.node_key) ?? []).flatMap(build);
    const target = node.target_key != null ? entityByTable.get(node.target_key) : undefined;
    if (!target || emitted.has(target.table_name)) return children;
    emitted.add(target.table_name);
    return [
      {
        key: node.node_key,
        kind: 'entity',
        label: labelOf(node.display_name, target.display_name),
        tableName: target.table_name,
        ...(node.icon ? { icon: node.icon } : {}),
        collapsedByDefault: node.collapsed_by_default,
        children,
      },
    ];
  };

  const result: MenuEntry[] = sortNodes(childrenOf.get(null) ?? []).flatMap(build);
  const unplaced = [...entityByTable.values()]
    .filter(e => !withNode.has(e.table_name))
    .sort((a, b) => compareEntities({ sort: a.sort_order, key: a.table_name }, { sort: b.sort_order, key: b.table_name }));
  for (const e of unplaced) {
    result.push({
      key: e.table_name,
      kind: 'entity',
      label: e.display_name,
      tableName: e.table_name,
      collapsedByDefault: false,
      children: [],
    });
  }
  return result;
}

/**
 * Codes of {@link MenuTreeError}; they mirror the structural rules of the
 * database trigger.
 *
 * @consumer typed validateMenuTree
 */
export type MenuTreeErrorCode =
  | 'duplicate-key'
  | 'heading-key'
  | 'heading-label'
  | 'heading-target'
  | 'entity-key'
  | 'unknown-parent'
  | 'parent-kind'
  | 'cycle'
  | 'depth'
  | 'duplicate-entity'
  | 'unknown-target'
  | 'dashboard-key'
  | 'dashboard-children'
  | 'duplicate-dashboard';

/**
 * One structural problem found in a menu tree.
 *
 * @consumer typed validateMenuTree
 */
export interface MenuTreeError {
  code: MenuTreeErrorCode;
  nodeKey: string;
}

/**
 * Checks a menu tree against the structural rules the database trigger
 * enforces, returning every violation as data (in node order), so an editor can
 * report them before saving:
 * - headings sit at the root or under a heading; entity and dashboard nodes at the root, under a heading or
 *   under an entity node; nothing sits under a dashboard node (`dashboard-children`);
 * - depth at most 3 (the root level is 1), no cycles, parents must exist, node keys are unique;
 * - one node per entity, an entity node's key equals its target, a heading key matches `^[a-z][a-z0-9_]*$`
 *   and a heading has a label and no target;
 * - a dashboard node has a `dashboard_id`, no target and the key `dashboard:<id>`, and an entity node has no
 *   `dashboard_id` (`dashboard-key`); one node per dashboard, dashboard nodes and heading links together
 *   (`duplicate-dashboard`);
 * - when `entities` is given, an entity node must target one of them (`unknown-target`).
 *
 * @consumer app
 */
export function validateMenuTree(
  nodes: readonly MenuNodeRow[],
  entities?: readonly Pick<SchemaEntityTable, 'table_name'>[],
): MenuTreeError[] {
  const errors: MenuTreeError[] = [];
  const add = (code: MenuTreeErrorCode, nodeKey: string): void => {
    errors.push({ code, nodeKey });
  };
  const byKey = new Map<string, MenuNodeRow>();
  for (const n of nodes) if (!byKey.has(n.node_key)) byKey.set(n.node_key, n);
  const known = entities ? new Set(entities.map(e => e.table_name)) : undefined;
  const seenKeys = new Set<string>();
  const seenTargets = new Set<string>();
  const seenDashboards = new Set<number>();
  const checkDashboard = (n: MenuNodeRow): void => {
    if (n.dashboard_id == null) return;
    if (seenDashboards.has(n.dashboard_id)) add('duplicate-dashboard', n.node_key);
    seenDashboards.add(n.dashboard_id);
  };

  for (const n of nodes) {
    if (seenKeys.has(n.node_key)) {
      add('duplicate-key', n.node_key);
      continue;
    }
    seenKeys.add(n.node_key);

    if (n.node_kind === 'heading') {
      if (!MENU_HEADING_KEY.test(n.node_key)) add('heading-key', n.node_key);
      if (n.display_name == null || n.display_name.trim() === '') add('heading-label', n.node_key);
      if (n.target_key != null) add('heading-target', n.node_key);
      checkDashboard(n);
    } else if (n.node_kind === 'dashboard') {
      if (n.dashboard_id == null || n.target_key != null || n.node_key !== menuDashboardKey(n.dashboard_id)) {
        add('dashboard-key', n.node_key);
      }
      checkDashboard(n);
    } else {
      if (n.target_key == null || n.node_key !== n.target_key) add('entity-key', n.node_key);
      if (n.dashboard_id != null) add('dashboard-key', n.node_key);
      if (n.target_key != null) {
        if (seenTargets.has(n.target_key)) add('duplicate-entity', n.node_key);
        seenTargets.add(n.target_key);
        if (known && !known.has(n.target_key)) add('unknown-target', n.node_key);
      }
    }

    const parentKey = n.parent_node_key;
    if (parentKey != null) {
      const parent = byKey.get(parentKey);
      if (!parent) add('unknown-parent', n.node_key);
      else if (parent.node_kind === 'dashboard') add('dashboard-children', n.node_key);
      else if (!menuPlacementAllowed(n.node_kind, parent.node_kind)) add('parent-kind', n.node_key);
    }

    // Depth and cycle: walk up while parents resolve
    const seen = new Set<string>([n.node_key]);
    let depth = 1;
    let cursor = parentKey != null ? byKey.get(parentKey) : undefined;
    let cyclic = false;
    while (cursor) {
      if (seen.has(cursor.node_key)) {
        cyclic = true;
        break;
      }
      seen.add(cursor.node_key);
      depth++;
      cursor = cursor.parent_node_key != null ? byKey.get(cursor.parent_node_key) : undefined;
    }
    if (cyclic) add('cycle', n.node_key);
    else if (depth > MAX_MENU_DEPTH) add('depth', n.node_key);
  }
  return errors;
}

/**
 * What a menu entry opens: an entity's table name, or a dashboard (a dashboard
 * entry, or a heading whose title opens it).
 *
 * @consumer typed menuBranchKeys
 */
export type MenuTarget = string | { dashboardId: number };

/** Whether the entry opens `target`. */
function opens(entry: MenuEntry, target: MenuTarget): boolean {
  return typeof target === 'string'
    ? entry.kind === 'entity' && entry.tableName === target
    : entry.dashboardId === target.dashboardId;
}

/**
 * The keys of the ancestors of the entry that opens `target` (a table name, or
 * `{ dashboardId }`), outermost first, so the host can open the active route's
 * branch. Empty when the entry is at the root or is not in the menu.
 *
 * @consumer app
 */
export function menuBranchKeys(menu: readonly MenuEntry[], target: MenuTarget): string[] {
  const walk = (entries: readonly MenuEntry[], trail: string[]): string[] | undefined => {
    for (const entry of entries) {
      if (opens(entry, target)) return trail;
      const found = walk(entry.children, [...trail, entry.key]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(menu, []) ?? [];
}
