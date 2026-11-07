-- Deploy civic_os:v0-81-1-translations-cache-version
-- Requires: v0-81-0-menu-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- v0.81.1 -- A translations cache version that moves on every write (issue #78).
--
--   metadata.translations_version  single row stamped by every write to metadata.translations
--   public.schema_cache_versions   the 'translations' row reads it instead of MAX(updated_at)
--
-- MAX(updated_at) never moved on a delete, so an admin reverting a label to its default left open
-- browsers on the old text. Same pattern as metadata.menu_version (v0.81.0): statement-level triggers
-- stamp a singleton row on INSERT, UPDATE, DELETE and TRUNCATE. Unlike menu_version, a statement that
-- changes no row does not stamp: every signed-in user holds DELETE on public.translations and RLS
-- filters it to nothing, so an empty statement would let any user force a cache refresh in every
-- open browser. The INSERT, UPDATE and DELETE triggers read a transition table to tell.
--
-- Framework migration: no schema decision (ADR) is recorded.

BEGIN;

-- ============================================================================
-- 1. TABLE
-- ============================================================================

CREATE TABLE metadata.translations_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO metadata.translations_version (singleton, changed_at) VALUES (TRUE, clock_timestamp());

COMMENT ON TABLE metadata.translations_version IS
    'Single row: when metadata.translations last changed (insert, update, delete or truncate). Read by schema_cache_versions as the translations version. Added in v0.81.1.';

-- No grants to API roles: only schema_cache_versions (a definer view) and the stamp trigger read or write it.

-- ============================================================================
-- 2. TRIGGERS
-- ============================================================================

CREATE FUNCTION metadata.translations_stamp_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
BEGIN
  -- changed_rows is the statement's transition table; the TRUNCATE trigger has none.
  -- Nested IF: plpgsql plans the inner query only when it is reached.
  IF TG_OP <> 'TRUNCATE' THEN
    IF NOT EXISTS (SELECT 1 FROM changed_rows) THEN
      RETURN NULL;
    END IF;
  END IF;
  INSERT INTO metadata.translations_version (singleton, changed_at) VALUES (TRUE, clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET changed_at = EXCLUDED.changed_at;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata.translations_stamp_version() IS
    'Statement-level AFTER trigger of metadata.translations: stamps metadata.translations_version when a statement changed at least one row, or on truncate, so deletes move the translations cache version too. Added in v0.81.1.';

-- One trigger per event: a transition table belongs to a single-event trigger here, and all three
-- name it changed_rows so one function serves them.
CREATE TRIGGER translations_stamp_version_insert
    AFTER INSERT ON metadata.translations
    REFERENCING NEW TABLE AS changed_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.translations_stamp_version();

CREATE TRIGGER translations_stamp_version_update
    AFTER UPDATE ON metadata.translations
    REFERENCING NEW TABLE AS changed_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.translations_stamp_version();

CREATE TRIGGER translations_stamp_version_delete
    AFTER DELETE ON metadata.translations
    REFERENCING OLD TABLE AS changed_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.translations_stamp_version();

CREATE TRIGGER translations_stamp_version_truncate
    AFTER TRUNCATE ON metadata.translations
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.translations_stamp_version();

REVOKE EXECUTE ON FUNCTION metadata.translations_stamp_version() FROM PUBLIC;

-- ============================================================================
-- 3. schema_cache_versions: the 'translations' row reads translations_version
-- ============================================================================
-- v0.81.0 body otherwise unchanged. Stays a definer view (allowlisted in
-- tests/functional/view-security-guard-test.sh); CREATE OR REPLACE keeps its grants.

CREATE OR REPLACE VIEW public.schema_cache_versions AS
SELECT 'entities' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
       ) AS version
UNION ALL
SELECT 'properties' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
       ) AS version
UNION ALL
SELECT 'constraint_messages' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) AS version
UNION ALL
SELECT 'introspection' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_functions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.database_triggers),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.trigger_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.notification_triggers)
       ) AS version
UNION ALL
SELECT 'categories' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.categories),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.category_groups)
       ) AS version
UNION ALL
SELECT 'translations' AS cache_name,
       (SELECT COALESCE(MAX(changed_at), '1970-01-01'::timestamptz) FROM metadata.translations_version) AS version
UNION ALL
SELECT 'profile_extensions' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.user_profile_extensions) AS version
UNION ALL
SELECT 'instance_config' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.instance_config) AS version
UNION ALL
SELECT 'statuses' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.statuses),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.status_types)
       ) AS version
UNION ALL
SELECT 'menu' AS cache_name,
       (SELECT COALESCE(MAX(changed_at), '1970-01-01'::timestamptz) FROM metadata.menu_version) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, profile_extensions, instance_config,
     statuses, and menu.';

COMMIT;
