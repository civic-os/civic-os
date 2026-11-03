# Civic OS Database Migration Container
#
# This container runs Sqitch migrations against a PostgreSQL database.
# It is versioned alongside the frontend and postgrest containers to ensure
# schema compatibility with the application.
#
# Usage:
#   docker run --rm \
#     -e PGRST_DB_URI="postgres://user:pass@host:5432/dbname" \
#     ghcr.io/civic-os/migrations:v0.4.0
#
# Environment Variables:
#   PGRST_DB_URI (required) - PostgreSQL connection string
#   SQITCH_VERIFY (optional) - Set to "false" to skip verification (default: "true")
#   APP_TITLE, DEFAULT_THEME, DEFAULT_LOCALE, SUPPORTED_LOCALES, SMS_CONFIGURED,
#   MATOMO_ENABLED, MAP_DEFAULT_LAT, MAP_DEFAULT_LNG, MAP_DEFAULT_ZOOM,
#   STRIPE_PUBLISHABLE_KEY (optional) - seeded once into metadata.instance_config
#   after a successful deploy; see seed-instance-config.sh

FROM sqitch/sqitch:latest

# Copy Sqitch configuration and migrations
COPY sqitch.conf /migrations/sqitch.conf
COPY sqitch.plan /migrations/sqitch.plan
COPY postgres/migrations/ /migrations/postgres/migrations/

WORKDIR /migrations

# Entrypoint script to run migrations
COPY --chmod=755 docker/migrations/docker-entrypoint.sh /entrypoint.sh

# Seeds Tier 2 instance config from ENV after a successful deploy
COPY --chmod=755 docker/migrations/seed-instance-config.sh /seed-instance-config.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["deploy"]
