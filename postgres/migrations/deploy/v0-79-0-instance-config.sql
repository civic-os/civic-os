-- Deploy civic_os:v0-79-0-instance-config to pg
-- requires: v0-77-2-about-core-version-label
--
-- Instance config store (design: docs/notes/INSTANCE_SETUP_DESIGN.md, Part 1).
--
--   metadata.instance_config_groups   display groups for the admin config page
--   metadata.instance_config          key/value store for instance-level settings, one row per key
--   public.instance_config            the PostgREST view clients read (security_invoker)
--   public.set_instance_config()      the permission-checked write path
--   metadata.instance_config_normalize()  trigger: the one place values and defaults are validated and normalized by type
--   public.get_config()               SQL-side read of one value (the value, else the key's default)
--   public.schema_cache_versions      gains an 'instance_config' version (when config last changed)
--
-- Rows are the keys the framework itself reads; their values start NULL (not set). Keys are never
-- created or deleted over the API: the only API write is UPDATE of config_value, through RLS gated by
-- the metadata.instance_config:update permission (granted to admin). Anonymous callers see only rows
-- flagged is_public. The migration seeds shape and framework keys only (ON CONFLICT DO NOTHING) and
-- records no schema decision (framework changes do not log ADRs). The table is not a CRUD entity:
-- no metadata.entities row, so schema_contract_hash() is unaffected.

BEGIN;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

CREATE TABLE metadata.instance_config_groups (
    group_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE metadata.instance_config_groups IS
    'Display groups for the instance config admin page. Added in v0.79.0.';
COMMENT ON COLUMN metadata.instance_config_groups.group_key IS 'Stable identifier of the group.';
COMMENT ON COLUMN metadata.instance_config_groups.display_name IS 'Heading shown on the config page.';
COMMENT ON COLUMN metadata.instance_config_groups.description IS 'Short explanation shown under the heading.';
COMMENT ON COLUMN metadata.instance_config_groups.icon IS 'Material icon name.';
COMMENT ON COLUMN metadata.instance_config_groups.sort_order IS 'Group order on the config page (ascending).';

CREATE TABLE metadata.instance_config (
    config_key TEXT PRIMARY KEY,
    config_value TEXT,
    default_value TEXT,
    config_type TEXT NOT NULL DEFAULT 'string',
    display_name TEXT NOT NULL,
    description TEXT,
    group_key TEXT REFERENCES metadata.instance_config_groups(group_key) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_public BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT instance_config_type_check CHECK (
        config_type IN ('string', 'integer', 'number', 'boolean', 'json', 'theme', 'locale', 'locale_list')),
    -- Framework keys take their default from the deployment's ENV chain (the frontend needs it before
    -- the first request), so a default here would be a second source the frontend never reads.
    CONSTRAINT instance_config_framework_default_check CHECK (
        default_value IS NULL OR config_key NOT IN (
            'app_title', 'default_theme', 'default_locale', 'supported_locales', 'sms_configured',
            'matomo_enabled', 'stripe_publishable_key', 'map_default_lat', 'map_default_lng', 'map_default_zoom'))
);

CREATE INDEX idx_instance_config_group_key ON metadata.instance_config(group_key);

CREATE TRIGGER set_updated_at_trigger
    BEFORE UPDATE ON metadata.instance_config
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- The single validation path: every write to config_value (the RPC, or a direct UPDATE through the API)
-- is normalized and checked by the key's config_type. Blank (including tab, CR and LF) stores NULL;
-- invalid input raises check_violation with a human message naming the key. INSERTs skip the config_value
-- check; the seed is an UPDATE and is checked. The same function checks default_value (trigger argument
-- 'default_value') on INSERT and on UPDATE of it, so a bad default fails where the key is defined.
CREATE FUNCTION metadata.instance_config_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_trim CONSTANT TEXT := E' \t\r\n';
  v_is_default CONSTANT BOOLEAN := TG_ARGV[0] = 'default_value';
  v_val TEXT := CASE WHEN v_is_default THEN NEW.default_value ELSE NEW.config_value END;
  v_key TEXT := NEW.config_key || CASE WHEN v_is_default THEN ' default' ELSE '' END;
  v_item TEXT;
  v_items TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_val IS NULL OR btrim(v_val, v_trim) = '' THEN
    IF v_is_default THEN NEW.default_value := NULL; ELSE NEW.config_value := NULL; END IF;
    RETURN NEW;
  END IF;

  IF NEW.config_type IN ('string', 'theme') THEN
    NULL;  -- stored as given
  ELSIF NEW.config_type = 'integer' THEN
    v_val := btrim(v_val, v_trim);
    IF v_val !~ '^-?[0-9]+$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be a whole number', v_key);
    END IF;
    BEGIN
      PERFORM v_val::integer;
    EXCEPTION WHEN numeric_value_out_of_range THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s must be a whole number within the integer range', v_key);
    END;
  ELSIF NEW.config_type = 'number' THEN
    -- plain decimal only: numeric would also accept 0x10, 1_000 and 1e400, which JavaScript reads differently
    v_val := btrim(v_val, v_trim);
    IF v_val !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s must be a plain number such as 42 or -83.04', v_key);
    END IF;
    BEGIN
      PERFORM v_val::numeric::double precision;  -- out of double range would read as Infinity in JavaScript
    EXCEPTION WHEN numeric_value_out_of_range THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s is too large', v_key);
    END;
  ELSIF NEW.config_type = 'boolean' THEN
    v_val := lower(btrim(v_val, v_trim));
    IF v_val NOT IN ('true', 'false') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be true or false', v_key);
    END IF;
  ELSIF NEW.config_type = 'json' THEN
    BEGIN
      PERFORM v_val::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be valid JSON', v_key);
    END;
  ELSIF NEW.config_type = 'locale' THEN
    v_val := btrim(v_val, v_trim);
    IF v_val !~ '^[a-z]{2,3}(-[A-Z]{2})?$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s must be a language code such as en or pt-BR', v_key);
    END IF;
  ELSIF NEW.config_type = 'locale_list' THEN
    FOREACH v_item IN ARRAY string_to_array(v_val, ',')
    LOOP
      v_item := btrim(v_item, v_trim);
      IF v_item !~ '^[a-z]{2,3}(-[A-Z]{2})?$' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('%s must be comma-separated language codes such as en,es', v_key);
      END IF;
      v_items := v_items || v_item;
    END LOOP;
    v_val := array_to_string(v_items, ',');
  END IF;

  -- Framework keys with a narrower rule than their type. The Stripe row is public, so a secret
  -- key pasted there would reach anonymous callers. (Framework keys have no default_value.)
  IF v_key = 'stripe_publishable_key' THEN
    v_val := btrim(v_val, v_trim);
    IF v_val !~ '^pk_(test|live)_[A-Za-z0-9]+$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s must be a publishable key starting with pk_test_ or pk_live_ (never a secret key)', v_key);
    END IF;
  ELSIF v_key = 'map_default_lat' AND abs(v_val::numeric) > 90 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be between -90 and 90', v_key);
  ELSIF v_key = 'map_default_lng' AND abs(v_val::numeric) > 180 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be between -180 and 180', v_key);
  ELSIF v_key = 'map_default_zoom' AND v_val::integer NOT BETWEEN 0 AND 22 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be between 0 and 22', v_key);
  END IF;

  IF v_is_default THEN NEW.default_value := v_val; ELSE NEW.config_value := v_val; END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.instance_config_normalize() IS
    'Trigger on metadata.instance_config: validates and normalizes config_value (BEFORE UPDATE OF config_value) or, with the argument default_value, default_value (BEFORE INSERT OR UPDATE OF default_value) by config_type. Blank becomes NULL; invalid input raises check_violation with a readable message. Added in v0.79.0.';

REVOKE EXECUTE ON FUNCTION metadata.instance_config_normalize() FROM PUBLIC;

CREATE TRIGGER instance_config_normalize_trigger
    BEFORE UPDATE OF config_value ON metadata.instance_config
    FOR EACH ROW
    EXECUTE FUNCTION metadata.instance_config_normalize('config_value');

CREATE TRIGGER instance_config_default_trigger
    BEFORE INSERT OR UPDATE OF default_value ON metadata.instance_config
    FOR EACH ROW
    EXECUTE FUNCTION metadata.instance_config_normalize('default_value');

COMMENT ON TABLE metadata.instance_config IS
    'Instance-level settings (key/value). Values are text, validated by config_type in the instance_config_normalize trigger. NULL means not set: readers use default_value (integrator keys) or the ENV chain (framework keys). Anonymous callers read only is_public rows. Added in v0.79.0.';
COMMENT ON COLUMN metadata.instance_config.config_key IS 'Stable identifier read by get_config() and the frontend.';
COMMENT ON COLUMN metadata.instance_config.config_value IS 'The setting, as text. NULL means not set.';
COMMENT ON COLUMN metadata.instance_config.default_value IS 'Used while config_value is NULL. Set in SQL when the key is defined (not writable through the API); checked by config_type. Always NULL for framework keys, whose default comes from the ENV chain.';
COMMENT ON COLUMN metadata.instance_config.config_type IS 'Value type: string, integer, number, boolean, json, theme, locale or locale_list. Checked on write.';
COMMENT ON COLUMN metadata.instance_config.display_name IS 'Label shown on the config page.';
COMMENT ON COLUMN metadata.instance_config.description IS 'Help text shown on the config page.';
COMMENT ON COLUMN metadata.instance_config.group_key IS 'Display group (metadata.instance_config_groups).';
COMMENT ON COLUMN metadata.instance_config.sort_order IS 'Order within the group (ascending).';
COMMENT ON COLUMN metadata.instance_config.is_public IS 'When true, anonymous callers can read the row. Keep false for anything not needed before login.';
COMMENT ON COLUMN metadata.instance_config.updated_at IS 'Set on every update; its maximum drives the instance_config cache version.';

-- ============================================================================
-- 2. ROW LEVEL SECURITY AND GRANTS
-- ============================================================================
-- Both API roles already have USAGE on schema metadata (baseline). No INSERT or DELETE is granted:
-- keys are created by migrations. The only writable column is config_value.

ALTER TABLE metadata.instance_config_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.instance_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY instance_config_groups_select ON metadata.instance_config_groups
    FOR SELECT TO web_anon, authenticated USING (true);

CREATE POLICY instance_config_select_anon ON metadata.instance_config
    FOR SELECT TO web_anon USING (is_public);

CREATE POLICY instance_config_select_authenticated ON metadata.instance_config
    FOR SELECT TO authenticated USING (true);

CREATE POLICY instance_config_update ON metadata.instance_config
    FOR UPDATE TO authenticated
    USING (public.has_permission('metadata.instance_config', 'update'))
    WITH CHECK (public.has_permission('metadata.instance_config', 'update'));

GRANT SELECT ON metadata.instance_config_groups TO web_anon, authenticated;
GRANT SELECT ON metadata.instance_config TO web_anon, authenticated;
GRANT UPDATE (config_value) ON metadata.instance_config TO authenticated;

-- ============================================================================
-- 3. PERMISSION
-- ============================================================================

INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('metadata.instance_config', 'update')
ON CONFLICT (table_name, permission) DO NOTHING;

DO $$
DECLARE
  v_admin_role_id SMALLINT;
  v_perm RECORD;
BEGIN
  SELECT id INTO v_admin_role_id FROM metadata.roles WHERE role_key = 'admin';
  IF v_admin_role_id IS NOT NULL THEN
    FOR v_perm IN
      SELECT id FROM metadata.permissions
      WHERE table_name = 'metadata.instance_config'
    LOOP
      INSERT INTO metadata.permission_roles (role_id, permission_id)
      VALUES (v_admin_role_id, v_perm.id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;

-- ============================================================================
-- 4. FRAMEWORK GROUPS AND KEYS
-- ============================================================================
-- Values stay NULL (not set). ON CONFLICT DO NOTHING keeps anything already present.

INSERT INTO metadata.instance_config_groups (group_key, display_name, description, icon, sort_order) VALUES
  ('appearance',   'Appearance',   'Title and default theme',         'palette',   10),
  ('language',     'Language',     'Default and supported languages', 'translate', 20),
  ('integrations', 'Integrations', 'SMS, analytics and payments',     'extension', 30),
  ('map',          'Map',          'Default map position',            'map',       40)
ON CONFLICT (group_key) DO NOTHING;

INSERT INTO metadata.instance_config (config_key, config_type, group_key, sort_order, is_public, display_name, description) VALUES
  ('app_title', 'string', 'appearance', 10, true,
   'Application title',
   'Shown in the navbar, the browser tab and emails.'),
  ('default_theme', 'theme', 'appearance', 20, true,
   'Default theme',
   'Used for users who have not picked a theme.'),
  ('default_locale', 'locale', 'language', 10, true,
   'Default language',
   'Used when a user has no saved language and their browser language is not supported.'),
  ('supported_locales', 'locale_list', 'language', 20, true,
   'Supported languages',
   'Comma-separated language codes, for example en,es.'),
  ('sms_configured', 'boolean', 'integrations', 10, false,
   'SMS enabled',
   'Shows SMS options. Turn on only when the worker has SMS credentials.'),
  ('matomo_enabled', 'boolean', 'integrations', 20, true,
   'Analytics enabled',
   'Turns the app''s analytics tracking on or off. The tracker itself is set up by the deployment.'),
  ('stripe_publishable_key', 'string', 'integrations', 30, true,
   'Stripe publishable key',
   'The pk_ key used by the payment form. Never put a secret key here.'),
  ('map_default_lat', 'number', 'map', 10, true,
   'Default latitude',
   'Center latitude for new maps.'),
  ('map_default_lng', 'number', 'map', 20, true,
   'Default longitude',
   'Center longitude for new maps.'),
  ('map_default_zoom', 'integer', 'map', 30, true,
   'Default zoom',
   'Zoom level for new maps.')
ON CONFLICT (config_key) DO NOTHING;

-- ============================================================================
-- 5. PUBLIC VIEW
-- ============================================================================
-- Deliberately not registered in metadata.entities: it is read by the config page and the bootstrap,
-- never rendered as a CRUD entity, and must not enter schema_contract_hash().

CREATE VIEW public.instance_config
WITH (security_invoker = true) AS
SELECT
    c.config_key,
    c.config_value,
    c.default_value,
    c.config_type,
    c.display_name,
    c.description,
    c.group_key,
    c.sort_order,
    c.is_public,
    c.updated_at,
    g.display_name AS group_display_name,
    g.description AS group_description,
    g.icon AS group_icon,
    g.sort_order AS group_sort_order
FROM metadata.instance_config c
LEFT JOIN metadata.instance_config_groups g ON g.group_key = c.group_key
ORDER BY g.sort_order NULLS LAST, c.sort_order, c.config_key;

COMMENT ON VIEW public.instance_config IS
    'Instance config with its group, for the config page and the frontend bootstrap. RLS on metadata.instance_config decides which rows a caller sees (anonymous: is_public only). Added in v0.79.0.';

GRANT SELECT ON public.instance_config TO web_anon, authenticated;

-- ============================================================================
-- 6. RPCs
-- ============================================================================

-- Write one value. The permission and unknown-key checks live here; type validation and normalization
-- live in the instance_config_normalize trigger, so a direct UPDATE through the API gets the same
-- treatment. SECURITY INVOKER: the has_permission check gives a clear message and RLS stays the backstop.
CREATE OR REPLACE FUNCTION public.set_instance_config(p_key TEXT, p_value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_store TEXT;
BEGIN
  IF NOT public.has_permission('metadata.instance_config', 'update') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM metadata.instance_config WHERE config_key = p_key) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown config key: ' || COALESCE(p_key, '(null)'));
  END IF;

  UPDATE metadata.instance_config SET config_value = p_value WHERE config_key = p_key
  RETURNING config_value INTO v_store;
  IF NOT FOUND THEN
    -- RLS filtered the row out
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  END IF;

  RETURN jsonb_build_object('success', true, 'config_key', p_key, 'config_value', v_store);
EXCEPTION
  WHEN check_violation THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
END;
$$;

COMMENT ON FUNCTION public.set_instance_config(TEXT, TEXT) IS
    'Set one instance config value. Validation and normalization by the key''s config_type happen in the instance_config_normalize trigger; NULL or blank clears it. Requires the metadata.instance_config:update permission. Returns {success, config_key, config_value} or {success: false, error}. Added in v0.79.0.';

REVOKE EXECUTE ON FUNCTION public.set_instance_config(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_instance_config(TEXT, TEXT) TO authenticated;

-- Read one value from SQL (triggers, views, notification templates). SECURITY INVOKER: an anonymous
-- caller gets NULL for a key that is not public.
CREATE OR REPLACE FUNCTION public.get_config(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
  SELECT COALESCE(config_value, default_value) FROM metadata.instance_config WHERE config_key = p_key
$$;

COMMENT ON FUNCTION public.get_config(TEXT) IS
    'Value of one instance config key (its default_value while unset), or NULL when unset with no default, unknown or not visible to the caller. SECURITY INVOKER, so RLS applies (anonymous callers see only public keys). Added in v0.79.0.';

REVOKE EXECUTE ON FUNCTION public.get_config(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_config(TEXT) TO web_anon, authenticated;

-- ============================================================================
-- 7. ADD instance_config TO schema_cache_versions
-- ============================================================================
-- Same definer view as before (allowlisted in view-security-guard-test.sh); the new branch exposes only
-- when config last changed, never a value.

DROP VIEW public.schema_cache_versions;

CREATE VIEW public.schema_cache_versions AS
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
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.translations) AS version
UNION ALL
SELECT 'profile_extensions' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.user_profile_extensions) AS version
UNION ALL
SELECT 'instance_config' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
        FROM metadata.instance_config) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, profile_extensions, and instance_config.';

GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
