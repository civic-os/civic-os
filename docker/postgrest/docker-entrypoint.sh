#!/bin/bash
# Copyright (C) 2023-2025 Civic OS, L3C
# AGPL-3.0-or-later

set -e  # Exit on error

echo "======================================"
echo "PostgREST Container Starting"
echo "======================================"

# Set default values for PostgREST configuration
export PGRST_DB_SCHEMA="${PGRST_DB_SCHEMA:-public}"
export PGRST_DB_ANON_ROLE="${PGRST_DB_ANON_ROLE:-web_anon}"
export PGRST_DB_PRE_REQUEST="${PGRST_DB_PRE_REQUEST:-metadata.check_jwt}"
export PGRST_JWT_SECRET="${PGRST_JWT_SECRET:-@/etc/postgrest/jwt-secret.jwks}"
export PGRST_JWT_AUD="${PGRST_JWT_AUD:-account}"
export PGRST_LOG_LEVEL="${PGRST_LOG_LEVEL:-info}"

echo "Configuration:"
echo "  PGRST_DB_SCHEMA: $PGRST_DB_SCHEMA"
echo "  PGRST_DB_ANON_ROLE: $PGRST_DB_ANON_ROLE"
echo "  PGRST_DB_PRE_REQUEST: $PGRST_DB_PRE_REQUEST"
echo "  PGRST_JWT_AUD: $PGRST_JWT_AUD"
echo "  PGRST_LOG_LEVEL: $PGRST_LOG_LEVEL"
echo ""

# Fetch Keycloak JWKS
echo "Fetching Keycloak JWKS..."
/usr/local/bin/fetch-keycloak-jwk.sh /etc/postgrest/jwt-secret.jwks

echo ""
echo "======================================"
echo "Starting PostgREST..."
echo "======================================"

# Start PostgREST (exec replaces shell process, allows proper signal handling)
exec postgrest
