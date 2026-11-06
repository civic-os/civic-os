/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The two kinds of menu node: a labelled `heading` with no target, or an
 * `entity` link.
 *
 * @consumer typed MenuNodeRow
 */
export type MenuNodeKind = 'heading' | 'entity';

/**
 * One row of the `schema_menu_nodes` view: a node of the sidebar menu tree.
 * `display_name` is already translated server-side. An entity node has
 * `node_key === target_key`; a heading key matches `^[a-z][a-z0-9_]*$`.
 *
 * @consumer app
 */
export interface MenuNodeRow {
  node_key: string;
  node_kind: MenuNodeKind;
  /** The entity's table name for an entity node; `null` for a heading. */
  target_key: string | null;
  /** Label override; `null` falls back to the entity's display name. */
  display_name: string | null;
  icon: string | null;
  parent_node_key: string | null;
  sort_order: number | null;
  is_hidden: boolean;
  collapsed_by_default: boolean;
}

/**
 * One entry of the built, visible menu tree (see `buildMenu`).
 *
 * @consumer app
 */
export interface MenuEntry {
  /** The node key, or the table name for an entity that has no node. */
  key: string;
  kind: MenuNodeKind;
  /** Resolved label: the node's `display_name`, else the entity's. */
  label: string;
  /** Set for `entity` entries: the table the link opens. */
  tableName?: string;
  icon?: string;
  /** Headings and parents start collapsed. Always `false` for an entity without a node. */
  collapsedByDefault: boolean;
  children: readonly MenuEntry[];
}
