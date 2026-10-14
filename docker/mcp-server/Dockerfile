# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
#
# Bun-based container for the Civic OS MCP server.
# Bun runs TypeScript natively — no tsc build step needed.
# Single-stage build: install deps, copy source, run.
#
# The server depends on @civic-os/core through "file:../../packages/core", so
# the image mirrors the repo layout (/app/tools/mcp-server and
# /app/packages/core). Bun resolves the core's "@civic-os/source" export
# condition (see ENTRYPOINT) and runs its TypeScript source directly, so the
# core needs no build step here either.

FROM oven/bun:1-alpine

# Non-root user for security
RUN addgroup -g 1001 civicos && \
    adduser -u 1001 -G civicos -s /bin/sh -D civicos

WORKDIR /app/tools/mcp-server

# @civic-os/core: manifest and TypeScript source, copied before the install so
# the file: dependency resolves (scripts/check-docker-workspaces.mjs checks this).
COPY packages/core/package.json /app/packages/core/
COPY packages/core/src/ /app/packages/core/src/

# Copy package files and install production dependencies only
# Bun can read package-lock.json from npm; bun.lock is preferred if present
COPY tools/mcp-server/package.json tools/mcp-server/package-lock.json* tools/mcp-server/bun.lock* ./
RUN bun install --production && \
    chown -R civicos:civicos /app

# Copy TypeScript source (Bun runs it directly)
COPY --chown=civicos:civicos tools/mcp-server/tsconfig.json ./
COPY --chown=civicos:civicos tools/mcp-server/src/ ./src/

USER civicos

# Default environment variables (overridden at runtime)
# Docker defaults to HTTP transport; CLI defaults to stdio
ENV POSTGREST_URL=http://postgrest:3000 \
    MCP_TRANSPORT=http \
    MCP_PORT=3001 \
    NODE_ENV=production

# HTTP Streamable transport port
EXPOSE 3001

# Start the MCP server directly from TypeScript source. The custom condition
# makes @civic-os/core resolve to packages/core/src instead of its dist build.
ENTRYPOINT ["bun", "--conditions=@civic-os/source", "run", "src/index.ts"]
