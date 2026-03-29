#!/usr/bin/env bash
# Reset the eval database to a clean state (baseline or pothole).
# Much faster than destroying/recreating the container (~5s vs ~30s).
#
# Usage:
#   ./scripts/reset-db.sh              # baseline only
#   ./scripts/reset-db.sh pothole      # baseline + pothole schema

set -euo pipefail

CONTAINER="${EVAL_CONTAINER:-docker-eval-pg-1}"
POSTGREST_URL="${EVAL_POSTGREST_URL:-http://localhost:3001}"
DB="civic_os_eval"
STATE="${1:-baseline}"

echo "Resetting eval DB to: $STATE"

# Terminate active connections then drop and recreate database
docker exec "$CONTAINER" psql -U postgres -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = '$DB' AND pid <> pg_backend_pid();
" >/dev/null 2>&1
docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1
docker exec "$CONTAINER" psql -U postgres -c "CREATE DATABASE $DB;" >/dev/null 2>&1

# Re-create authenticator role (may already exist from initial setup)
docker exec "$CONTAINER" psql -U postgres -d "$DB" -c "
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
      CREATE ROLE authenticator NOINHERIT LOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'web_anon') THEN
      CREATE ROLE web_anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    GRANT web_anon TO authenticator;
    GRANT authenticated TO authenticator;
  END \$\$;
" >/dev/null 2>&1

# Run Sqitch migrations
docker exec "$CONTAINER" bash -c "cd /civic-os-migrations && sqitch deploy --verify 'db:pg://postgres@localhost/$DB'" 2>&1 | grep -E "^(  \+|Deploying|$)" | tail -5

# Apply pothole starting state if requested
if [[ "$STATE" == "pothole" ]]; then
  echo "Applying pothole schema..."
  for script in 01_pot_hole_schema.sql 02_validation_examples.sql 04_pot_hole_permissions.sql; do
    docker exec "$CONTAINER" psql -U postgres -d "$DB" -f "/pothole-init/$script" >/dev/null 2>&1
  done
  echo "Pothole schema applied"
fi

# Set authenticator password (PostgREST connects as authenticator)
docker exec "$CONTAINER" psql -U postgres -d "$DB" -c "
  ALTER ROLE authenticator WITH PASSWORD 'evalpass';
" >/dev/null 2>&1

# Reload PostgREST schema cache via NOTIFY
docker exec "$CONTAINER" psql -U postgres -d "$DB" -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1

# Wait for PostgREST to pick up the reload (LISTEN/NOTIFY is async)
sleep 1

# Verify PostgREST is responding
if curl -sf "$POSTGREST_URL/" >/dev/null 2>&1; then
  echo "PostgREST schema cache reloaded"
else
  echo "Warning: PostgREST not responding at $POSTGREST_URL (context will fall back to direct DB)"
fi

echo "Reset complete"
