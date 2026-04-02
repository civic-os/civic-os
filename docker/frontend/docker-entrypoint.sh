#!/bin/sh
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later

set -e

echo "======================================"
echo "Civic OS Frontend Container Starting"
echo "======================================"

echo "Configuration:"
echo "  POSTGREST_URL: $POSTGREST_URL"
echo "  SWAGGER_URL: $SWAGGER_URL"
echo "  KEYCLOAK_URL: $KEYCLOAK_URL"
echo "  KEYCLOAK_REALM: $KEYCLOAK_REALM"
echo "  KEYCLOAK_CLIENT_ID: $KEYCLOAK_CLIENT_ID"
echo "  MAP_DEFAULT_LAT: $MAP_DEFAULT_LAT"
echo "  MAP_DEFAULT_LNG: $MAP_DEFAULT_LNG"
echo "  MAP_DEFAULT_ZOOM: $MAP_DEFAULT_ZOOM"
echo "  S3_ENDPOINT: $S3_ENDPOINT"
echo "  S3_BUCKET: $S3_BUCKET"
echo "  STRIPE_PUBLISHABLE_KEY: ${STRIPE_PUBLISHABLE_KEY:+pk_***${STRIPE_PUBLISHABLE_KEY: -4}}"
echo "  MATOMO_URL: $MATOMO_URL"
echo "  MATOMO_SITE_ID: $MATOMO_SITE_ID"
echo "  MATOMO_ENABLED: $MATOMO_ENABLED"
echo "  SMS_CONFIGURED: $SMS_CONFIGURED"
echo "  DEFAULT_THEME: $DEFAULT_THEME"
echo "  APP_TITLE: $APP_TITLE"
echo "  FAVICON_URL: $FAVICON_URL"
echo ""

# Generate inline config script
echo "Injecting runtime configuration into index.html..."

# Create temporary file with config script
cat > /tmp/config-script.html <<EOF
<script>
window.civicOsConfig = {
  postgrestUrl: '${POSTGREST_URL}',
  swaggerUrl: '${SWAGGER_URL}',
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
  },
  stripe: {
    publishableKey: '${STRIPE_PUBLISHABLE_KEY}'
  },
  matomo: {
    url: '${MATOMO_URL}',
    siteId: '${MATOMO_SITE_ID}',
    enabled: '${MATOMO_ENABLED}' === 'true'
  },
  sms: {
    configured: '${SMS_CONFIGURED}' === 'true'
  },
  theme: {
    defaultTheme: '${DEFAULT_THEME}' || 'corporate'
  },
  appTitle: '$(echo "${APP_TITLE}" | sed "s/'/\\\\'/g")' || 'Civic OS',
  faviconUrl: '${FAVICON_URL}'
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

# Replace page title if APP_TITLE is set
if [ -n "$APP_TITLE" ] && [ "$APP_TITLE" != "Civic OS" ]; then
  sed -i "s|<title>Civic OS</title>|<title>${APP_TITLE}</title>|" /usr/share/nginx/html/index.html
  echo "✓ Page title set to: $APP_TITLE"
fi

# Replace favicon URL if FAVICON_URL is set
if [ -n "$FAVICON_URL" ]; then
  sed -i "s|href=\"favicon.ico\"|href=\"${FAVICON_URL}\"|" /usr/share/nginx/html/index.html
  echo "✓ Favicon URL set to: $FAVICON_URL"
fi

echo ""

# Substitute runtime URLs into nginx CSP configuration
echo "Updating nginx CSP header with runtime URLs..."
sed -i "s|POSTGREST_URL_PLACEHOLDER|${POSTGREST_URL}|g" /etc/nginx/conf.d/default.conf
sed -i "s|KEYCLOAK_URL_PLACEHOLDER|${KEYCLOAK_URL}|g" /etc/nginx/conf.d/default.conf
sed -i "s|MATOMO_URL_PLACEHOLDER|${MATOMO_URL:-}|g" /etc/nginx/conf.d/default.conf
sed -i "s|S3_ENDPOINT_PLACEHOLDER|${S3_ENDPOINT}|g" /etc/nginx/conf.d/default.conf
echo "✓ Nginx configuration updated"
echo ""

echo "======================================"
echo "Starting Nginx..."
echo "======================================"

# Execute the CMD (nginx)
exec "$@"
