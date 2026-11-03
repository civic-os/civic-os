#!/bin/sh
# Civic OS Database Migration Entrypoint
#
# This script runs Sqitch commands against a PostgreSQL database.
# It converts PGRST_DB_URI format to Sqitch target format.

set -e

# Required environment variables
if [ -z "$PGRST_DB_URI" ]; then
  echo "Error: PGRST_DB_URI environment variable is required"
  echo ""
  echo "Example:"
  echo "  docker run --rm \\"
  echo "    -e PGRST_DB_URI='postgres://user:pass@host:5432/dbname' \\"
  echo "    ghcr.io/civic-os/migrations:latest"
  exit 1
fi

# Parse command and flags
SQITCH_COMMAND=${1:-deploy}
SQITCH_VERIFY=${SQITCH_VERIFY:-true}

# Build Sqitch flags
SQITCH_FLAGS=""
if [ "$SQITCH_VERIFY" = "true" ] && [ "$SQITCH_COMMAND" = "deploy" ]; then
  SQITCH_FLAGS="--verify"
fi

# Additional arguments passed to container
shift || true
SQITCH_ARGS="$@"

# Convert PGRST_DB_URI to Sqitch target format
# e.g., postgres://user:pass@host:5432/dbname -> db:pg://user:pass@host:5432/dbname
if echo "$PGRST_DB_URI" | grep -q "^postgres://"; then
  SQITCH_TARGET="db:pg://${PGRST_DB_URI#postgres://}"
elif echo "$PGRST_DB_URI" | grep -q "^postgresql://"; then
  SQITCH_TARGET="db:pg://${PGRST_DB_URI#postgresql://}"
else
  # Assume it's already in correct format
  SQITCH_TARGET="$PGRST_DB_URI"
fi

echo "===================================="
echo "Civic OS Database Migration"
echo "===================================="
echo "Command: sqitch ${SQITCH_COMMAND} ${SQITCH_FLAGS} ${SQITCH_ARGS}"
echo "Target: ${SQITCH_TARGET%%:*@*}:****@****"  # Mask password in output
echo ""

# Initialize Sqitch registry if this is a fresh database
# This prevents ERROR messages about missing "changes" table
sqitch init "${SQITCH_TARGET}" 2>/dev/null || true

# Run Sqitch. Capture the exit code explicitly: under `set -e` a bare failing
# command would exit before the failure banner below could print.
EXIT_CODE=0
sqitch ${SQITCH_COMMAND} ${SQITCH_FLAGS} ${SQITCH_ARGS} "${SQITCH_TARGET}" || EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "===================================="
  echo "Migration completed successfully!"
  echo "===================================="

  # Seed Tier 2 instance config from ENV (best-effort, never fails the run)
  if [ "$SQITCH_COMMAND" = "deploy" ]; then
    /seed-instance-config.sh
  fi
else
  echo ""
  echo "===================================="
  echo "Migration failed with exit code ${EXIT_CODE}"
  echo "===================================="
  exit $EXIT_CODE
fi
