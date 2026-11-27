#!/bin/bash
# =============================================================================
# Functional Test: v0-87-0 file reconcile (full stack, pothole)
# =============================================================================
# Drives the consolidated worker's FileReconcileCron end to end: files are uploaded the way the Create page
# uploads them (request_upload_url with an empty entity id, presigned PUT, create_file_record), records are
# saved through PostgREST, and the test waits for the worker's ticks:
#   A. An Issue photo (with thumbnails) is claimed: the row gets the record id, every object moves from
#      Issue/_new/<file>/ to Issue/<id>/<file>/, and the old objects are gone.
#   B. A WorkPackage with a PDF and a generic file: both are claimed.
#   C. A file uploaded for Issue but saved on a WorkPackage is claimed as WorkPackage.
#   D. A file with a live thumbnail job waits; it is claimed once the job is gone.
#   E. A file two Issues reference is claimed for the lower id, and both still reference it.
#   F. An unreferenced staged file older than the TTL is deleted with its object; a young one is kept.
#   G. Objects left under _new/ by an interrupted move (row already claimed) are swept.
#   H. Upload requests older than 24 hours are deleted.
#   I. Further ticks change nothing.
# Not covered here: the legacy "{type}//{file}" keys (RustFS refuses them; the Go and SQL tests cover the
# mapping) and FILE_RECONCILE_INTERVAL=0 (a Go test).
#
# Prerequisites: the pothole stack, with the worker started with a short interval, for example
#   FILE_RECONCILE_INTERVAL=5s docker compose up -d
# (tests/e2e/env/pothole.compose-env sets it for the nightly run), and jq.
#
# Environment overrides:
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db (superuser)
#   POSTGREST_URL  http://localhost:3000     KEYCLOAK_URL  http://localhost:8082
#   S3_URL         http://localhost:9000     S3_BUCKET     civic-os-files
#   S3_ROOT_USER / S3_ROOT_PASSWORD   minioadmin (signed HEADs: objects are private since v0.88.0)
#   TICK_WAIT      seconds to wait for a tick's effect (default 60)
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"
POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-civic-os-dev}"
KEYCLOAK_CLIENT="${KEYCLOAK_CLIENT:-civic-os-dev-client}"
S3_URL="${S3_URL:-http://localhost:9000}"
S3_BUCKET="${S3_BUCKET:-civic-os-files}"
TICK_WAIT="${TICK_WAIT:-60}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0
pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atq -c "$1"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMP/pixel.png"
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$TMP/report.pdf"
printf 'reconcile test\n' > "$TMP/note.txt"

get_token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    -d "client_id=$KEYCLOAK_CLIENT" -d "username=$1" -d "password=$1" -d "grant_type=password" | jq -r '.access_token // empty'
}

# The Create page's upload: the database issues an upload with an empty entity id (v0.88.0:
# request_file_upload, synchronous), PUT, create the row. Prints the file id.
upload_staged() {
  local entity_type="$1" path="$2" name="$3" type="$4" property="$5"
  local issued url file_id key bucket size thumb="not_applicable"
  size=$(wc -c < "$path" | tr -d ' ')
  issued=$(curl -s -X POST "$POSTGREST_URL/rpc/request_file_upload" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"p_entity_type\":\"$entity_type\",\"p_entity_id\":\"\",\"p_file_name\":\"$name\",\"p_file_type\":\"$type\"}")
  url=$(echo "$issued" | jq -r '.url // empty'); file_id=$(echo "$issued" | jq -r '.file_id // empty')
  key=$(echo "$issued" | jq -r '.key // empty'); bucket=$(echo "$issued" | jq -r '.bucket // empty')
  [ -z "$url" ] && return 1
  # private file: no x-amz-acl (it is signed into the URL only for static assets)
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$url" -H "Content-Type: $type" --data-binary @"$path")" = "200" ] || return 1
  case "$type" in image/*|application/pdf) thumb="pending" ;; esac
  curl -s -X POST "$POSTGREST_URL/rpc/create_file_record" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"p_id\":\"$file_id\",\"p_entity_type\":\"$entity_type\",\"p_entity_id\":\"\",\"p_property_name\":\"$property\",\"p_file_name\":\"$name\",\"p_file_type\":\"$type\",\"p_file_size\":$size,\"p_s3_bucket\":\"$bucket\",\"p_s3_original_key\":\"$key\",\"p_thumbnail_status\":\"$thumb\"}" \
    | jq -r '.id // empty'
}

# POST a record the way the Create page saves it; prints its id.
create_record() {
  curl -s -X POST "$POSTGREST_URL/$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "Prefer: return=representation" -d "$2" | jq -r '.[0].id // empty'
}

# Poll SQL until it prints the expected value; prints the last value.
wait_for() {
  local sql="$1" want="$2" got=""
  for _ in $(seq 1 "$TICK_WAIT"); do
    got=$(q "$sql" 2>/dev/null)
    [ "$got" = "$want" ] && break
    sleep 1
  done
  echo "$got"
}

# Objects are private since v0.88.0, so existence is checked with a signed HEAD (200 or 404).
object_status() {
  curl -s -o /dev/null -w '%{http_code}' -I --aws-sigv4 "aws:amz:us-east-1:s3" \
    --user "${S3_ROOT_USER:-minioadmin}:${S3_ROOT_PASSWORD:-minioadmin}" "$S3_URL/$S3_BUCKET/$1"
}

# Every object key of a file, space-separated, original first.
file_keys() {
  q "SELECT concat_ws(' ', s3_original_key, s3_thumbnail_small_key, s3_thumbnail_medium_key, s3_thumbnail_large_key) FROM metadata.files WHERE id = '$1'"
}

# All of a file's objects answer 200 at their keys under prefix, and the given old keys do not.
check_moved() {
  local label="$1" file_id="$2" prefix="$3" old_keys="$4" k ok=1
  for k in $(file_keys "$file_id"); do
    case "$k" in "$prefix"*) ;; *) ok=0; fail "$label: key $k is not under $prefix" ;; esac
    [ "$(object_status "$k")" = "200" ] || { ok=0; fail "$label: object $k is missing"; }
  done
  for k in $old_keys; do
    [ "$(object_status "$k")" = "200" ] && { ok=0; fail "$label: old object $k is still there"; }
  done
  [ $ok = 1 ] && pass "$label: every object moved to $prefix and the old ones are gone"
}

TOKEN=$(get_token testadmin)
[ -z "$TOKEN" ] && { echo "No token from $KEYCLOAK_URL"; exit 1; }
curl -s -o /dev/null -X POST "$POSTGREST_URL/rpc/refresh_current_user" -H "Authorization: Bearer $TOKEN"
RUN="reconcile-$(date +%s)"
CREATED_FILES=()

# -----------------------------------------------------------------------------
section "A. An Issue photo with thumbnails"
# -----------------------------------------------------------------------------
FA=$(upload_staged Issue "$TMP/pixel.png" a.png image/png photo); CREATED_FILES+=("$FA")
check "A. the upload is staged under _new" "Issue/_new/$FA/original.png" "$(q "SELECT s3_original_key FROM metadata.files WHERE id = '$FA'")"
check "A. thumbnails are generated while staged" "completed" "$(wait_for "SELECT thumbnail_status FROM metadata.files WHERE id = '$FA'" completed)"
OLD_A=$(file_keys "$FA")
IA=$(create_record Issue "{\"display_name\":\"$RUN A\",\"photo\":\"$FA\"}")
check "A. the row is claimed for the Issue" "Issue|$IA" "$(wait_for "SELECT entity_type || '|' || entity_id FROM metadata.files WHERE id = '$FA'" "Issue|$IA")"
check "A. three thumbnails came along" "4" "$(file_keys "$FA" | wc -w | tr -d ' ')"
check_moved "A" "$FA" "Issue/$IA/$FA/" "$OLD_A"

# -----------------------------------------------------------------------------
section "B. A WorkPackage with a PDF and a generic file"
# -----------------------------------------------------------------------------
FB1=$(upload_staged WorkPackage "$TMP/report.pdf" report.pdf application/pdf report_pdf); CREATED_FILES+=("$FB1")
FB2=$(upload_staged WorkPackage "$TMP/note.txt" note.txt text/plain attachment); CREATED_FILES+=("$FB2")
wait_for "SELECT thumbnail_status FROM metadata.files WHERE id = '$FB1'" completed > /dev/null
OLD_B1=$(file_keys "$FB1"); OLD_B2=$(file_keys "$FB2")
WB=$(create_record WorkPackage "{\"display_name\":\"$RUN B\",\"quote_due_date\":\"2031-03-14T18:30:00Z\",\"report_pdf\":\"$FB1\",\"attachment\":\"$FB2\"}")
check "B. the PDF is claimed" "WorkPackage|$WB" "$(wait_for "SELECT entity_type || '|' || entity_id FROM metadata.files WHERE id = '$FB1'" "WorkPackage|$WB")"
check "B. the generic file is claimed" "WorkPackage|$WB" "$(wait_for "SELECT entity_type || '|' || entity_id FROM metadata.files WHERE id = '$FB2'" "WorkPackage|$WB")"
check_moved "B. PDF" "$FB1" "WorkPackage/$WB/$FB1/" "$OLD_B1"
check_moved "B. generic file" "$FB2" "WorkPackage/$WB/$FB2/" "$OLD_B2"

# -----------------------------------------------------------------------------
section "C. Uploaded for Issue, saved on a WorkPackage"
# -----------------------------------------------------------------------------
FC=$(upload_staged Issue "$TMP/note.txt" moved.txt text/plain photo); CREATED_FILES+=("$FC")
OLD_C=$(file_keys "$FC")
WC=$(create_record WorkPackage "{\"display_name\":\"$RUN C\",\"quote_due_date\":\"2031-03-14T18:30:00Z\",\"attachment\":\"$FC\"}")
check "C. claimed by its owner's table" "WorkPackage|$WC" "$(wait_for "SELECT entity_type || '|' || entity_id FROM metadata.files WHERE id = '$FC'" "WorkPackage|$WC")"
check_moved "C" "$FC" "WorkPackage/$WC/$FC/" "$OLD_C"

# -----------------------------------------------------------------------------
section "D. A live thumbnail job holds the file back"
# -----------------------------------------------------------------------------
FD=$(upload_staged Issue "$TMP/note.txt" held.txt text/plain photo); CREATED_FILES+=("$FD")
q "INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, state, scheduled_at)
   VALUES ('thumbnail_generate', jsonb_build_object('file_id', '$FD'), 'thumbnails', 1, 25, 'scheduled', now() + interval '1 day')" > /dev/null
ID_D=$(create_record Issue "{\"display_name\":\"$RUN D\",\"photo\":\"$FD\"}")
# Wait for a later file to be claimed: that proves a tick ran while D's job was live.
FD2=$(upload_staged Issue "$TMP/note.txt" marker.txt text/plain photo); CREATED_FILES+=("$FD2")
ID_D2=$(create_record Issue "{\"display_name\":\"$RUN D marker\",\"photo\":\"$FD2\"}")
wait_for "SELECT entity_id FROM metadata.files WHERE id = '$FD2'" "$ID_D2" > /dev/null
check "D. still staged while its job is live" "" "$(q "SELECT entity_id FROM metadata.files WHERE id = '$FD'")"
q "DELETE FROM metadata.river_job WHERE kind = 'thumbnail_generate' AND args->>'file_id' = '$FD'" > /dev/null
check "D. claimed once the job is gone" "$ID_D" "$(wait_for "SELECT entity_id FROM metadata.files WHERE id = '$FD'" "$ID_D")"

# -----------------------------------------------------------------------------
section "E. One file, two Issues"
# -----------------------------------------------------------------------------
FE=$(upload_staged Issue "$TMP/note.txt" shared.txt text/plain photo); CREATED_FILES+=("$FE")
IE1=$(create_record Issue "{\"display_name\":\"$RUN E1\",\"photo\":\"$FE\"}")
IE2=$(create_record Issue "{\"display_name\":\"$RUN E2\",\"photo\":\"$FE\"}")
LOW=$(( IE1 < IE2 ? IE1 : IE2 ))
check "E. claimed for the lower id" "$LOW" "$(wait_for "SELECT entity_id FROM metadata.files WHERE id = '$FE'" "$LOW")"
check "E. both Issues still reference it" "2" "$(q "SELECT count(*) FROM \"Issue\" WHERE id IN ($IE1, $IE2) AND photo = '$FE'")"
check "E. its object answers at the new key" "200" "$(object_status "Issue/$LOW/$FE/original.txt")"

# -----------------------------------------------------------------------------
section "F. Orphans past the TTL"
# -----------------------------------------------------------------------------
FF_OLD=$(upload_staged Issue "$TMP/note.txt" abandoned.txt text/plain photo)
FF_NEW=$(upload_staged Issue "$TMP/note.txt" recent.txt text/plain photo); CREATED_FILES+=("$FF_NEW")
KEY_F_OLD=$(file_keys "$FF_OLD")
q "UPDATE metadata.files SET created_at = now() - interval '8 days' WHERE id = '$FF_OLD'" > /dev/null
check "F. the old unreferenced row is deleted" "0" "$(wait_for "SELECT count(*) FROM metadata.files WHERE id = '$FF_OLD'" 0)"
[ "$(object_status "$KEY_F_OLD")" = "200" ] && fail "F. the old object $KEY_F_OLD is still there" || pass "F. its object is deleted"
check "F. the young unreferenced file is kept" "1" "$(q "SELECT count(*) FROM metadata.files WHERE id = '$FF_NEW' AND entity_id = ''")"
check "F. its object is kept" "200" "$(object_status "$(file_keys "$FF_NEW")")"

# -----------------------------------------------------------------------------
section "G. Objects an interrupted move left under _new/"
# -----------------------------------------------------------------------------
FG=$(upload_staged Issue "$TMP/note.txt" interrupted.txt text/plain photo); CREATED_FILES+=("$FG")
KEY_G=$(file_keys "$FG")
# The claim committed but the old objects were not deleted: the row points elsewhere already.
q "UPDATE metadata.files SET entity_id = '999999', s3_original_key = 'Issue/999999/$FG/original.txt' WHERE id = '$FG'" > /dev/null
for _ in $(seq 1 "$TICK_WAIT"); do [ "$(object_status "$KEY_G")" = "200" ] || break; sleep 1; done
[ "$(object_status "$KEY_G")" = "200" ] && fail "G. $KEY_G was not swept" || pass "G. the claimed row's leftover object under _new/ is swept"

# -----------------------------------------------------------------------------
section "H. Stale upload requests"
# -----------------------------------------------------------------------------
# Since v0.88.0 registering a file deletes its request, so only abandoned uploads (issued, never
# registered) leave rows. Issue two, make one old.
issue_only() {
  curl -s -X POST "$POSTGREST_URL/rpc/request_file_upload" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"p_entity_type\":\"Issue\",\"p_entity_id\":\"\",\"p_file_name\":\"$1\",\"p_file_type\":\"text/plain\"}" > /dev/null
}
issue_only abandoned-old.txt; issue_only abandoned-recent.txt
q "UPDATE metadata.file_upload_requests SET created_at = now() - interval '25 hours' WHERE file_name = 'abandoned-old.txt'" > /dev/null
check "H. upload requests older than 24 hours are deleted" "0" "$(wait_for "SELECT count(*) FROM metadata.file_upload_requests WHERE file_name = 'abandoned-old.txt'" 0)"
check "H. recent ones are kept" "t" "$(q "SELECT count(*) > 0 FROM metadata.file_upload_requests WHERE file_name = 'abandoned-recent.txt'")"
q "DELETE FROM metadata.file_upload_requests WHERE file_name = 'abandoned-recent.txt'" > /dev/null

# -----------------------------------------------------------------------------
section "I. Idempotency"
# -----------------------------------------------------------------------------
IDS=$(printf "'%s'," "${CREATED_FILES[@]}"); IDS=${IDS%,}
BEFORE=$(q "SELECT md5(string_agg(id || entity_type || entity_id || s3_original_key || coalesce(s3_thumbnail_small_key, ''), ',' ORDER BY id)) FROM metadata.files WHERE id IN ($IDS)")
# One more file claimed proves at least one more tick ran.
FI=$(upload_staged Issue "$TMP/note.txt" tick.txt text/plain photo); CREATED_FILES+=("$FI")
II=$(create_record Issue "{\"display_name\":\"$RUN I\",\"photo\":\"$FI\"}")
wait_for "SELECT entity_id FROM metadata.files WHERE id = '$FI'" "$II" > /dev/null
check "I. another tick changes nothing already reconciled" "$BEFORE" "$(q "SELECT md5(string_agg(id || entity_type || entity_id || s3_original_key || coalesce(s3_thumbnail_small_key, ''), ',' ORDER BY id)) FROM metadata.files WHERE id IN ($IDS)")"

# -----------------------------------------------------------------------------
# Cleanup: records first, then their files
# -----------------------------------------------------------------------------
q "DELETE FROM \"Issue\" WHERE display_name LIKE '$RUN %'; DELETE FROM \"WorkPackage\" WHERE display_name LIKE '$RUN %';" > /dev/null
IDS=$(printf "'%s'," "${CREATED_FILES[@]}"); IDS=${IDS%,}
q "DELETE FROM metadata.files WHERE id IN ($IDS)" > /dev/null

echo ""
echo -e "${BOLD}Passed: $PASS  Failed: $FAIL${NC}"
[ "$FAIL" -eq 0 ]
