/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metadata for synthetic M:M properties from schema_m2m_properties VIEW.
 * Bridges metadata.properties flags to virtual M:M columns that don't exist
 * in information_schema.columns (and thus aren't returned by schema_properties).
 *
 * @since v0.46.0
 * @consumer app
 */
export interface M2mPropertyMetadata {
  table_name: string;
  column_name: string;
  options_source_rpc: string | null;
  depends_on_columns: string[] | null;
  fk_search_modal: boolean;
  show_inline: boolean;
  display_name: string | null;
  sort_order: number | null;
  column_width: number | null;
  show_on_list: boolean | null;
  show_on_create: boolean | null;
  show_on_edit: boolean | null;
  show_on_detail: boolean | null;
  options_filter_column: string | null;
}

/**
 * Status option for dropdowns and filters.
 * Simplified version of StatusValue for UI components.
 *
 * @consumer app
 */
export interface StatusOption {
  id: number;
  display_name: string;
  color: string | null;
  status_key?: string;
}

/**
 * Category option for dropdowns and filters.
 * Same shape as StatusOption (both are colored badge enums).
 * Added in v0.34.0.
 *
 * @consumer app
 */
export interface CategoryOption {
  id: number;
  display_name: string;
  color: string | null;
}
