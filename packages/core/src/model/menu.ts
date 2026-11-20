/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The kinds of menu node: a labelled `heading` (which may open a dashboard),
 * an `entity` link, or a `dashboard` link (since v0.83.0), which has no children.
 *
 * @consumer typed MenuNodeRow
 */
export type MenuNodeKind = 'heading' | 'entity' | 'dashboard';

/**
 * One row of the `schema_menu_nodes` view: a node of the sidebar menu tree.
 * `display_name` is already translated server-side. An entity node has
 * `node_key === target_key`; a heading key matches `^[a-z][a-z0-9_]*$`; a
 * dashboard node's key is `dashboard:<dashboard_id>`.
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
  /** The dashboard a dashboard node links to, or the dashboard a heading's title opens; `null` otherwise. */
  dashboard_id: number | null;
  /**
   * The dashboard's translated title, `null` when the caller cannot see the dashboard
   * (or the node has none). A dashboard node or heading link shows only when it is set.
   */
  dashboard_display_name: string | null;
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
  /** Resolved label: the node's `display_name`, else the entity's name or the dashboard's title. */
  label: string;
  /** Set for `entity` entries: the table the link opens. */
  tableName?: string;
  /** Set for `dashboard` entries, and for headings whose title opens a dashboard the caller can see. */
  dashboardId?: number;
  icon?: string;
  /** Headings and parents start collapsed. Always `false` for an entity without a node. */
  collapsedByDefault: boolean;
  children: readonly MenuEntry[];
}
