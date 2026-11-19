#!/bin/bash
# =============================================================================
# Functional Test: v0-82-0 metadata.dashboards NOT NULL columns
# =============================================================================
# is_default, is_public, sort_order, created_at and updated_at are NOT NULL (with show_title and
# show_in_selector), matching @civic-os/core's Dashboard type. Asserts:
#   - an insert that omits them gets the column defaults (and the timestamp triggers)
#   - an explicit NULL in any of them is rejected with not_null_violation
#   - get_dashboard() returns show_title and show_in_selector as booleans, never null
# The backfill (NULL -> the value readers already took it to mean) runs once at deploy and is verified by
# deploying onto a database seeded with NULLs; see docs/notes/DASHBOARD_DESIGN.md (Amendment: NOT NULL).
# Everything runs in one transaction that is rolled back.
#
# Usage: ./tests/functional/v0-82-0-dashboards-not-null-test.sh
# Environment: DATABASE_URL (superuser, to create fixtures)
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

DO $$
DECLARE
  v_id INT;
  v_row metadata.dashboards%ROWTYPE;
  v_json JSON;
  v_col TEXT;
BEGIN
  ASSERT (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'metadata' AND table_name = 'dashboards' AND is_nullable = 'YES'
            AND column_name IN ('is_default', 'is_public', 'sort_order', 'created_at', 'updated_at',
                                'show_title', 'show_in_selector')) = 0,
    'every typed-as-non-null dashboards column is NOT NULL';

  -- Omitted columns take their defaults
  INSERT INTO metadata.dashboards (display_name) VALUES ('NN defaults') RETURNING id INTO v_id;
  SELECT * INTO v_row FROM metadata.dashboards WHERE id = v_id;
  ASSERT v_row.is_default IS FALSE AND v_row.is_public IS TRUE AND v_row.sort_order = 0
     AND v_row.show_title IS TRUE AND v_row.show_in_selector IS TRUE
     AND v_row.created_at IS NOT NULL AND v_row.updated_at IS NOT NULL,
    'an insert that omits the columns gets the defaults';

  -- An explicit NULL is rejected, column by column
  FOREACH v_col IN ARRAY ARRAY['is_default', 'is_public', 'sort_order', 'show_title', 'show_in_selector'] LOOP
    BEGIN
      EXECUTE format('UPDATE metadata.dashboards SET %I = NULL WHERE id = $1', v_col) USING v_id;
      RAISE EXCEPTION 'NULL % was accepted', v_col;
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
  END LOOP;

  -- get_dashboard() returns real booleans (no COALESCE needed any more)
  v_json := public.get_dashboard(v_id);
  ASSERT json_typeof(v_json->'show_title') = 'boolean' AND json_typeof(v_json->'show_in_selector') = 'boolean',
    'get_dashboard returns show_title and show_in_selector as booleans';
  ASSERT json_typeof(v_json->'is_public') = 'boolean' AND json_typeof(v_json->'is_default') = 'boolean'
     AND json_typeof(v_json->'sort_order') = 'number',
    'get_dashboard returns is_public, is_default and sort_order set';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: metadata.dashboards columns typed as non-null are NOT NULL, with defaults, and get_dashboard returns them set"
else
  echo "FAIL: metadata.dashboards NOT NULL columns are incomplete (see error above)"
  exit 1
fi
