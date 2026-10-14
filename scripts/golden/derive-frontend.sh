#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Regenerate (or check) the frontend golden outputs in tests/golden/derived/frontend/
# from the committed raw fixtures in tests/golden/raw/, by running the REAL frontend
# code under the Angular unit-test runner.
#
#   scripts/golden/derive-frontend.sh           rewrite every artifact (explicit regeneration)
#   scripts/golden/derive-frontend.sh --check   compare only; non-zero exit on any diff
#
# Normal `npm run test:headless` runs the same specs in COMPARE mode and fails on any
# diff, missing file or orphan file. Writing happens only with GOLDEN_UPDATE=1, which
# this script sets. All four time zones (UTC, America/New_York, Asia/Kolkata,
# Australia/Lord_Howe) are exercised in-process via process.env.TZ, so one run
# covers the whole matrix and the machine zone does not matter.
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT=tests/golden/derived/frontend
INCLUDE='src/app/testing/golden/**/*.golden.spec.ts'

if [[ "${1:-}" == "--check" ]]; then
  exec npx ng test --watch=false --include="$INCLUDE"
fi

# Remove every generated artifact (keeps hand-written COVERAGE.md) so deleted
# artifacts cannot linger as orphans.
if [[ -d "$OUT" ]]; then
  find "$OUT" -name '*.json' -type f -delete
  find "$OUT" -mindepth 1 -type d -empty -delete
fi

GOLDEN_UPDATE=1 npx ng test --watch=false --include="$INCLUDE"

echo "Wrote $(find "$OUT" -name '*.json' | wc -l | tr -d ' ') artifacts, $(du -sh "$OUT" | cut -f1) in $OUT"
