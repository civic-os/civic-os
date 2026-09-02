# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later

# Official PostgREST images are built FROM scratch with only the static binary.
# To extend them, we copy the binary into a fuller base image per official docs:
# https://github.com/PostgREST/postgrest/tree/main/nix/tools/docker

FROM ubuntu:24.04

# Copy PostgREST binary from official image
COPY --from=postgrest/postgrest:v16.2 /bin/postgrest /bin/postgrest

# Install dependencies for JWKS fetching
# Using BuildKit cache mounts for faster rebuilds (only downloads missing packages)
# Build with: DOCKER_BUILDKIT=1 docker build ...
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        jq \
        bash \
        ca-certificates \
        libpq5 \
        libgmp10

# Create directory for JWKS file with proper ownership
# Note: Ubuntu 24.04 already has UID 1000 (ubuntu user), so we use it directly
RUN mkdir -p /etc/postgrest && \
    chown -R 1000:1000 /etc/postgrest

# Copy scripts (placed after expensive operations for better layer caching)
COPY docker/postgrest/fetch-keycloak-jwk.sh /usr/local/bin/fetch-keycloak-jwk.sh
COPY docker/postgrest/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Set permissions on scripts (combined into single layer)
RUN chmod +x /usr/local/bin/fetch-keycloak-jwk.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch to non-root user for runtime security
USER 1000

# Set custom entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
