#!/bin/bash
# =============================================================================
# Functional Test: v0-80-0 schema cache versions for statuses, category_key for the categories RPC
# =============================================================================
# Covers public.schema_cache_versions:
#   - `statuses` moves on INSERT and UPDATE of metadata.statuses and metadata.status_types;
#   - `categories` moves on INSERT and UPDATE of metadata.categories and metadata.category_groups;
#   - the view stays readable by web_anon and authenticated.
# Covers public.get_categories_for_entity():
#   - returns category_key to web_anon and authenticated;
#   - has no PUBLIC entry in its ACL.
#
# NOW() is fixed for a transaction, so each case runs in its own rolled-back transaction, with
# fixtures dated in the past so that the version read before the change is older than NOW().
#
# Usage:
#   ./tests/functional/v0-80-0-widget-key-filters-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures and switch roles):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

FAIL=0

# version_moves <label> <cache_name> <fixture SQL> <change SQL>
version_moves() {
  local label="$1" cache="$2" fixture="$3" change="$4"
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL
BEGIN;
$fixture
CREATE TEMP TABLE before_change ON COMMIT DROP AS
  SELECT version FROM public.schema_cache_versions WHERE cache_name = '$cache';
$change
DO \$\$
BEGIN
  ASSERT (SELECT count(*) FROM before_change) = 1, 'the version row exists';
  ASSERT (SELECT v.version > b.version
          FROM public.schema_cache_versions v, before_change b
          WHERE v.cache_name = '$cache'), 'the version moved';
END \$\$;
ROLLBACK;
SQL
  then
    echo "ok   $label"
  else
    echo "FAIL $label"
    FAIL=1
  fi
}

OLD="'2001-01-01 00:00:00+00'"

version_moves "statuses moves on INSERT into metadata.status_types" statuses \
  "" \
  "INSERT INTO metadata.status_types (entity_type) VALUES ('wkf_fixture');"

version_moves "statuses moves on UPDATE of metadata.status_types" statuses \
  "INSERT INTO metadata.status_types (entity_type, updated_at) VALUES ('wkf_fixture', $OLD);" \
  "UPDATE metadata.status_types SET description = 'changed' WHERE entity_type = 'wkf_fixture';"

version_moves "statuses moves on INSERT into metadata.statuses" statuses \
  "INSERT INTO metadata.status_types (entity_type, updated_at) VALUES ('wkf_fixture', $OLD);" \
  "INSERT INTO metadata.statuses (entity_type, display_name) VALUES ('wkf_fixture', 'New');"

version_moves "statuses moves on UPDATE of metadata.statuses" statuses \
  "INSERT INTO metadata.status_types (entity_type, updated_at) VALUES ('wkf_fixture', $OLD);
   INSERT INTO metadata.statuses (entity_type, display_name, updated_at) VALUES ('wkf_fixture', 'New', $OLD);" \
  "UPDATE metadata.statuses SET display_name = 'Renamed' WHERE entity_type = 'wkf_fixture';"

version_moves "categories moves on INSERT into metadata.category_groups" categories \
  "" \
  "INSERT INTO metadata.category_groups (entity_type) VALUES ('wkf_fixture');"

version_moves "categories moves on UPDATE of metadata.category_groups" categories \
  "INSERT INTO metadata.category_groups (entity_type, updated_at) VALUES ('wkf_fixture', $OLD);" \
  "UPDATE metadata.category_groups SET description = 'changed' WHERE entity_type = 'wkf_fixture';"

version_moves "categories moves on INSERT into metadata.categories" categories \
  "INSERT INTO metadata.category_groups (entity_type, updated_at) VALUES ('wkf_fixture', $OLD);" \
  "INSERT INTO metadata.categories (entity_type, display_name) VALUES ('wkf_fixture', 'Hand tools');"

version_moves "categories moves on UPDATE of metadata.categories" categories \
  "INSERT INTO metadata.category_groups (entity_type, updated_at) VALUES ('wkf_fixture', $OLD);
   INSERT INTO metadata.categories (entity_type, display_name, updated_at) VALUES ('wkf_fixture', 'Hand tools', $OLD);" \
  "UPDATE metadata.categories SET display_name = 'Renamed' WHERE entity_type = 'wkf_fixture';"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;
INSERT INTO metadata.category_groups (entity_type) VALUES ('wkf_fixture');
INSERT INTO metadata.categories (entity_type, display_name, category_key) VALUES ('wkf_fixture', 'Hand tools', 'hand');

SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.schema_cache_versions WHERE cache_name = 'statuses') = 1,
    'web_anon reads the statuses version';
  ASSERT (SELECT category_key FROM public.get_categories_for_entity('wkf_fixture')) = 'hand',
    'web_anon receives category_key';
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.schema_cache_versions WHERE cache_name = 'statuses') = 1,
    'authenticated reads the statuses version';
  ASSERT (SELECT category_key FROM public.get_categories_for_entity('wkf_fixture')) = 'hand',
    'authenticated receives category_key';
END $$;
RESET ROLE;

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1
    FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.oid = 'public.get_categories_for_entity(text)'::regprocedure AND a.grantee = 0
  ), 'get_categories_for_entity has no PUBLIC entry';
  ASSERT (SELECT proacl IS NOT NULL FROM pg_proc
          WHERE oid = 'public.get_categories_for_entity(text)'::regprocedure),
    'get_categories_for_entity has an explicit ACL';
END $$;
ROLLBACK;
SQL
then
  echo "ok   category_key and grants"
else
  echo "FAIL category_key and grants"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "v0-80-0 widget key filters test FAILED"
  exit 1
fi
echo "v0-80-0 widget key filters test passed"
