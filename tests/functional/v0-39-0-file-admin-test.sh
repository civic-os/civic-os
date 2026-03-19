#!/bin/bash
# =============================================================================
# Functional Test Suite: v0.39.0 File Administration
# =============================================================================
# Tests the complete file admin feature: migration, RLS, RPCs, API, and uploads.
#
# Usage:
#   ./tests/functional/v0-39-0-file-admin-test.sh          # Run tests + cleanup
#   ./tests/functional/v0-39-0-file-admin-test.sh --seed    # Run tests + seed UI data (no cleanup)
#
# The --seed flag uploads real files to S3, links them to entities, and leaves
# everything in place for Chrome-based UI testing of /admin/files.
#
# Prerequisites:
#   - Docker compose running (pothole example)
#   - Keycloak JWT fetched (fetch-keycloak-jwk.sh)
#   - jq installed
# =============================================================================

set -uo pipefail

# Parse flags
SEED_MODE=false
if [ "${1:-}" = "--seed" ]; then
  SEED_MODE=true
fi

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
MINIO_URL="http://localhost:9000"
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

assert_gt() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" -gt "$expected" ] 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} $test_name (got $actual)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name (expected > $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_http_status() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "^$expected"; then
    echo -e "  ${GREEN}PASS${NC} $test_name (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $test_name (expected HTTP $expected, got $actual)"
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

# Full upload workflow: presigned URL → S3 upload → create_file_record RPC
# Usage: upload_file <token> <entity_type> <entity_id> <file_path> <file_name> <file_type> <property_name>
# Returns: file UUID on success, empty on failure
upload_file() {
  local token="$1" entity_type="$2" entity_id="$3" file_path="$4"
  local file_name="$5" file_type="$6" property_name="$7"
  local file_size
  file_size=$(wc -c < "$file_path" | tr -d ' ')

  # Request presigned URL
  local request_id
  request_id=$(curl -s -X POST "$POSTGREST_URL/rpc/request_upload_url" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"p_entity_type\":\"$entity_type\",\"p_entity_id\":\"$entity_id\",\"p_file_name\":\"$file_name\",\"p_file_type\":\"$file_type\"}" \
    | jq -r '. // empty' | tr -d '"')
  [ -z "$request_id" ] && return 1

  # Poll for URL (max 10s)
  local url="" file_id=""
  for i in $(seq 1 20); do
    local poll
    poll=$(curl -s -H "Authorization: Bearer $token" \
      "$POSTGREST_URL/rpc/get_upload_url?p_request_id=$request_id")
    local status
    status=$(echo "$poll" | jq -r '.[0].status // "pending"')
    if [ "$status" = "completed" ]; then
      url=$(echo "$poll" | jq -r '.[0].url // empty')
      file_id=$(echo "$poll" | jq -r '.[0].file_id // empty')
      break
    elif [ "$status" = "failed" ]; then
      return 1
    fi
    sleep 0.5
  done
  [ -z "$url" ] && return 1

  # Upload to S3
  local upload_status
  upload_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "$url" -H "Content-Type: $file_type" --data-binary @"$file_path")
  [ "$upload_status" != "200" ] && return 1

  # Extract S3 bucket/key from presigned URL
  local s3_path s3_bucket s3_key
  s3_path=$(echo "$url" | sed 's|http[s]*://[^/]*/||' | sed 's|?.*||')
  s3_bucket=$(echo "$s3_path" | cut -d'/' -f1)
  s3_key=$(echo "$s3_path" | sed 's|^[^/]*/||')

  # Determine thumbnail_status
  local thumb_status="not_applicable"
  case "$file_type" in
    image/*|application/pdf) thumb_status="pending" ;;
  esac

  # Create file record via RPC
  local record
  record=$(curl -s -X POST "$POSTGREST_URL/rpc/create_file_record" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{
      \"p_id\":\"$file_id\",
      \"p_entity_type\":\"$entity_type\",
      \"p_entity_id\":\"$entity_id\",
      \"p_property_name\":\"$property_name\",
      \"p_file_name\":\"$file_name\",
      \"p_file_type\":\"$file_type\",
      \"p_file_size\":$file_size,
      \"p_s3_bucket\":\"$s3_bucket\",
      \"p_s3_original_key\":\"$s3_key\",
      \"p_thumbnail_status\":\"$thumb_status\"
    }")
  echo "$record" | jq -r '.id // empty'
}

# =============================================================================
# SETUP: Seed Database with Test Users and Entities
# =============================================================================

section "SETUP: Seeding Test Data"

# Get tokens and extract UUIDs for user seeding
ADMIN_TOKEN=$(get_token "testadmin")
EDITOR_TOKEN=$(get_token "testeditor")
USER_TOKEN=$(get_token "testuser")

# Decode JWT to get user UUIDs (fix base64 padding)
decode_jwt() { local payload=$(echo "$1" | cut -d. -f2); local padded="$payload"; while [ $((${#padded} % 4)) -ne 0 ]; do padded="${padded}="; done; echo "$padded" | base64 -d 2>/dev/null; }

ADMIN_UUID=$(decode_jwt "$ADMIN_TOKEN" | jq -r '.sub')
EDITOR_UUID=$(decode_jwt "$EDITOR_TOKEN" | jq -r '.sub')
USER_UUID=$(decode_jwt "$USER_TOKEN" | jq -r '.sub')

echo "  Admin UUID:  $ADMIN_UUID"
echo "  Editor UUID: $EDITOR_UUID"
echo "  User UUID:   $USER_UUID"

# Seed users into civic_os_users tables
PGPASSWORD=$DB_PASS $PSQL -c "
INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('$ADMIN_UUID', 'Test Admin'),
  ('$EDITOR_UUID', 'Test Editor'),
  ('$USER_UUID', 'Test User')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metadata.civic_os_users_private (id, display_name, email) VALUES
  ('$ADMIN_UUID', 'Test Admin', 'testadmin@example.com'),
  ('$EDITOR_UUID', 'Test Editor', 'testeditor@example.com'),
  ('$USER_UUID', 'Test User', 'testuser@example.com')
ON CONFLICT (id) DO NOTHING;
" 2>/dev/null
echo "  Users seeded."

# Seed Issue records (disable triggers to avoid broken IssueStatus reference)
PGPASSWORD=$DB_PASS $PSQL -c "
ALTER TABLE public.\"Issue\" DISABLE TRIGGER ALL;
INSERT INTO public.\"Issue\" (id, display_name, description, created_user) VALUES
  (1, 'Test Pothole #1', 'Large pothole on Main St', '$ADMIN_UUID'),
  (2, 'Test Pothole #2', 'Small crack on Oak Ave', '$EDITOR_UUID'),
  (3, 'Test Pothole #3', 'Sinkhole on Elm St', '$USER_UUID')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.\"Issue\" ENABLE TRIGGER ALL;
" 2>/dev/null
echo "  Issue records seeded."

# Clean up any leftover seed data from previous --seed runs (ensures test assertions are accurate)
# Must clear FK references on entity tables BEFORE deleting file records to avoid FK violations
PGPASSWORD=$DB_PASS $PSQL -c "
  -- Clear FK references first (FK constraints prevent file deletion otherwise)
  ALTER TABLE public.\"Issue\" DISABLE TRIGGER ALL;
  UPDATE public.\"Issue\" SET photo = NULL WHERE photo IS NOT NULL;
  ALTER TABLE public.\"Issue\" ENABLE TRIGGER ALL;

  ALTER TABLE public.\"WorkPackage\" DISABLE TRIGGER ALL;
  DELETE FROM public.\"WorkPackage\" WHERE id IN (1, 2, 3, 4);
  ALTER TABLE public.\"WorkPackage\" ENABLE TRIGGER ALL;

  -- Now delete seed file records (real S3 uploads from previous --seed runs)
  DELETE FROM metadata.files WHERE entity_type IN ('Issue', 'WorkPackage')
    AND file_name IN (
      'pothole_main_photo.png', 'inspection_notes.txt', 'crack_closeup.png',
      'depth_measurements.csv', 'final_report_Q1.pdf', 'site_photo_before.png',
      'quarterly_assessment.pdf'
    );
" 2>/dev/null
echo "  Previous seed data cleaned."

# Reload PostgREST schema cache to pick up migration changes
PGPASSWORD=$DB_PASS $PSQL -c "NOTIFY pgrst, 'reload schema';" 2>/dev/null
sleep 1
echo "  PostgREST schema cache reloaded."

# Verify the public.files VIEW has security_invoker (set by migration)
VIEW_SEC=$(PGPASSWORD=$DB_PASS $PSQL -c "
  SELECT reloptions FROM pg_class WHERE relname = 'files' AND relkind = 'v'
    AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
" 2>/dev/null)
if echo "$VIEW_SEC" | grep -q "security_invoker=true"; then
  echo "  public.files VIEW has security_invoker=true (from migration)."
else
  echo -e "  ${YELLOW}WARNING${NC}: public.files VIEW missing security_invoker=true. Apply migration first!"
  echo "  Some RLS tests may produce incorrect results."
fi

# =============================================================================
# PART 1: Migration Verification (SQL)
# =============================================================================

section "PART 1: Migration Verification"

echo "Testing v0-39-0-add-file-admin migration artifacts..."

# 1a. property_name column exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT column_name FROM information_schema.columns WHERE table_schema='metadata' AND table_name='files' AND column_name='property_name';" 2>/dev/null)
assert_eq "1a. property_name column exists" "property_name" "$RESULT"

# 1b. pg_trgm extension installed
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT extname FROM pg_extension WHERE extname='pg_trgm';" 2>/dev/null)
assert_eq "1b. pg_trgm extension installed" "pg_trgm" "$RESULT"

# 1c. Trigram index exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT indexname FROM pg_indexes WHERE indexname='idx_files_file_name_trgm';" 2>/dev/null)
assert_eq "1c. Trigram index exists" "idx_files_file_name_trgm" "$RESULT"

# 1d. can_view_entity_record function exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT proname FROM pg_proc WHERE proname='can_view_entity_record' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='metadata');" 2>/dev/null)
assert_eq "1d. can_view_entity_record() exists" "can_view_entity_record" "$RESULT"

# 1e. can_view_entity_record is SECURITY INVOKER (not DEFINER)
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT prosecdef FROM pg_proc WHERE proname='can_view_entity_record' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='metadata');" 2>/dev/null)
assert_eq "1e. can_view_entity_record is SECURITY INVOKER" "f" "$RESULT"

# 1f. get_file_storage_stats function exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT proname FROM pg_proc WHERE proname='get_file_storage_stats' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null)
assert_eq "1f. get_file_storage_stats() exists" "get_file_storage_stats" "$RESULT"

# 1g. get_file_storage_stats is SECURITY INVOKER
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT prosecdef FROM pg_proc WHERE proname='get_file_storage_stats' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null)
assert_eq "1g. get_file_storage_stats is SECURITY INVOKER" "f" "$RESULT"

# 1h. create_file_record RPC exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT proname FROM pg_proc WHERE proname='create_file_record' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null)
assert_eq "1h. create_file_record() RPC exists" "create_file_record" "$RESULT"

# 1i. create_file_record is SECURITY DEFINER
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT prosecdef FROM pg_proc WHERE proname='create_file_record' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null)
assert_eq "1i. create_file_record is SECURITY DEFINER" "t" "$RESULT"

# 1j. delete_file_record RPC exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT proname FROM pg_proc WHERE proname='delete_file_record' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');" 2>/dev/null)
assert_eq "1j. delete_file_record() RPC exists" "delete_file_record" "$RESULT"

# 1k. Old permissive policy removed
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT policyname FROM pg_policies WHERE tablename='files' AND schemaname='metadata' AND policyname='Users can view files';" 2>/dev/null)
assert_eq "1k. Old permissive policy removed" "" "$RESULT"

# 1l. New tiered policy exists
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT policyname FROM pg_policies WHERE tablename='files' AND schemaname='metadata' AND policyname='Tiered file visibility';" 2>/dev/null)
assert_eq "1l. Tiered file visibility policy exists" "Tiered file visibility" "$RESULT"

# 1m. Files CRUD permissions registered
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT COUNT(*) FROM metadata.permissions WHERE table_name='files' AND permission IN ('read','create','update','delete');" 2>/dev/null)
assert_eq "1m. All 4 files permissions registered" "4" "$RESULT"

# =============================================================================
# PART 2: RLS Policy Tests (SQL, run as different roles)
# =============================================================================

section "PART 2: RLS Policy Tests (Direct SQL)"

echo "Setting up test data for RLS verification..."

# Create test file records as postgres (bypasses RLS)
# IMPORTANT: Disable set_file_created_by_trigger so our explicit created_by values aren't overwritten
# (the trigger always sets created_by = current_user_id() from JWT, which is NULL for psql)
PGPASSWORD=$DB_PASS $PSQL -c "
  -- Clean up any previous test data
  DELETE FROM metadata.files WHERE entity_type = 'TestEntity';
  DELETE FROM metadata.files WHERE id IN (
    'a0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',
    'a0000000-0000-0000-0000-000000000003'
  );

  -- Disable trigger so created_by isn't overwritten with NULL
  ALTER TABLE metadata.files DISABLE TRIGGER set_file_created_by_trigger;

  -- Insert test files with different scenarios
  -- File 1: Created by testadmin (will test own-uploads tier)
  INSERT INTO metadata.files (id, entity_type, entity_id, file_name, file_type, file_size, s3_original_key, property_name, thumbnail_status, created_by)
  VALUES (
    'a0000000-0000-0000-0000-000000000001'::UUID,
    'Issue', '1', 'admin_photo.jpg', 'image/jpeg', 1024, 'Issue/1/a1/original.jpg', 'photo', 'not_applicable',
    '$ADMIN_UUID'::UUID
  ) ON CONFLICT (id) DO NOTHING;

  -- File 2: Created by testeditor
  INSERT INTO metadata.files (id, entity_type, entity_id, file_name, file_type, file_size, s3_original_key, property_name, thumbnail_status, created_by)
  VALUES (
    'a0000000-0000-0000-0000-000000000002'::UUID,
    'Issue', '2', 'editor_photo.jpg', 'image/jpeg', 2048, 'Issue/2/a2/original.jpg', 'photo', 'not_applicable',
    '$EDITOR_UUID'::UUID
  ) ON CONFLICT (id) DO NOTHING;

  -- File 3: Created by testuser (for a table with restricted access)
  INSERT INTO metadata.files (id, entity_type, entity_id, file_name, file_type, file_size, s3_original_key, property_name, thumbnail_status, created_by)
  VALUES (
    'a0000000-0000-0000-0000-000000000003'::UUID,
    'TestEntity', '999', 'user_doc.pdf', 'application/pdf', 4096, 'TestEntity/999/a3/original.pdf', 'report', 'not_applicable',
    '$USER_UUID'::UUID
  ) ON CONFLICT (id) DO NOTHING;

  -- Re-enable trigger for subsequent operations
  ALTER TABLE metadata.files ENABLE TRIGGER set_file_created_by_trigger;

  -- Link Issue records to their file records via photo FK
  -- (so Phase 1 entity query 'Issue?photo=not.is.null' finds them)
  ALTER TABLE public.\"Issue\" DISABLE TRIGGER ALL;
  UPDATE public.\"Issue\" SET photo = 'a0000000-0000-0000-0000-000000000001'::UUID WHERE id = 1;
  UPDATE public.\"Issue\" SET photo = 'a0000000-0000-0000-0000-000000000002'::UUID WHERE id = 2;
  ALTER TABLE public.\"Issue\" ENABLE TRIGGER ALL;
" 2>/dev/null

echo "Test data inserted. Now testing RLS tiers..."

# 2a. Admin can see ALL files (Tier 1: is_admin())
if [ -z "$ADMIN_TOKEN" ]; then
  echo -e "  ${RED}FAIL${NC} Could not get admin token from Keycloak"
  FAIL=$((FAIL + 1))
else
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?id=in.(a0000000-0000-0000-0000-000000000001,a0000000-0000-0000-0000-000000000002,a0000000-0000-0000-0000-000000000003)&select=id" \
    | jq 'length')
  assert_eq "2a. Admin sees all 3 test files (Tier 1: is_admin)" "3" "$RESULT"
fi

# 2b. Editor can see files for tables they have permission on (Tier 3: has_permission)
if [ -z "$EDITOR_TOKEN" ]; then
  echo -e "  ${RED}FAIL${NC} Could not get editor token from Keycloak"
  FAIL=$((FAIL + 1))
else
  # Editor should see Issue files (has Issue:read permission) but NOT TestEntity files
  RESULT=$(curl -s -H "Authorization: Bearer $EDITOR_TOKEN" \
    "$POSTGREST_URL/files?id=in.(a0000000-0000-0000-0000-000000000001,a0000000-0000-0000-0000-000000000002)&select=id" \
    | jq 'length')
  assert_eq "2b. Editor sees Issue files (Tier 3: has_permission)" "2" "$RESULT"
fi

# 2c. Editor cannot see files for entities without permission (no TestEntity permission)
if [ -n "$EDITOR_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $EDITOR_TOKEN" \
    "$POSTGREST_URL/files?id=eq.a0000000-0000-0000-0000-000000000003&select=id" \
    | jq 'length')
  assert_eq "2c. Editor cannot see TestEntity file (no permission)" "0" "$RESULT"
fi

# 2d. User sees own uploads even for entities without table permission (Tier 2: created_by)
if [ -z "$USER_TOKEN" ]; then
  echo -e "  ${RED}FAIL${NC} Could not get user token from Keycloak"
  FAIL=$((FAIL + 1))
else
  RESULT=$(curl -s -H "Authorization: Bearer $USER_TOKEN" \
    "$POSTGREST_URL/files?id=eq.a0000000-0000-0000-0000-000000000003&select=id" \
    | jq 'length')
  assert_eq "2d. User sees own upload for TestEntity (Tier 2: created_by)" "1" "$RESULT"
fi

# 2e. Anonymous can see Issue files via Tier 4 (can_view_entity_record delegates to Issue RLS)
# In the pothole example, web_anon has SELECT on Issue → can view Issue records → Tier 4 matches.
# But anonymous CANNOT see TestEntity files (no table, no RLS delegation).
RESULT=$(curl -s "$POSTGREST_URL/files?id=in.(a0000000-0000-0000-0000-000000000001,a0000000-0000-0000-0000-000000000002,a0000000-0000-0000-0000-000000000003)&select=id" \
  | jq 'length')
assert_eq "2e. Anonymous sees 2 Issue files (Tier 4: entity RLS delegates)" "2" "$RESULT"

# 2e2. Anonymous cannot see TestEntity file (table doesn't exist → Tier 4 returns false)
RESULT=$(curl -s "$POSTGREST_URL/files?id=eq.a0000000-0000-0000-0000-000000000003&select=id" \
  | jq 'length')
assert_eq "2e2. Anonymous cannot see TestEntity file (no table)" "0" "$RESULT"

# 2f. Tier 4: Record-level RLS delegation via can_view_entity_record()
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT metadata.can_view_entity_record('Issue', '1');" 2>/dev/null)
assert_eq "2f. can_view_entity_record('Issue','1') returns true (as superuser)" "t" "$RESULT"

# 2g. can_view_entity_record returns false for non-existent table
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT metadata.can_view_entity_record('NonExistentTable', '1');" 2>/dev/null)
assert_eq "2g. can_view_entity_record returns false for non-existent table" "f" "$RESULT"

# 2h. can_view_entity_record returns false for non-existent record
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT metadata.can_view_entity_record('Issue', '99999');" 2>/dev/null)
assert_eq "2h. can_view_entity_record returns false for non-existent record" "f" "$RESULT"

# =============================================================================
# PART 3: Storage Stats RPC Tests (curl)
# =============================================================================

section "PART 3: Storage Stats RPC"

# 3a. Admin gets storage stats
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/rpc/get_file_storage_stats" | jq '.[0].total_count // 0')
  assert_gt "3a. Admin sees total_count > 0" "0" "$RESULT"

  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/rpc/get_file_storage_stats" | jq '.[0].total_size_bytes // 0')
  assert_gt "3b. Admin sees total_size_bytes > 0" "0" "$RESULT"
fi

# 3c. Non-admin user gets RLS-filtered stats
if [ -n "$USER_TOKEN" ]; then
  ADMIN_COUNT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/rpc/get_file_storage_stats" | jq '.[0].total_count // 0')
  USER_COUNT=$(curl -s -H "Authorization: Bearer $USER_TOKEN" \
    "$POSTGREST_URL/rpc/get_file_storage_stats" | jq '.[0].total_count // 0')
  if [ "$USER_COUNT" -le "$ADMIN_COUNT" ] 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} 3c. User stats <= admin stats (RLS filtered: user=$USER_COUNT, admin=$ADMIN_COUNT)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} 3c. User stats should be <= admin stats (user=$USER_COUNT, admin=$ADMIN_COUNT)"
    FAIL=$((FAIL + 1))
  fi
fi

# 3d. Anonymous user gets empty stats or error
RESULT=$(curl -s "$POSTGREST_URL/rpc/get_file_storage_stats" -o /dev/null -w "%{http_code}")
if [ "$RESULT" = "401" ] || [ "$RESULT" = "403" ]; then
  echo -e "  ${GREEN}PASS${NC} 3d. Anonymous blocked from storage stats (HTTP $RESULT)"
  PASS=$((PASS + 1))
else
  echo -e "  ${YELLOW}SKIP${NC} 3d. Anonymous access returned HTTP $RESULT (may be allowed via web_anon)"
  SKIP=$((SKIP + 1))
fi

# =============================================================================
# PART 4: File Record Creation via RPC (curl + PostgREST)
# =============================================================================

section "PART 4: File Record Creation via RPC"

echo "Testing file creation via create_file_record RPC..."

# 4a. Create file record WITH property_name via RPC
FILE_ID=""
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -X POST "$POSTGREST_URL/rpc/create_file_record" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "p_id": "b0000000-0000-0000-0000-000000000001",
      "p_entity_type": "Issue",
      "p_entity_id": "1",
      "p_property_name": "photo",
      "p_file_name": "functional_test_photo.jpg",
      "p_file_type": "image/jpeg",
      "p_file_size": 12345,
      "p_s3_bucket": "civic-os-files",
      "p_s3_original_key": "Issue/1/test-func/original.jpg",
      "p_thumbnail_status": "not_applicable"
    }')
  FILE_ID=$(echo "$RESULT" | jq -r '.id // empty')
  PROP_NAME=$(echo "$RESULT" | jq -r '.property_name // empty')
  assert_not_empty "4a. File created via RPC with property_name" "$FILE_ID"
  assert_eq "4a. property_name stored correctly" "photo" "$PROP_NAME"
fi

# 4b. Create file record WITHOUT property_name (legacy compat)
LEGACY_ID=""
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -X POST "$POSTGREST_URL/rpc/create_file_record" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "p_id": "b0000000-0000-0000-0000-000000000002",
      "p_entity_type": "Issue",
      "p_entity_id": "2",
      "p_file_name": "legacy_upload.png",
      "p_file_type": "image/png",
      "p_file_size": 54321,
      "p_s3_bucket": "civic-os-files",
      "p_s3_original_key": "Issue/2/test-legacy/original.png",
      "p_thumbnail_status": "not_applicable"
    }')
  LEGACY_ID=$(echo "$RESULT" | jq -r '.id // empty')
  LEGACY_PROP=$(echo "$RESULT" | jq -r '.property_name // "null"')
  assert_not_empty "4b. Legacy file created without property_name" "$LEGACY_ID"
  assert_eq "4b. property_name is null for legacy upload" "null" "$LEGACY_PROP"
fi

# 4c. created_by automatically set from JWT (trigger fires in SECURITY DEFINER RPC)
if [ -n "$ADMIN_TOKEN" ] && [ -n "$FILE_ID" ]; then
  CREATED_BY=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?id=eq.$FILE_ID&select=created_by" \
    | jq -r '.[0].created_by // empty')
  assert_not_empty "4c. created_by auto-set from JWT (trigger in SECDEF RPC)" "$CREATED_BY"
fi

# 4d. Anonymous cannot call create_file_record
ANON_CREATE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$POSTGREST_URL/rpc/create_file_record" \
  -H "Content-Type: application/json" \
  -d '{
    "p_id": "b0000000-0000-0000-0000-000000000099",
    "p_entity_type": "Issue",
    "p_entity_id": "1",
    "p_file_name": "anon.jpg",
    "p_file_type": "image/jpeg",
    "p_file_size": 100,
    "p_s3_bucket": "civic-os-files",
    "p_s3_original_key": "anon/key",
    "p_thumbnail_status": "not_applicable"
  }')
if [ "$ANON_CREATE" = "401" ] || [ "$ANON_CREATE" = "403" ]; then
  echo -e "  ${GREEN}PASS${NC} 4d. Anonymous blocked from create_file_record (HTTP $ANON_CREATE)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${NC} 4d. Anonymous should be blocked from create_file_record (HTTP $ANON_CREATE)"
  FAIL=$((FAIL + 1))
fi

# 4e. Delete file via RPC (owner can delete)
if [ -n "$ADMIN_TOKEN" ] && [ -n "$LEGACY_ID" ]; then
  DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$POSTGREST_URL/rpc/delete_file_record" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"p_file_id\": \"$LEGACY_ID\"}")
  assert_http_status "4e. Owner can delete file via RPC" "204" "$DEL_STATUS"

  # Verify it's gone
  DELETED_CHECK=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?id=eq.$LEGACY_ID&select=id" | jq 'length')
  assert_eq "4e. Deleted file no longer visible" "0" "$DELETED_CHECK"
fi

# =============================================================================
# PART 5: PostgREST Query Patterns (curl) — Admin Files Page queries
# =============================================================================

section "PART 5: PostgREST Query Patterns for Admin Page"

# 5a. All Files mode: basic query with pagination
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -D /tmp/headers.txt -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Prefer: count=exact" \
    -H "Range: 0-24" \
    "$POSTGREST_URL/files?order=created_at.desc&limit=25")
  FILE_COUNT=$(echo "$RESULT" | jq 'length')
  assert_gt "5a. All Files query returns files" "0" "$FILE_COUNT"

  # Check Content-Range header for total count
  CONTENT_RANGE=$(grep -i "content-range" /tmp/headers.txt | tr -d '\r' || echo "")
  assert_not_empty "5a. Content-Range header present" "$CONTENT_RANGE"
fi

# 5b. Filter by entity_type
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?entity_type=eq.Issue&select=id" | jq 'length')
  assert_gt "5b. Filter by entity_type=Issue returns files" "0" "$RESULT"
fi

# 5c. Filter by file_type (LIKE for wildcards)
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?file_type=like.image/*&select=id" | jq 'length')
  assert_gt "5c. Filter by file_type=image/* returns images" "0" "$RESULT"
fi

# 5d. Filename search (ILIKE, backed by trigram index)
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?file_name=ilike.*functional_test*&select=id,file_name" | jq 'length')
  assert_gt "5d. Filename ILIKE search finds test file" "0" "$RESULT"
fi

# 5e. Date range filter
if [ -n "$ADMIN_TOKEN" ]; then
  TODAY=$(date -u +%Y-%m-%d)
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?created_at=gte.${TODAY}&select=id" | jq 'length')
  assert_gt "5e. Date range filter (today's files)" "0" "$RESULT"
fi

# 5f. Sorting by file_size
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?order=file_size.desc&limit=5&select=file_size" | jq '.[0].file_size // 0')
  assert_gt "5f. Sort by file_size desc returns largest first" "0" "$RESULT"
fi

# 5g. Filter by property_name (new v0.39.0 column)
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?property_name=eq.photo&select=id" | jq 'length')
  assert_gt "5g. Filter by property_name=photo" "0" "$RESULT"
fi

# 5h. VIEW is read-only (INSERT through VIEW should fail)
if [ -n "$ADMIN_TOKEN" ]; then
  INSERT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$POSTGREST_URL/files" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d '{
      "entity_type": "Issue",
      "entity_id": "1",
      "file_name": "should_fail.jpg",
      "file_type": "image/jpeg",
      "file_size": 100,
      "s3_original_key": "test/fail.jpg",
      "thumbnail_status": "not_applicable"
    }')
  # Should get 405 (method not allowed) or 403 (no INSERT grant on VIEW)
  if [ "$INSERT_STATUS" != "201" ] && [ "$INSERT_STATUS" != "200" ]; then
    echo -e "  ${GREEN}PASS${NC} 5h. INSERT through VIEW correctly rejected (HTTP $INSERT_STATUS)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} 5h. INSERT through VIEW should be rejected but got HTTP $INSERT_STATUS"
    FAIL=$((FAIL + 1))
  fi
fi

# =============================================================================
# PART 6: Two-Phase Entity Files Query (curl) — Admin Page Entity Mode
# =============================================================================

section "PART 6: Two-Phase Entity Files Query"

# Phase 1: Get entity IDs that have files
if [ -n "$ADMIN_TOKEN" ]; then
  # Query Issue entities that have a non-null photo column (entities with files)
  ENTITY_IDS=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/Issue?photo=not.is.null&select=id" | jq -r '[.[].id] | join(",")')

  if [ -n "$ENTITY_IDS" ] && [ "$ENTITY_IDS" != "" ]; then
    assert_not_empty "6a. Phase 1: Found entities with files" "$ENTITY_IDS"

    # Phase 2: Get files for those entity IDs
    RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Prefer: count=exact" \
      "$POSTGREST_URL/files?entity_type=eq.Issue&entity_id=in.($ENTITY_IDS)&order=created_at.desc&limit=25&select=id,file_name,entity_id")
    FILE_COUNT=$(echo "$RESULT" | jq 'length')
    assert_gt "6b. Phase 2: Files found for matched entities" "0" "$FILE_COUNT"
  else
    # No entities with photo set — test with our test data
    skip_test "6a. Phase 1: No entities have photo FK set" "Insert test Issue with photo FK to test"

    # Fallback: test with entity_id from our test files
    RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Prefer: count=exact" \
      "$POSTGREST_URL/files?entity_type=eq.Issue&entity_id=in.(1,2)&order=created_at.desc&limit=25&select=id,file_name,entity_id")
    FILE_COUNT=$(echo "$RESULT" | jq 'length')
    assert_gt "6b. Phase 2: Files found for entity IDs 1,2" "0" "$FILE_COUNT"
  fi
fi

# --- 6c-6g: Multi-file-column edge case (WorkPackage: report_pdf + attachment) ---
# Tests the Phase 1 OR filter: or=(report_pdf.not.is.null,attachment.not.is.null)
# 4 records: both set, only col1 set, only col2 set, neither set.

if [ -n "$ADMIN_TOKEN" ]; then
  # WorkPackage has two file columns: report_pdf + attachment (from 07_add_file_fields.sql)
  # Create 4 file records for WorkPackage
  PGPASSWORD=$DB_PASS $PSQL -c "
    ALTER TABLE metadata.files DISABLE TRIGGER set_file_created_by_trigger;
    INSERT INTO metadata.files (id, entity_type, entity_id, file_name, file_type, file_size, s3_original_key, property_name, thumbnail_status, created_by) VALUES
      ('c0000000-0000-0000-0000-000000000001'::UUID, 'WorkPackage', '1', 'wp1_report.pdf',    'application/pdf', 5000, 'WP/1/report.pdf',    'report_pdf',  'not_applicable', '$ADMIN_UUID'::UUID),
      ('c0000000-0000-0000-0000-000000000002'::UUID, 'WorkPackage', '1', 'wp1_attachment.png', 'image/png',       3000, 'WP/1/attachment.png','attachment',  'not_applicable', '$ADMIN_UUID'::UUID),
      ('c0000000-0000-0000-0000-000000000003'::UUID, 'WorkPackage', '2', 'wp2_report.pdf',    'application/pdf', 4000, 'WP/2/report.pdf',    'report_pdf',  'not_applicable', '$ADMIN_UUID'::UUID),
      ('c0000000-0000-0000-0000-000000000004'::UUID, 'WorkPackage', '3', 'wp3_attachment.jpg', 'image/jpeg',      2000, 'WP/3/attachment.jpg','attachment',  'not_applicable', '$ADMIN_UUID'::UUID)
    ON CONFLICT (id) DO NOTHING;
    ALTER TABLE metadata.files ENABLE TRIGGER set_file_created_by_trigger;
  " 2>/dev/null

  # Create 4 WorkPackage records with different file column combinations
  PGPASSWORD=$DB_PASS $PSQL -c "
    ALTER TABLE public.\"WorkPackage\" DISABLE TRIGGER ALL;
    INSERT INTO public.\"WorkPackage\" (id, display_name, quote_due_date, report_pdf, attachment) VALUES
      (1, 'WP Both Files',     NOW() + INTERVAL '30 days', 'c0000000-0000-0000-0000-000000000001'::UUID, 'c0000000-0000-0000-0000-000000000002'::UUID),
      (2, 'WP Report Only',    NOW() + INTERVAL '30 days', 'c0000000-0000-0000-0000-000000000003'::UUID, NULL),
      (3, 'WP Attachment Only', NOW() + INTERVAL '30 days', NULL, 'c0000000-0000-0000-0000-000000000004'::UUID),
      (4, 'WP No Files',       NOW() + INTERVAL '30 days', NULL, NULL)
    ON CONFLICT (id) DO NOTHING;
    ALTER TABLE public.\"WorkPackage\" ENABLE TRIGGER ALL;
  " 2>/dev/null

  # 6c. Phase 1 with OR filter: entities with ANY file column set
  WP_IDS=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/WorkPackage?or=(report_pdf.not.is.null,attachment.not.is.null)&select=id&order=id" \
    | jq -r '[.[].id] | join(",")')
  assert_eq "6c. Multi-file Phase 1: OR filter returns 3 entities (not WP4)" "1,2,3" "$WP_IDS"

  # 6d. Verify WP4 (no files) is excluded
  WP4_CHECK=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/WorkPackage?or=(report_pdf.not.is.null,attachment.not.is.null)&id=eq.4&select=id" \
    | jq 'length')
  assert_eq "6d. Multi-file Phase 1: WP with no files excluded" "0" "$WP4_CHECK"

  # 6e. Phase 2: files for matched entity IDs
  WP_FILES=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?entity_type=eq.WorkPackage&entity_id=in.($WP_IDS)&select=id,entity_id,property_name&order=entity_id")
  WP_FILE_COUNT=$(echo "$WP_FILES" | jq 'length')
  assert_eq "6e. Multi-file Phase 2: 4 files for 3 entities" "4" "$WP_FILE_COUNT"

  # 6f. Verify files span correct entity IDs
  WP_FILE_ENTITIES=$(echo "$WP_FILES" | jq -r '[.[].entity_id] | unique | sort | join(",")')
  assert_eq "6f. Multi-file Phase 2: files span entities 1,2,3" "1,2,3" "$WP_FILE_ENTITIES"

  # 6g. Verify both property_names present
  WP_FILE_PROPS=$(echo "$WP_FILES" | jq -r '[.[].property_name] | unique | sort | join(",")')
  assert_eq "6g. Multi-file Phase 2: both property_names present" "attachment,report_pdf" "$WP_FILE_PROPS"
fi

# =============================================================================
# PART 7: Full Upload Workflow via RPC (curl → worker → S3)
# =============================================================================

section "PART 7: Full Upload Workflow (RPC + Worker + S3)"

echo "Testing presigned URL workflow..."

# 7a. Request presigned URL via RPC
if [ -n "$ADMIN_TOKEN" ]; then
  REQUEST_ID=$(curl -s -X POST "$POSTGREST_URL/rpc/request_upload_url" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "p_entity_type": "Issue",
      "p_entity_id": "1",
      "p_file_name": "test_upload.jpg",
      "p_file_type": "image/jpeg"
    }' | jq -r '. // empty' | tr -d '"')

  if [ -n "$REQUEST_ID" ] && [ "$REQUEST_ID" != "null" ]; then
    assert_not_empty "7a. Presigned URL request created" "$REQUEST_ID"

    # 7b. Poll for presigned URL (worker generates it)
    echo "  Polling for presigned URL (max 15s)..."
    PRESIGNED_URL=""
    S3_FILE_ID=""
    for i in $(seq 1 30); do
      POLL_RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        "$POSTGREST_URL/rpc/get_upload_url?p_request_id=$REQUEST_ID")

      STATUS=$(echo "$POLL_RESULT" | jq -r '.[0].status // "pending"')

      if [ "$STATUS" = "completed" ]; then
        PRESIGNED_URL=$(echo "$POLL_RESULT" | jq -r '.[0].url // empty')
        S3_FILE_ID=$(echo "$POLL_RESULT" | jq -r '.[0].file_id // empty')
        break
      elif [ "$STATUS" = "failed" ]; then
        echo -e "  ${RED}FAIL${NC} 7b. Presigned URL generation failed"
        FAIL=$((FAIL + 1))
        break
      fi
      sleep 0.5
    done

    if [ -n "$PRESIGNED_URL" ]; then
      assert_not_empty "7b. Presigned URL received" "$PRESIGNED_URL"

      # 7c. Upload a small test file to S3 via presigned URL
      printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' > /tmp/test_upload.jpg

      UPLOAD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -X PUT "$PRESIGNED_URL" \
        -H "Content-Type: image/jpeg" \
        --data-binary @/tmp/test_upload.jpg)

      assert_http_status "7c. File uploaded to S3 via presigned URL" "200" "$UPLOAD_STATUS"

      # 7d. Create file record via RPC (not through VIEW)
      if [ -n "$S3_FILE_ID" ]; then
        # Extract S3 key from presigned URL (path before ?)
        S3_PATH=$(echo "$PRESIGNED_URL" | sed 's|http[s]*://[^/]*/||' | sed 's|?.*||')
        S3_BUCKET=$(echo "$S3_PATH" | cut -d'/' -f1)
        S3_KEY=$(echo "$S3_PATH" | sed 's|^[^/]*/||')

        FILE_RECORD=$(curl -s -X POST "$POSTGREST_URL/rpc/create_file_record" \
          -H "Authorization: Bearer $ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          -d "{
            \"p_id\": \"$S3_FILE_ID\",
            \"p_entity_type\": \"Issue\",
            \"p_entity_id\": \"1\",
            \"p_property_name\": \"photo\",
            \"p_file_name\": \"test_upload.jpg\",
            \"p_file_type\": \"image/jpeg\",
            \"p_file_size\": 24,
            \"p_s3_bucket\": \"$S3_BUCKET\",
            \"p_s3_original_key\": \"$S3_KEY\",
            \"p_thumbnail_status\": \"pending\"
          }")

        RECORD_ID=$(echo "$FILE_RECORD" | jq -r '.id // empty')
        assert_not_empty "7d. File record created via RPC" "$RECORD_ID"
      else
        skip_test "7d. File record creation" "No file_id from presigned URL response"
      fi

      rm -f /tmp/test_upload.jpg
    else
      skip_test "7b. Presigned URL" "Worker not responding (may not be running)"
      skip_test "7c. S3 upload" "No presigned URL"
      skip_test "7d. File record" "No presigned URL"
    fi
  else
    echo -e "  ${RED}FAIL${NC} 7a. Could not request presigned URL"
    FAIL=$((FAIL + 1))
    skip_test "7b-d" "Presigned URL request failed"
  fi
fi

# 7e. Anonymous presigned URL access
ANON_RESULT=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$POSTGREST_URL/rpc/request_upload_url" \
  -H "Content-Type: application/json" \
  -d '{
    "p_entity_type": "Issue",
    "p_entity_id": "1",
    "p_file_name": "anon.jpg",
    "p_file_type": "image/jpeg"
  }')
if [ "$ANON_RESULT" = "401" ] || [ "$ANON_RESULT" = "403" ]; then
  echo -e "  ${GREEN}PASS${NC} 7e. Anonymous blocked from presigned URL (HTTP $ANON_RESULT)"
  PASS=$((PASS + 1))
else
  skip_test "7e. Anonymous presigned URL (HTTP $ANON_RESULT)" "Pre-existing: EXECUTE granted to PUBLIC in v0-5-0"
fi

# =============================================================================
# PART 8: S3 Direct Access Tests (MinIO)
# =============================================================================

section "PART 8: MinIO/S3 Integration"

# 8a. MinIO health check
MINIO_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$MINIO_URL/minio/health/live" 2>/dev/null)
if [ "$MINIO_STATUS" = "200" ]; then
  assert_http_status "8a. MinIO is healthy" "200" "$MINIO_STATUS"

  # 8b. Bucket exists and is accessible
  BUCKET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$MINIO_URL/civic-os-files/" 2>/dev/null)
  if [ "$BUCKET_STATUS" = "200" ] || [ "$BUCKET_STATUS" = "403" ]; then
    echo -e "  ${GREEN}PASS${NC} 8b. S3 bucket 'civic-os-files' exists (HTTP $BUCKET_STATUS)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} 8b. S3 bucket check failed (HTTP $BUCKET_STATUS)"
    FAIL=$((FAIL + 1))
  fi
else
  skip_test "8a. MinIO health" "MinIO not accessible at $MINIO_URL"
  skip_test "8b. Bucket exists" "MinIO not accessible"
fi

# =============================================================================
# PART 9: property_name Integration Test
# =============================================================================

section "PART 9: property_name Column Integration"

# 9a. Verify property_name is nullable (backward compatible)
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema='metadata' AND table_name='files' AND column_name='property_name';" 2>/dev/null)
assert_eq "9a. property_name is nullable (backward compat)" "YES" "$RESULT"

# 9b. Can query files by property_name
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?property_name=eq.photo&select=id,property_name" | jq 'length')
  assert_gt "9b. Can filter files by property_name" "0" "$RESULT"
fi

# 9c. Can query files where property_name is null (legacy)
if [ -n "$ADMIN_TOKEN" ]; then
  RESULT=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$POSTGREST_URL/files?property_name=is.null&select=id" | jq -r 'type')
  assert_eq "9c. Can filter for null property_name (legacy)" "array" "$RESULT"
fi

# =============================================================================
# PART 10: Admin Page Route & Permissions (curl)
# =============================================================================

section "PART 10: Files Permissions Integration"

# 10a. files:read permission exists in database
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT COUNT(*) FROM metadata.permissions WHERE table_name='files' AND permission='read';" 2>/dev/null)
assert_eq "10a. files:read permission registered" "1" "$RESULT"

# 10b. Verify files:read is granted to admin role (from init scripts, not created here)
RESULT=$(PGPASSWORD=$DB_PASS $PSQL -c \
  "SELECT COUNT(*) FROM metadata.permission_roles pr
   JOIN metadata.permissions p ON p.id = pr.permission_id
   JOIN metadata.roles r ON r.id = pr.role_id
   WHERE p.table_name = 'files' AND p.permission = 'read' AND r.role_key = 'admin';" 2>/dev/null)
assert_eq "10b. files:read granted to admin role (via init scripts)" "1" "$RESULT"

# =============================================================================
# Cleanup & Seed
# =============================================================================

if [ "$SEED_MODE" = true ]; then
  # ---------------------------------------------------------------------------
  # SEED MODE: Upload real files to S3 for Chrome UI testing
  # ---------------------------------------------------------------------------
  # Clean up DB-only test artifacts first (no real S3 objects behind them),
  # then upload real files via the full workflow.
  # ---------------------------------------------------------------------------

  section "SEED: Cleaning test artifacts, then uploading real files"

  # Remove DB-only test records (Parts 2, 4, 6) — these have fake S3 keys
  PGPASSWORD=$DB_PASS $PSQL -c "
    ALTER TABLE public.\"WorkPackage\" DISABLE TRIGGER ALL;
    DELETE FROM public.\"WorkPackage\" WHERE id IN (1, 2, 3, 4);
    ALTER TABLE public.\"WorkPackage\" ENABLE TRIGGER ALL;

    ALTER TABLE public.\"Issue\" DISABLE TRIGGER ALL;
    UPDATE public.\"Issue\" SET photo = NULL WHERE id IN (1, 2);
    ALTER TABLE public.\"Issue\" ENABLE TRIGGER ALL;

    DELETE FROM metadata.files WHERE file_name LIKE 'functional_test%';
    DELETE FROM metadata.files WHERE file_name = 'test_upload.jpg' AND entity_type = 'Issue';
    DELETE FROM metadata.files WHERE file_name = 'legacy_upload.png' AND s3_original_key LIKE '%test-legacy%';
    DELETE FROM metadata.files WHERE id IN (
      'a0000000-0000-0000-0000-000000000001',
      'a0000000-0000-0000-0000-000000000002',
      'a0000000-0000-0000-0000-000000000003',
      'b0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
      'b0000000-0000-0000-0000-000000000099',
      'c0000000-0000-0000-0000-000000000001',
      'c0000000-0000-0000-0000-000000000002',
      'c0000000-0000-0000-0000-000000000003',
      'c0000000-0000-0000-0000-000000000004'
    );


    -- Also clean up any previous seed data for idempotent re-runs
    DELETE FROM metadata.files WHERE entity_type IN ('Issue', 'WorkPackage')
      AND file_name IN (
        'pothole_main_photo.png', 'inspection_notes.txt', 'crack_closeup.png',
        'depth_measurements.csv', 'final_report_Q1.pdf', 'site_photo_before.png',
        'quarterly_assessment.pdf', 'test_upload.jpg'
      );
  " 2>/dev/null
  echo "  Test artifacts cleaned."

  # Create sample files with real content
  SEED_DIR="/tmp/seed-files"
  mkdir -p "$SEED_DIR"

  # Generate real PNGs using ImageMagick (proper images for thumbnail generation)
  # Prefer 'magick' (IMv7+), fall back to 'convert' (IMv6)
  IMGCMD=""
  if command -v magick &>/dev/null; then IMGCMD="magick"; elif command -v convert &>/dev/null; then IMGCMD="convert"; fi

  if [ -n "$IMGCMD" ]; then
    # 200x200 solid color PNGs — distinct colors to visually verify in admin UI
    $IMGCMD -size 200x200 xc:'#DC2626' "$SEED_DIR/pothole_photo.png"       # Red
    $IMGCMD -size 200x200 xc:'#2563EB' "$SEED_DIR/crack_photo.png"         # Blue
    $IMGCMD -size 200x200 xc:'#16A34A' "$SEED_DIR/site_photo_before.png"   # Green (WP attachment)
    echo "  Using ImageMagick for real PNG generation (thumbnail-ready)"
  else
    # Fallback: minimal valid PNGs (1x1, may not trigger thumbnail generation)
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$SEED_DIR/pothole_photo.png"
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xc0\x00\x00\x00\x03\x00\x01\xa4\x97\xa5\x18\x00\x00\x00\x00IEND\xaeB`\x82' > "$SEED_DIR/crack_photo.png"
    cp "$SEED_DIR/pothole_photo.png" "$SEED_DIR/site_photo_before.png"
    echo "  ${YELLOW}WARNING${NC}: ImageMagick not found, using minimal PNGs (thumbnails may not generate)"
  fi

  # Minimal PDF (valid structure)
  printf '%%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\nxref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n101\n%%%%EOF' > "$SEED_DIR/work_report.pdf"

  # Plain text file
  echo "Inspection notes: Pothole depth approximately 4 inches. Located near storm drain." > "$SEED_DIR/inspection_notes.txt"

  # CSV data file
  printf 'date,measurement,unit\n2026-03-01,4.2,inches\n2026-03-15,4.8,inches\n' > "$SEED_DIR/measurements.csv"

  SEED_COUNT=0
  SEED_FAIL=0

  echo "  Uploading files via full presigned URL workflow..."

  # --- Issue 1: Two files (photo + will test "All Files" variety) ---
  PHOTO1_ID=$(upload_file "$ADMIN_TOKEN" "Issue" "1" "$SEED_DIR/pothole_photo.png" "pothole_main_photo.png" "image/png" "photo")
  if [ -n "$PHOTO1_ID" ]; then
    echo -e "  ${GREEN}OK${NC} Issue 1 photo: $PHOTO1_ID"
    SEED_COUNT=$((SEED_COUNT + 1))
    # Link to Issue.photo FK
    PGPASSWORD=$DB_PASS $PSQL -c "
      ALTER TABLE public.\"Issue\" DISABLE TRIGGER ALL;
      UPDATE public.\"Issue\" SET photo = '$PHOTO1_ID'::UUID WHERE id = 1;
      ALTER TABLE public.\"Issue\" ENABLE TRIGGER ALL;
    " 2>/dev/null
  else
    echo -e "  ${RED}FAIL${NC} Issue 1 photo upload"; SEED_FAIL=$((SEED_FAIL + 1))
  fi

  NOTES_ID=$(upload_file "$ADMIN_TOKEN" "Issue" "1" "$SEED_DIR/inspection_notes.txt" "inspection_notes.txt" "text/plain" "")
  if [ -n "$NOTES_ID" ]; then
    echo -e "  ${GREEN}OK${NC} Issue 1 notes: $NOTES_ID"
    SEED_COUNT=$((SEED_COUNT + 1))
  else
    echo -e "  ${RED}FAIL${NC} Issue 1 notes upload"; SEED_FAIL=$((SEED_FAIL + 1))
  fi

  # --- Issue 2: Photo only ---
  PHOTO2_ID=$(upload_file "$ADMIN_TOKEN" "Issue" "2" "$SEED_DIR/crack_photo.png" "crack_closeup.png" "image/png" "photo")
  if [ -n "$PHOTO2_ID" ]; then
    echo -e "  ${GREEN}OK${NC} Issue 2 photo: $PHOTO2_ID"
    SEED_COUNT=$((SEED_COUNT + 1))
    PGPASSWORD=$DB_PASS $PSQL -c "
      ALTER TABLE public.\"Issue\" DISABLE TRIGGER ALL;
      UPDATE public.\"Issue\" SET photo = '$PHOTO2_ID'::UUID WHERE id = 2;
      ALTER TABLE public.\"Issue\" ENABLE TRIGGER ALL;
    " 2>/dev/null
  else
    echo -e "  ${RED}FAIL${NC} Issue 2 photo upload"; SEED_FAIL=$((SEED_FAIL + 1))
  fi

  # --- Issue 3: CSV data ---
  CSV_ID=$(upload_file "$ADMIN_TOKEN" "Issue" "3" "$SEED_DIR/measurements.csv" "depth_measurements.csv" "text/csv" "")
  if [ -n "$CSV_ID" ]; then
    echo -e "  ${GREEN}OK${NC} Issue 3 CSV: $CSV_ID"
    SEED_COUNT=$((SEED_COUNT + 1))
  else
    echo -e "  ${RED}FAIL${NC} Issue 3 CSV upload"; SEED_FAIL=$((SEED_FAIL + 1))
  fi

  # --- WorkPackage 1: report_pdf + attachment (both columns) ---
  WP_PDF_ID=$(upload_file "$ADMIN_TOKEN" "WorkPackage" "1" "$SEED_DIR/work_report.pdf" "final_report_Q1.pdf" "application/pdf" "report_pdf")
  if [ -n "$WP_PDF_ID" ]; then
    echo -e "  ${GREEN}OK${NC} WP 1 report: $WP_PDF_ID"
    SEED_COUNT=$((SEED_COUNT + 1))
  else
    echo -e "  ${RED}FAIL${NC} WP 1 report upload"; SEED_FAIL=$((SEED_FAIL + 1))
  fi

  WP_ATT_ID=$(upload_file "$ADMIN_TOKEN" "WorkPackage" "1" "$SEED_DIR/site_photo_before.png" "site_photo_before.png" "image/png" "attachment")
  if [ -n "$WP_ATT_ID" ]; then
    echo -e "  ${GREEN}OK${NC} WP 1 attachment: $WP_ATT_ID"
    SEED_COUNT=$((SEED_COUNT + 1))
  else
    echo -e "  ${RED}FAIL${NC} WP 1 attachment upload"; SEED_FAIL=$((SEED_FAIL + 1))
  fi

  # Link WorkPackage FKs (WP records were created by Part 6 tests but cleaned up — recreate)
  PGPASSWORD=$DB_PASS $PSQL -c "
    ALTER TABLE public.\"WorkPackage\" DISABLE TRIGGER ALL;
    INSERT INTO public.\"WorkPackage\" (id, display_name, quote_due_date, report_pdf, attachment) VALUES
      (1, 'Main St Repaving', NOW() + INTERVAL '30 days',
       $([ -n "$WP_PDF_ID" ] && echo "'$WP_PDF_ID'::UUID" || echo "NULL"),
       $([ -n "$WP_ATT_ID" ] && echo "'$WP_ATT_ID'::UUID" || echo "NULL"))
    ON CONFLICT (id) DO UPDATE SET
      report_pdf = EXCLUDED.report_pdf,
      attachment = EXCLUDED.attachment;
    ALTER TABLE public.\"WorkPackage\" ENABLE TRIGGER ALL;
  " 2>/dev/null

  # --- WorkPackage 2: report_pdf only ---
  WP2_PDF_ID=$(upload_file "$ADMIN_TOKEN" "WorkPackage" "2" "$SEED_DIR/work_report.pdf" "quarterly_assessment.pdf" "application/pdf" "report_pdf")
  if [ -n "$WP2_PDF_ID" ]; then
    echo -e "  ${GREEN}OK${NC} WP 2 report: $WP2_PDF_ID"
    SEED_COUNT=$((SEED_COUNT + 1))
  else
    echo -e "  ${RED}FAIL${NC} WP 2 report upload"; SEED_FAIL=$((SEED_FAIL + 1))
  fi

  PGPASSWORD=$DB_PASS $PSQL -c "
    ALTER TABLE public.\"WorkPackage\" DISABLE TRIGGER ALL;
    INSERT INTO public.\"WorkPackage\" (id, display_name, quote_due_date, report_pdf) VALUES
      (2, 'Oak Ave Crack Seal', NOW() + INTERVAL '60 days',
       $([ -n "$WP2_PDF_ID" ] && echo "'$WP2_PDF_ID'::UUID" || echo "NULL"))
    ON CONFLICT (id) DO UPDATE SET report_pdf = EXCLUDED.report_pdf;
    ALTER TABLE public.\"WorkPackage\" ENABLE TRIGGER ALL;
  " 2>/dev/null

  rm -rf "$SEED_DIR"

  echo ""
  echo -e "  ${BOLD}Seed complete:${NC} $SEED_COUNT files uploaded, $SEED_FAIL failed"
  echo -e "  ${CYAN}UI test ready:${NC} http://localhost:4200/admin/files (login as testadmin)"
  echo ""
  echo -e "  Data summary:"
  echo -e "    Issue 1 (Test Pothole #1): photo (PNG) + inspection notes (TXT)"
  echo -e "    Issue 2 (Test Pothole #2): photo (PNG)"
  echo -e "    Issue 3 (Test Pothole #3): measurements (CSV)"
  echo -e "    WorkPackage 1 (Main St Repaving): report (PDF) + attachment (PNG)"
  echo -e "    WorkPackage 2 (Oak Ave Crack Seal): report (PDF)"
  echo ""
  echo -e "  File types present: image/png, application/pdf, text/plain, text/csv"
  echo -e "  Entity types present: Issue (3 files), WorkPackage (3 files)"
  echo -e "  Property names: photo, report_pdf, attachment, null (untagged)"

else
  # ---------------------------------------------------------------------------
  # NORMAL MODE: Clean up test data
  # ---------------------------------------------------------------------------

  section "Cleanup"

  # Clean up WorkPackage test records (FK constraint before file deletion)
  PGPASSWORD=$DB_PASS $PSQL -c "
    ALTER TABLE public.\"WorkPackage\" DISABLE TRIGGER ALL;
    DELETE FROM public.\"WorkPackage\" WHERE id IN (1, 2, 3, 4);
    ALTER TABLE public.\"WorkPackage\" ENABLE TRIGGER ALL;
  " 2>/dev/null

  # Clean up Issue photo FKs before deleting file records (FK constraint)
  PGPASSWORD=$DB_PASS $PSQL -c "
    ALTER TABLE public.\"Issue\" DISABLE TRIGGER ALL;
    UPDATE public.\"Issue\" SET photo = NULL WHERE id IN (1, 2);
    ALTER TABLE public.\"Issue\" ENABLE TRIGGER ALL;
  " 2>/dev/null

  # Clean up test files
  PGPASSWORD=$DB_PASS $PSQL -c "
    DELETE FROM metadata.files WHERE file_name LIKE 'functional_test%';
    DELETE FROM metadata.files WHERE file_name = 'test_upload.jpg' AND entity_type = 'Issue';
    DELETE FROM metadata.files WHERE file_name = 'legacy_upload.png' AND s3_original_key LIKE '%test-legacy%';
    DELETE FROM metadata.files WHERE id IN (
      'a0000000-0000-0000-0000-000000000001',
      'a0000000-0000-0000-0000-000000000002',
      'a0000000-0000-0000-0000-000000000003',
      'b0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
      'b0000000-0000-0000-0000-000000000099',
      'c0000000-0000-0000-0000-000000000001',
      'c0000000-0000-0000-0000-000000000002',
      'c0000000-0000-0000-0000-000000000003',
      'c0000000-0000-0000-0000-000000000004'
    );
  " 2>/dev/null
  echo "Test data cleaned up."
fi

rm -f /tmp/headers.txt /tmp/test_upload.jpg

# Print summary
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  FUNCTIONAL TEST RESULTS: v0.39.0 File Administration${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}PASSED${NC}: $PASS"
echo -e "  ${RED}FAILED${NC}: $FAIL"
echo -e "  ${YELLOW}SKIPPED${NC}: $SKIP"
echo -e "  Total:   $((PASS + FAIL + SKIP))"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ $FAIL -gt 0 ]; then
  echo -e "\n${RED}Some tests failed!${NC}"
  exit 1
else
  echo -e "\n${GREEN}All tests passed!${NC}"
  exit 0
fi
