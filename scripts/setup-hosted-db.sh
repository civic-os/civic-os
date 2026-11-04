#!/bin/bash
set -e

# =====================================================
# Civic OS - Application-Specific Database Setup Script
# =====================================================
#
# This script consolidates example-specific scripts into a single deployment
# package for hosted PostgreSQL databases.
#
# PREREQUISITES:
#   - Civic OS core schema must be deployed first via Sqitch migrations
#   - PostgreSQL with PostGIS extension
#   - Authenticator role must be created
#
# To deploy core Civic OS schema:
#   docker run --rm -e PGRST_DB_URI="your-connection-string" \
#     ghcr.io/civic-os/migrations:latest deploy
#
# After core deployment, run this script to set up application-specific tables.
#
# USAGE:
#   Run this script from any example folder (example/, broader-impacts/, etc.)
#
#   Generate consolidated SQL file:
#     cd example/
#     ../scripts/setup-hosted-db.sh --output pothole.sql
#
#   Execute directly on hosted database:
#     cd example/
#     DB_HOST=db.ondigitalocean.com \
#     DB_NAME=civic_os_db \
#     DB_USER=doadmin \
#     DB_PASSWORD=yourpassword \
#     ../scripts/setup-hosted-db.sh
#
# ENVIRONMENT VARIABLES:
#   DB_HOST    - Database host (e.g., db-postgresql-nyc3-12345.ondigitalocean.com)
#   DB_PORT    - Database port (default: 5432)
#   DB_NAME    - Database name (default: defaultdb for DigitalOcean)
#   DB_USER    - Database user (e.g., doadmin)
#   DB_PASSWORD - Database password
#   SSLMODE    - SSL mode (default: require)
#
# OPTIONS:
#   --output FILE - Generate consolidated SQL file instead of executing
#   --help        - Show this help message
#
# NOTES:
#   - Run from an example folder (must have init-scripts/ subdirectory)
#   - Requires psql client for direct execution
#   - Uses .env.hosted file if present in current directory
#   - Skips *.deprecated and *.sh files automatically
#
# =====================================================

# Color output helpers
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1" >&2
}

# Show help
show_help() {
    head -n 45 "$0" | grep "^#" | sed 's/^# \?//'
    exit 0
}

# Parse arguments
OUTPUT_FILE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        --help)
            show_help
            ;;
        *)
            error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Load .env.hosted if present
if [ -f ".env.hosted" ]; then
    info "Loading configuration from .env.hosted"
    set -a
    source .env.hosted
    set +a
fi

# Validate we're in an example directory
if [ ! -d "init-scripts" ]; then
    error "This script must be run from an example folder (e.g., example/, broader-impacts/)"
    error "Current directory must contain an 'init-scripts/' subdirectory"
    exit 1
fi

# Get current example folder name
EXAMPLE_NAME="$(basename "$(pwd)")"
info "Detected example: $EXAMPLE_NAME"

# Set defaults
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-defaultdb}"
SSLMODE="${SSLMODE:-require}"

# Validate required variables for direct execution
if [ -z "$OUTPUT_FILE" ]; then
    if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ]; then
        error "Missing required environment variables for direct execution"
        echo ""
        echo "Required variables:"
        echo "  DB_HOST    - Database host"
        echo "  DB_USER    - Database user"
        echo "  DB_PASSWORD - Database password"
        echo ""
        echo "Optional variables:"
        echo "  DB_PORT    - Database port (default: 5432)"
        echo "  DB_NAME    - Database name (default: defaultdb)"
        echo "  SSLMODE    - SSL mode (default: require)"
        echo ""
        echo "Alternatively, use --output to generate a SQL file"
        exit 1
    fi

    # Check for psql
    if ! command -v psql &> /dev/null; then
        error "psql command not found - required for direct execution"
        echo "Install PostgreSQL client or use --output to generate SQL file"
        exit 1
    fi
fi


# Function to add section header
add_header() {
    local title="$1"
    echo ""
    echo "-- ============================================================================================================="
    echo "-- $title"
    echo "-- ============================================================================================================="
    echo ""
}

# Collect application-specific SQL files
info "Collecting application-specific SQL files..."

EXAMPLE_SCRIPTS=()
for script in init-scripts/*.sql; do
    if [ -f "$script" ]; then
        # Skip deprecated files
        if [[ ! "$script" =~ \.deprecated$ ]]; then
            EXAMPLE_SCRIPTS+=("$script")
        fi
    fi
done

info "Found ${#EXAMPLE_SCRIPTS[@]} example scripts for $EXAMPLE_NAME"

# Generate or execute SQL
if [ -n "$OUTPUT_FILE" ]; then
    # Generate consolidated SQL file
    info "Generating consolidated SQL file: $OUTPUT_FILE"

    {
        add_header "CIVIC OS APPLICATION: $(echo "$EXAMPLE_NAME" | tr '[:lower:]' '[:upper:]' | tr '-' ' ')"
        echo "-- Generated: $(date)"
        echo "-- Example: $EXAMPLE_NAME"
        echo "-- "
        echo "-- This file contains application-specific tables, permissions, and mock data for the $EXAMPLE_NAME example."
        echo "-- "
        echo "-- PREREQUISITES:"
        echo "--   1. Civic OS core schema must be deployed first via Sqitch migrations"
        echo "--   2. PostgreSQL with PostGIS extension"
        echo "--   3. Authenticator role must be created"
        echo "--"
        echo "-- To deploy core Civic OS schema:"
        echo "--   docker run --rm -e PGRST_DB_URI=\"your-connection-string\" \\"
        echo "--     ghcr.io/civic-os/migrations:latest deploy"
        echo "--"
        echo "-- After core deployment, run this SQL file to set up the $EXAMPLE_NAME application."
        echo "--"
        echo "-- To seed instance config (title, theme, locales, map defaults) from environment"
        echo "-- variables, deploy the core schema with the env file instead:"
        echo "--   ./scripts/migrate-production.sh --env-file .env.prod latest \"your-connection-string\""

        # Example scripts
        add_header "APPLICATION-SPECIFIC SCRIPTS"
        for script in "${EXAMPLE_SCRIPTS[@]}"; do
            echo ""
            echo "-- Source: $(basename "$script")"
            echo ""
            cat "$script"
        done

        add_header "SETUP COMPLETE"
        echo "-- Next steps:"
        echo "-- 1. Review this SQL file"
        echo "-- 2. Execute against your hosted database:"
        echo "--    psql 'postgresql://user:password@host:port/dbname?sslmode=require' -f $OUTPUT_FILE"
        echo ""

    } > "$OUTPUT_FILE"

    success "Consolidated SQL generated: $OUTPUT_FILE"
    info "Execute this file after deploying core Civic OS schema via Sqitch"
    info "To seed instance config from env vars: ./scripts/migrate-production.sh --env-file <file> latest <db-url>"

else
    # Execute directly
    info "Connecting to database: $DB_HOST:$DB_PORT/$DB_NAME"

    # Build connection string
    export PGPASSWORD="$DB_PASSWORD"
    PSQL_CMD="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME --set ON_ERROR_STOP=1 --set AUTOCOMMIT=off"

    if [ "$SSLMODE" != "disable" ]; then
        PSQL_CMD="$PSQL_CMD sslmode=$SSLMODE"
    fi

    # Start transaction
    info "Beginning transaction..."

    {
        echo "BEGIN;"

        # Application-specific scripts
        for script in "${EXAMPLE_SCRIPTS[@]}"; do
            info "Executing: $(basename "$script")"
            cat "$script"
        done

        echo "COMMIT;"

    } | $PSQL_CMD

    success "Application setup complete!"
    info "All application scripts executed successfully in a single transaction"
fi

# Cleanup
unset PGPASSWORD
