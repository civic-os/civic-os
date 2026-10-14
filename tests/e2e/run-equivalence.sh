#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Request-equivalence harness runner. See tests/e2e/README.md.
#
#   run-equivalence.sh <example> --record              write committed baselines (lead only)
#   run-equivalence.sh <example> --compare             record to .artifacts and diff against baselines
#   run-equivalence.sh <example> --visual-base <ref>   screenshots of <ref>'s app vs this checkout's app
#
# Options:
#   --keep-stack     leave the Docker stack and dev server running afterwards (development)
#   --reuse-stack    skip the fresh stack and use one left by --keep-stack (development; not with --record)
#   --grep <re>      run only matching flows (development; not with --record)
#   --keep-base      keep (and reuse) the --visual-base worktree and its node_modules
#
# Environment:
#   E2E_STD_LOCK     lock directory guarding the standard ports and :4200
#                    (default: ${TMPDIR:-/tmp}/civic-os-e2e-std.lock)
#   E2E_LOCK_HELD=1  the caller already holds the lock; do not acquire or release it
#   E2E_ROLES        roles to log in (default: testadmin,testeditor)
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$E2E_DIR" rev-parse --show-toplevel)"

usage() { sed -n '4,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# Everything runs inside main(), which bash parses completely before running it,
# so editing this file during a run cannot change the run in progress.
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$EX_DIR/docker-compose.yml" "$@"; }

stop_dev_server() {
  [[ -n "$DEV_PID" ]] || return 0
  kill "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  DEV_PID=""
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:4200 -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "port 4200 still in use after stopping the dev server" >&2
}

# Globals the EXIT trap relies on; main() fills in the rest.
KEEP_STACK=0; KEEP_BASE=0; STACK_STARTED=0; LOCK_ACQUIRED=0; DEV_PID=""; BASE_WT=""; T_START=$(date +%s)

cleanup() {
  local rc=$?
  set +e
  if [[ $KEEP_STACK == 0 ]]; then
    stop_dev_server
    if [[ $STACK_STARTED == 1 ]]; then
      log "tearing down $PROJECT"
      teardown_stack
    fi
  elif [[ -n "$DEV_PID" ]]; then
    log "leaving dev server (pid $DEV_PID) and stack $PROJECT running (--keep-stack)"
  fi
  if [[ -n "$BASE_WT" && $KEEP_BASE == 0 ]]; then
    git -C "$ROOT" worktree remove --force "$BASE_WT" >/dev/null 2>&1
  fi
  if [[ $LOCK_ACQUIRED == 1 ]]; then rm -rf "$LOCK"; fi
  log "total $(( $(date +%s) - T_START ))s"
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

acquire_lock() {
  if [[ "${E2E_LOCK_HELD:-0}" == 1 ]]; then return; fi
  until mkdir "$LOCK" 2>/dev/null; do
    log "waiting for lock $LOCK (held by: $(cat "$LOCK/owner" 2>/dev/null || echo unknown))"
    sleep 20
  done
  echo "e2e-equivalence $EXAMPLE $(date -u +%FT%TZ)" > "$LOCK/owner"
  LOCK_ACQUIRED=1
}

wait_http() {
  local url="$1" timeout="$2" t=0
  until curl -sf -o /dev/null "$url"; do
    t=$((t + 3)); [[ $t -ge $timeout ]] && { echo "timeout waiting for $url" >&2; return 1; }
    sleep 3
  done
}

# Background jobs (series expansion, notifications) started by init scripts must
# finish before flows run, or worker-assigned ids interleave with flow-created ones.
settle_workers() {
  local q="SELECT count(*) FROM metadata.river_job WHERE state IN ('available','running') OR (state IN ('retryable','scheduled') AND kind = 'expand_recurring_series')"
  local t=0 n
  while :; do
    n=$(compose exec -T postgres psql -U postgres -d civic_os_db -tAc "$q" 2>/dev/null | tr -d '[:space:]')
    [[ "$n" == 0 ]] && return 0
    t=$((t + 2)); [[ $t -ge 180 ]] && { echo "background jobs did not settle (pending: ${n:-?})" >&2; return 1; }
    sleep 2
  done
}

# Waits until every created container of the project that has a healthcheck reports
# "healthy" (compose gives up on a dependency the first time it is unhealthy, but the
# healthcheck keeps running and recovers once a slow init finishes).
wait_healthy() {
  local timeout="$1" t=0 id st pending
  while :; do
    pending=""
    for id in $(compose ps -a -q 2>/dev/null); do
      st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null)
      case "$st" in healthy|none) ;; *) pending="$pending $(docker inspect -f '{{.Name}}' "$id")=$st" ;; esac
    done
    [[ -z "$pending" ]] && return 0
    t=$((t + 5)); [[ $t -ge $timeout ]] && { echo "containers not healthy within ${timeout}s:$pending" >&2; return 1; }
    sleep 5
  done
}

# Tears down this run's stack. Containers that carry this project's compose label
# but are not one of its services (e.g. a container started from an image this
# project built) are never touched: in that case only our own services, their
# anonymous volumes and our named volumes are removed.
teardown_stack() {
  local expected labelled foreign=""
  expected=$(compose config --format json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s);
      for (const [name, svc] of Object.entries(c.services || {})) console.log(svc.container_name || `${c.name}-${name}-1`);
    });')
  labelled=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}')
  for name in $labelled; do
    grep -qx "$name" <<< "$expected" || foreign="$foreign $name"
  done
  if [[ -z "$foreign" ]]; then
    compose down -v >/dev/null 2>&1 || true
    return 0
  fi
  log "foreign containers carry the $PROJECT label (left untouched):$foreign"
  # shellcheck disable=SC2046
  compose rm -s -f -v $(compose config --services) >/dev/null 2>&1 || true
  local vol
  for vol in $(compose config --volumes 2>/dev/null); do
    docker volume rm "${PROJECT}_${vol}" >/dev/null 2>&1 || true
  done
  local net
  for net in $(docker network ls --filter "label=com.docker.compose.project=$PROJECT" -q); do
    docker network rm "$net" >/dev/null 2>&1 || true
  done
}

fresh_stack() {
  if [[ $REUSE_STACK == 1 ]]; then log "reusing running stack $PROJECT"; return; fi
  local t0; t0=$(date +%s)
  log "fresh stack $PROJECT (down -v, up --build)"
  STACK_STARTED=1
  teardown_stack
  local services
  services=$(compose config --services | grep -vxE 'swagger-ui|mcp-server|payment-worker' | tr '\n' ' ')
  # shellcheck disable=SC2086
  if ! compose up -d --build --quiet-pull $services > "$ART/compose-up.log" 2>&1; then
    if ! grep -qE "is unhealthy|dependency failed to start" "$ART/compose-up.log"; then
      tail -20 "$ART/compose-up.log" >&2
      return 1
    fi
    # Postgres init (migrations + init scripts, amd64 image) or Keycloak startup can
    # overrun the compose healthcheck window on a loaded VM. Show the memory picture,
    # wait for the healthchecks to recover, then start the remaining services.
    log "compose up failed (see compose-up.log); VM memory and load:"
    docker info --format 'MemTotal={{.MemTotal}} NCPU={{.NCPU}}' >&2 || true
    docker stats --no-stream --format '  {{.Name}} {{.MemUsage}} {{.CPUPerc}}' >&2 || true
    wait_healthy 900 || { tail -40 "$ART/compose-up.log" >&2; return 1; }
    log "dependencies healthy; retrying compose up"
    # shellcheck disable=SC2086
    compose up -d --quiet-pull $services >> "$ART/compose-up.log" 2>&1 || { tail -40 "$ART/compose-up.log" >&2; return 1; }
  fi
  wait_http "http://localhost:3000/" 400
  wait_http "http://localhost:8082/realms/civic-os-dev/.well-known/openid-configuration" 400
  settle_workers
  log "stack ready in $(( $(date +%s) - t0 ))s"
}

start_dev_server() {
  local app_root="$1" logfile="$2" t0
  t0=$(date +%s)
  if lsof -nP -iTCP:4200 -sTCP:LISTEN >/dev/null 2>&1; then
    if [[ $REUSE_STACK == 1 ]]; then log "dev server already listening on :4200 (reuse)"; return; fi
    echo "port 4200 is busy; stop the other dev server first" >&2; return 1
  fi
  log "starting dev server from $app_root"
  ( cd "$app_root" && NG_CLI_ANALYTICS=false exec node node_modules/@angular/cli/bin/ng.js serve --port 4200 --host localhost ) > "$logfile" 2>&1 &
  DEV_PID=$!
  local t=0
  until curl -sf http://localhost:4200/ | grep -q '<app-root>'; do
    kill -0 "$DEV_PID" 2>/dev/null || { tail -30 "$logfile" >&2; echo "dev server exited" >&2; return 1; }
    t=$((t + 2)); [[ $t -ge 400 ]] && { echo "dev server did not come up" >&2; return 1; }
    sleep 2
  done
  log "dev server ready in $(( $(date +%s) - t0 ))s"
}

run_flows() {
  local art="$1" t0 rc=0
  t0=$(date +%s)
  rm -rf "$art/raw" "$art/screenshots" "$art/auth" "$art/test-results"
  local grep_args=()
  [[ -n "$GREP" ]] && grep_args=(--grep "$GREP")
  log "running flows for $EXAMPLE"
  ( cd "$E2E_DIR" && E2E_EXAMPLE="$EXAMPLE" E2E_ARTIFACT_DIR="$art" E2E_ROLES="$ROLES" \
      npx playwright test --project=flows ${grep_args[@]+"${grep_args[@]}"} ) || rc=$?
  log "flows finished in $(( $(date +%s) - t0 ))s (exit $rc)"
  return $rc
}

capture() {
  local app_root="$1" art="$2"
  mkdir -p "$art"
  fresh_stack
  start_dev_server "$app_root" "$art/dev-server.log"
  run_flows "$art"
  # A dependency re-optimization or live reload during the flows would add page loads.
  if grep -qiE "page reload|optimized dependencies changed|reloading" "$art/dev-server.log"; then
    echo "WARNING: the dev server reloaded the page during the run (see $art/dev-server.log)" >&2
  fi
  if [[ $KEEP_STACK == 0 ]]; then stop_dev_server; fi
}

meta_json() {
  local sha dirty=false
  sha=$(git -C "$ROOT" rev-parse HEAD)
  if [[ -n "$(git -C "$ROOT" status --porcelain -- src "examples/$EXAMPLE" postgres sqitch.plan)" ]]; then dirty=true; fi
  printf '{"example":"%s","baseSha":"%s","exampleTree":"%s","migrationsTree":"%s","appSourceDirty":%s,"clockT0":"%s","timezone":"%s","locale":"%s"}' \
    "$EXAMPLE" "$sha" \
    "$(git -C "$ROOT" rev-parse "HEAD:examples/$EXAMPLE")" \
    "$(git -C "$ROOT" rev-parse HEAD:postgres/migrations)" \
    "$dirty" \
    "$(cd "$E2E_DIR" && node --input-type=module -e 'const c = await import("./lib/config.mjs"); process.stdout.write(c.CLOCK_T0)')" \
    "America/New_York" "en-US"
}

main() {
  [[ $# -ge 2 ]] || usage
  EXAMPLE="$1"; shift
  MODE=""; VISUAL_REF=""; KEEP_STACK=0; REUSE_STACK=0; GREP=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --record) MODE=record ;;
      --compare) MODE=compare ;;
      --visual-base) MODE=visual; VISUAL_REF="${2:?--visual-base needs a git ref}"; shift ;;
      --keep-stack) KEEP_STACK=1 ;;
      --reuse-stack) REUSE_STACK=1 ;;
      --grep) GREP="${2:?--grep needs a pattern}"; shift ;;
      --keep-base) KEEP_BASE=1 ;;
      *) usage ;;
    esac
    shift
  done
  [[ -n "$MODE" ]] || usage
  if [[ "$MODE" == record && ( $REUSE_STACK == 1 || -n "$GREP" ) ]]; then
    echo "--record always runs every flow on a fresh stack; --reuse-stack/--grep are not allowed" >&2; exit 2
  fi
  if [[ "$MODE" == visual && $REUSE_STACK == 1 ]]; then
    echo "--visual-base needs two fresh stacks; --reuse-stack is not allowed" >&2; exit 2
  fi

  EX_DIR="$ROOT/examples/$EXAMPLE"
  SPEC="$E2E_DIR/flows/$EXAMPLE.spec.ts"
  ENV_FILE="$E2E_DIR/env/$EXAMPLE.env"
  for f in "$EX_DIR/docker-compose.yml" "$SPEC" "$ENV_FILE"; do
    [[ -f "$f" ]] || { echo "missing $f" >&2; exit 2; }
  done
  [[ -d "$E2E_DIR/node_modules/@playwright/test" ]] || { echo "run 'npm ci' in tests/e2e first" >&2; exit 2; }

  PROJECT="sdk-$EXAMPLE"
  ART="$E2E_DIR/.artifacts/$EXAMPLE"
  LOCK="${E2E_STD_LOCK:-${TMPDIR:-/tmp}/civic-os-e2e-std.lock}"
  ROLES="${E2E_ROLES:-testadmin,testeditor}"
  mkdir -p "$ART"
  acquire_lock

  case "$MODE" in
    record|compare)
      OUT_ART="$ART/$MODE"
      capture "$ROOT" "$OUT_ART"
      if [[ "$MODE" == record ]]; then
        DEST="$E2E_DIR/baselines/$EXAMPLE"
      else
        DEST="$OUT_ART/normalized"
      fi
      ( cd "$E2E_DIR" && node lib/cli.mjs normalize --raw "$OUT_ART/raw" --out "$DEST" --meta "$(meta_json)" )
      if [[ "$MODE" == compare ]]; then
        [[ -d "$E2E_DIR/baselines/$EXAMPLE" ]] || { echo "no baselines for $EXAMPLE; the lead records them with --record" >&2; exit 1; }
        ( cd "$E2E_DIR" && node lib/cli.mjs compare --baseline "baselines/$EXAMPLE" --current "$DEST" --report "$OUT_ART/compare-report.txt" )
      else
        log "baselines written to tests/e2e/baselines/$EXAMPLE (review the diff before committing)"
      fi
      ;;
    visual)
      BASE_SHA=$(git -C "$ROOT" rev-parse --verify "$VISUAL_REF^{commit}")
      BASE_WT="${E2E_TMPDIR:-${TMPDIR:-/tmp}}/civic-os-visual-base-$BASE_SHA"
      if [[ -d "$BASE_WT/node_modules" && "$(git -C "$BASE_WT" rev-parse HEAD 2>/dev/null)" == "$BASE_SHA" ]]; then
        log "reusing base worktree $BASE_WT"
      else
        git -C "$ROOT" worktree remove --force "$BASE_WT" >/dev/null 2>&1 || rm -rf "$BASE_WT"
        git -C "$ROOT" worktree add --detach "$BASE_WT" "$BASE_SHA" >/dev/null
        log "npm ci in base worktree ($BASE_SHA)"
        ( cd "$BASE_WT" && npm ci --no-audit --no-fund > "$ART/visual-base-npm-ci.log" 2>&1 ) || { tail -30 "$ART/visual-base-npm-ci.log" >&2; exit 1; }
      fi
      rm -rf "$ART/visual"
      capture "$BASE_WT" "$ART/visual/base"
      capture "$ROOT" "$ART/visual/current"
      ( cd "$E2E_DIR" && node lib/cli.mjs visual --base "$ART/visual/base/screenshots" --current "$ART/visual/current/screenshots" --report-dir "$ART/visual/report" )
      ;;
  esac
}

main "$@"; exit $?
