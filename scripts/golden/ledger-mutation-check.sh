#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Proves the divergence ledger's attribution is tight (opt-in gate for any
# change to scripts/golden/ledger*.mjs, to the golden specs/tests, or to the
# behavior the ledger models).
#
# For each source mutation in scripts/golden/ledger-mutations.mjs, in a
# scratch copy of the repository (node_modules symlinked; the checkout is not
# touched):
#   1. apply the mutation,
#   2. re-derive the goldens of the mutated side: MCP mutations re-derive the
#      MCP goldens; frontend mutations re-derive the frontend goldens (Angular
#      unit-test runner) and then the MCP goldens, which take their inputs
#      from the frontend artifacts,
#   3. require that at least one golden of the mutated side changed (the
#      mutation is covered by a golden),
#   4. run scripts/golden/ledger.mjs and require exit 2 (unattributed).
# Control runs without a mutation must re-derive identical goldens and leave
# `ledger --check` at exit 0.
#
#   scripts/golden/ledger-mutation-check.sh            all mutations (about 6 minutes)
#   scripts/golden/ledger-mutation-check.sh M3 FE-1    selected ids (prefix match)
#
# Needs node_modules in the repo root and in tools/mcp-server (npm ci in both).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
for nm in "$REPO/node_modules" "$REPO/tools/mcp-server/node_modules"; do
  [[ -d "$nm" ]] || { echo "$nm missing: run npm ci there first" >&2; exit 1; }
done
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ledger-mutation.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
COPY="$WORK/repo"
FE_GLOB='src/app/testing/golden/**/*.golden.spec.ts'

rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .angular --exclude coverage "$REPO/" "$COPY/"
ln -s "$REPO/node_modules" "$COPY/node_modules"
ln -s "$REPO/tools/mcp-server/node_modules" "$COPY/tools/mcp-server/node_modules"
mkdir -p "$WORK/clean/tools/mcp-server" "$WORK/clean/src"
cp -R "$COPY/tools/mcp-server/src" "$WORK/clean/tools/mcp-server/src"
cp -R "$COPY/src/app" "$WORK/clean/src/app"

derive_mcp() { (cd "$COPY/tools/mcp-server" && GOLDEN_UPDATE=1 npx vitest run src/__tests__/golden/ > "$WORK/vitest.log" 2>&1); }
derive_fe() { (cd "$COPY" && GOLDEN_UPDATE=1 npx ng test --watch=false --include="$FE_GLOB" > "$WORK/ng.log" 2>&1); }
restore() {
  rm -rf "$COPY/tools/mcp-server/src" && cp -R "$WORK/clean/tools/mcp-server/src" "$COPY/tools/mcp-server/src"
  rm -rf "$COPY/src/app" && cp -R "$WORK/clean/src/app" "$COPY/src/app"
  rm -rf "$COPY/tests/golden/derived/mcp" && cp -R "$WORK/base-mcp" "$COPY/tests/golden/derived/mcp"
  rm -rf "$COPY/tests/golden/derived/frontend" && cp -R "$WORK/base-fe" "$COPY/tests/golden/derived/frontend"
}

ids=$(node "$REPO/scripts/golden/ledger-mutations.mjs" list | cut -f1)
if [[ $# -gt 0 ]]; then
  sel=""
  for want in "$@"; do sel="$sel $(printf '%s\n' $ids | grep "^$want" || true)"; done
  ids="$sel"
fi
needs_fe=0
for id in $ids; do
  side=$(node "$REPO/scripts/golden/ledger-mutations.mjs" list | awk -F'\t' -v id="$id" '$1 == id { print $2 }')
  [[ "$side" == frontend ]] && needs_fe=1
done

# Controls: unmutated sources reproduce the committed goldens and ledger.
if [[ $needs_fe -eq 1 ]]; then
  derive_fe || { echo "control: frontend derive failed"; tail -30 "$WORK/ng.log"; exit 1; }
  if ! diff -rq "$REPO/tests/golden/derived/frontend" "$COPY/tests/golden/derived/frontend" > /dev/null; then
    echo "control: re-derived frontend goldens differ from the checkout"; diff -rq "$REPO/tests/golden/derived/frontend" "$COPY/tests/golden/derived/frontend" | head; exit 1
  fi
fi
derive_mcp || { echo "control: MCP derive failed"; tail -20 "$WORK/vitest.log"; exit 1; }
if ! diff -rq "$REPO/tests/golden/derived/mcp" "$COPY/tests/golden/derived/mcp" > /dev/null; then
  echo "control: re-derived MCP goldens differ from the checkout (derive and commit them first)"; exit 1
fi
node "$COPY/scripts/golden/ledger.mjs" --check > "$WORK/control.out" 2>&1
control=$?
if [[ $control -ne 0 ]]; then echo "control: ledger --check exit $control"; cat "$WORK/control.out"; exit 1; fi
cp -R "$COPY/tests/golden/derived/mcp" "$WORK/base-mcp"
cp -R "$COPY/tests/golden/derived/frontend" "$WORK/base-fe"

printf '%-36s %-9s %-8s %-6s %s\n' MUTATION SIDE GOLDENS LEDGER RESULT
fail=0
for id in $ids; do
  side=$(node "$REPO/scripts/golden/ledger-mutations.mjs" list | awk -F'\t' -v id="$id" '$1 == id { print $2 }')
  restore
  if ! node "$REPO/scripts/golden/ledger-mutations.mjs" apply "$COPY" "$id" 2> "$WORK/apply.err"; then
    printf '%-36s %-9s %-8s %-6s %s\n' "$id" "$side" - - "FAIL (cannot apply: $(cat "$WORK/apply.err"))"; fail=1; continue
  fi
  if [[ "$side" == frontend ]]; then
    derive_fe
    changed=$(diff -rq "$WORK/base-fe" "$COPY/tests/golden/derived/frontend" | wc -l | tr -d ' ')
  else
    changed=0
  fi
  derive_mcp
  [[ "$side" == mcp ]] && changed=$(diff -rq "$WORK/base-mcp" "$COPY/tests/golden/derived/mcp" | wc -l | tr -d ' ')
  node "$COPY/scripts/golden/ledger.mjs" > "$WORK/$id.out" 2>&1
  code=$?
  result=ok
  if [[ "$changed" == "0" ]]; then result="FAIL (no $side golden changed: mutation not covered)"; fail=1
  elif [[ $code -ne 2 ]]; then result="FAIL (ledger exit $code, expected 2)"; fail=1; fi
  # Which comparison areas flagged it (e.g. "mcp-model: 46"), for the record.
  areas=$(grep -E '^  [a-z-]+: [0-9]+$' "$WORK/$id.out" | sed 's/^  //' | paste -sd ',' - | sed 's/,/, /g')
  printf '%-36s %-9s %-8s %-6s %s\n' "$id" "$side" "$changed" "$code" "$result${areas:+ ($areas)}"
  if [[ "$result" != ok ]]; then head -8 "$WORK/$id.out" | sed 's/^/    /'; fi
done

if [[ $fail -ne 0 ]]; then echo "ledger mutation check FAILED"; exit 1; fi
echo "ledger mutation check passed"
