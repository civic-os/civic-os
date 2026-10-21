#!/bin/bash
# =============================================================================
# v0.76.9 occurrence_date pre-flight sync test
# =============================================================================
# The upgrade pre-flight (postgres/migrations/scripts/v0-76-9-occurrence-date-preflight.sql)
# plans the occurrence_date conversion with the same code as migration
# v0-76-9-occurrence-date-local. The block between the ">>> shared" and
# "<<< shared" markers must be identical in both files, or the pre-flight would
# report something other than what the upgrade does.
#
# Usage:
#   ./tests/functional/v0-76-9-occurrence-date-preflight-sync-test.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

shared() { awk '/^-- >>> shared/{f=1;next} /^-- <<< shared/{f=0} f' "$1"; }

DEPLOY=postgres/migrations/deploy/v0-76-9-occurrence-date-local.sql
PREFLIGHT=postgres/migrations/scripts/v0-76-9-occurrence-date-preflight.sql

if [ -z "$(shared "$DEPLOY")" ]; then
    echo "FAIL: no shared block in $DEPLOY"; exit 1
fi
if diff <(shared "$DEPLOY") <(shared "$PREFLIGHT"); then
    echo "PASS: pre-flight and migration share the same conversion code"
else
    echo "FAIL: the shared blocks differ (see diff above)"; exit 1
fi
