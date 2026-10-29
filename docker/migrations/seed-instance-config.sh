#!/bin/sh
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
#
# Civic OS Instance Config Seeder
#
# Copies the deployment's Tier 2 environment variables into
# metadata.instance_config, once. Only rows whose config_value is NULL are
# filled, so a value an admin has edited is never overwritten. To re-seed a
# key, set its config_value back to NULL (Reset on /admin/config).
#
# Best-effort: any failure prints a WARNING and the script still exits 0, so a
# seed problem never blocks the stack (PostgREST waits on the migrations
# service completing successfully). Each key is seeded on its own, so one bad
# value (rejected by the table's validation trigger) does not stop the others.
#
# Required: PGRST_DB_URI (psql accepts postgres:// URIs directly)
# See docs/notes/INSTANCE_SETUP_DESIGN.md (Seed-Once Mechanism).

if [ -z "$PGRST_DB_URI" ]; then
  echo "WARNING: instance config seed skipped: PGRST_DB_URI is not set"
  exit 0
fi

# Run psql against the target. Keys and values travel as psql variables
# (-v) and are quoted by psql (:'name'), never interpolated into the SQL text.
run_psql() {
  psql "$PGRST_DB_URI" -X -q -t -A -v ON_ERROR_STOP=1 "$@"
}

echo ""
echo "Seeding instance config from environment..."

if ! HAS_TABLE=$(run_psql -c "SELECT to_regclass('metadata.instance_config') IS NOT NULL" 2>&1); then
  echo "WARNING: instance config seed failed: ${HAS_TABLE}"
  exit 0
fi

if [ "$HAS_TABLE" != "t" ]; then
  echo "Skipping instance config seed: metadata.instance_config does not exist yet"
  exit 0
fi

# seed_key ENV_VAR config_key
seed_key() {
  _env="$1"
  _key="$2"
  _val=$(printenv "$_env") || return 0
  # Whitespace-only counts as unset: the table's trigger would store it as NULL.
  [ -n "$(printf '%s' "$_val" | tr -d ' \t\r\n')" ] || return 0

  if _out=$(run_psql -v "key=${_key}" -v "val=${_val}" 2>&1 <<'SQL'
WITH u AS (
  UPDATE metadata.instance_config
     SET config_value = :'val'
   WHERE config_key = :'key' AND config_value IS NULL
  RETURNING 1
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM u) THEN 'seeded'
  WHEN EXISTS (SELECT 1 FROM metadata.instance_config WHERE config_key = :'key') THEN 'kept'
  ELSE 'missing'
END;
SQL
  ); then
    case "$_out" in
      seeded)  echo "  seeded ${_key}" ;;
      kept)    echo "  kept ${_key} (already set)" ;;
      missing) echo "  skipped ${_key} (no such config key)" ;;
      *)       echo "  WARNING: instance config seed failed for ${_key}: unexpected result" ;;
    esac
  else
    # Never echo psql's message for the Stripe key: it may quote the value.
    if [ "$_key" = "stripe_publishable_key" ]; then
      echo "  WARNING: instance config seed failed for ${_key}"
    else
      echo "  WARNING: instance config seed failed for ${_key}: ${_out}"
    fi
  fi
  return 0
}

seed_key APP_TITLE              app_title
seed_key DEFAULT_THEME          default_theme
seed_key DEFAULT_LOCALE         default_locale
seed_key SUPPORTED_LOCALES      supported_locales
seed_key SMS_CONFIGURED         sms_configured
seed_key MATOMO_ENABLED         matomo_enabled
seed_key MAP_DEFAULT_LAT        map_default_lat
seed_key MAP_DEFAULT_LNG        map_default_lng
seed_key MAP_DEFAULT_ZOOM       map_default_zoom
seed_key STRIPE_PUBLISHABLE_KEY stripe_publishable_key

echo "Instance config seed complete"
exit 0
