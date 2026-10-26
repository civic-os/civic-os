#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Regenerate (or check) the MCP server golden outputs in tests/golden/derived/mcp/
# from the committed raw fixtures in tests/golden/raw/, by running the REAL MCP
# server code (SchemaCache, select builder, name resolver, tools) under vitest
# with a fixture-backed fetch stub.
#
#   scripts/golden/derive-mcp.sh           rewrite every artifact (explicit regeneration)
#   scripts/golden/derive-mcp.sh --check   compare only; non-zero exit on any diff
#
# Where a frontend artifact of the same name exists, the MCP golden tests read
# their INPUTS from it (condition records, error payloads, query inputs), so
# regenerate the frontend goldens first (scripts/golden/derive-frontend.sh) when
# both need refreshing. The divergence ledger is derived from both trees:
# node scripts/golden/ledger.mjs (see docs/notes/SDK_DIVERGENCE_LEDGER.md).
#
# A normal `npm test` in tools/mcp-server runs the same tests in COMPARE mode and
# fails on any diff, missing file or orphan file. Writing happens only with
# GOLDEN_UPDATE=1, which this script sets.
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT=tests/golden/derived/mcp
TESTS=src/__tests__/golden/

if [[ ! -d tools/mcp-server/node_modules ]]; then
  echo "tools/mcp-server/node_modules missing: run (cd tools/mcp-server && npm ci) first" >&2
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  cd tools/mcp-server
  exec npx vitest run "$TESTS"
fi

# Remove every generated artifact (keeps hand-written COVERAGE.md) so deleted
# artifacts cannot linger as orphans.
if [[ -d "$OUT" ]]; then
  find "$OUT" -name '*.json' -type f -delete
  find "$OUT" -mindepth 1 -type d -empty -delete
fi

(cd tools/mcp-server && GOLDEN_UPDATE=1 npx vitest run "$TESTS")

echo "Wrote $(find "$OUT" -name '*.json' | wc -l | tr -d ' ') artifacts, $(du -sh "$OUT" | cut -f1) in $OUT"
