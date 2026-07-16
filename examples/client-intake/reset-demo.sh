#!/bin/bash
# ============================================================================
# RESET DEMO: Exemplary Community Services (ECS)
# ============================================================================
# Tears down and rebuilds the full demo environment from scratch.
#
# Stage 1: npm run generate client-intake  (clients, partners via mock data)
# Stage 2: ./seed-demo-data.sh             (consents, referrals, surveys)
#
# Usage:
#   ./reset-demo.sh                         # Local Docker (default)
#   ./reset-demo.sh "$DATABASE_URL"         # Remote database
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DB_URL="${1:-postgresql://postgres:securepassword123@localhost:15432/civic_os_db}"

echo "=== ECS Demo Reset ==="
echo ""

# Stage 1: Generate base entity data (clients, partners)
echo "── Stage 1: Generating mock data (clients, partners)..."
cd "$REPO_ROOT"
npm run generate client-intake
echo "  Done."

# Stage 2: Seed relationship data (consents, referrals, surveys)
echo ""
echo "── Stage 2: Seeding relationship data..."
"$SCRIPT_DIR/seed-demo-data.sh" "$DB_URL"

echo ""
echo "=== ECS Demo Reset Complete ==="
