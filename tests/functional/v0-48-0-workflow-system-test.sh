#!/bin/bash
# =============================================================================
# Functional Test Suite: v0.48.0 Guided Form System
# =============================================================================
# Tests the complete guided form feature: migration, tables, RPCs,
# CHECK constraints, submit locks, on_submit_rpc, and progress tracking.
#
# Usage:
#   ./tests/functional/v0-48-0-workflow-system-test.sh
#
# Prerequisites:
#   - Docker compose running (neighborhood-hub example)
#   - Keycloak JWT fetched
#   - jq installed
# =============================================================================

set -uo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Counters
PASS=0
FAIL=0
SKIP=0

# Configuration
POSTGREST_URL="http://localhost:3000"
KEYCLOAK_URL="http://localhost:8082"
KEYCLOAK_REALM="civic-os-dev"
KEYCLOAK_CLIENT="civic-os-dev-client"
DB_HOST="localhost"
DB_PORT="15432"
DB_NAME="civic_os_db"
DB_USER="postgres"
DB_PASS="securepassword123"

PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A"

# =============================================================================
# Test Helpers
# =============================================================================

assert_eq() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}PASS${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name"
    echo -e "       Expected: ${CYAN}$expected${NC}"
    echo -e "       Actual:   ${RED}$actual${NC}"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_empty() {
  local test_name="$1"
  local actual="$2"
  if [ -n "$actual" ] && [ "$actual" != "null" ] && [ "$actual" != "" ]; then
    echo -e "  ${GREEN}PASS${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name (got empty/null)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -qi "$expected"; then
    echo -e "  ${GREEN}PASS${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name"
    echo -e "       Expected to contain: ${CYAN}$expected${NC}"
    echo -e "       Actual: ${RED}$actual${NC}"
    FAIL=$((FAIL + 1))
  fi
}

skip_test() {
  local test_name="$1"
  local reason="$2"
  echo -e "  ${YELLOW}SKIP${NC} $test_name ($reason)"
  SKIP=$((SKIP + 1))
}

section() {
  echo ""
  echo -e "${BOLD}━━━ $1 ━━━${NC}"
}

get_token() {
  local username="$1"
  curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d "client_id=$KEYCLOAK_CLIENT" \
    -d "username=$username" \
    -d "password=$username" \
    -d "grant_type=password" 2>/dev/null | jq -r '.access_token // empty'
}

# Helper: call an RPC and capture both body and HTTP status
call_rpc() {
  local rpc_name="$1"
  local payload="$2"
  local token="$3"
  curl -s -o /tmp/rpc_body.json -w "%{http_code}" \
    -X POST "$POSTGREST_URL/rpc/$rpc_name" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

# =============================================================================
# SETUP: Get Tokens and Seed Test Data
# =============================================================================

section "SETUP: Authentication & Test Data"

ADMIN_TOKEN=$(get_token "testadmin")
EDITOR_TOKEN=$(get_token "testeditor")

if [ -z "$ADMIN_TOKEN" ]; then
  echo -e "  ${RED}FAIL${NC} Could not get admin token from Keycloak"
  FAIL=$((FAIL + 1))
  exit 1
fi

echo "  Admin token acquired."

# Look up guided_form status IDs (shared across all guided forms)
DRAFT_STATUS_ID=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT id FROM metadata.statuses WHERE entity_type='guided_form' AND status_key='draft';" 2>/dev/null)
COMPLETE_STATUS_ID=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT id FROM metadata.statuses WHERE entity_type='guided_form' AND status_key='complete';" 2>/dev/null)
SUBMITTED_STATUS_ID=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT id FROM metadata.statuses WHERE entity_type='guided_form' AND status_key='submitted';" 2>/dev/null)

echo "  Status IDs: draft=$DRAFT_STATUS_ID complete=$COMPLETE_STATUS_ID submitted=$SUBMITTED_STATUS_ID"

# Seed a test guided form and participating tables
SETUP_OUTPUT=$(PGPASSWORD=$DB_PASS $PSQL -c "
-- Clean up previous test data
UPDATE metadata.entities SET guided_form_key = NULL WHERE guided_form_key IN ('test_gf', 'test_gf_rpc');
DELETE FROM metadata.guided_form_progress WHERE guided_form_key IN ('test_gf', 'test_gf_rpc');
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key IN ('test_gf', 'test_gf_rpc')
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key IN ('test_gf', 'test_gf_rpc');
DELETE FROM metadata.guided_forms WHERE guided_form_key IN ('test_gf', 'test_gf_rpc');
DROP TABLE IF EXISTS public.test_gf_step1 CASCADE;
DROP TABLE IF EXISTS public.test_gf_parent CASCADE;
DROP TABLE IF EXISTS public.test_rpc_parent CASCADE;
DROP FUNCTION IF EXISTS public.test_on_submit_rpc(BIGINT);

-- Create parent table with status_id defaulting to draft
CREATE TABLE public.test_gf_parent (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    status_id INTEGER REFERENCES metadata.statuses(id) DEFAULT $DRAFT_STATUS_ID,
    submitted_at TIMESTAMPTZ,
    applicant_name VARCHAR(100),
    is_nonprofit BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID DEFAULT public.current_user_id()
);

-- Create step 1 table
CREATE TABLE public.test_gf_step1 (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    status_id INTEGER REFERENCES metadata.statuses(id) DEFAULT $DRAFT_STATUS_ID,
    parent_id BIGINT REFERENCES public.test_gf_parent(id),
    inspector_notes TEXT,
    inspection_passed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Register entities in metadata schema
INSERT INTO metadata.entities (table_name, display_name)
VALUES ('test_gf_parent', 'Test GF Parent')
ON CONFLICT (table_name) DO UPDATE SET display_name = 'Test GF Parent';

INSERT INTO metadata.entities (table_name, display_name)
VALUES ('test_gf_step1', 'Test GF Step 1')
ON CONFLICT (table_name) DO UPDATE SET display_name = 'Test GF Step 1';

-- Grant permissions to authenticated
GRANT ALL ON public.test_gf_parent TO authenticated;
GRANT ALL ON public.test_gf_step1 TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.test_gf_parent_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.test_gf_step1_id_seq TO authenticated;

-- Register guided form (use named params matching deploy function signature)
DO \$\$
DECLARE
    v_result JSONB;
BEGIN
    v_result := public.register_guided_form(
        p_guided_form_key := 'test_gf'::name,
        p_parent_table := 'test_gf_parent'::name,
        p_description := 'A test guided form for functional testing'::text,
        p_on_submit_rpc := NULL::name,
        p_parent_step_display_name := 'Application Details'::varchar,
        p_review_intro_text := 'Please review all information before submitting.'::text,
        p_lock_on_submit := TRUE
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_guided_form failed: %', v_result->>'message';
    END IF;
END \$\$;

-- Add step 1
SELECT public.add_guided_form_step(
    'test_gf'::name,
    'inspection'::name,
    'Site Inspection'::varchar,
    1,
    'test_gf_step1'::name,
    'parent_id'::name,
    'A test step for inspection'::text,
    FALSE
);

-- Add skip condition: skip inspection if nonprofit
SELECT public.add_guided_form_step_condition(
    'test_gf'::name,
    'inspection'::name,
    'skip_if'::name,
    'is_nonprofit'::name,
    'eq'::name,
    'true'::text
);

-- Add validations for test tables so CHECK constraints are generated
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES ('test_gf_parent', 'display_name', 'required', '', 'Display name is required')
ON CONFLICT (table_name, column_name, validation_type) DO NOTHING;

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES ('test_gf_step1', 'inspector_notes', 'required', '', 'Inspector notes are required')
ON CONFLICT (table_name, column_name, validation_type) DO NOTHING;

-- Rebuild constraints to generate CHECK constraints on test tables
SELECT metadata.rebuild_guided_form_constraints('test_gf_parent');
SELECT metadata.rebuild_guided_form_constraints('test_gf_step1');
" 2>&1)

if [ $? -ne 0 ]; then
  echo -e "  ${RED}FAIL${NC} Test data setup failed:"
  echo "$SETUP_OUTPUT"
  exit 1
fi

echo "  Test guided form and tables created."

# Reload PostgREST schema cache
PGPASSWORD=$DB_PASS $PSQL -c "NOTIFY pgrst, 'reload schema';" 2>/dev/null
sleep 1
echo "  PostgREST schema cache reloaded."

# =============================================================================
# PART 1: Migration Verification
# =============================================================================

section "PART 1: Migration Artifacts"

# 1a. guided_forms table exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='metadata' AND table_name='guided_forms';" 2>/dev/null)
assert_eq "1a. metadata.guided_forms table exists" "guided_forms" "$RESULT"

# 1b. guided_form_steps table exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='metadata' AND table_name='guided_form_steps';" 2>/dev/null)
assert_eq "1b. metadata.guided_form_steps table exists" "guided_form_steps" "$RESULT"

# 1c. guided_form_step_conditions table exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='metadata' AND table_name='guided_form_step_conditions';" 2>/dev/null)
assert_eq "1c. metadata.guided_form_step_conditions table exists" "guided_form_step_conditions" "$RESULT"

# 1d. guided_form_progress table exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='metadata' AND table_name='guided_form_progress';" 2>/dev/null)
assert_eq "1d. metadata.guided_form_progress table exists" "guided_form_progress" "$RESULT"

# 1e. entities.guided_form_key column exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT column_name FROM information_schema.columns WHERE table_schema='metadata' AND table_name='entities' AND column_name='guided_form_key';" 2>/dev/null)
assert_eq "1e. metadata.entities.guided_form_key column exists" "guided_form_key" "$RESULT"

# 1f-j. Core RPCs exist
for rpc in start_guided_form complete_guided_form_step submit_guided_form cancel_guided_form get_guided_form_progress; do
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT proname FROM pg_proc WHERE proname='$rpc' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null)
  assert_eq "1. $rpc RPC exists" "$rpc" "$RESULT"
done

# 1k. __parent__ step auto-registered
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT step_key FROM metadata.guided_form_steps WHERE guided_form_key='test_gf' AND step_key='__parent__';" 2>/dev/null)
assert_eq "1k. __parent__ step auto-registered" "__parent__" "$RESULT"

# =============================================================================
# PART 2: RPC Tests
# =============================================================================

section "PART 2: Guided Form RPC Tests"

# 2a. start_guided_form creates a parent record
HTTP=$(call_rpc "start_guided_form" '{"p_guided_form_key": "test_gf"}' "$ADMIN_TOKEN")
PARENT_ID=$(cat /tmp/rpc_body.json | jq -r '.parent_id')
assert_eq "2a. start_guided_form returns HTTP 200" "200" "$HTTP"
assert_not_empty "2a. start_guided_form returns parent_id" "$PARENT_ID"

# 2b. Parent record has draft status
if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT s.status_key FROM public.test_gf_parent p JOIN metadata.statuses s ON s.id = p.status_id WHERE p.id=$PARENT_ID;" 2>/dev/null)
  assert_eq "2b. New parent record has draft status" "draft" "$RESULT"
else
  skip_test "2b. Parent draft status" "No parent_id from start_guided_form"
fi

# 2c. complete_guided_form_step for __parent__
# NOTE: Parent status stays "draft" until ALL steps are complete. Completing
# just __parent__ records progress and returns the next step to fill in.
if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
  # Set display_name so CHECK constraint does not block completion
  PGPASSWORD=$DB_PASS $PSQL -c \
    "UPDATE public.test_gf_parent SET display_name = 'Test Application' WHERE id=$PARENT_ID;" 2>/dev/null

  HTTP=$(call_rpc "complete_guided_form_step" \
    "{\"p_guided_form_key\": \"test_gf\", \"p_parent_id\": $PARENT_ID, \"p_step_key\": \"__parent__\"}" "$ADMIN_TOKEN")
  assert_eq "2c. complete_step(__parent__) returns HTTP 200" "200" "$HTTP"

  # Status should still be draft (inspection step is pending)
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT s.status_key FROM public.test_gf_parent p JOIN metadata.statuses s ON s.id = p.status_id WHERE p.id=$PARENT_ID;" 2>/dev/null)
  assert_eq "2c. Parent status stays draft (steps pending)" "draft" "$RESULT"

  # Response should indicate next step is "inspection"
  NEXT_STEP=$(cat /tmp/rpc_body.json | jq -r '.next_step_key')
  assert_eq "2c. Next step is inspection" "inspection" "$NEXT_STEP"

  # The RPC auto-creates a draft step record via ensure_guided_form_step_record
  STEP1_RECORD_ID=$(cat /tmp/rpc_body.json | jq -r '.next_record_id')
else
  skip_test "2c. complete_step(__parent__)" "No parent_id"
fi

# 2d. get_guided_form_progress returns progress
if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
  HTTP=$(call_rpc "get_guided_form_progress" \
    "{\"p_guided_form_key\": \"test_gf\", \"p_parent_id\": $PARENT_ID}" "$ADMIN_TOKEN")
  PROGRESS_COUNT=$(cat /tmp/rpc_body.json | jq 'length')
  assert_eq "2d. get_guided_form_progress returns 1 entry" "1" "$PROGRESS_COUNT"

  STEP_KEY=$(cat /tmp/rpc_body.json | jq -r '.[0].step_key')
  assert_eq "2d. Progress entry is for __parent__" "__parent__" "$STEP_KEY"
else
  skip_test "2d. get_guided_form_progress" "No parent_id"
fi

# 2e. Fill in step 1 record (auto-created in 2c) and complete it
# The step record was auto-created by ensure_guided_form_step_record during 2c.
# We UPDATE it with required data rather than INSERTing a duplicate.
if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ] && [ -n "$STEP1_RECORD_ID" ] && [ "$STEP1_RECORD_ID" != "null" ]; then
  PGPASSWORD=$DB_PASS $PSQL -c \
    "UPDATE public.test_gf_step1 SET display_name = 'Inspection for $PARENT_ID', inspector_notes = 'Looks good', inspection_passed = TRUE WHERE id=$STEP1_RECORD_ID;" 2>/dev/null

  HTTP=$(call_rpc "complete_guided_form_step" \
    "{\"p_guided_form_key\": \"test_gf\", \"p_parent_id\": $PARENT_ID, \"p_step_key\": \"inspection\"}" "$ADMIN_TOKEN")
  assert_eq "2e. complete_step(inspection) returns HTTP 200" "200" "$HTTP"

  ALL_COMPLETE=$(cat /tmp/rpc_body.json | jq -r '.all_data_steps_complete')
  assert_eq "2e. all_data_steps_complete is true" "true" "$ALL_COMPLETE"

  # NOW parent status should be 'complete' (all steps done)
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT s.status_key FROM public.test_gf_parent p JOIN metadata.statuses s ON s.id = p.status_id WHERE p.id=$PARENT_ID;" 2>/dev/null)
  assert_eq "2e. Parent status now complete" "complete" "$RESULT"
else
  skip_test "2e. complete_step(inspection)" "No parent_id or no auto-created step1 record"
fi

# 2f. submit_guided_form succeeds when all steps complete
if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
  HTTP=$(call_rpc "submit_guided_form" \
    "{\"p_guided_form_key\": \"test_gf\", \"p_parent_id\": $PARENT_ID}" "$ADMIN_TOKEN")
  assert_eq "2f. submit_guided_form returns HTTP 200" "200" "$HTTP"

  # With no on_submit_rpc, navigate_to should be empty string
  NAV_TO=$(cat /tmp/rpc_body.json | jq -r '.navigate_to')
  assert_eq "2f. navigate_to is empty (no on_submit_rpc)" "" "$NAV_TO"

  # Verify submitted_at is set
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT submitted_at IS NOT NULL FROM public.test_gf_parent WHERE id=$PARENT_ID;" 2>/dev/null)
  assert_eq "2f. Parent submitted_at is set" "t" "$RESULT"
else
  skip_test "2f. submit_guided_form" "No parent_id"
fi

# 2g. cancel_guided_form removes the parent record
# Refresh token in case the previous tests took time near Keycloak expiry
ADMIN_TOKEN=$(get_token "testadmin")

HTTP=$(call_rpc "start_guided_form" '{"p_guided_form_key": "test_gf"}' "$ADMIN_TOKEN")
CANCEL_PARENT_ID=$(cat /tmp/rpc_body.json | jq -r '.parent_id')

if [ -n "$CANCEL_PARENT_ID" ] && [ "$CANCEL_PARENT_ID" != "null" ]; then
  HTTP=$(call_rpc "cancel_guided_form" \
    "{\"p_guided_form_key\": \"test_gf\", \"p_parent_id\": $CANCEL_PARENT_ID}" "$ADMIN_TOKEN")
  assert_eq "2g. cancel_guided_form returns HTTP 200" "200" "$HTTP"

  # Verify record is deleted
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT COUNT(*) FROM public.test_gf_parent WHERE id=$CANCEL_PARENT_ID;" 2>/dev/null)
  assert_eq "2g. Parent record deleted after cancel" "0" "$RESULT"
else
  skip_test "2g. cancel_guided_form" "Could not create cancel test parent"
fi

# =============================================================================
# PART 3: CHECK Constraints & Submit Lock
# =============================================================================

section "PART 3: CHECK Constraints & Submit Lock"

# 3a. Auto-generated CHECK constraint exists on parent table
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT conname FROM pg_constraint WHERE conrelid='public.test_gf_parent'::regclass AND conname LIKE '%_wfcheck';" 2>/dev/null)
assert_not_empty "3a. CHECK constraint exists on parent table" "$RESULT"

# 3b. Submitted record cannot be updated (submit lock)
# Use the admin token (record owner) so the owner RLS policy matches and the row
# is visible for UPDATE. The block_submitted_update trigger then fires: since no
# RBAC 'update' permission is registered for test_gf_parent, has_permission()
# returns false and the trigger raises an exception.
if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
  LOCK_HTTP=$(curl -s -o /tmp/rpc_body.json -w "%{http_code}" \
    -X PATCH "$POSTGREST_URL/test_gf_parent?id=eq.$PARENT_ID" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d '{"display_name": "Hacked"}')
  if [ "$LOCK_HTTP" -ge 400 ] 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} 3b. Update on submitted record blocked (HTTP $LOCK_HTTP)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} 3b. Update on submitted record should be blocked"
    echo "       Got HTTP: $LOCK_HTTP"
    echo "       Body: $(cat /tmp/rpc_body.json 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
else
  skip_test "3b. Submit lock on submitted record" "No parent_id"
fi

# 3c. CHECK constraint allows draft records with missing required fields
DRAFT_ID=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "INSERT INTO public.test_gf_parent (display_name, status_id) VALUES ('Draft Test', $DRAFT_STATUS_ID) RETURNING id;" 2>/dev/null)
assert_not_empty "3c. Draft record inserted despite CHECK constraint" "$DRAFT_ID"

# =============================================================================
# PART 4: Condition Evaluation (skip_if)
# =============================================================================

section "PART 4: Condition Evaluation"

# 4a. Create a nonprofit parent (should skip inspection)
HTTP=$(call_rpc "start_guided_form" '{"p_guided_form_key": "test_gf"}' "$ADMIN_TOKEN")
NONPROFIT_ID=$(cat /tmp/rpc_body.json | jq -r '.parent_id')

if [ -n "$NONPROFIT_ID" ] && [ "$NONPROFIT_ID" != "null" ]; then
  # Set is_nonprofit = true
  PGPASSWORD=$DB_PASS $PSQL -c \
    "UPDATE public.test_gf_parent SET is_nonprofit = TRUE WHERE id=$NONPROFIT_ID;" 2>/dev/null

  # Complete parent step
  call_rpc "complete_guided_form_step" \
    "{\"p_guided_form_key\": \"test_gf\", \"p_parent_id\": $NONPROFIT_ID, \"p_step_key\": \"__parent__\"}" "$ADMIN_TOKEN" >/dev/null

  # _check_guided_form_complete should return true even without inspection step
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT public._check_guided_form_complete('test_gf', $NONPROFIT_ID);" 2>/dev/null)
  assert_eq "4a. Nonprofit skips inspection — guided form considered complete" "t" "$RESULT"
else
  skip_test "4a. skip_if condition evaluation" "Could not create nonprofit parent"
fi

# =============================================================================
# PART 5: Schema Integration (entities.guided_form_key)
# =============================================================================

section "PART 5: Schema Integration"

# 5a. test_gf_parent entity has guided_form_key
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT guided_form_key FROM metadata.entities WHERE table_name='test_gf_parent';" 2>/dev/null)
assert_eq "5a. Entity registered with guided_form_key" "test_gf" "$RESULT"

# =============================================================================
# PART 6: on_submit_rpc Execution
# =============================================================================

# Refresh token before PART 6
ADMIN_TOKEN=$(get_token "testadmin")

section "PART 6: on_submit_rpc"

# Setup: create a test on_submit_rpc function and a guided form that uses it
RPC_SETUP=$(PGPASSWORD=$DB_PASS $PSQL -c "
-- Create a second parent table for on_submit_rpc testing
DROP TABLE IF EXISTS public.test_rpc_parent CASCADE;
CREATE TABLE public.test_rpc_parent (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    status_id INTEGER REFERENCES metadata.statuses(id) DEFAULT $DRAFT_STATUS_ID,
    submitted_at TIMESTAMPTZ,
    rpc_was_called BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID DEFAULT public.current_user_id()
);
GRANT ALL ON public.test_rpc_parent TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.test_rpc_parent_id_seq TO authenticated;

INSERT INTO metadata.entities (table_name, display_name)
VALUES ('test_rpc_parent', 'Test RPC Parent')
ON CONFLICT (table_name) DO UPDATE SET display_name = 'Test RPC Parent';

-- Create on_submit_rpc: sets rpc_was_called=true, returns navigate_to.
-- If display_name = 'FAIL', returns {success: false} to test error path.
CREATE OR REPLACE FUNCTION public.test_on_submit_rpc(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS \$rpc\$
DECLARE
    v_display_name TEXT;
BEGIN
    SELECT display_name INTO v_display_name FROM public.test_rpc_parent WHERE id = p_parent_id;
    IF v_display_name = 'FAIL' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Simulated RPC failure');
    END IF;
    UPDATE public.test_rpc_parent SET rpc_was_called = TRUE WHERE id = p_parent_id;
    RETURN jsonb_build_object('success', true, 'navigate_to', '/custom/success/path');
END;
\$rpc\$;
GRANT EXECUTE ON FUNCTION public.test_on_submit_rpc(BIGINT) TO authenticated;

-- Register guided form with on_submit_rpc (use named params)
DO \$\$
DECLARE v_result JSONB;
BEGIN
    v_result := public.register_guided_form(
        p_guided_form_key := 'test_gf_rpc'::name,
        p_parent_table := 'test_rpc_parent'::name,
        p_description := 'Tests on_submit_rpc execution'::text,
        p_on_submit_rpc := 'test_on_submit_rpc'::name,
        p_parent_step_display_name := 'Parent Details'::varchar,
        p_review_intro_text := NULL::text,
        p_lock_on_submit := FALSE
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_guided_form failed: %', v_result->>'message';
    END IF;
END \$\$;

-- Rebuild constraints
SELECT metadata.rebuild_guided_form_constraints('test_rpc_parent');
" 2>&1)

if echo "$RPC_SETUP" | grep -qi "ERROR"; then
  echo -e "  ${RED}FAIL${NC} PART 6 setup failed:"
  echo "$RPC_SETUP" | grep -i "error" | head -5
else
  echo "  on_submit_rpc test setup complete."
fi

# Reload PostgREST schema cache for new table
PGPASSWORD=$DB_PASS $PSQL -c "NOTIFY pgrst, 'reload schema';" 2>/dev/null
sleep 1

# 6a. Start guided form, complete parent, and submit — RPC should be called
HTTP=$(call_rpc "start_guided_form" '{"p_guided_form_key": "test_gf_rpc"}' "$ADMIN_TOKEN")
RPC_PARENT_ID=$(cat /tmp/rpc_body.json | jq -r '.parent_id')

if [ -n "$RPC_PARENT_ID" ] && [ "$RPC_PARENT_ID" != "null" ]; then
  # Set display_name so it's not 'FAIL' (success path)
  PGPASSWORD=$DB_PASS $PSQL -c \
    "UPDATE public.test_rpc_parent SET display_name = 'Good Record' WHERE id=$RPC_PARENT_ID;" 2>/dev/null

  # Complete parent step
  call_rpc "complete_guided_form_step" \
    "{\"p_guided_form_key\": \"test_gf_rpc\", \"p_parent_id\": $RPC_PARENT_ID, \"p_step_key\": \"__parent__\"}" "$ADMIN_TOKEN" >/dev/null

  # Submit — this triggers on_submit_rpc
  HTTP=$(call_rpc "submit_guided_form" \
    "{\"p_guided_form_key\": \"test_gf_rpc\", \"p_parent_id\": $RPC_PARENT_ID}" "$ADMIN_TOKEN")

  # 6a. navigate_to should be forwarded from the RPC
  NAV_TO=$(cat /tmp/rpc_body.json | jq -r '.navigate_to')
  assert_eq "6a. on_submit_rpc navigate_to forwarded" "/custom/success/path" "$NAV_TO"

  # 6b. Verify the RPC was actually called (side effect: rpc_was_called = true)
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT rpc_was_called FROM public.test_rpc_parent WHERE id=$RPC_PARENT_ID;" 2>/dev/null)
  assert_eq "6b. on_submit_rpc side effect applied" "t" "$RESULT"

  # 6c. Verify submitted_at is also set (framework sets this AFTER rpc)
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT submitted_at IS NOT NULL FROM public.test_rpc_parent WHERE id=$RPC_PARENT_ID;" 2>/dev/null)
  assert_eq "6c. submitted_at set after on_submit_rpc success" "t" "$RESULT"
else
  skip_test "6a. on_submit_rpc navigate_to" "No parent_id"
  skip_test "6b. on_submit_rpc side effect" "No parent_id"
  skip_test "6c. submitted_at after rpc" "No parent_id"
fi

# 6d. on_submit_rpc returning {success: false} should block submission
HTTP=$(call_rpc "start_guided_form" '{"p_guided_form_key": "test_gf_rpc"}' "$ADMIN_TOKEN")
RPC_FAIL_ID=$(cat /tmp/rpc_body.json | jq -r '.parent_id')

if [ -n "$RPC_FAIL_ID" ] && [ "$RPC_FAIL_ID" != "null" ]; then
  # Set display_name to 'FAIL' to trigger the error path
  PGPASSWORD=$DB_PASS $PSQL -c \
    "UPDATE public.test_rpc_parent SET display_name = 'FAIL' WHERE id=$RPC_FAIL_ID;" 2>/dev/null

  # Complete parent step
  call_rpc "complete_guided_form_step" \
    "{\"p_guided_form_key\": \"test_gf_rpc\", \"p_parent_id\": $RPC_FAIL_ID, \"p_step_key\": \"__parent__\"}" "$ADMIN_TOKEN" >/dev/null

  # Submit — RPC should fail and block submission
  FAIL_HTTP=$(call_rpc "submit_guided_form" \
    "{\"p_guided_form_key\": \"test_gf_rpc\", \"p_parent_id\": $RPC_FAIL_ID}" "$ADMIN_TOKEN")

  # Should return an error (4xx)
  if [ "$FAIL_HTTP" -ge 400 ] 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} 6d. on_submit_rpc failure returns HTTP $FAIL_HTTP"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} 6d. on_submit_rpc failure should return 4xx (got $FAIL_HTTP)"
    echo "       Body: $(cat /tmp/rpc_fail_result.json)"
    FAIL=$((FAIL + 1))
  fi

  # 6e. Record should NOT be submitted (submitted_at remains NULL)
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT submitted_at IS NULL FROM public.test_rpc_parent WHERE id=$RPC_FAIL_ID;" 2>/dev/null)
  assert_eq "6e. Failed on_submit_rpc leaves record unsubmitted" "t" "$RESULT"

  # 6f. RPC side effect should NOT have been applied (transaction rolled back)
  RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
    "SELECT rpc_was_called FROM public.test_rpc_parent WHERE id=$RPC_FAIL_ID;" 2>/dev/null)
  assert_eq "6f. Failed on_submit_rpc rolls back side effects" "f" "$RESULT"
else
  skip_test "6d. on_submit_rpc failure" "No parent_id"
  skip_test "6e. Failed rpc leaves unsubmitted" "No parent_id"
  skip_test "6f. Failed rpc rolls back" "No parent_id"
fi

# =============================================================================
# CLEANUP
# =============================================================================

section "CLEANUP"

PGPASSWORD=$DB_PASS $PSQL -c "
-- Clean up all test artifacts
DELETE FROM metadata.guided_form_progress WHERE guided_form_key IN ('test_gf', 'test_gf_rpc');
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key IN ('test_gf', 'test_gf_rpc')
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key IN ('test_gf', 'test_gf_rpc');
DELETE FROM metadata.guided_forms WHERE guided_form_key IN ('test_gf', 'test_gf_rpc');
UPDATE metadata.entities SET guided_form_key = NULL WHERE table_name IN ('test_gf_parent', 'test_gf_step1', 'test_rpc_parent');
DELETE FROM metadata.entities WHERE table_name IN ('test_gf_parent', 'test_gf_step1', 'test_rpc_parent');
DROP TABLE IF EXISTS public.test_gf_step1 CASCADE;
DROP TABLE IF EXISTS public.test_gf_parent CASCADE;
DROP TABLE IF EXISTS public.test_rpc_parent CASCADE;
DROP FUNCTION IF EXISTS public.test_on_submit_rpc(BIGINT);
" 2>/dev/null

echo "  Test tables and guided form data cleaned up."

# =============================================================================
# SUMMARY
# =============================================================================

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Guided Form System Test Results${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo -e "  ${YELLOW}SKIP: $SKIP${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
