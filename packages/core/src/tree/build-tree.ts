/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Trees over adjacency-list rows (a key and a parent key per row), shared by every view of a hierarchy
 * (docs/notes/TREE_LIST_VIEW_DESIGN.md, Relation to the Dimension property type). Pure and total: bad
 * data never throws and never loops, it degrades.
 *
 *   - Sibling order is input order: the server orders rows, the tree keeps that order within siblings.
 *   - Orphans (a parent key not among the rows, e.g. hidden by RLS) become roots, marked `orphan`.
 *   - Cycles (possible on a table without the server guard) are broken: every row on a cycle becomes a
 *     root, marked `cycle`, and the rows hanging below it stay under it.
 *   - Keys are compared by value after normalization to string, so a BIGINT key read as a number and a
 *     parent key read as a string still match.
 */

/**
 * A row key. PostgREST returns BIGINT keys as numbers; any key type is compared as its string form.
 *
 * @consumer typed buildTree
 */
export type TreeKey = string | number;

/**
 * Where a row sits in the tree, from {@link buildTree}.
 *
 * @consumer typed buildTree
 */
export interface TreeNodeInfo {
  readonly key: TreeKey;
  /** 1 for a root. */
  readonly level: number;
  /** Ancestor keys, root first, the row itself excluded. */
  readonly ancestors: readonly TreeKey[];
  /** Child keys in input order. */
  readonly children: readonly TreeKey[];
  /** Number of rows below this one, at any depth. */
  readonly descendantCount: number;
  /** The row names a parent that is not among the rows. */
  readonly orphan: boolean;
  /** The row was on a parent cycle and was made a root. */
  readonly cycle: boolean;
}

/**
 * An immutable index over a tree's rows, from {@link buildTree}.
 *
 * @consumer app
 */
export interface TreeIndex {
  /** Root keys in input order: true roots, orphans and broken cycle members. */
  readonly roots: readonly TreeKey[];
  /** Every row's position, by key (normalized to string). */
  node(key: TreeKey): TreeNodeInfo | undefined;
  /** Keys of every row below `key`, at any depth, in depth-first order. */
  descendants(key: TreeKey): readonly TreeKey[];
  /** Number of rows indexed. */
  readonly size: number;
}

/**
 * Property names of the key and parent columns.
 *
 * @consumer typed buildTree
 */
export interface TreeColumns<T> {
  readonly key: keyof T & string;
  readonly parent: keyof T & string;
}

function norm(key: TreeKey): string {
  return String(key);
}

/**
 * Indexes rows into a tree by their key and parent columns. Rows with a NULL, undefined or missing parent
 * are roots; a duplicate key keeps its first row.
 *
 * @consumer app
 */
export function buildTree<T extends object>(rows: readonly T[], columns: TreeColumns<T>): TreeIndex {
  const keys: TreeKey[] = [];
  const parentOf = new Map<string, string | null>();
  const original = new Map<string, TreeKey>();

  for (const row of rows) {
    const raw = (row as Record<string, unknown>)[columns.key];
    if (raw === null || raw === undefined) continue;
    const key = raw as TreeKey;
    const k = norm(key);
    if (original.has(k)) continue;
    original.set(k, key);
    keys.push(key);
    const p = (row as Record<string, unknown>)[columns.parent];
    parentOf.set(k, p === null || p === undefined ? null : norm(p as TreeKey));
  }

  // Break cycles: walk each row's parent chain; a chain that returns to a row already on the current walk
  // is a cycle, and every row on it becomes a root.
  const cycle = new Set<string>();
  const settled = new Set<string>();
  for (const key of keys) {
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cur: string | null = norm(key);
    while (cur !== null && !settled.has(cur) && original.has(cur)) {
      if (onPath.has(cur)) {
        for (const c of path.slice(onPath.get(cur))) cycle.add(c);
        break;
      }
      onPath.set(cur, path.length);
      path.push(cur);
      cur = cycle.has(cur) ? null : (parentOf.get(cur) ?? null);
    }
    for (const p of path) settled.add(p);
  }

  const children = new Map<string, TreeKey[]>();
  const roots: TreeKey[] = [];
  const orphan = new Set<string>();
  for (const key of keys) {
    const k = norm(key);
    const p = parentOf.get(k) ?? null;
    if (p === null || cycle.has(k)) {
      roots.push(key);
    } else if (!original.has(p)) {
      orphan.add(k);
      roots.push(key);
    } else {
      const list = children.get(p);
      if (list) list.push(key);
      else children.set(p, [key]);
    }
  }

  // Depth-first from the roots: levels, ancestor paths and descendant lists. Every row is reachable once,
  // since each non-root has exactly one parent and cycles were broken.
  const info = new Map<string, TreeNodeInfo>();
  const below = new Map<string, TreeKey[]>();
  const visit = (key: TreeKey, ancestors: readonly TreeKey[]): TreeKey[] => {
    const k = norm(key);
    const kids = children.get(k) ?? [];
    const path = [...ancestors, key];
    const desc: TreeKey[] = [];
    for (const child of kids) {
      desc.push(child, ...visit(child, path));
    }
    below.set(k, desc);
    info.set(k, {
      key,
      level: ancestors.length + 1,
      ancestors,
      children: kids,
      descendantCount: desc.length,
      orphan: orphan.has(k),
      cycle: cycle.has(k),
    });
    return desc;
  };
  for (const root of roots) visit(root, []);

  return {
    roots,
    size: info.size,
    node: (key) => info.get(norm(key)),
    descendants: (key) => below.get(norm(key)) ?? [],
  };
}

/**
 * One visible row, in display order, from {@link flattenTree}.
 *
 * @consumer app
 */
export interface FlatTreeRow {
  readonly key: TreeKey;
  /** 1-based, for indentation and `aria-level`. */
  readonly level: number;
  /** Visible siblings, for `aria-setsize`. */
  readonly setSize: number;
  /** 1-based position among the visible siblings, for `aria-posinset`. */
  readonly posInSet: number;
  readonly hasChildren: boolean;
  /** The row's children are shown. */
  readonly expanded: boolean;
  /** With `matches`: the row matched, or is shown only as an ancestor of a match. */
  readonly match?: 'match' | 'context';
}

/**
 * What {@link flattenTree} shows.
 *
 * @consumer typed flattenTree
 */
export interface FlattenOptions {
  /** Rows whose children are shown, or `'all'`. Ignored for ancestors of matches, which always open. */
  readonly expanded?: ReadonlySet<TreeKey> | 'all';
  /**
   * When given, only matching rows and their ancestors are shown; ancestors open so every match is
   * visible. Keys compare by string form.
   */
  readonly matches?: ReadonlySet<TreeKey>;
}

/**
 * The visible rows of a tree in display order (depth first, input order within siblings).
 *
 * @consumer app
 */
export function flattenTree(tree: TreeIndex, options: FlattenOptions = {}): readonly FlatTreeRow[] {
  const expandedAll = options.expanded === 'all';
  const expanded = new Set<string>(
    options.expanded === undefined || options.expanded === 'all' ? [] : [...options.expanded].map(norm),
  );

  let shown: Set<string> | undefined;
  let matched: Set<string> | undefined;
  if (options.matches) {
    matched = new Set([...options.matches].map(norm));
    shown = new Set<string>();
    for (const m of matched) {
      const n = tree.node(m);
      if (!n) continue;
      shown.add(m);
      for (const a of n.ancestors) shown.add(norm(a));
    }
  }

  const out: FlatTreeRow[] = [];
  const walk = (siblings: readonly TreeKey[]): void => {
    const visible = shown ? siblings.filter((s) => shown.has(norm(s))) : siblings;
    visible.forEach((key, i) => {
      const n = tree.node(key)!;
      const k = norm(key);
      const open =
        n.children.length > 0 &&
        (shown ? n.children.some((c) => shown.has(norm(c))) : expandedAll || expanded.has(k));
      out.push({
        key,
        level: n.level,
        setSize: visible.length,
        posInSet: i + 1,
        hasChildren: n.children.length > 0,
        expanded: open,
        ...(matched ? { match: matched.has(k) ? 'match' as const : 'context' as const } : {}),
      });
      if (open) walk(n.children);
    });
  };
  walk(tree.roots);
  return out;
}
