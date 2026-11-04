#!/bin/bash
# Civic OS Production Migration Script
#
# Run database migrations against a production database using the versioned
# migration container.
#
# Usage:
#   ./scripts/migrate-production.sh [--env-file <path>] [version] [database_url] [command]
#
# --env-file <path> is forwarded to `docker run`. After a successful deploy the
# migrations container seeds metadata.instance_config from the Tier 2 variables
# in its environment (APP_TITLE, DEFAULT_THEME, DEFAULT_LOCALE,
# SUPPORTED_LOCALES, SMS_CONFIGURED, MATOMO_ENABLED, MAP_DEFAULT_LAT,
# MAP_DEFAULT_LNG, MAP_DEFAULT_ZOOM, STRIPE_PUBLISHABLE_KEY). Without it nothing
# is seeded and the instance runs on its defaults.
#
# Examples:
#   # Deploy and seed instance config from a .env file
#   ./scripts/migrate-production.sh --env-file .env.prod latest $DATABASE_URL
#
#   # Deploy latest migrations
#   ./scripts/migrate-production.sh latest $DATABASE_URL
#
#   # Deploy specific version
#   ./scripts/migrate-production.sh v0.4.0 postgres://user:pass@host:5432/civic_os
#
#   # Revert to specific migration
#   ./scripts/migrate-production.sh v0.4.0 $DATABASE_URL revert --to @HEAD^
#
#   # Show migration status
#   ./scripts/migrate-production.sh latest $DATABASE_URL status

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Pull out --env-file (anywhere on the command line) before positional parsing
ENV_FILE_ARGS=()
REMAINING_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      if [ -z "${2:-}" ]; then
        echo -e "${RED}Error: --env-file requires a path${NC}"
        exit 1
      fi
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#--env-file=}"
      shift
      ;;
    *)
      REMAINING_ARGS+=("$1")
      shift
      ;;
  esac
done
set -- ${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}

if [ -n "${ENV_FILE:-}" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Error: env file not found: $ENV_FILE${NC}"
    exit 1
  fi
  ENV_FILE_ARGS=(--env-file "$ENV_FILE")
fi

# Parse arguments
VERSION=${1:-latest}
DATABASE_URL=${2:-$PGRST_DB_URI}
COMMAND=${3:-deploy}
shift 3 2>/dev/null || true
EXTRA_ARGS="$@"

# Validate inputs
if [ -z "$DATABASE_URL" ]; then
  echo -e "${RED}Error: Database URL required${NC}"
  echo ""
  echo "Usage: $0 [version] [database_url] [command] [extra_args...]"
  echo ""
  echo "Examples:"
  echo "  $0 v0.4.0 postgres://user:pass@host:5432/civic_os"
  echo "  $0 latest \$PGRST_DB_URI revert --to @HEAD^"
  echo "  $0 v0.4.0 \$DATABASE_URL status"
  echo ""
  echo "Commands:"
  echo "  deploy  - Apply migrations (default)"
  echo "  revert  - Rollback migrations"
  echo "  status  - Show migration status"
  echo "  verify  - Verify database schema"
  echo ""
  exit 1
fi

# Mask password in output
SAFE_URL=$(echo "$DATABASE_URL" | sed -E 's/:([^:@]+)@/:****@/')

echo -e "${GREEN}===================================="
echo "Civic OS Migration Runner"
echo -e "====================================${NC}"
echo "Version: $VERSION"
echo "Command: $COMMAND $EXTRA_ARGS"
echo "Target:  $SAFE_URL"
if [ -n "${ENV_FILE:-}" ]; then
  echo "Env file: $ENV_FILE (Tier 2 instance config is seeded after deploy)"
elif [ "$COMMAND" = "deploy" ]; then
  echo "Env file: none (instance config will not be seeded; pass --env-file to seed it)"
fi
echo ""

# Confirm for production
if [ "$COMMAND" = "revert" ]; then
  echo -e "${YELLOW}WARNING: You are about to REVERT database migrations!${NC}"
  echo -e "${YELLOW}This operation may result in data loss.${NC}"
  echo ""
  read -p "Are you sure you want to continue? (yes/no): " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted."
    exit 1
  fi
  echo ""
fi

# Pull latest image
echo "Pulling migration container image..."
docker pull ghcr.io/civic-os/migrations:${VERSION}
echo ""

# Run migration
echo -e "${GREEN}Running migration...${NC}"
echo ""

docker run --rm \
  --network host \
  ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} \
  -e PGRST_DB_URI="$DATABASE_URL" \
  ghcr.io/civic-os/migrations:${VERSION} \
  $COMMAND $EXTRA_ARGS

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo -e "${GREEN}===================================="
  echo "Migration completed successfully!"
  echo -e "====================================${NC}"
else
  echo ""
  echo -e "${RED}===================================="
  echo "Migration failed with exit code ${EXIT_CODE}"
  echo -e "====================================${NC}"
  exit $EXIT_CODE
fi
