#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Proves the divergence ledger's attribution is tight (opt-in gate for any
# change to scripts/golden/ledger*.mjs or to the MCP golden tests).
#
# For each MCP source mutation in scripts/golden/ledger-mutations.mjs, in a
# scratch copy of the repository (node_modules symlinked, nothing in the
# checkout is touched):
#   1. apply the mutation to the MCP source,
#   2. re-derive the MCP goldens (GOLDEN_UPDATE=1 vitest),
#   3. require that at least one MCP golden changed (the mutation is covered),
#   4. run scripts/golden/ledger.mjs and require exit 2 (unattributed).
# A control run without a mutation must re-derive identical goldens and give
# exit 0 with a ledger identical to the committed one.
#
#   scripts/golden/ledger-mutation-check.sh            all mutations
#   scripts/golden/ledger-mutation-check.sh M3 O2      selected ids (prefix match)
#
# Needs tools/mcp-server/node_modules (npm ci there). Takes about a minute.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ ! -d "$REPO/tools/mcp-server/node_modules" ]]; then
  echo "tools/mcp-server/node_modules missing: run (cd tools/mcp-server && npm ci) first" >&2
  exit 1
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ledger-mutation.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
COPY="$WORK/repo"
BASE="$WORK/base-mcp"

rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .angular --exclude coverage "$REPO/" "$COPY/"
ln -s "$REPO/tools/mcp-server/node_modules" "$COPY/tools/mcp-server/node_modules"
cp -R "$COPY/tools/mcp-server/src" "$WORK/clean-src"

derive() {
  (cd "$COPY/tools/mcp-server" && GOLDEN_UPDATE=1 npx vitest run src/__tests__/golden/ > "$WORK/vitest.log" 2>&1)
}

# Control: unmutated source must reproduce the committed goldens and ledger.
derive || { echo "control derive failed (see vitest log below)"; tail -20 "$WORK/vitest.log"; exit 1; }
if ! diff -rq "$REPO/tests/golden/derived/mcp" "$COPY/tests/golden/derived/mcp" > /dev/null; then
  echo "control: re-derived MCP goldens differ from the checkout (derive and commit them first)"; exit 1
fi
node "$COPY/scripts/golden/ledger.mjs" --check > "$WORK/control.out" 2>&1
control=$?
if [[ $control -ne 0 ]]; then echo "control: ledger --check exit $control"; cat "$WORK/control.out"; exit 1; fi
cp -R "$COPY/tests/golden/derived/mcp" "$BASE"

ids=$(node "$REPO/scripts/golden/ledger-mutations.mjs" list | cut -f1)
if [[ $# -gt 0 ]]; then
  sel=""
  for want in "$@"; do sel="$sel $(printf '%s\n' $ids | grep "^$want" || true)"; done
  ids="$sel"
fi

printf '%-40s %-8s %-6s %s\n' MUTATION GOLDENS LEDGER RESULT
fail=0
for id in $ids; do
  rm -rf "$COPY/tools/mcp-server/src" && cp -R "$WORK/clean-src" "$COPY/tools/mcp-server/src"
  rm -rf "$COPY/tests/golden/derived/mcp" && cp -R "$BASE" "$COPY/tests/golden/derived/mcp"
  if ! node "$REPO/scripts/golden/ledger-mutations.mjs" apply "$COPY" "$id" 2> "$WORK/apply.err"; then
    printf '%-40s %-8s %-6s %s\n' "$id" - - "FAIL (cannot apply: $(cat "$WORK/apply.err"))"; fail=1; continue
  fi
  derive
  changed=$(diff -rq "$BASE" "$COPY/tests/golden/derived/mcp" | wc -l | tr -d ' ')
  node "$COPY/scripts/golden/ledger.mjs" > "$WORK/$id.out" 2>&1
  code=$?
  result=ok
  if [[ "$changed" == "0" ]]; then result="FAIL (no golden changed: mutation not covered)"; fail=1
  elif [[ $code -ne 2 ]]; then result="FAIL (ledger exit $code, expected 2)"; fail=1; fi
  # Which comparison areas flagged it (e.g. "mcp-model: 46"), for the record.
  areas=$(grep -E '^  [a-z-]+: [0-9]+$' "$WORK/$id.out" | sed 's/^  //' | paste -sd ',' - | sed 's/,/, /g')
  printf '%-40s %-8s %-6s %s\n' "$id" "$changed" "$code" "$result${areas:+ ($areas)}"
  if [[ "$result" != ok ]]; then head -8 "$WORK/$id.out" | sed 's/^/    /'; fi
done

if [[ $fail -ne 0 ]]; then echo "ledger mutation check FAILED"; exit 1; fi
echo "ledger mutation check passed"
