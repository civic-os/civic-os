/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A row of `public.schema_dimensions` (v0.85.0): a lookup table registered with `register_dimension()`.
 * Every BIGINT foreign key into `public` that targets a registered table's key column is a `Dimension`
 * property (v0.86.0).
 *
 * @consumer app
 */
export interface SchemaDimension {
  dimension_key: string;
  display_name: string;
  table_schema: string;
  table_name: string;
  key_column: string;
  label_column: string;
  /** NULL for a flat dimension. */
  parent_column: string | null;
  /** Rows are retired (false), never deleted. */
  active_column: string;
  external_id_column: string | null;
  /** Filled into an empty FK on insert, unless retired. */
  default_value_id: number | null;
  /** With exactly one active row, clients hide the control; the server fills the value. */
  hide_when_single: boolean;
  /** Orders the dimensions in the registry, not a dimension's rows. */
  sort_order: number;
  /**
   * Column that orders a dimension's rows within each parent, then label, then key (v0.86.0); NULL orders by
   * label. Optional so registry rows from a v0.85.0 instance still type-check.
   */
  sort_column?: string | null;
}
