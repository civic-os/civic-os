-- Revert civic_os:v0-88-0-instance-secrets from pg
--
-- Restores the v0.79.0 policies, get_config() and normalize trigger, and the v0.80.2 view; drops the
-- secret-key functions, the file_storage keys and group with their seeded translations, and the columns.

BEGIN;

DROP FUNCTION public.get_instance_secret_status();
DROP FUNCTION public.set_instance_secret(TEXT, TEXT);
DROP FUNCTION metadata.publish_deployment_config(JSONB);
DROP FUNCTION metadata.get_instance_secret(TEXT);
DROP FUNCTION metadata.s3_signing_config();

DELETE FROM metadata.translations
WHERE (source_type = 'instance_config_group' AND source_key LIKE 'file_storage.%')
   OR (source_type = 'instance_config' AND split_part(source_key, '.', 1) IN
       ('s3_access_key_id', 's3_secret_access_key', 's3_region', 's3_public_endpoint', 's3_bucket'));

DELETE FROM metadata.instance_config
WHERE config_key IN ('s3_access_key_id', 's3_secret_access_key', 's3_region', 's3_public_endpoint', 's3_bucket');
DELETE FROM metadata.instance_config_groups WHERE group_key = 'file_storage';

DROP POLICY instance_config_select_anon ON metadata.instance_config;
DROP POLICY instance_config_select_authenticated ON metadata.instance_config;
DROP POLICY instance_config_update ON metadata.instance_config;

CREATE POLICY instance_config_select_anon ON metadata.instance_config
    FOR SELECT TO web_anon USING (is_public);

CREATE POLICY instance_config_select_authenticated ON metadata.instance_config
    FOR SELECT TO authenticated USING (true);

CREATE POLICY instance_config_update ON metadata.instance_config
    FOR UPDATE TO authenticated
    USING (public.has_permission('metadata.instance_config', 'update'))
    WITH CHECK (public.has_permission('metadata.instance_config', 'update'));

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


COMMENT ON FUNCTION public.get_config(TEXT) IS
    'Value of one instance config key (its default_value while unset), or NULL when unset with no default, unknown or not visible to the caller. SECURITY INVOKER, so RLS applies (anonymous callers see only public keys). Added in v0.79.0.';

CREATE OR REPLACE VIEW public.instance_config
WITH (security_invoker = true) AS
SELECT
    c.config_key,
    c.config_value,
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
    'Instance config with its group, for the config page and the frontend bootstrap. RLS on metadata.instance_config decides which rows a caller sees (anonymous: is_public only). Labels and descriptions go through metadata.t() (source types instance_config and instance_config_group). Added in v0.79.0; labels translated in v0.80.2.';

GRANT SELECT ON public.instance_config TO web_anon, authenticated;


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
  END IF;

  IF v_is_default THEN NEW.default_value := v_val; ELSE NEW.config_value := v_val; END IF;
  RETURN NEW;
END;
$$;


ALTER TABLE metadata.instance_config
    DROP CONSTRAINT instance_config_secret_display_check,
    DROP CONSTRAINT instance_config_managed_by_check,
    DROP CONSTRAINT instance_config_secret_shape_check,
    DROP COLUMN secret_display,
    DROP COLUMN managed_by,
    DROP COLUMN is_secret;

NOTIFY pgrst, 'reload schema';

COMMIT;
