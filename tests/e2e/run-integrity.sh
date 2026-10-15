#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Data-integrity suite (tests/e2e/integrity.spec.ts) against a fresh pothole stack.
# See tests/e2e/README.md "Data-integrity suite".
#
#   run-integrity.sh                 fresh stack (down -v, up), dev server, suite, teardown
#   run-integrity.sh --keep-stack    leave the stack and dev server up afterwards (development)
#   run-integrity.sh --reuse-stack   use a stack left up by --keep-stack (development)
#   run-integrity.sh --grep <re>     run a subset of the tests (development)
#
# Needs psql on PATH (or E2E_PSQL); it connects to localhost:15432 as postgres.
# Lock handling and every other environment variable are those of run-equivalence.sh.
set -euo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v "${E2E_PSQL:-psql}" >/dev/null || { echo "psql not found (install a PostgreSQL client or set E2E_PSQL)" >&2; exit 2; }
exec "$E2E_DIR/run-equivalence.sh" pothole --integrity "$@"
