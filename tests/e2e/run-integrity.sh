#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Data-integrity suites against fresh stacks. See tests/e2e/README.md "Data-integrity suite".
#
#   run-integrity.sh                      pothole (integrity.spec.ts), then community-center
#                                         (integrity-series.spec.ts): two fresh stacks, one after
#                                         the other; exits non-zero if either fails
#   run-integrity.sh --example <ex>       one of them only (pothole or community-center)
#   --keep-stack    leave the stack and dev server up afterwards (development; needs --example)
#   --reuse-stack   use a stack left up by --keep-stack (development; needs --example)
#   --grep <re>     run a subset of the tests (development; needs --example)
#
# Needs psql on PATH (or E2E_PSQL); it connects to the example's Postgres port (15432 on the
# standard stack, 25432 with E2E_STACK=alt) as postgres.
# Lock handling and every other environment variable are those of run-equivalence.sh.
set -euo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v "${E2E_PSQL:-psql}" >/dev/null || { echo "psql not found (install a PostgreSQL client or set E2E_PSQL)" >&2; exit 2; }

EXAMPLE=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --example) EXAMPLE="${2:?--example needs pothole or community-center}"; shift ;;
    --keep-stack|--reuse-stack) ARGS+=("$1") ;;
    --grep) ARGS+=("$1" "${2:?--grep needs a pattern}"); shift ;;
    *) echo "unknown option $1 (see the header of $0)" >&2; exit 2 ;;
  esac
  shift
done

if [[ -n "$EXAMPLE" ]]; then
  exec "$E2E_DIR/run-equivalence.sh" "$EXAMPLE" --integrity ${ARGS[@]+"${ARGS[@]}"}
fi
if [[ ${#ARGS[@]} -gt 0 ]]; then
  echo "--keep-stack, --reuse-stack and --grep need --example (each example runs on its own stack)" >&2
  exit 2
fi
rc=0
for ex in pothole community-center; do
  "$E2E_DIR/run-equivalence.sh" "$ex" --integrity || rc=$?
done
exit $rc
