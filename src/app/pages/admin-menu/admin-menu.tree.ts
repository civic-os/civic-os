/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * Pure tree operations for the menu editor. The draft is a flat list of rows in
 * depth-first display order; a row's parent is the nearest previous row with
 * depth - 1 (the root level is depth 1). The placement rules mirror the
 * database trigger and core's `validateMenuTree`: depth at most 3, headings at
 * the root or under a heading, entity rows at the root, under a heading or
 * under an entity row.
 */

import type { MenuNodeRow } from '@civic-os/core';

export const MAX_MENU_DEPTH = 3;

export interface DraftRow {
  /** The node key: the table name for an entity row, an immutable slug for a heading. */
  key: string;
  kind: 'heading' | 'entity';
  targetKey: string | null;
  /** Label override; null falls back to the entity's display name (headings always have one). */
  label: string | null;
  icon: string | null;
  hidden: boolean;
  collapsed: boolean;
  /** 1 = root. */
  depth: number;
}

/** Spacing between sibling sort_order values, so a hand-written row can slot in between. */
const SORT_STEP = 10;

/** Sorts siblings by (sort_order ?? 0, key): the order core's buildMenu uses. */
function sortSiblings(list: MenuNodeRow[]): MenuNodeRow[] {
  return [...list].sort((a, b) => {
    const bySort = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (bySort !== 0) return bySort;
    return a.node_key < b.node_key ? -1 : a.node_key > b.node_key ? 1 : 0;
  });
}

/** Menu nodes (from the database) to draft rows in depth-first order. Orphans and cycle members surface at the root. */
export function nodesToRows(nodes: readonly MenuNodeRow[]): DraftRow[] {
  const byKey = new Map<string, MenuNodeRow>();
  for (const n of nodes) if (!byKey.has(n.node_key)) byKey.set(n.node_key, n);
  const childrenOf = new Map<string | null, MenuNodeRow[]>();
  for (const n of byKey.values()) {
    const parent = n.parent_node_key != null && byKey.has(n.parent_node_key) ? n.parent_node_key : null;
    const list = childrenOf.get(parent);
    if (list) list.push(n);
    else childrenOf.set(parent, [n]);
  }
  const rows: DraftRow[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const n of sortSiblings(childrenOf.get(parent) ?? [])) {
      if (visited.has(n.node_key)) continue;
      visited.add(n.node_key);
      rows.push({
        key: n.node_key,
        kind: n.node_kind,
        targetKey: n.target_key,
        label: n.display_name,
        icon: n.icon,
        hidden: n.is_hidden,
        collapsed: n.collapsed_by_default,
        depth,
      });
      walk(n.node_key, depth + 1);
    }
  };
  walk(null, 1);
  // Members of a cycle never reach the root walk: place them at the root so nothing is silently lost
  for (const n of byKey.values()) {
    if (!visited.has(n.node_key)) {
      visited.add(n.node_key);
      rows.push({
        key: n.node_key, kind: n.node_kind, targetKey: n.target_key, label: n.display_name,
        icon: n.icon, hidden: n.is_hidden, collapsed: n.collapsed_by_default, depth: 1,
      });
      walk(n.node_key, 2);
    }
  }
  return rows;
}

/** The index of the parent row of `rows[index]`, or -1 at the root. */
export function parentIndex(rows: readonly DraftRow[], index: number): number {
  const depth = rows[index].depth;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].depth === depth - 1) return i;
  }
  return -1;
}

/** Draft rows to menu nodes: parent from nesting, sort_order = position among siblings x 10. */
export function rowsToNodes(rows: readonly DraftRow[]): MenuNodeRow[] {
  const stack: string[] = [];
  const counters = new Map<string | null, number>();
  return rows.map(row => {
    stack.length = Math.max(0, row.depth - 1);
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    const position = counters.get(parent) ?? 0;
    counters.set(parent, position + 1);
    stack[row.depth - 1] = row.key;
    stack.length = row.depth;
    const label = row.label != null && row.label.trim() !== '' ? row.label : null;
    return {
      node_key: row.key,
      node_kind: row.kind,
      target_key: row.kind === 'entity' ? row.targetKey : null,
      display_name: label,
      icon: row.icon != null && row.icon.trim() !== '' ? row.icon.trim() : null,
      parent_node_key: parent,
      sort_order: position * SORT_STEP,
      is_hidden: row.hidden,
      collapsed_by_default: row.collapsed,
    };
  });
}

/** One past the last row of the subtree rooted at `index`. */
export function subtreeEnd(rows: readonly DraftRow[], index: number): number {
  let end = index + 1;
  while (end < rows.length && rows[end].depth > rows[index].depth) end++;
  return end;
}

/** Levels below the row in its subtree (0 for a leaf). */
function subtreeHeight(rows: readonly DraftRow[], index: number): number {
  let max = rows[index].depth;
  for (let i = index + 1; i < subtreeEnd(rows, index); i++) max = Math.max(max, rows[i].depth);
  return max - rows[index].depth;
}

/** The start index of the previous sibling's subtree, or -1. */
export function previousSibling(rows: readonly DraftRow[], index: number): number {
  const depth = rows[index].depth;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].depth < depth) return -1;
    if (rows[i].depth === depth) return i;
  }
  return -1;
}

/** The index of the next sibling, or -1. */
export function nextSibling(rows: readonly DraftRow[], index: number): number {
  const end = subtreeEnd(rows, index);
  return end < rows.length && rows[end].depth === rows[index].depth ? end : -1;
}

export function canMoveUp(rows: readonly DraftRow[], index: number): boolean {
  return previousSibling(rows, index) !== -1;
}

export function canMoveDown(rows: readonly DraftRow[], index: number): boolean {
  return nextSibling(rows, index) !== -1;
}

function moveBlock(rows: readonly DraftRow[], from: number, end: number, insertAt: number): DraftRow[] {
  const block = rows.slice(from, end);
  const rest = [...rows.slice(0, from), ...rows.slice(end)];
  rest.splice(insertAt, 0, ...block);
  return rest;
}

/** Moves the row and its subtree before its previous sibling. Unchanged when there is none. */
export function moveUp(rows: readonly DraftRow[], index: number): DraftRow[] {
  const prev = previousSibling(rows, index);
  if (prev === -1) return [...rows];
  return moveBlock(rows, index, subtreeEnd(rows, index), prev);
}

/** Moves the row and its subtree after its next sibling's subtree. Unchanged when there is none. */
export function moveDown(rows: readonly DraftRow[], index: number): DraftRow[] {
  const next = nextSibling(rows, index);
  if (next === -1) return [...rows];
  const nextSize = subtreeEnd(rows, next) - next;
  return moveBlock(rows, index, subtreeEnd(rows, index), index + nextSize);
}

/** Whether the row can become the last child of its previous sibling. */
export function canIndent(rows: readonly DraftRow[], index: number): boolean {
  const prev = previousSibling(rows, index);
  if (prev === -1) return false;
  if (rows[index].depth + 1 + subtreeHeight(rows, index) > MAX_MENU_DEPTH) return false;
  // A heading may only sit under a heading
  if (rows[index].kind === 'heading' && rows[prev].kind !== 'heading') return false;
  return true;
}

/** Makes the row (and its subtree) the last child of its previous sibling. Unchanged when not allowed. */
export function indent(rows: readonly DraftRow[], index: number): DraftRow[] {
  if (!canIndent(rows, index)) return [...rows];
  const end = subtreeEnd(rows, index);
  return rows.map((row, i) => (i >= index && i < end ? { ...row, depth: row.depth + 1 } : row));
}

export function canOutdent(rows: readonly DraftRow[], index: number): boolean {
  return rows[index].depth > 1;
}

/** Moves the row (and its subtree) up one level, to just after its former parent's subtree. */
export function outdent(rows: readonly DraftRow[], index: number): DraftRow[] {
  if (!canOutdent(rows, index)) return [...rows];
  const parent = parentIndex(rows, index);
  const end = subtreeEnd(rows, index);
  const parentEnd = subtreeEnd(rows, parent);
  const shifted = rows.map((row, i) => (i >= index && i < end ? { ...row, depth: row.depth - 1 } : row));
  // The row is the last of its parent's children when nothing follows it inside the parent
  if (end >= parentEnd) return shifted;
  const block = shifted.slice(index, end);
  const rest = [...shifted.slice(0, index), ...shifted.slice(end)];
  // After removal the parent's subtree ends at parentEnd - (end - index)
  rest.splice(parentEnd - (end - index), 0, ...block);
  return rest;
}

/** Removes the row and its whole subtree. Entities among them become unplaced (the page derives the tray). */
export function removeRow(rows: readonly DraftRow[], index: number): DraftRow[] {
  return [...rows.slice(0, index), ...rows.slice(subtreeEnd(rows, index))];
}

/** Appends a row at the root, last. */
export function appendRoot(rows: readonly DraftRow[], row: Omit<DraftRow, 'depth'>): DraftRow[] {
  return [...rows, { ...row, depth: 1 }];
}

/** Whether a row list satisfies every placement rule (depth jumps, depth cap, heading parents). */
export function isValidShape(rows: readonly DraftRow[]): boolean {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.depth < 1 || row.depth > MAX_MENU_DEPTH) return false;
    if (i === 0 ? row.depth !== 1 : row.depth > rows[i - 1].depth + 1) return false;
    if (row.kind === 'heading' && row.depth > 1 && rows[parentIndex(rows, i)].kind !== 'heading') return false;
  }
  return true;
}

/**
 * Applies a drag-drop: the row and its subtree land where `toIndex` (the CDK drop index in the
 * flat list) says. The row becomes a sibling of the row it lands in front of (at the end of the list
 * it keeps its depth); when that depth is invalid there, the nearest valid depth is used. Dropping inside its own subtree, or where no depth is valid, changes nothing.
 */
export function dropReorder(rows: readonly DraftRow[], fromIndex: number, toIndex: number): DraftRow[] {
  const end = subtreeEnd(rows, fromIndex);
  const size = end - fromIndex;
  if (toIndex === fromIndex || (toIndex > fromIndex && toIndex < end)) return [...rows];
  const insertAt = toIndex > fromIndex ? toIndex - size + 1 : toIndex;
  const original = rows[fromIndex].depth;
  const moved = moveBlock(rows, fromIndex, end, insertAt);
  // Dropping in front of a row makes the dropped row its sibling; at the end of the list it keeps its depth
  const preferred = insertAt + size < moved.length ? moved[insertAt + size].depth : original;
  const candidates: number[] = [];
  for (let d = 0; d <= MAX_MENU_DEPTH; d++) {
    for (const c of [preferred - d, preferred + d]) {
      if (c >= 1 && c <= MAX_MENU_DEPTH && !candidates.includes(c)) candidates.push(c);
    }
  }
  for (const depth of candidates) {
    const delta = depth - original;
    const next = moved.map((row, i) => (i >= insertAt && i < insertAt + size ? { ...row, depth: row.depth + delta } : row));
    if (isValidShape(next)) return next;
  }
  return [...rows];
}

/** Where a row sits: its parent's key (null at the root), its 1-based position among its siblings and the sibling count. */
export function describePosition(rows: readonly DraftRow[], key: string): { parentKey: string | null; position: number; count: number } | undefined {
  const index = rows.findIndex(r => r.key === key);
  if (index === -1) return undefined;
  const parent = parentIndex(rows, index);
  let position = 1;
  let count = 0;
  const depth = rows[index].depth;
  const start = parent === -1 ? 0 : parent + 1;
  const end = parent === -1 ? rows.length : subtreeEnd(rows, parent);
  for (let i = start; i < end; i++) {
    if (rows[i].depth !== depth) continue;
    count++;
    if (i < index) position++;
  }
  return { parentKey: parent === -1 ? null : rows[parent].key, position, count };
}

const HEADING_SLUG_MAX = 40;

/** An immutable heading key from a label: lowercase slug, `^[a-z][a-z0-9_]*$`, unique among `taken` (numeric suffix). */
export function headingKeyFromLabel(label: string, taken: ReadonlySet<string>): string {
  let slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, HEADING_SLUG_MAX)
    .replace(/_+$/g, '');
  if (slug === '') slug = 'heading';
  if (!/^[a-z]/.test(slug)) slug = `h_${slug}`;
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}_${n}`)) n++;
  return `${slug}_${n}`;
}
