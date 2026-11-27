#!/bin/bash
# =============================================================================
# Functional Test: v0-88-0 secret instance config keys
# =============================================================================
# Sets every secret key to a unique sentinel and checks that the sentinel never comes back through
# an API surface (docs/notes/INSTANCE_SETUP_DESIGN.md, Secret Keys, Tests That Prove Secrets Do Not Leak):
#   - RLS: web_anon, authenticated and an admin JWT see no secret row in metadata.instance_config or
#     public.instance_config;
#   - get_config() is NULL for every secret key as each API role, as the owner and inside a definer;
#   - writes refused: an admin UPDATE matches 0 rows, UPDATE (is_secret) is denied, set_instance_config()
#     refuses secret keys, set_instance_secret() refuses deployment-managed keys;
#   - API roles cannot execute s3_signing_config(), get_instance_secret() or publish_deployment_config();
#   - publish_deployment_config(): refused with JWT claims, as authenticator and as a plain role; accepted
#     for a CREATEROLE non-superuser (doadmin's shape); all or nothing; unchanged values move nothing;
#     refuses admin-managed, non-secret and unknown keys;
#   - no rejected write's SQLERRM, DETAIL or HINT contains the sentinel;
#   - get_instance_secret_status() follows secret_display, never returns the secret, raises 42501 for a
#     non-admin; set_instance_secret() on an admin-managed key is write-only;
#   - the CHECK constraints hold; s3_signing_config() has no row until all five values are set.
# With POSTGREST_URL and Keycloak reachable it also checks the API bodies with real tokens (anonymous,
# testuser, testadmin), and that the metadata functions are not exposed.
#
# Everything runs in one transaction that is rolled back, so the instance's own published values are
# untouched; a second session confirms that.
#
# Usage:
#   ./tests/functional/v0-88-0-instance-secrets-test.sh
#
# Environment overrides (the connecting user must be a superuser):
#   DATABASE_URL    postgres://postgres:securepassword123@localhost:15432/civic_os_db
#   POSTGREST_URL   http://localhost:3000            (API section; skipped when unreachable)
#   KEYCLOAK_URL    http://localhost:8082
#   SKIP_API=1      skip the API section (CI's migration job has no PostgREST or Keycloak)
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"
POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082}"
SENTINEL="LEAKCHECK-$(date +%s)-$RANDOM"

BEFORE=$(psql "$DATABASE_URL" -Atq -c "SELECT md5(string_agg(config_key || '=' || coalesce(config_value, '') || '@' || updated_at, ',' ORDER BY config_key)) FROM metadata.instance_config WHERE is_secret")

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v sentinel="$SENTINEL" -q -o /dev/null <<'SQL'
BEGIN;
SELECT set_config('t.sentinel', :'sentinel', true);

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

-- Runs p_sql, which must fail; true when no part of the error mentions the sentinel.
CREATE FUNCTION pg_temp.error_is_clean(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_msg text; v_detail text; v_hint text;
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'expected an error from: %', p_sql;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL, v_hint = PG_EXCEPTION_HINT;
  IF v_msg LIKE 'expected an error from:%' THEN RAISE; END IF;
  RETURN position(current_setting('t.sentinel') IN coalesce(v_msg, '') || coalesce(v_detail, '') || coalesce(v_hint, '')) = 0;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.error_is_clean(text) TO PUBLIC;

-- A definer that leaks through get_config() if get_config() returned secrets.
CREATE FUNCTION pg_temp.definer_get_config(p_key text) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.get_config(p_key)
$$;
GRANT EXECUTE ON FUNCTION pg_temp.definer_get_config(text) TO PUBLIC;

-- Runs a statement as the calling role and returns its text, for "does this contain the sentinel" checks.
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, '');
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.q(text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Shape: constraints and security properties
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM metadata.instance_config WHERE is_secret AND managed_by = 'deployment'
          AND config_key IN ('s3_access_key_id','s3_secret_access_key','s3_region','s3_public_endpoint','s3_bucket')) = 5,
    'five deployment-managed S3 secret keys';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.instance_config (config_key, display_name, is_secret, managed_by, secret_display, is_public) VALUES ('t_x','x',true,'admin','none',true)$q$, '23514'),
    'a secret row cannot be public';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.instance_config (config_key, display_name, is_secret, managed_by, secret_display, config_type) VALUES ('t_x','x',true,'admin','none','integer')$q$, '23514'),
    'a secret row is a string';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.instance_config (config_key, display_name, is_secret, secret_display) VALUES ('t_x','x',true,'none')$q$, '23514'),
    'a secret row needs managed_by';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.instance_config (config_key, display_name, managed_by) VALUES ('t_x','x','admin')$q$, '23514'),
    'managed_by only on secret rows';
  ASSERT pg_temp.expect_sqlstate($q$INSERT INTO metadata.instance_config (config_key, display_name, is_secret, managed_by, secret_display, default_value) VALUES ('t_x','x',true,'admin','none','d')$q$, '23514'),
    'a secret row has no default';
  ASSERT NOT has_function_privilege('web_anon', 'metadata.s3_signing_config()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'metadata.s3_signing_config()', 'EXECUTE')
     AND NOT has_function_privilege('web_anon', 'metadata.get_instance_secret(text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'metadata.get_instance_secret(text)', 'EXECUTE')
     AND NOT has_function_privilege('web_anon', 'metadata.publish_deployment_config(jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'metadata.publish_deployment_config(jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticator', 'metadata.publish_deployment_config(jsonb)', 'EXECUTE'),
    'no API role can execute the owner-only readers or the deployment writer';
  ASSERT NOT has_function_privilege('web_anon', 'public.get_instance_secret_status()', 'EXECUTE')
     AND NOT has_function_privilege('web_anon', 'public.set_instance_secret(text,text)', 'EXECUTE'),
    'web_anon cannot run the admin secret RPCs';
  ASSERT (SELECT bool_and(prosecdef AND proconfig::text LIKE '%search_path%') FROM pg_proc
          WHERE oid IN ('metadata.publish_deployment_config(jsonb)'::regprocedure,
                        'public.set_instance_secret(text,text)'::regprocedure,
                        'public.get_instance_secret_status()'::regprocedure)),
    'the three definers pin their search_path';
  ASSERT (SELECT bool_and(NOT prosecdef) FROM pg_proc
          WHERE oid IN ('metadata.s3_signing_config()'::regprocedure, 'metadata.get_instance_secret(text)'::regprocedure)),
    'the two readers are SECURITY INVOKER';
END $$;

-- ---------------------------------------------------------------------------
-- Publish: clear, then partial (no config row), then the sentinel set
-- ---------------------------------------------------------------------------
UPDATE metadata.instance_config SET config_value = NULL WHERE is_secret;

DO $$
DECLARE v_s text := current_setting('t.sentinel');
BEGIN
  ASSERT metadata.publish_deployment_config(jsonb_build_object('s3_access_key_id', 'AKID' || v_s, 's3_secret_access_key', v_s))
         = '{"changed": ["s3_access_key_id", "s3_secret_access_key"]}'::jsonb, 'publish returns the changed key names';
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.s3_signing_config()), 's3_signing_config has no row until all five are set';

  ASSERT (metadata.publish_deployment_config(jsonb_build_object(
            's3_access_key_id', 'AKID' || v_s, 's3_secret_access_key', v_s, 's3_region', 'us-east-1',
            's3_public_endpoint', 'http://localhost:9000', 's3_bucket', 'civic-os-files')) -> 'changed')
         = '["s3_bucket", "s3_public_endpoint", "s3_region"]'::jsonb, 'only the new values count as changed';
  ASSERT (SELECT secret_access_key FROM metadata.s3_signing_config()) = v_s
     AND (SELECT default_bucket FROM metadata.s3_signing_config()) = 'civic-os-files',
    's3_signing_config returns the five values to the owner';
  ASSERT metadata.get_instance_secret('s3_secret_access_key') = v_s, 'get_instance_secret reads a secret key';
  ASSERT metadata.get_instance_secret('app_title') IS NULL, 'get_instance_secret is NULL for a non-secret key';
END $$;

-- unchanged values move nothing
SELECT set_config('t.updated', (SELECT max(updated_at)::text FROM metadata.instance_config WHERE is_secret), true);
DO $$
DECLARE v_s text := current_setting('t.sentinel');
BEGIN
  PERFORM pg_sleep(0.01);
  ASSERT metadata.publish_deployment_config(jsonb_build_object(
            's3_access_key_id', 'AKID' || v_s, 's3_secret_access_key', v_s, 's3_region', 'us-east-1',
            's3_public_endpoint', 'http://localhost:9000', 's3_bucket', 'civic-os-files'))
         = '{"changed": []}'::jsonb, 'a re-publish of unchanged values changes nothing';
END $$;

-- all or nothing, and no error carries the value
DO $$
DECLARE v_s text := current_setting('t.sentinel');
BEGIN
  ASSERT pg_temp.error_is_clean(format($q$SELECT metadata.publish_deployment_config('{"s3_secret_access_key": "%s-new", "s3_region": "BAD %s"}')$q$, v_s, v_s)),
    'a rejected publish error does not contain the value';
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('{"s3_region": "BAD REGION"}')$q$, '23514'),
    'an invalid region is a check violation';
  ASSERT metadata.get_instance_secret('s3_secret_access_key') = v_s, 'a failed publish changes no row (all or nothing)';
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('{"app_title": "x"}')$q$, '22023'),
    'publish refuses a non-secret key';
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('{"no_such_key": "x"}')$q$, '22023'),
    'publish refuses an unknown key';
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('[1]')$q$, '22023'),
    'publish wants an object';
  ASSERT pg_temp.error_is_clean(format($q$SELECT metadata.publish_deployment_config('{"s3_access_key_id": "has space %s"}')$q$, v_s)),
    'a whitespace key id error does not contain the value';
  ASSERT pg_temp.error_is_clean(format($q$SELECT metadata.publish_deployment_config('{"s3_public_endpoint": "ftp://%s"}')$q$, v_s)),
    'an endpoint error does not contain the value';
END $$;

DO $$
BEGIN
  ASSERT (SELECT max(updated_at)::text FROM metadata.instance_config WHERE is_secret) = current_setting('t.updated'),
    'neither the unchanged re-publish nor the failed ones moved updated_at';
END $$;

-- an admin-managed secret key for the write-only path
INSERT INTO metadata.instance_config (config_key, display_name, is_secret, managed_by, secret_display, group_key, sort_order)
VALUES ('t_admin_secret', 'T admin secret', true, 'admin', 'last4', 'file_storage', 99);
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('{"t_admin_secret": "x"}')$q$, '22023'),
    'publish refuses an admin-managed key';
END $$;

-- the deployer guard: JWT claims present
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["admin"]}', true);
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('{"s3_region": "us-west-2"}')$q$, '42501'),
    'publish is refused while JWT claims are set, even for a superuser session';
END $$;
SELECT set_config('request.jwt.claims', '{}', true);

-- a CREATEROLE non-superuser (doadmin's shape) passes the guard once it may execute the function
CREATE ROLE t_doadmin CREATEROLE NOLOGIN;
GRANT EXECUTE ON FUNCTION metadata.publish_deployment_config(jsonb) TO t_doadmin;
GRANT USAGE ON SCHEMA metadata TO t_doadmin;
CREATE ROLE t_plain NOLOGIN;
GRANT EXECUTE ON FUNCTION metadata.publish_deployment_config(jsonb) TO t_plain;
GRANT USAGE ON SCHEMA metadata TO t_plain;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO t_doadmin, t_plain;

SET LOCAL SESSION AUTHORIZATION t_doadmin;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  ASSERT (metadata.publish_deployment_config('{"s3_region": "us-east-1"}') -> 'changed') = '[]'::jsonb,
    'a CREATEROLE non-superuser session without claims is a deployer';
END $$;
RESET SESSION AUTHORIZATION;

SET LOCAL SESSION AUTHORIZATION t_plain;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('{"s3_region": "us-west-2"}')$q$, '42501'),
    'a role that is neither superuser nor CREATEROLE is refused, even with EXECUTE';
END $$;
RESET SESSION AUTHORIZATION;

-- authenticator (PostgREST's login role): no EXECUTE, and the guard would refuse it anyway
SET LOCAL SESSION AUTHORIZATION authenticator;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.publish_deployment_config('{"s3_region": "us-west-2"}')$q$, '42501'),
    'authenticator cannot publish';
END $$;
RESET SESSION AUTHORIZATION;

-- ---------------------------------------------------------------------------
-- The owner: get_config() and definer code never see a secret
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT public.get_config('s3_secret_access_key') IS NULL, 'get_config is NULL for a secret key, even for the owner';
  ASSERT pg_temp.definer_get_config('s3_secret_access_key') IS NULL, 'and inside a definer function';
  ASSERT (SELECT config_value FROM public.instance_config WHERE config_key = 's3_secret_access_key') IS NULL,
    'the view masks the value even for a caller that bypasses RLS';
END $$;

-- ---------------------------------------------------------------------------
-- API roles: no secret row, no value, no write
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
DECLARE v_s text := current_setting('t.sentinel');
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.instance_config WHERE is_secret), 'web_anon sees no secret row';
  ASSERT NOT EXISTS (SELECT 1 FROM public.instance_config WHERE config_key LIKE 's3\_%'), 'nor through the view';
  ASSERT public.get_config('s3_secret_access_key') IS NULL AND public.get_config('s3_bucket') IS NULL, 'get_config is NULL';
  ASSERT pg_temp.definer_get_config('s3_secret_access_key') IS NULL, 'definer get_config is NULL';
  ASSERT pg_temp.expect_sqlstate($q$SELECT * FROM metadata.s3_signing_config()$q$, '42501'), 'web_anon cannot run s3_signing_config';
  ASSERT position(v_s IN pg_temp.q($q$SELECT string_agg(row_to_json(c)::text, '') FROM public.instance_config c$q$)) = 0,
    'no view row contains the sentinel';
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated","roles":["user"]}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.instance_config WHERE is_secret), 'a user sees no secret row';
  ASSERT public.get_config('s3_secret_access_key') IS NULL, 'get_config is NULL for a user';
  ASSERT pg_temp.expect_sqlstate($q$SELECT * FROM public.get_instance_secret_status()$q$, '42501'),
    'get_instance_secret_status raises 42501 for a non-admin';
  ASSERT public.set_instance_secret('t_admin_secret', 'x') = '{"success": false, "error": "Permission denied"}'::jsonb,
    'set_instance_secret refuses a non-admin';
  ASSERT pg_temp.expect_sqlstate($q$SELECT * FROM metadata.get_instance_secret('s3_secret_access_key')$q$, '42501'),
    'a user cannot run get_instance_secret';
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated","roles":["admin"]}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_s text := current_setting('t.sentinel'); v_rows int; v_status text;
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM metadata.instance_config WHERE is_secret), 'an admin sees no secret row';
  ASSERT public.get_config('s3_secret_access_key') IS NULL, 'get_config is NULL for an admin';
  UPDATE metadata.instance_config SET config_value = 'x' WHERE config_key = 's3_secret_access_key';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  ASSERT v_rows = 0, 'an admin UPDATE of a secret row matches no row';
  ASSERT pg_temp.expect_sqlstate($q$UPDATE metadata.instance_config SET is_secret = false$q$, '42501'),
    'no API caller can update is_secret';
  ASSERT (public.set_instance_config('s3_secret_access_key', 'x') ->> 'success')::boolean = false,
    'set_instance_config refuses a secret key';
  ASSERT public.set_instance_secret('s3_secret_access_key', 'x') ->> 'error' = 's3_secret_access_key is set by the deployment',
    'set_instance_secret refuses a deployment-managed key';
  ASSERT public.set_instance_secret('app_title', 'x') ->> 'error' = 'Unknown secret key: app_title',
    'set_instance_secret refuses a non-secret key';

  -- write-only admin path
  v_status := public.set_instance_secret('t_admin_secret', 'adm' || v_s)::text;
  ASSERT (v_status::jsonb ->> 'success')::boolean AND (v_status::jsonb ->> 'is_set')::boolean,
    'set_instance_secret stores an admin-managed key: ' || v_status;
  ASSERT position(v_s IN v_status) = 0, 'and does not echo the value';
  ASSERT (public.set_instance_secret('t_admin_secret', 'has space') ->> 'success')::boolean IS NOT DISTINCT FROM true,
    'an admin secret accepts any string (no per-key rule)';

  -- status: display policies, never the secret
  v_status := (SELECT string_agg(row_to_json(s)::text, '') FROM public.get_instance_secret_status() s);
  ASSERT position(v_s IN v_status) = 0, 'get_instance_secret_status never returns a secret value';
  ASSERT (SELECT display_value FROM public.get_instance_secret_status() WHERE config_key = 's3_secret_access_key') IS NULL
     AND (SELECT is_set FROM public.get_instance_secret_status() WHERE config_key = 's3_secret_access_key'),
    'none: set, nothing shown';
  ASSERT (SELECT display_value FROM public.get_instance_secret_status() WHERE config_key = 's3_access_key_id') = '…' || right(v_s, 4),
    'last4: an ellipsis and four characters';
  ASSERT (SELECT display_value FROM public.get_instance_secret_status() WHERE config_key = 's3_bucket') = 'civic-os-files',
    'full: the value';
  ASSERT (SELECT group_icon FROM public.get_instance_secret_status() WHERE config_key = 's3_bucket') = 'cloud',
    'the group is joined in';
END $$;
RESET ROLE;

DO $$
BEGIN
  ASSERT metadata.get_instance_secret('t_admin_secret') = 'has space', 'the admin secret is stored';
END $$;

ROLLBACK;
SQL
then
  AFTER=$(psql "$DATABASE_URL" -Atq -c "SELECT md5(string_agg(config_key || '=' || coalesce(config_value, '') || '@' || updated_at, ',' ORDER BY config_key)) FROM metadata.instance_config WHERE is_secret")
  [ "$BEFORE" = "$AFTER" ] || { echo "FAIL: the rollback did not restore the published secret values"; exit 1; }
  echo "PASS: secret instance config keys (RLS, get_config, view, writers, guard, error text, status)"
else
  echo "FAIL: secret instance config checks failed (see error above)"
  exit 1
fi

# -----------------------------------------------------------------------------
# API bodies with real tokens. The published values are whatever the worker set; plant the sentinel in
# a transaction we cannot hold across HTTP requests, so check the real secret instead.
# -----------------------------------------------------------------------------
if [ "${SKIP_API:-}" = "1" ] || ! curl -sf -o /dev/null "$POSTGREST_URL/" 2>/dev/null; then
  echo "SKIP: API checks (SKIP_API or $POSTGREST_URL unreachable)"
  exit 0
fi

SECRET=$(psql "$DATABASE_URL" -Atq -c "SELECT metadata.get_instance_secret('s3_secret_access_key')")
KEYID=$(psql "$DATABASE_URL" -Atq -c "SELECT metadata.get_instance_secret('s3_access_key_id')")
if [ -z "$SECRET" ]; then
  echo "FAIL: no published s3_secret_access_key (has the worker started?)"
  exit 1
fi

token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/civic-os-dev/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=civic-os-dev-client -d username="$1" -d password="$1" |
    python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
}
USER_TOKEN=$(token testuser)
ADMIN_TOKEN=$(token testadmin)

fail=0
check_clean() { # label body
  if printf '%s' "$2" | grep -qF -- "$SECRET"; then echo "FAIL: $1 contains the secret"; fail=1; fi
  if [ ${#KEYID} -gt 4 ] && printf '%s' "$2" | grep -qF -- "$KEYID"; then echo "FAIL: $1 contains the full key id"; fail=1; fi
}
for who in anon user admin; do
  case $who in anon) auth=();; user) auth=(-H "Authorization: Bearer $USER_TOKEN");; admin) auth=(-H "Authorization: Bearer $ADMIN_TOKEN");; esac
  check_clean "$who GET /instance_config" "$(curl -s ${auth[@]+"${auth[@]}"} "$POSTGREST_URL/instance_config")"
  body=$(curl -s ${auth[@]+"${auth[@]}"} "$POSTGREST_URL/instance_config?config_key=eq.s3_secret_access_key")
  [ "$body" = "[]" ] || { echo "FAIL: $who can see the s3_secret_access_key row: $body"; fail=1; }
  check_clean "$who rpc/get_config" "$(curl -s ${auth[@]+"${auth[@]}"} -H 'Content-Type: application/json' -d '{"p_key":"s3_secret_access_key"}' "$POSTGREST_URL/rpc/get_config")"
  check_clean "$who rpc/get_instance_secret_status" "$(curl -s ${auth[@]+"${auth[@]}"} -H 'Content-Type: application/json' -d '{}' "$POSTGREST_URL/rpc/get_instance_secret_status")"
  status=$(curl -s -o /dev/null -w '%{http_code}' ${auth[@]+"${auth[@]}"} -H 'Content-Type: application/json' -d '{"p_key":"s3_secret_access_key"}' "$POSTGREST_URL/rpc/get_instance_secret")
  [ "$status" = 404 ] || { echo "FAIL: /rpc/get_instance_secret is exposed to $who ($status)"; fail=1; }
  status=$(curl -s -o /dev/null -w '%{http_code}' ${auth[@]+"${auth[@]}"} -H 'Content-Type: application/json' -d '{"p_values":{}}' "$POSTGREST_URL/rpc/publish_deployment_config")
  [ "$status" = 404 ] || { echo "FAIL: /rpc/publish_deployment_config is exposed to $who ($status)"; fail=1; }
done
# an admin PATCH changes nothing
curl -s -o /dev/null -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"config_value":"patched"}' "$POSTGREST_URL/instance_config?config_key=eq.s3_secret_access_key" || true
[ "$(psql "$DATABASE_URL" -Atq -c "SELECT metadata.get_instance_secret('s3_secret_access_key')")" = "$SECRET" ] ||
  { echo "FAIL: an admin PATCH changed the secret"; fail=1; }
openapi=$(curl -s "$POSTGREST_URL/")
if printf '%s' "$openapi" | grep -qE 'get_instance_secret"|publish_deployment_config|s3_signing_config'; then
  echo "FAIL: the OpenAPI document lists an owner-only function"; fail=1
fi
admin_status=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{}' "$POSTGREST_URL/rpc/get_instance_secret_status")
printf '%s' "$admin_status" | python3 -c "import sys,json; rows=json.load(sys.stdin); assert all(r['is_set'] for r in rows if r['config_key'].startswith('s3_')), rows" ||
  { echo "FAIL: testadmin does not see every S3 key set (has the worker published?)"; fail=1; }

[ $fail = 0 ] && echo "PASS: API bodies never carry the secret; owner-only functions are not exposed; the worker published" || exit 1
