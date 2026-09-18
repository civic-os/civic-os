#!/usr/bin/env bash
# Build the civic-os Keycloak login theme as a deployable JAR.
#
# Usage:
#   ./build-theme-jar.sh              # outputs civic-os-theme.jar
#   ./build-theme-jar.sh my-output    # outputs my-output.jar
#
# Deploy to bare-metal Keycloak:
#   cp civic-os-theme.jar /opt/keycloak/providers/
#   sudo -u keycloak /opt/keycloak/bin/kc.sh build
#   sudo systemctl restart keycloak
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2023-2026 Civic OS, L3C

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
THEME_DIR="$SCRIPT_DIR/themes/civic-os"
OUTPUT_NAME="${1:-civic-os-theme}"
OUTPUT_JAR="$SCRIPT_DIR/${OUTPUT_NAME}.jar"

# JAR expects theme files under theme/<name>/
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

# Copy manifest
mkdir -p "$STAGING/META-INF"
cp "$THEME_DIR/META-INF/keycloak-themes.json" "$STAGING/META-INF/"

# Copy theme files
mkdir -p "$STAGING/theme/civic-os"
cp -r "$THEME_DIR/login" "$STAGING/theme/civic-os/"

# Build JAR (just a ZIP with .jar extension)
cd "$STAGING"
zip -r "$OUTPUT_JAR" META-INF theme -q

echo "Built: $OUTPUT_JAR"
echo "Deploy: cp $OUTPUT_JAR /opt/keycloak/providers/ && kc.sh build"
