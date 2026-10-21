#!/bin/bash
# =============================================================================
# Recurring DST Agreement Test (Go worker vs PostgreSQL)
# =============================================================================
# The expansion worker (Go, wallClockInstant) and the SQL split/repair functions
# (`timestamp AT TIME ZONE tz`) must resolve wall-clock times to the same UTC
# instant, including inside DST transition hours. Both sides are checked against
# one fixture:
#   services/consolidated-worker-go/testdata/dst_wallclock_cases.json
# The Go side is TestWallClockInstant_MatchesPostgreSQL (go test); this script is
# the PostgreSQL side. A failure here means PostgreSQL's rule changed (or the
# fixture is wrong) and the worker must be re-pinned.
#
# Usage:
#   ./tests/functional/recurring-dst-agreement-test.sh
#
# Prerequisites:
#   - A Civic OS PostgreSQL reachable via PGHOST/PGPORT (default localhost:15432)
#   - python3 (to read the JSON fixture)
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-15432}"
PGDB="${PGDB:-civic_os_db}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-securepassword123}"
export PGPASSWORD

FIXTURE="$(cd "$(dirname "$0")/../.." && pwd)/services/consolidated-worker-go/testdata/dst_wallclock_cases.json"

PASS=0
FAIL=0

while IFS=$'\t' read -r tz wall expected kind; do
  got=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -Atq -c \
    "SELECT to_char(('$wall'::timestamp AT TIME ZONE '$tz') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")
  if [ "$got" = "$expected" ]; then
    echo -e "  ${GREEN}PASS${NC} $tz $wall ($kind) -> $got"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $tz $wall ($kind): PostgreSQL $got, fixture $expected"
    FAIL=$((FAIL + 1))
  fi
done < <(python3 -c '
import json, sys
for c in json.load(open(sys.argv[1]))["cases"]:
    print("\t".join([c["tz"], c["wall"], c["utc"], c["kind"]]))
' "$FIXTURE")

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
