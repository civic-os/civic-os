#!/bin/bash
# =============================================================================
# Functional Test Suite: v0.71.0 iCal HTTP Caching
# =============================================================================
# Exercises the iCal helpers end-to-end through PostgREST:
#   - Stable body between fetches (DTSTAMP derived from last_modified)
#   - ETag / Last-Modified / Cache-Control response headers
#   - 304 Not Modified for If-None-Match and fresh If-Modified-Since
#   - 200 for stale If-Modified-Since
#   - RFC 5545 line folding (no physical line > 75 octets, UTF-8 safe)
#   - REFRESH-INTERVAL / X-PUBLISHED-TTL advertised
#
# The test installs a throwaway RPC (zz_ical_http_caching_test) that calls the
# metadata helpers directly, so it runs against ANY example instance and does
# not depend on instance tables. The RPC is dropped on exit.
#
# Usage:
#   ./tests/functional/v0-71-0-ical-http-caching-test.sh
#
# Prerequisites:
#   - Docker compose running (any example)
#   - POSTGREST_URL (default http://localhost:3000)
#   - PG_CONTAINER  (default postgres_db), PG_DB (default civic_os_db)
# =============================================================================

set -uo pipefail

POSTGREST_URL="${POSTGREST_URL:-http://localhost:3000}"
PG_CONTAINER="${PG_CONTAINER:-postgres_db}"
PG_DB="${PG_DB:-civic_os_db}"
RPC="zz_ical_http_caching_test"
URL="$POSTGREST_URL/rpc/$RPC"
TMP="$(mktemp -d)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
PASS=0; FAIL=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }
section() { echo -e "\n${CYAN}${BOLD}$1${NC}"; }

psql_exec() { docker exec -i "$PG_CONTAINER" psql -U postgres -d "$PG_DB" -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  psql_exec <<EOF >/dev/null 2>&1
DROP FUNCTION IF EXISTS public.$RPC();
NOTIFY pgrst, 'reload schema';
EOF
  rm -rf "$TMP"
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
section "Setup: install throwaway feed RPC"
# -----------------------------------------------------------------------------
psql_exec <<EOF
CREATE OR REPLACE FUNCTION public.$RPC() RETURNS "*/*" LANGUAGE plpgsql STABLE AS \$\$
DECLARE v TEXT := '';
BEGIN
  v := v || metadata.format_ical_event('t-1@civic-os.org', 'Private Event',
    '2026-08-31 21:00+00', '2026-09-01 02:00+00', NULL, 'Pavilion',
    '2026-08-19 20:44:24.678+00') || chr(13) || chr(10);
  v := v || metadata.format_ical_event('t-2@civic-os.org',
    'Women''s Group - Rebecca Johnson - Women''s Group',
    '2026-09-03 22:00+00', '2026-09-04 00:00+00',
    E'Hosted by: Women''s Group - Rebecca Johnson\nType: Women''s Group',
    'Pavilion', '2026-08-18 13:32:05+00') || chr(13) || chr(10);
  v := v || metadata.format_ical_event('t-3@civic-os.org', repeat('Café Über ', 12),
    '2026-09-05 13:00+00', '2026-09-06 01:00+00', NULL, NULL,
    '2026-08-11 17:59:34+00') || chr(13) || chr(10);
  RETURN metadata.wrap_ical_feed(v, 'Functional Test Feed', '2026-08-19 20:44:24.678+00');
END \$\$;
GRANT EXECUTE ON FUNCTION public.$RPC() TO web_anon, authenticated;
NOTIFY pgrst, 'reload schema';
EOF
[ $? -eq 0 ] && pass "RPC installed" || { fail "RPC install failed"; exit 1; }
sleep 2

# -----------------------------------------------------------------------------
section "1. Plain GET: status, headers, body"
# -----------------------------------------------------------------------------
curl -s -D "$TMP/h1" -o "$TMP/b1" "$URL"
grep -q "^HTTP/1.1 200" "$TMP/h1" && pass "200 OK" || fail "expected 200: $(head -1 "$TMP/h1")"
grep -qi "^content-type: text/calendar; charset=utf-8" "$TMP/h1" && pass "Content-Type text/calendar" || fail "Content-Type missing"
grep -qi "^cache-control: no-cache" "$TMP/h1" && pass "Cache-Control: no-cache" || fail "Cache-Control missing"
grep -qi "^last-modified: Wed, 19 Aug 2026 20:44:24 GMT" "$TMP/h1" && pass "Last-Modified (second-truncated)" || fail "Last-Modified wrong: $(grep -i last-modified "$TMP/h1")"
ETAG=$(grep -i '^etag:' "$TMP/h1" | cut -d' ' -f2- | tr -d '\r')
[ "$ETAG" = 'W/"1787172264"' ] && pass "ETag W/\"<epoch>\"" || fail "ETag wrong: $ETAG"
grep -q "^REFRESH-INTERVAL;VALUE=DURATION:PT1H" "$TMP/b1" && pass "REFRESH-INTERVAL PT1H" || fail "REFRESH-INTERVAL missing"
grep -q "^X-PUBLISHED-TTL:PT1H" "$TMP/b1" && pass "X-PUBLISHED-TTL PT1H" || fail "X-PUBLISHED-TTL missing"
grep -q "^DTSTAMP:20260819T204424Z" "$TMP/b1" && pass "DTSTAMP derived from last_modified" || fail "DTSTAMP not derived"

# -----------------------------------------------------------------------------
section "2. Body is byte-stable across fetches"
# -----------------------------------------------------------------------------
sleep 1
curl -s -o "$TMP/b2" "$URL"
cmp -s "$TMP/b1" "$TMP/b2" && pass "second fetch identical" || fail "body changed between fetches"

# -----------------------------------------------------------------------------
section "3. Conditional requests"
# -----------------------------------------------------------------------------
code=$(curl -s -o "$TMP/b3" -w "%{http_code}" -H "If-None-Match: $ETAG" "$URL")
[ "$code" = "304" ] && [ ! -s "$TMP/b3" ] && pass "If-None-Match → 304, empty body" || fail "If-None-Match: $code ($(wc -c < "$TMP/b3") bytes)"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-Modified-Since: Wed, 19 Aug 2026 20:44:24 GMT" "$URL")
[ "$code" = "304" ] && pass "If-Modified-Since (equal) → 304" || fail "If-Modified-Since equal: $code"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-Modified-Since: Sat, 22 Aug 2026 00:00:00 GMT" "$URL")
[ "$code" = "304" ] && pass "If-Modified-Since (newer) → 304" || fail "If-Modified-Since newer: $code"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-Modified-Since: Tue, 18 Aug 2026 00:00:00 GMT" "$URL")
[ "$code" = "200" ] && pass "If-Modified-Since (stale) → 200" || fail "If-Modified-Since stale: $code"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: W/\"999\"" "$URL")
[ "$code" = "200" ] && pass "If-None-Match mismatch → 200" || fail "If-None-Match mismatch: $code"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: \"zzz\", ${ETAG#W/}" "$URL")
[ "$code" = "304" ] && pass "If-None-Match list + strong-form tag → 304 (weak comparison)" || fail "weak comparison list: $code"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: *" "$URL")
[ "$code" = "304" ] && pass "If-None-Match: * → 304" || fail "star: $code"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: W/\"9${ETAG#W/\"}" "$URL")
[ "$code" = "200" ] && pass "superstring tag → 200 (exact match only)" || fail "superstring: $code"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "If-Modified-Since: not-a-date" "$URL")
[ "$code" = "200" ] && pass "unparseable If-Modified-Since → 200" || fail "unparseable date: $code"

# -----------------------------------------------------------------------------
section "4. RFC 5545 formatting"
# -----------------------------------------------------------------------------
python3 - "$TMP/b1" <<'PY'
import re, sys
raw = open(sys.argv[1], 'rb').read()
ok = True
def check(cond, msg):
    global ok
    print(("  \033[0;32m✓\033[0m " if cond else "  \033[0;31m✗\033[0m ") + msg)
    ok = ok and cond
lines = raw.split(b'\r\n')
check(b'\n' not in raw.replace(b'\r\n', b''), "CRLF line endings only")
check(max(len(l) for l in lines) <= 75, f"max physical line {max(len(l) for l in lines)} octets ≤ 75")
text = raw.decode('utf-8')  # raises if a multibyte char was split
check(True, "valid UTF-8 (no split multibyte characters)")
unfolded = re.sub(r'\r\n[ \t]', '', text)
summaries = [l for l in unfolded.split('\r\n') if l.startswith('SUMMARY:')]
check(summaries[2] == 'SUMMARY:' + 'Café Über ' * 12, "folded multibyte SUMMARY round-trips")
check(unfolded.count('BEGIN:VEVENT') == 3, "3 VEVENTs present")
check(unfolded.endswith('END:VCALENDAR'), "ends with END:VCALENDAR")
sys.exit(0 if ok else 1)
PY
if [ $? -eq 0 ]; then PASS=$((PASS+6)); else FAIL=$((FAIL+1)); fi

# -----------------------------------------------------------------------------
echo -e "\n${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
[ "$FAIL" -eq 0 ]
