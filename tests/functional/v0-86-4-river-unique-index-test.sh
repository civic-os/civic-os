#!/bin/bash
# =============================================================================
# River unique jobs after dropping the legacy index (v0.86.4, issue #147)
# =============================================================================
# Inserts River job rows the way River's client does (unique_key plus the
# unique_states bitmask of the states a job declares), in one transaction that is
# rolled back, and checks that:
#   1. the legacy index metadata.river_job_kind_unique_key_idx is gone;
#   2. a schema parse job can be queued while a completed one is still kept;
#   3. a second parse job is still refused while the first is available;
#   4. a scheduled-job execution (unique in every state) is still refused while
#      a completed one for the same scheduled time is kept.
#
# Usage:
#   ./tests/functional/v0-86-4-river-unique-index-test.sh
#
# Environment overrides: PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDB (default: the
# example stacks' postgres on localhost:15432).
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; FAIL=0
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-15432}"; PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-securepassword123}"; PGDB="${PGDB:-civic_os_db}"
export PGPASSWORD

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1));
  else echo -e "  ${RED}FAIL${NC} $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1)); fi
}

# Bit order of metadata.river_job_state_in_bitmask(): bit 7 available, 6 cancelled,
# 5 completed, 4 discarded, 3 pending, 2 retryable, 1 running, 0 scheduled.
PARSE_STATES="B'10001011'"   # ParseAllSourceCodeArgs: available, pending, running, scheduled
ALL_STATES="B'11111111'"     # ScheduledJobExecuteArgs: every state

OUT=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -Atq 2>&1 <<SQL
BEGIN;
SELECT 'LEGACY_INDEX ' || (to_regclass('metadata.river_job_kind_unique_key_idx') IS NOT NULL);
CREATE FUNCTION pg_temp.try_insert(p_kind text, p_key text, p_states bit(8), p_state text) RETURNS text
LANGUAGE plpgsql AS \$f\$
BEGIN
  INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, unique_key, unique_states,
                                  finalized_at)
  VALUES (p_state::metadata.river_job_state, 'triage_test', p_kind, '{}', 1, convert_to(p_key, 'UTF8'), p_states,
          CASE WHEN p_state = 'completed' THEN now() END);
  RETURN 'ok';
EXCEPTION WHEN unique_violation THEN RETURN 'duplicate';
END \$f\$;
SELECT 'PARSE_COMPLETED ' || pg_temp.try_insert('rtest_parse', 'rtest-parse-key', $PARSE_STATES, 'completed');
SELECT 'PARSE_AFTER_COMPLETED ' || pg_temp.try_insert('rtest_parse', 'rtest-parse-key', $PARSE_STATES, 'available');
SELECT 'PARSE_WHILE_AVAILABLE ' || pg_temp.try_insert('rtest_parse', 'rtest-parse-key', $PARSE_STATES, 'available');
SELECT 'SCHED_COMPLETED ' || pg_temp.try_insert('rtest_sched', 'rtest-sched-key', $ALL_STATES, 'completed');
SELECT 'SCHED_AFTER_COMPLETED ' || pg_temp.try_insert('rtest_sched', 'rtest-sched-key', $ALL_STATES, 'available');
ROLLBACK;
SQL
)
val() { echo "$OUT" | grep -o "^$1 .*" | cut -d' ' -f2; }

echo "River unique jobs (v0.86.4, issue #147)"
check "the legacy index river_job_kind_unique_key_idx is gone" "false" "$(val LEGACY_INDEX)"
check "a completed parse job can be recorded" "ok" "$(val PARSE_COMPLETED)"
check "a new parse job is queued while a completed one is kept" "ok" "$(val PARSE_AFTER_COMPLETED)"
check "a second parse job is refused while one is available" "duplicate" "$(val PARSE_WHILE_AVAILABLE)"
check "a completed scheduled-job execution can be recorded" "ok" "$(val SCHED_COMPLETED)"
check "the same execution is refused while the completed one is kept" "duplicate" "$(val SCHED_AFTER_COMPLETED)"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
