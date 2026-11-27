-- Deploy civic_os:v0-88-0-instance-secrets to pg
-- requires: v0-87-0-import-validation-translations
--
-- Secret keys in the instance config store (design: docs/notes/INSTANCE_SETUP_DESIGN.md, Secret Keys).
-- A secret row can be written but never read back through the API:
--
--   metadata.instance_config      gains is_secret, managed_by, secret_display (+ CHECKs); RLS hides secret
--                                 rows from web_anon and authenticated, and no API role can update them
--   public.get_config()           returns NULL for a secret key in every context (the owner's included)
--   public.instance_config        re-created; masks config_value for secret rows (RLS already hides them)
--   metadata.instance_config_normalize()  gains the rules of the five S3 keys
--   file_storage group            five deployment-managed secret keys the in-database URL signer reads
--   metadata.s3_signing_config()  owner-only read of the five S3 values (one row, or none until all are set)
--   metadata.get_instance_secret()  owner-only read of one secret key
--   metadata.publish_deployment_config()  the deployment write path (the consolidated worker at startup)
--   public.set_instance_secret()  admin write-only path for admin-managed secret keys (none ship yet)
--   public.get_instance_secret_status()  what /admin/config shows of each secret key, never a secret value
--
-- Every function that writes a secret row re-raises errors with a message naming only the key, so no
-- DETAIL ("Failing row contains ...") can carry a value to the caller or the log. Framework change: no
-- schema decision (framework migrations log no ADRs).

BEGIN;

-- ============================================================================
-- 1. COLUMNS AND CHECKS
-- ============================================================================

ALTER TABLE metadata.instance_config
    ADD COLUMN is_secret BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN managed_by TEXT,
    ADD COLUMN secret_display TEXT,
    ADD CONSTRAINT instance_config_secret_shape_check CHECK (
        NOT is_secret OR (NOT is_public AND config_type = 'string' AND default_value IS NULL)),
    -- CASE, not OR: a CHECK passes on NULL, and "is_secret AND NULL IN (...)" is NULL
    ADD CONSTRAINT instance_config_managed_by_check CHECK (CASE WHEN is_secret
        THEN managed_by IS NOT NULL AND managed_by IN ('deployment', 'admin')
        ELSE managed_by IS NULL END),
    ADD CONSTRAINT instance_config_secret_display_check CHECK (CASE WHEN is_secret
        THEN secret_display IS NOT NULL AND secret_display IN ('none', 'last4', 'full')
        ELSE secret_display IS NULL END);

COMMENT ON COLUMN metadata.instance_config.is_secret IS
    'The value is never readable through the API: not by RLS, get_config(), the public.instance_config view or the worker''s template snapshot. Written only by publish_deployment_config() (managed_by deployment) or set_instance_secret() (managed_by admin); read only by owner-only functions such as s3_signing_config(). Added in v0.88.0.';
COMMENT ON COLUMN metadata.instance_config.managed_by IS
    'For a secret key: deployment (written by publish_deployment_config()) or admin (written by set_instance_secret()). NULL for other keys. Added in v0.88.0.';
COMMENT ON COLUMN metadata.instance_config.secret_display IS
    'For a secret key, what /admin/config shows of a set value: none (only Set), last4 (an ellipsis and the last four characters) or full (for non-secret companions such as an endpoint). NULL for other keys. Added in v0.88.0.';

-- ============================================================================
-- 2. ROW LEVEL SECURITY
-- ============================================================================
-- The SELECT policy also applies to the rows an UPDATE reads, so an API PATCH of a secret row matches
-- nothing. The column grant stays UPDATE (config_value), so no API caller can turn is_secret off.

DROP POLICY instance_config_select_anon ON metadata.instance_config;
DROP POLICY instance_config_select_authenticated ON metadata.instance_config;
DROP POLICY instance_config_update ON metadata.instance_config;

CREATE POLICY instance_config_select_anon ON metadata.instance_config
    FOR SELECT TO web_anon USING (is_public AND NOT is_secret);

CREATE POLICY instance_config_select_authenticated ON metadata.instance_config
    FOR SELECT TO authenticated USING (NOT is_secret);

CREATE POLICY instance_config_update ON metadata.instance_config
    FOR UPDATE TO authenticated
    USING (public.has_permission('metadata.instance_config', 'update') AND NOT is_secret)
    WITH CHECK (public.has_permission('metadata.instance_config', 'update') AND NOT is_secret);

-- ============================================================================
-- 3. get_config() NEVER RETURNS A SECRET
-- ============================================================================
-- Inside a definer function or a notification trigger the invoker is the owner, who bypasses RLS, so
-- the filter is explicit.

CREATE OR REPLACE FUNCTION public.get_config(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
  SELECT COALESCE(config_value, default_value) FROM metadata.instance_config
  WHERE config_key = p_key AND NOT is_secret
$$;

COMMENT ON FUNCTION public.get_config(TEXT) IS
    'Value of one instance config key (its default_value while unset), or NULL when unset with no default, unknown, secret or not visible to the caller. SECURITY INVOKER, so RLS applies (anonymous callers see only public keys); secret keys return NULL for every caller, the owner included. Added in v0.79.0; secret keys excluded in v0.88.0.';

-- ============================================================================
-- 4. public.instance_config MASKS SECRET VALUES
-- ============================================================================
-- RLS already hides secret rows from API roles; the CASE guards a caller that bypasses RLS.
-- CREATE OR REPLACE VIEW resets view options, so WITH (security_invoker = true) is repeated.

CREATE OR REPLACE VIEW public.instance_config
WITH (security_invoker = true) AS
SELECT
    c.config_key,
    CASE WHEN c.is_secret THEN NULL ELSE c.config_value END AS config_value,
    c.default_value,
    c.config_type,
    metadata.t('instance_config', c.config_key || '.display_name', c.display_name) AS display_name,
    metadata.t('instance_config', c.config_key || '.description', c.description) AS description,
    c.group_key,
    c.sort_order,
    c.is_public,
    c.updated_at,
    metadata.t('instance_config_group', g.group_key || '.display_name', g.display_name) AS group_display_name,
    metadata.t('instance_config_group', g.group_key || '.description', g.description) AS group_description,
    g.icon AS group_icon,
    g.sort_order AS group_sort_order
FROM metadata.instance_config c
LEFT JOIN metadata.instance_config_groups g ON g.group_key = c.group_key
ORDER BY g.sort_order NULLS LAST, c.sort_order, c.config_key;

COMMENT ON VIEW public.instance_config IS
    'Instance config with its group, for the config page and the frontend bootstrap. RLS on metadata.instance_config decides which rows a caller sees (anonymous: is_public only; secret rows: nobody), and config_value is NULL for a secret row. Labels and descriptions go through metadata.t() (source types instance_config and instance_config_group). Added in v0.79.0; labels translated in v0.80.2; secret values masked in v0.88.0.';

GRANT SELECT ON public.instance_config TO web_anon, authenticated;

-- ============================================================================
-- 5. NORMALIZE TRIGGER: RULES OF THE S3 KEYS
-- ============================================================================
-- Same body as v0.79.0 plus the five s3_* rules. Messages name the key, never the value.

CREATE OR REPLACE FUNCTION metadata.instance_config_normalize()
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
  -- S3 keys read by the in-database URL signer (v0.88.0). Local MinIO and RustFS accept keys such as
  -- minioadmin, so the key id has no AWS-shaped pattern.
  ELSIF v_key = 's3_public_endpoint' THEN
    v_val := rtrim(btrim(v_val, v_trim), '/');
    IF v_val !~ '^https?://[^/\s]+(/\S*)?$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('%s must be an http or https URL such as https://nyc3.digitaloceanspaces.com', v_key);
    END IF;
  ELSIF v_key = 's3_region' THEN
    v_val := btrim(v_val, v_trim);
    IF v_val !~ '^[a-z0-9-]+$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be a region such as us-east-1', v_key);
    END IF;
  ELSIF v_key = 's3_bucket' THEN
    v_val := btrim(v_val, v_trim);
    IF v_val !~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must be a valid S3 bucket name', v_key);
    END IF;
  ELSIF v_key IN ('s3_access_key_id', 's3_secret_access_key') THEN
    IF v_val ~ '\s' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('%s must not contain whitespace', v_key);
    END IF;
  END IF;

  IF v_is_default THEN NEW.default_value := v_val; ELSE NEW.config_value := v_val; END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 6. FILE STORAGE GROUP AND KEYS
-- ============================================================================
-- Deployment-managed: the consolidated worker publishes the values it signs with at startup.

INSERT INTO metadata.instance_config_groups (group_key, display_name, description, icon, sort_order) VALUES
  ('file_storage', 'File storage',
   'Set by the deployment from the worker''s S3 settings. To change them, update the settings and restart the worker.',
   'cloud', 50)
ON CONFLICT (group_key) DO NOTHING;

INSERT INTO metadata.instance_config
  (config_key, config_type, group_key, sort_order, is_public, is_secret, managed_by, secret_display, display_name, description)
VALUES
  ('s3_access_key_id', 'string', 'file_storage', 10, false, true, 'deployment', 'last4',
   'Access key ID', 'Identifies the storage key that signs file links.'),
  ('s3_secret_access_key', 'string', 'file_storage', 20, false, true, 'deployment', 'none',
   'Secret access key', 'Signs file links. Never shown.'),
  ('s3_region', 'string', 'file_storage', 30, false, true, 'deployment', 'full',
   'Region', 'The storage region the bucket is in.'),
  ('s3_public_endpoint', 'string', 'file_storage', 40, false, true, 'deployment', 'full',
   'Public endpoint', 'The address browsers use to reach file storage.'),
  ('s3_bucket', 'string', 'file_storage', 50, false, true, 'deployment', 'full',
   'Bucket', 'The bucket new files are uploaded to.')
ON CONFLICT (config_key) DO NOTHING;

-- ============================================================================
-- 7. OWNER-ONLY READERS
-- ============================================================================
-- EXECUTE is revoked from PUBLIC and granted to no role: only the owner (the migration role) and
-- superusers run them, so they are reachable only from SECURITY DEFINER functions the migration role
-- owns. They are INVOKER on purpose: an accidental grant to an API role reads nothing, because RLS hides
-- secret rows from that role. A definer function that calls them returns only what it computed, and no
-- caller input decides which secret it reads.

CREATE FUNCTION metadata.s3_signing_config()
RETURNS TABLE (access_key_id TEXT, secret_access_key TEXT, region TEXT, public_endpoint TEXT, default_bucket TEXT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = metadata, pg_catalog
AS $$
  SELECT *
  FROM (
    SELECT
      max(config_value) FILTER (WHERE config_key = 's3_access_key_id'),
      max(config_value) FILTER (WHERE config_key = 's3_secret_access_key'),
      max(config_value) FILTER (WHERE config_key = 's3_region'),
      max(config_value) FILTER (WHERE config_key = 's3_public_endpoint'),
      max(config_value) FILTER (WHERE config_key = 's3_bucket')
    FROM metadata.instance_config
    WHERE is_secret
      AND config_key IN ('s3_access_key_id', 's3_secret_access_key', 's3_region', 's3_public_endpoint', 's3_bucket')
  ) c (access_key_id, secret_access_key, region, public_endpoint, default_bucket)
  WHERE c.access_key_id IS NOT NULL AND c.secret_access_key IS NOT NULL AND c.region IS NOT NULL
    AND c.public_endpoint IS NOT NULL AND c.default_bucket IS NOT NULL
$$;

COMMENT ON FUNCTION metadata.s3_signing_config() IS
    'The five S3 values the in-database URL signer needs: one row when all are set, no rows otherwise. Owner-only (no grants): call it only from a SECURITY DEFINER function owned by the migration role that returns computed results, never the values. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata.s3_signing_config() FROM PUBLIC;

CREATE FUNCTION metadata.get_instance_secret(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = metadata, pg_catalog
AS $$
  SELECT config_value FROM metadata.instance_config WHERE config_key = p_key AND is_secret
$$;

COMMENT ON FUNCTION metadata.get_instance_secret(TEXT) IS
    'Value of one secret instance config key, or NULL when unset or not a secret key. Owner-only (no grants): call it only from a SECURITY DEFINER function owned by the migration role, with a fixed key, returning computed results, never the value. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata.get_instance_secret(TEXT) FROM PUBLIC;

-- ============================================================================
-- 8. WRITERS
-- ============================================================================

-- The deployment write path. The consolidated worker calls it at startup with the S3 values it presigns
-- with, as one bind parameter. All or nothing; rows whose value is unchanged are not touched, so a
-- restart with the same credentials moves neither updated_at nor the cache version.
CREATE FUNCTION metadata.publish_deployment_config(p_values JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_key TEXT;
  v_value TEXT;
  v_changed TEXT[] := ARRAY[]::TEXT[];
  v_row metadata.instance_config%ROWTYPE;
BEGIN
  -- In-body guard: the definer runs as the owner, so session_user and the JWT decide.
  IF NOT metadata._is_deployer() THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'publish_deployment_config is for the deployment role only';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = 'p_values must be a JSON object';
  END IF;

  BEGIN
    FOR v_key, v_value IN SELECT key, value FROM jsonb_each_text(p_values) ORDER BY key
    LOOP
      SELECT * INTO v_row FROM metadata.instance_config WHERE config_key = v_key FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = format('Unknown config key: %s', v_key);
      ELSIF NOT v_row.is_secret OR v_row.managed_by IS DISTINCT FROM 'deployment' THEN
        RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
          MESSAGE = format('%s is not a deployment-managed secret key', v_key);
      END IF;

      UPDATE metadata.instance_config SET config_value = v_value
      WHERE config_key = v_key AND config_value IS DISTINCT FROM v_value;
      -- The caller sends normalized values (the worker strips the endpoint's trailing slash), so equal
      -- values compare equal here and a restart touches nothing.
      IF FOUND THEN
        v_changed := v_changed || v_key;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- Re-raise without DETAIL or HINT: a constraint's "Failing row contains (...)" would print the value.
    RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = SQLERRM;
  END;

  RETURN jsonb_build_object('changed', to_jsonb(v_changed));
END;
$$;

COMMENT ON FUNCTION metadata.publish_deployment_config(JSONB) IS
    'Deployment write path for deployment-managed secret keys: {"s3_access_key_id": "...", ...}. Only the deployment role without a JWT (metadata._is_deployer()). All or nothing; unchanged values are not touched. Returns {"changed": [keys]}, never a value; errors carry no DETAIL. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata.publish_deployment_config(JSONB) FROM PUBLIC;

-- The admin write-only path, for secret keys marked managed_by = 'admin'. No framework key uses it yet.
CREATE FUNCTION public.set_instance_secret(p_key TEXT, p_value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_row metadata.instance_config%ROWTYPE;
BEGIN
  IF NOT (public.has_permission('metadata.instance_config', 'update') OR public.is_admin()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  END IF;

  SELECT * INTO v_row FROM metadata.instance_config WHERE config_key = p_key AND is_secret;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown secret key: ' || COALESCE(p_key, '(null)'));
  ELSIF v_row.managed_by <> 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', p_key || ' is set by the deployment');
  END IF;

  BEGIN
    UPDATE metadata.instance_config SET config_value = p_value WHERE config_key = p_key
    RETURNING * INTO v_row;
  EXCEPTION
    WHEN check_violation THEN
      RETURN jsonb_build_object('success', false, 'error', SQLERRM);
    WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = SQLERRM;
  END;

  RETURN jsonb_build_object('success', true, 'config_key', p_key,
    'is_set', v_row.config_value IS NOT NULL, 'updated_at', v_row.updated_at);
END;
$$;

COMMENT ON FUNCTION public.set_instance_secret(TEXT, TEXT) IS
    'Write-only update of an admin-managed secret instance config key; NULL or blank clears it. Requires metadata.instance_config:update or admin. Returns {success, config_key, is_set, updated_at}, never the value. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION public.set_instance_secret(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_instance_secret(TEXT, TEXT) TO authenticated;

-- What /admin/config shows of each secret key.
CREATE FUNCTION public.get_instance_secret_status()
RETURNS TABLE (
  config_key TEXT,
  display_name TEXT,
  description TEXT,
  group_key TEXT,
  group_display_name TEXT,
  group_description TEXT,
  group_icon TEXT,
  group_sort_order INTEGER,
  sort_order INTEGER,
  managed_by TEXT,
  is_set BOOLEAN,
  display_value TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  IF NOT (public.has_permission('metadata.instance_config', 'update') OR public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Permission denied';
  END IF;

  RETURN QUERY
  SELECT
    c.config_key,
    metadata.t('instance_config', c.config_key || '.display_name', c.display_name),
    metadata.t('instance_config', c.config_key || '.description', c.description),
    c.group_key,
    metadata.t('instance_config_group', g.group_key || '.display_name', g.display_name),
    metadata.t('instance_config_group', g.group_key || '.description', g.description),
    g.icon,
    g.sort_order,
    c.sort_order,
    c.managed_by,
    c.config_value IS NOT NULL,
    CASE
      WHEN c.config_value IS NULL OR c.secret_display = 'none' THEN NULL
      WHEN c.secret_display = 'last4' THEN '…' || right(c.config_value, 4)
      ELSE c.config_value
    END,
    c.updated_at
  FROM metadata.instance_config c
  LEFT JOIN metadata.instance_config_groups g ON g.group_key = c.group_key
  WHERE c.is_secret
  ORDER BY g.sort_order NULLS LAST, c.sort_order, c.config_key;
END;
$$;

COMMENT ON FUNCTION public.get_instance_secret_status() IS
    'Status of every secret instance config key for /admin/config: labels, group, managed_by, is_set, display_value (by secret_display: none shows nothing, last4 an ellipsis and four characters, full the value) and updated_at. Requires metadata.instance_config:update or admin; raises 42501 otherwise. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION public.get_instance_secret_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_instance_secret_status() TO authenticated;

-- ============================================================================
-- 9. TRANSLATIONS OF THE GROUP AND KEY LABELS
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('instance_config_group', 'file_storage.display_name', 'es', 'Almacenamiento de archivos'),
  ('instance_config_group', 'file_storage.display_name', 'ar', 'تخزين الملفات'),
  ('instance_config_group', 'file_storage.display_name', 'fr', 'Stockage des fichiers'),
  ('instance_config_group', 'file_storage.display_name', 'de', 'Dateispeicher'),
  ('instance_config_group', 'file_storage.display_name', 'ps', 'د فایلونو زیرمه'),
  ('instance_config_group', 'file_storage.description', 'es', 'Los define el despliegue a partir de la configuración S3 del worker. Para cambiarlos, actualice esa configuración y reinicie el worker.'),
  ('instance_config_group', 'file_storage.description', 'ar', 'يحددها النشر من إعدادات S3 الخاصة بالعامل. لتغييرها، حدّث الإعدادات وأعد تشغيل العامل.'),
  ('instance_config_group', 'file_storage.description', 'fr', 'Définis par le déploiement à partir des paramètres S3 du worker. Pour les modifier, mettez à jour ces paramètres et redémarrez le worker.'),
  ('instance_config_group', 'file_storage.description', 'de', 'Werden bei der Bereitstellung aus den S3-Einstellungen des Workers übernommen. Zum Ändern die Einstellungen anpassen und den Worker neu starten.'),
  ('instance_config_group', 'file_storage.description', 'ps', 'د ورکر د S3 له تنظیماتو څخه د ځای پر ځای کولو له لارې ټاکل کیږي. د بدلولو لپاره، تنظیمات تازه کړئ او ورکر بیا پیل کړئ.'),
  ('instance_config', 's3_access_key_id.display_name', 'es', 'ID de clave de acceso'),
  ('instance_config', 's3_access_key_id.display_name', 'ar', 'معرّف مفتاح الوصول'),
  ('instance_config', 's3_access_key_id.display_name', 'fr', 'ID de clé d''accès'),
  ('instance_config', 's3_access_key_id.display_name', 'de', 'Zugriffsschlüssel-ID'),
  ('instance_config', 's3_access_key_id.display_name', 'ps', 'د لاسرسي کیلي پېژند'),
  ('instance_config', 's3_access_key_id.description', 'es', 'Identifica la clave de almacenamiento que firma los enlaces de archivos.'),
  ('instance_config', 's3_access_key_id.description', 'ar', 'يحدد مفتاح التخزين الذي يوقّع روابط الملفات.'),
  ('instance_config', 's3_access_key_id.description', 'fr', 'Identifie la clé de stockage qui signe les liens des fichiers.'),
  ('instance_config', 's3_access_key_id.description', 'de', 'Kennzeichnet den Speicherschlüssel, der Dateilinks signiert.'),
  ('instance_config', 's3_access_key_id.description', 'ps', 'هغه زیرمه کیلي پېژني چې د فایلونو لینکونه لاسلیکوي.'),
  ('instance_config', 's3_secret_access_key.display_name', 'es', 'Clave de acceso secreta'),
  ('instance_config', 's3_secret_access_key.display_name', 'ar', 'مفتاح الوصول السري'),
  ('instance_config', 's3_secret_access_key.display_name', 'fr', 'Clé d''accès secrète'),
  ('instance_config', 's3_secret_access_key.display_name', 'de', 'Geheimer Zugriffsschlüssel'),
  ('instance_config', 's3_secret_access_key.display_name', 'ps', 'پټه د لاسرسي کیلي'),
  ('instance_config', 's3_secret_access_key.description', 'es', 'Firma los enlaces de archivos. Nunca se muestra.'),
  ('instance_config', 's3_secret_access_key.description', 'ar', 'يوقّع روابط الملفات. لا يُعرض أبدًا.'),
  ('instance_config', 's3_secret_access_key.description', 'fr', 'Signe les liens des fichiers. Jamais affichée.'),
  ('instance_config', 's3_secret_access_key.description', 'de', 'Signiert Dateilinks. Wird nie angezeigt.'),
  ('instance_config', 's3_secret_access_key.description', 'ps', 'د فایلونو لینکونه لاسلیکوي. هیڅکله نه ښودل کیږي.'),
  ('instance_config', 's3_region.display_name', 'es', 'Región'),
  ('instance_config', 's3_region.display_name', 'ar', 'المنطقة'),
  ('instance_config', 's3_region.display_name', 'fr', 'Région'),
  ('instance_config', 's3_region.display_name', 'de', 'Region'),
  ('instance_config', 's3_region.display_name', 'ps', 'سیمه'),
  ('instance_config', 's3_region.description', 'es', 'La región de almacenamiento en la que está el bucket.'),
  ('instance_config', 's3_region.description', 'ar', 'منطقة التخزين التي توجد فيها الحاوية.'),
  ('instance_config', 's3_region.description', 'fr', 'La région de stockage où se trouve le bucket.'),
  ('instance_config', 's3_region.description', 'de', 'Die Speicherregion, in der sich der Bucket befindet.'),
  ('instance_config', 's3_region.description', 'ps', 'د زیرمې هغه سیمه چې بکټ پکې دی.'),
  ('instance_config', 's3_public_endpoint.display_name', 'es', 'Punto de acceso público'),
  ('instance_config', 's3_public_endpoint.display_name', 'ar', 'نقطة الوصول العامة'),
  ('instance_config', 's3_public_endpoint.display_name', 'fr', 'Point d''accès public'),
  ('instance_config', 's3_public_endpoint.display_name', 'de', 'Öffentlicher Endpunkt'),
  ('instance_config', 's3_public_endpoint.display_name', 'ps', 'عامه پای ټکی'),
  ('instance_config', 's3_public_endpoint.description', 'es', 'La dirección que usan los navegadores para llegar al almacenamiento de archivos.'),
  ('instance_config', 's3_public_endpoint.description', 'ar', 'العنوان الذي تستخدمه المتصفحات للوصول إلى تخزين الملفات.'),
  ('instance_config', 's3_public_endpoint.description', 'fr', 'L''adresse que les navigateurs utilisent pour accéder au stockage des fichiers.'),
  ('instance_config', 's3_public_endpoint.description', 'de', 'Die Adresse, über die Browser den Dateispeicher erreichen.'),
  ('instance_config', 's3_public_endpoint.description', 'ps', 'هغه پته چې براوزرونه یې د فایلونو زیرمې ته د رسیدو لپاره کاروي.'),
  ('instance_config', 's3_bucket.display_name', 'es', 'Bucket'),
  ('instance_config', 's3_bucket.display_name', 'ar', 'الحاوية'),
  ('instance_config', 's3_bucket.display_name', 'fr', 'Bucket'),
  ('instance_config', 's3_bucket.display_name', 'de', 'Bucket'),
  ('instance_config', 's3_bucket.display_name', 'ps', 'بکټ'),
  ('instance_config', 's3_bucket.description', 'es', 'El bucket al que se suben los archivos nuevos.'),
  ('instance_config', 's3_bucket.description', 'ar', 'الحاوية التي تُرفع إليها الملفات الجديدة.'),
  ('instance_config', 's3_bucket.description', 'fr', 'Le bucket dans lequel les nouveaux fichiers sont téléversés.'),
  ('instance_config', 's3_bucket.description', 'de', 'Der Bucket, in den neue Dateien hochgeladen werden.'),
  ('instance_config', 's3_bucket.description', 'ps', 'هغه بکټ چې نوي فایلونه پکې پورته کیږي.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
