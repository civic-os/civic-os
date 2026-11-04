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
# Prints one WARNING and stops (still exit 0) when the connecting role cannot
# see the table's rows: metadata.instance_config has row level security, so a
# role that is neither the table owner nor BYPASSRLS would update nothing and
# the per-key lines would be misleading. Prints a notice when no Tier 2
# variable is set at all, so a deployment path that never passes them
# (migrate-production.sh without --env-file, a K8s initContainer without
# envFrom) is visible in the log.
#
# Required: PGRST_DB_URI (psql accepts postgres:// URIs directly)
# See docs/notes/INSTANCE_SETUP_DESIGN.md (Seed-Once Mechanism).

if [ -z "$PGRST_DB_URI" ]; then
  echo "WARNING: instance config seed skipped: PGRST_DB_URI is not set"
  exit 0
fi

TIER2_VARS="APP_TITLE DEFAULT_THEME DEFAULT_LOCALE SUPPORTED_LOCALES SMS_CONFIGURED MATOMO_ENABLED MAP_DEFAULT_LAT MAP_DEFAULT_LNG MAP_DEFAULT_ZOOM STRIPE_PUBLISHABLE_KEY"

# Whitespace-only counts as unset: the table's trigger would store it as NULL.
ANY_SET=""
for _v in $TIER2_VARS; do
  _x=$(printenv "$_v") || continue
  if [ -n "$(printf '%s' "$_x" | tr -d ' \t\r\n')" ]; then
    ANY_SET=1
    break
  fi
done

if [ -z "$ANY_SET" ]; then
  echo ""
  echo "Instance config seed: no Tier 2 variables set, nothing to seed"
  echo "  (set ${TIER2_VARS} in the migrations container environment to seed instance config)"
  exit 0
fi

# Run psql against the target. Keys and values travel as psql variables
# (-v) and are quoted by psql (:'name'), never interpolated into the SQL text.
run_psql() {
  psql "$PGRST_DB_URI" -X -q -t -A -v ON_ERROR_STOP=1 "$@"
}

echo ""
echo "Seeding instance config from environment..."

# Probe queries keep stdout (the result) apart from stderr (NOTICEs, errors) so a
# server notice cannot corrupt the parsed value.
PROBE_ERR=$(mktemp 2>/dev/null || echo /tmp/seed-probe-err.$$)
trap 'rm -f "$PROBE_ERR"' EXIT

if ! HAS_TABLE=$(run_psql -c "SELECT to_regclass('metadata.instance_config') IS NOT NULL" 2>"$PROBE_ERR"); then
  echo "WARNING: instance config seed failed: $(cat "$PROBE_ERR")"
  exit 0
fi

if [ "$HAS_TABLE" != "t" ]; then
  echo "Skipping instance config seed: metadata.instance_config does not exist yet"
  exit 0
fi

# The table has row level security. A role that is neither the owner nor
# BYPASSRLS sees no rows, which would make every key below log "kept" or
# "skipped" while nothing is seeded. The migration seeds the framework rows,
# so zero visible rows means this role cannot see them.
if ! ROWS=$(run_psql -c "SELECT count(*) FROM metadata.instance_config" 2>"$PROBE_ERR"); then
  echo "WARNING: instance config seed failed: $(cat "$PROBE_ERR")"
  exit 0
fi

case "$ROWS" in
  ''|*[!0-9]*)
    echo "WARNING: instance config seed skipped: could not read the row count of metadata.instance_config"
    exit 0 ;;
esac

if [ "$ROWS" = "0" ]; then
  _who=$(run_psql -c "SELECT format('%s (table owner: %s, bypassrls: %s)', current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'instance_config'), (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user))" 2>/dev/null || echo "an unknown role")
  echo "WARNING: instance config seed skipped: this role cannot see any rows in metadata.instance_config"
  echo "  Connected as ${_who}."
  echo "  Connect as the table owner or a BYPASSRLS role (the migration role) to seed."
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
