#!/bin/bash
set -e

# This script runs during PostgreSQL initialization (docker-entrypoint-initdb.d)
# It creates the authenticator role and runs Sqitch migrations for the core schema.
#
# Execution order:
# 1. This script (00_*) - Creates authenticator + runs core migrations
# 2. Example-specific scripts (01_*, 02_*, etc.) - Create pothole tables
#
# NOTE: This uses the POSTGRES_PASSWORD for the authenticator role in development.
#       In production, the authenticator role should be created manually with a
#       secure password BEFORE running migrations.

echo "======================================"
echo "Civic OS Development Initialization"
echo "======================================"

# Create the authenticator role
echo "Creating authenticator role..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '$POSTGRES_PASSWORD';
EOSQL

echo "Authenticator role created successfully"
echo ""

# Run Sqitch migrations
echo "======================================"
echo "Running Civic OS Core Migrations"
echo "======================================"

cd /civic-os-migrations

# Sqitch needs the target database URI
# During init, postgres only accepts Unix socket connections
export SQITCH_TARGET="db:pg:$POSTGRES_DB"

# Initialize Sqitch registry (creates sqitch schema and tables)
# This prevents ERROR messages on first run
sqitch init "$SQITCH_TARGET" 2>/dev/null || true

# Run migrations with verification (using Unix socket)
sqitch deploy --verify "$SQITCH_TARGET"

echo ""
echo "======================================"
echo "Core migrations completed successfully!"
echo "======================================"
echo ""
echo "Now running example-specific initialization scripts..."
echo ""
