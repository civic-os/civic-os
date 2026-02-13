#!/bin/bash
# Copyright (C) 2023-2025 Civic OS, L3C
# AGPL-3.0-or-later

# Civic OS VPS Deployment Script
# Zero-downtime deployment using docker-rollout
#
# Usage:
#   ./deploy.sh              # Deploy without payments
#   ./deploy.sh --payments   # Deploy with payment-worker
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - docker-rollout plugin installed (~/.docker/cli-plugins/docker-rollout)
#   - .env file configured
#   - Caddyfile in same directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check for required files
if [ ! -f ".env" ]; then
    log_error ".env file not found. Copy .env.example to .env and configure it."
    exit 1
fi

if [ ! -f "Caddyfile" ]; then
    log_error "Caddyfile not found."
    exit 1
fi

if [ ! -f "docker-compose.vps.yml" ]; then
    log_error "docker-compose.vps.yml not found."
    exit 1
fi

# Check for docker-rollout (Docker CLI plugin)
if ! docker rollout 2>&1 | grep -q "Usage"; then
    log_error "docker-rollout plugin not installed. Install with:"
    log_error "  mkdir -p ~/.docker/cli-plugins"
    log_error "  curl -sL https://raw.githubusercontent.com/wowu/docker-rollout/main/docker-rollout -o ~/.docker/cli-plugins/docker-rollout"
    log_error "  chmod +x ~/.docker/cli-plugins/docker-rollout"
    exit 1
fi

# Parse arguments
PROFILE_ARGS=""
if [ "$1" = "--payments" ]; then
    PROFILE_ARGS="--profile payments"
    log_info "Deploying WITH payment-worker"
else
    log_info "Deploying WITHOUT payment-worker (use --payments to enable)"
fi

COMPOSE_CMD="docker compose -f docker-compose.vps.yml $PROFILE_ARGS"

# Step 1: Pull latest images
log_info "Pulling latest images..."
$COMPOSE_CMD pull

# Step 2: Run database migrations
log_info "Running database migrations..."
$COMPOSE_CMD run --rm migrations

# Step 3: Start/update services
# Check if this is initial deployment (no containers running)
RUNNING_CONTAINERS=$($COMPOSE_CMD ps -q 2>/dev/null | wc -l)

if [ "$RUNNING_CONTAINERS" -eq 0 ]; then
    # Initial deployment - just start everything
    log_info "Initial deployment detected - starting all services..."
    $COMPOSE_CMD up -d
else
    # Subsequent deployment - use zero-downtime rollout
    log_info "Updating existing deployment with zero-downtime rollout..."

    # Ensure Caddy and Swagger UI are up to date (non-rollout services)
    $COMPOSE_CMD up -d caddy swagger-ui

    # Zero-downtime rollout of stateless services
    log_info "Rolling out PostgREST..."
    docker rollout -f docker-compose.vps.yml $PROFILE_ARGS postgrest

    log_info "Rolling out Frontend..."
    docker rollout -f docker-compose.vps.yml $PROFILE_ARGS frontend

    log_info "Rolling out Consolidated Worker..."
    docker rollout -f docker-compose.vps.yml $PROFILE_ARGS consolidated-worker

    # Payment worker (if enabled)
    if [ "$1" = "--payments" ]; then
        log_info "Rolling out Payment Worker..."
        docker rollout -f docker-compose.vps.yml $PROFILE_ARGS payment-worker
    fi
fi

# Step 4: Verify health
log_info "Verifying service health..."
sleep 5
$COMPOSE_CMD ps

# Check if any services are unhealthy
UNHEALTHY=$($COMPOSE_CMD ps --format json | grep -c '"Health":"unhealthy"' || true)
if [ "$UNHEALTHY" -gt 0 ]; then
    log_warn "Some services are unhealthy. Check logs with: docker compose -f docker-compose.vps.yml logs"
else
    log_info "All services healthy!"
fi

log_info "Deployment complete!"
echo ""
echo "Your application is available at:"
echo "  Frontend: https://\${APP_DOMAIN}"
echo "  API:      https://api.\${APP_DOMAIN}"
echo "  Docs:     https://docs.\${APP_DOMAIN}"
