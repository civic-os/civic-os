#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
#
# Sync the MCP server version with the root package.json version.
# Usage: ./tools/mcp-server/scripts/sync-version.sh
#
# Run from the repo root before creating a release tag.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ROOT_PKG="$REPO_ROOT/package.json"
MCP_PKG="$REPO_ROOT/tools/mcp-server/package.json"

ROOT_VERSION=$(jq -r .version "$ROOT_PKG")
MCP_VERSION=$(jq -r .version "$MCP_PKG")

if [[ "$ROOT_VERSION" == "$MCP_VERSION" ]]; then
  echo "Versions already in sync: $ROOT_VERSION"
  exit 0
fi

echo "Syncing MCP server version: $MCP_VERSION → $ROOT_VERSION"

# Use jq to update the version in-place
jq --arg v "$ROOT_VERSION" '.version = $v' "$MCP_PKG" > "${MCP_PKG}.tmp"
mv "${MCP_PKG}.tmp" "$MCP_PKG"

echo "Done. MCP server version is now $ROOT_VERSION"
