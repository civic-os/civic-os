# Copyright (C) 2023-2025 Civic OS, L3C
# AGPL-3.0-or-later

# ======================================
# Stage 1: Build Angular Application
# ======================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies with npm cache mount for faster rebuilds
# Install only production dependencies first (skip test tooling like pa11y-ci, Puppeteer)
# Then explicitly install Angular CLI which is needed for build but listed as devDependency
RUN --mount=type=cache,target=/root/.npm \
    PUPPETEER_SKIP_DOWNLOAD='true' npm ci --omit=dev --legacy-peer-deps && \
    PUPPETEER_SKIP_DOWNLOAD='true' npm install --no-save --legacy-peer-deps @angular/cli @angular-devkit/build-angular

# Copy source code
COPY . .

# Build production bundle with Angular cache mount for faster rebuilds
# This creates optimized static files in dist/frontend/browser/
# Cache mounts persist between builds, significantly speeding up incremental builds
RUN --mount=type=cache,target=/app/.angular \
    --mount=type=cache,target=/root/.npm \
    npm run build

# ======================================
# Stage 2: Production Nginx Server
# ======================================
FROM nginx:alpine

# Install envsubst for environment variable substitution
RUN apk add --no-cache gettext

# Copy built Angular app from builder stage
COPY --from=builder /app/dist/frontend/browser /usr/share/nginx/html

# Copy nginx configuration
COPY docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy runtime config template
COPY src/assets/config.template.js /usr/share/nginx/html/assets/config.template.js

# Copy entrypoint script
COPY docker/frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Set default environment variables (can be overridden at runtime)
ENV POSTGREST_URL=http://localhost:3000/ \
    KEYCLOAK_URL=https://auth.civic-os.org \
    KEYCLOAK_REALM=civic-os-dev \
    KEYCLOAK_CLIENT_ID=myclient \
    MAP_TILE_URL=https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png \
    MAP_ATTRIBUTION="&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors" \
    MAP_DEFAULT_LAT=43.0125 \
    MAP_DEFAULT_LNG=-83.6875 \
    MAP_DEFAULT_ZOOM=13

# Expose port 80
EXPOSE 80

# Use custom entrypoint to generate config.js from ENV vars
ENTRYPOINT ["/docker-entrypoint.sh"]

# Start nginx in foreground
CMD ["nginx", "-g", "daemon off;"]
