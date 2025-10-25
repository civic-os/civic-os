#!/bin/sh
# Copyright (C) 2023-2025 Civic OS, L3C
# AGPL-3.0-or-later

set -e

echo "======================================"
echo "Civic OS Frontend Container Starting"
echo "======================================"

echo "Configuration:"
echo "  POSTGREST_URL: $POSTGREST_URL"
echo "  KEYCLOAK_URL: $KEYCLOAK_URL"
echo "  KEYCLOAK_REALM: $KEYCLOAK_REALM"
echo "  KEYCLOAK_CLIENT_ID: $KEYCLOAK_CLIENT_ID"
echo "  MAP_DEFAULT_LAT: $MAP_DEFAULT_LAT"
echo "  MAP_DEFAULT_LNG: $MAP_DEFAULT_LNG"
echo "  MAP_DEFAULT_ZOOM: $MAP_DEFAULT_ZOOM"
echo "  S3_ENDPOINT: $S3_ENDPOINT"
echo "  S3_BUCKET: $S3_BUCKET"
echo ""

# Generate inline config script
echo "Injecting runtime configuration into index.html..."

# Create temporary file with config script
cat > /tmp/config-script.html <<EOF
<script>
window.civicOsConfig = {
  postgrestUrl: '${POSTGREST_URL}',
  map: {
    tileUrl: '${MAP_TILE_URL}',
    attribution: "${MAP_ATTRIBUTION}",
    defaultCenter: [parseFloat('${MAP_DEFAULT_LAT}'), parseFloat('${MAP_DEFAULT_LNG}')],
    defaultZoom: parseInt('${MAP_DEFAULT_ZOOM}')
  },
  keycloak: {
    url: '${KEYCLOAK_URL}',
    realm: '${KEYCLOAK_REALM}',
    clientId: '${KEYCLOAK_CLIENT_ID}'
  },
  s3: {
    endpoint: '${S3_ENDPOINT}',
    bucket: '${S3_BUCKET}'
  }
};
</script>
EOF

# Inject the config script right after <head> tag in index.html
# Using awk for more reliable multiline insertion
awk '
/<head>/ {
  print
  system("cat /tmp/config-script.html")
  next
}
{ print }
' /usr/share/nginx/html/index.html > /tmp/index.html.new

# Replace original with modified version
mv /tmp/index.html.new /usr/share/nginx/html/index.html

echo "✓ Configuration injected into index.html"
echo ""

# Substitute KEYCLOAK_URL into nginx configuration
echo "Updating nginx CSP header with Keycloak URL..."
sed -i "s|KEYCLOAK_URL_PLACEHOLDER|${KEYCLOAK_URL}|g" /etc/nginx/conf.d/default.conf
echo "✓ Nginx configuration updated"
echo ""

echo "======================================"
echo "Starting Nginx..."
echo "======================================"

# Execute the CMD (nginx)
exec "$@"
