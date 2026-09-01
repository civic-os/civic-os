# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
#
# Bun-based container for the Civic OS MCP server.
# Bun runs TypeScript natively — no tsc build step needed.
# Single-stage build: install deps, copy source, run.

FROM oven/bun:1-alpine

# Non-root user for security
RUN addgroup -g 1001 civicos && \
    adduser -u 1001 -G civicos -s /bin/sh -D civicos

WORKDIR /app

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

# Start the MCP server directly from TypeScript source
ENTRYPOINT ["bun", "run", "src/index.ts"]
