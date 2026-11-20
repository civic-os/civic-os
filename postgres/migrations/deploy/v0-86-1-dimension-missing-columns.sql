-- Deploy civic_os:v0-86-1-dimension-missing-columns to pg
-- requires: v0-86-1-module-interface
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A dimension whose registry names a column that no longer exists is reported, not trusted (v0.86.1).
-- Answers Module Install Support open question 2: the registry keeps column names (renames are not
-- followed through attnum), and a rename cannot be refused, since that needs an event trigger, which needs a
-- superuser and is refused on some managed databases. Instead schema_dimensions checks every named column
-- against pg_catalog on each read:
--
--   public.schema_dimensions.missing_columns   registry columns (key, label, parent, active, external id,
--                                              sort, in that order) that the table no longer has; every
--                                              named column when the table itself is gone; empty when healthy
--
-- Clients treat a dimension with missing columns as unregistered (core dimensionFor()), so its FK columns fall
-- back to the ordinary dropdown instead of failing. compare_interface() keeps reporting dimension_mismatch.
-- Re-registering with the new names repairs it.
-- Design: docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md (Decisions after build).

BEGIN;

DROP VIEW public.schema_dimensions;

CREATE VIEW public.schema_dimensions
WITH (security_invoker = true) AS
SELECT
    d.dimension_key,
    d.display_name,
    d.table_schema,
    d.table_name,
    d.key_column,
    d.label_column,
    d.parent_column,
    d.active_column,
    d.external_id_column,
    d.default_value_id,
    d.hide_when_single,
    d.sort_order,
    d.sort_column,
    ARRAY(
      SELECT r.col
      FROM unnest(ARRAY[d.key_column, d.label_column, d.parent_column, d.active_column, d.external_id_column,
                        d.sort_column]) WITH ORDINALITY AS r(col, n)
      WHERE r.col IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = to_regclass(format('%I.%I', d.table_schema, d.table_name))
            AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY r.n
    )::NAME[] AS missing_columns
FROM metadata.dimensions d
ORDER BY d.sort_order, d.dimension_key;

COMMENT ON VIEW public.schema_dimensions IS
    'Registered dimensions for clients: table, column roles, default value, hide_when_single, sort column, and missing_columns (registry columns the table no longer has; clients treat such a dimension as unregistered). Added in v0.85.0; missing_columns since v0.86.1.';

GRANT SELECT ON public.schema_dimensions TO web_anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
