#!/bin/bash
# =============================================================================
# CI Guard: public views over RLS-protected tables must be security_invoker
# =============================================================================
# A VIEW runs with its owner's privileges, and Civic OS views are owned by a superuser (BYPASSRLS), so a
# public view whose base table has row-level security silently ignores those policies unless it sets
# security_invoker = true. CREATE OR REPLACE VIEW (and DROP + CREATE) resets that option, which is how
# the option was lost on several views in earlier migrations.
#
# After a full deploy this script fails if any view in the public schema reads (directly or through
# other views) a table with RLS enabled and lacks security_invoker, unless the view is listed in the
# allowlist below. Add a view to the allowlist only for a deliberate definer view, and state why.
#
# Usage (run against a fully migrated database):
#   DATABASE_URL=postgres://... ./tests/functional/view-security-guard-test.sh
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

# view|reason it may stay a definer view
ALLOWLIST='
categories|Reference data; the base table policy is "everyone can read", so a definer view returns the same rows.
statuses|Reference data; the base table policy is "everyone can read", so a definer view returns the same rows.
static_text|Display-only content blocks; the base table policy is "everyone can read".
notification_templates|Templates are readable by everyone per the base table policy; writes are not granted through the view.
schema_decisions|Architectural decision records; the base table policy is "everyone can read".
schema_entities|Entity metadata bridge for the frontend; the base table policy is "everyone can read" (and it joins other metadata).
schema_properties|Property metadata bridge for the frontend; it reads information_schema, which filters by privilege itself.
schema_m2m_properties|Metadata bridge for the frontend; it reads catalog data, not RLS-protected tables.
schema_cache_versions|Cache-version timestamps aggregated from metadata tables whose read policies are "everyone can read".
constraint_messages|Metadata bridge for the frontend; no RLS-protected base table.
payment_transactions|NOT security_invoker by design: the payments schema is unreachable by API roles and payers cannot read the refunds the view aggregates, so the view filters per caller in its own body (security_barrier). Covered by v0-76-9-view-rls-test.sh.
payment_refunds|NOT security_invoker by design for the same reason; filters per caller in its own body (security_barrier). Covered by v0-76-9-view-rls-test.sh.
'

OFFENDERS=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -F '|' <<'SQL'
WITH RECURSIVE deps AS (
  SELECT v.oid AS root, v.oid AS cur
  FROM pg_class v
  WHERE v.relkind = 'v' AND v.relnamespace = 'public'::regnamespace
  UNION
  SELECT d.root, dep.refobjid
  FROM deps d
  JOIN pg_rewrite r ON r.ev_class = d.cur
  JOIN pg_depend dep ON dep.objid = r.oid
                    AND dep.classid = 'pg_rewrite'::regclass
                    AND dep.refclassid = 'pg_class'::regclass
                    AND dep.refobjid <> d.cur
)
SELECT v.relname, string_agg(DISTINCT t.relnamespace::regnamespace || '.' || t.relname, ', ' ORDER BY t.relnamespace::regnamespace || '.' || t.relname)
FROM deps
JOIN pg_class v ON v.oid = deps.root
JOIN pg_class t ON t.oid = deps.cur AND t.relkind IN ('r', 'p') AND t.relrowsecurity
WHERE NOT coalesce(v.reloptions @> ARRAY['security_invoker=true'], false)
GROUP BY v.relname
ORDER BY v.relname;
SQL
)

FAILED=0
while IFS='|' read -r view tables; do
  [ -z "$view" ] && continue
  if printf '%s\n' "$ALLOWLIST" | grep -q "^${view}|"; then
    continue
  fi
  echo "FAIL: public.${view} reads RLS-protected table(s) (${tables}) but is not security_invoker."
  echo "      Use CREATE OR REPLACE VIEW ... WITH (security_invoker = true) (or ALTER VIEW ... SET (security_invoker = true))."
  echo "      If it is a deliberate definer view, add it to the allowlist in this script with the reason."
  FAILED=1
done <<< "$OFFENDERS"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "PASS: every public view over an RLS-protected table is security_invoker or explicitly allowlisted"
