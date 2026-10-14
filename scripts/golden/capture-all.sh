#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Boot each example stack in an isolated compose project (sdk-<example>), capture the
# raw metadata contract, and tear the stack down again.
#
#   scripts/golden/capture-all.sh [--alt] [--check] [example ...]     (default: all examples)
#
#   --alt   run on the ALT Docker slot: project sdk-alt-<example>, no container_names, all host
#           ports shifted +30000 via a generated override (scripts/golden/alt-ports-override.mjs).
#           Output is byte-identical to a standard-slot capture.
#
# Env:
#   DOCKER_HEAVY_LOCK / DOCKER_ALT_LOCK  optional lock dir (mkdir-style mutex). When set, it is acquired
#                      around each example's boot/capture/teardown and released between
#                      examples so other Docker users can interleave.
#   KEEP_UP=1          leave the stack running after capture (debugging)
#
# Only postgres, postgrest and keycloak are started: they are all the metadata contract needs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALL_EXAMPLES=(pothole community-center staff-portal neighborhood-hub client-intake mottpark broader-impacts storymap)
ALT=0
CHECK_ARGS=()
EXAMPLES=()
for a in "$@"; do
  case "$a" in
    --check) CHECK_ARGS=(--check) ;;
    --alt) ALT=1 ;;
    *) EXAMPLES+=("$a") ;;
  esac
done
[ ${#EXAMPLES[@]} -eq 0 ] && EXAMPLES=("${ALL_EXAMPLES[@]}")

# Lock dir: DOCKER_HEAVY_LOCK (standard slot) or, with --alt, DOCKER_ALT_LOCK.
if [ "$ALT" = 1 ]; then LOCK="${DOCKER_ALT_LOCK:-}"; else LOCK="${DOCKER_HEAVY_LOCK:-}"; fi
HELD=0
acquire() {
  [ -z "$LOCK" ] && return 0
  until mkdir "$LOCK" 2>/dev/null; do sleep 20; done
  echo "golden-capture $(date -u +%FT%TZ)" > "$LOCK/owner"
  HELD=1
}
release() {
  if [ "$HELD" = 1 ] && [ -n "$LOCK" ]; then rm -rf "$LOCK"; HELD=0; fi
}

CURRENT=""
FAILED=()
DC=()
OVERRIDE=""
cleanup() {
  if [ -n "$CURRENT" ] && [ "${KEEP_UP:-0}" != 1 ]; then
    (cd "$ROOT/examples/$CURRENT" && "${DC[@]}" down -v) || true
  fi
  CURRENT=""
  release
}
trap cleanup EXIT

wait_for() { # description, command...
  local desc="$1"; shift
  for _ in $(seq 1 240); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  echo "timed out waiting for $desc" >&2
  return 1
}

for ex in "${EXAMPLES[@]}"; do
  dir="$ROOT/examples/$ex"
  [ -d "$dir" ] || { echo "no such example: $ex" >&2; exit 2; }
  acquire
  CURRENT="$ex"
  echo "=== $ex ==="
  cd "$dir"
  if [ ! -f .env ]; then
    # Only postgres/postgrest/keycloak are started, so compose needs just these values.
    # (Copying .env.example is avoided: several ship unquoted SMTP_FROM lines that compose cannot parse.)
    printf 'POSTGRES_DB=civic_os_db\nPOSTGRES_PASSWORD=securepassword123\n' > .env
  fi
  # Idempotent known-good credentials for local capture (the .env is gitignored).
  grep -q '^POSTGRES_DB=' .env || echo 'POSTGRES_DB=civic_os_db' >> .env
  grep -q '^POSTGRES_PASSWORD=' .env || echo 'POSTGRES_PASSWORD=securepassword123' >> .env

  if [ "$ALT" = 1 ]; then
    PROJECT="sdk-alt-$ex"
    OVERRIDE="$(mktemp -t "golden-alt-$ex.XXXXXX")"
    node "$ROOT/scripts/golden/alt-ports-override.mjs" "$ex" > "$OVERRIDE"
    DC=(docker compose -p "$PROJECT" -f docker-compose.yml -f "$OVERRIDE")
    PG_PORT=33000; KC_PORT=38082
  else
    PROJECT="sdk-$ex"
    DC=(docker compose -p "$PROJECT")
    PG_PORT=3000; KC_PORT=8082
  fi
  export POSTGREST_URL="http://localhost:$PG_PORT/"
  export KEYCLOAK_TOKEN_URL="http://localhost:$KC_PORT/realms/civic-os-dev/protocol/openid-connect/token"

  # Stage the boot: first-time init (Sqitch + example scripts) can outlast compose's own
  # dependency-health budget, so start postgres alone and poll pg_isready ourselves.
  "${DC[@]}" up -d --build postgres
  wait_for "Postgres init ($ex)" "${DC[@]}" exec -T postgres pg_isready -h 127.0.0.1 -U postgres
  # Docker may still report the container "unhealthy" until its next check; compose then
  # refuses the dependent start. Retry until the health state catches up.
  wait_for "postgres healthy ($ex)" bash -c "\"\$@\" ps postgres | grep -q '(healthy)'" _ "${DC[@]}"
  wait_for "postgrest+keycloak up ($ex)" "${DC[@]}" up -d --build postgrest keycloak
  wait_for "PostgREST ($ex)" curl -sf "http://localhost:$PG_PORT/"
  wait_for "Keycloak token endpoint ($ex)" curl -sf -o /dev/null \
    -d client_id=civic-os-dev-client -d username=testadmin -d password=testadmin -d grant_type=password \
    "$KEYCLOAK_TOKEN_URL"
  # Allow PostgREST to finish its schema cache load after Keycloak JWKS fetch.
  wait_for "schema_entities ($ex)" curl -sf "http://localhost:$PG_PORT/schema_entities"

  if ! (cd "$ROOT" && node scripts/golden/capture-raw.mjs --example "$ex" ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"}); then
    FAILED+=("$ex")
  fi

  cd "$dir"
  if [ "${KEEP_UP:-0}" != 1 ]; then "${DC[@]}" down -v; fi
  rm -f "$OVERRIDE"; OVERRIDE=""
  CURRENT=""
  release
done
if [ ${#FAILED[@]} -gt 0 ]; then echo "FAILED examples: ${FAILED[*]}" >&2; exit 1; fi
echo "done"
