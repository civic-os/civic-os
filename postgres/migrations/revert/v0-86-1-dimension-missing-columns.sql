-- Revert civic_os:v0-86-1-dimension-missing-columns from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores the v0.86.0 schema_dimensions (no missing_columns).

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
    d.sort_column
FROM metadata.dimensions d
ORDER BY d.sort_order, d.dimension_key;

COMMENT ON VIEW public.schema_dimensions IS
    'Registered dimensions for clients: table, column roles, default value and hide_when_single. Added in v0.85.0.';

GRANT SELECT ON public.schema_dimensions TO web_anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
