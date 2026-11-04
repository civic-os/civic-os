#!/bin/sh
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later

set -e

# Paths are overridable so tests/functional/frontend-entrypoint-test.sh can run
# the templating against a copy of the built files without Docker.
HTML_ROOT="${HTML_ROOT:-/usr/share/nginx/html}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/default.conf}"
WORK_DIR="${WORK_DIR:-/tmp}"

# --- Escaping helpers --------------------------------------------------------
# Environment values land in JavaScript, JSON, HTML and sed replacements, and
# each sink needs its own escape. POSIX sed/tr only (busybox-safe).
TAB=$(printf '\t')
CR=$(printf '\r')

# js_escape: the body of a JS or JSON string literal, valid in either language
# and inside single or double quotes. Escapes backslash and double quote,
# renders ' < > & as \uXXXX (so a value cannot close a <script>, open a <!--
# comment or break out of an attribute), turns tab, CR and newline into \t \r
# \n, and drops all other control characters.
js_escape() {
  # Join all lines first so every substitution sees the whole value, and turn
  # the newlines into \n last.
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | sed \
    -e ':a' -e '$!{N;ba' -e '}' \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e "s/'/\\\\u0027/g" \
    -e 's/</\\u003c/g' \
    -e 's/>/\\u003e/g' \
    -e 's/&/\\u0026/g' \
    -e "s/${TAB}/\\\\t/g" \
    -e "s/${CR}/\\\\r/g" \
    -e 's/\n/\\n/g'
}
json_escape() { js_escape "$1"; }

# html_escape: element text or a double-quoted attribute value.
html_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

# sed_escape: replacement text for s|...|HERE|. Escapes backslash, & and the |
# delimiter. Newlines are removed since a replacement cannot span lines.
sed_escape() {
  printf '%s' "$1" | tr -d '\n\r' | sed -e 's/[\\&|]/\\&/g'
}

# --- Normalize and validate before anything is written ------------------------
# A trailing newline (file-mounted secret) is trimmed by command substitution.
# Single-line values get remaining newlines mapped to a space so every sink
# (JS, HTML title, manifest) sees the same text. MAINTENANCE_MESSAGE is the
# only value where newlines are kept.
APP_TITLE=$(printf '%s' "$APP_TITLE" | tr '\n\r' '  ')
FAVICON_URL=$(printf '%s' "$FAVICON_URL" | tr '\n\r' '  ')
PWA_APP_NAME=$(printf '%s' "$PWA_APP_NAME" | tr '\n\r' '  ')
DEFAULT_THEME=$(printf '%s' "$DEFAULT_THEME")
DEFAULT_LOCALE=$(printf '%s' "$DEFAULT_LOCALE")

# Theme and locale must be one line and match a strict pattern (checked on the
# whole value: grep alone validates per line). Invalid values warn and fall
# back to the built-in default instead of breaking the sed rewrites below.
case "$DEFAULT_THEME" in
  '') ;;
  *[!a-z0-9-]*)
    echo "WARNING: DEFAULT_THEME is not a valid theme name; ignoring it"
    DEFAULT_THEME="" ;;
esac
case "$DEFAULT_LOCALE" in
  '') ;;
  *[!a-zA-Z-]*)
    echo "WARNING: DEFAULT_LOCALE is not a valid locale code; ignoring it"
    DEFAULT_LOCALE="" ;;
  *)
    if ! printf '%s' "$DEFAULT_LOCALE" | grep -Eq '^[a-z]{2,3}(-[A-Z]{2})?$'; then
      echo "WARNING: DEFAULT_LOCALE is not a valid locale code; ignoring it"
      DEFAULT_LOCALE=""
    fi ;;
esac

# URLs that go into the nginx CSP header (a quoted add_header) must not contain
# characters that end the quoted string or start another directive. A loud
# error beats an nginx parse error or an injected directive.
check_csp_value() {
  case "$2" in
    *[\"\'\;\\\`\$\{\}[:space:]]*)
      echo "ERROR: $1 contains a character that is not allowed in a URL used in the Content-Security-Policy header (quotes, ;, \\, backtick, \$, braces or whitespace)." >&2
      echo "       Fix the value of $1 and restart the container." >&2
      exit 1 ;;
  esac
}
check_csp_value POSTGREST_URL "$POSTGREST_URL"
check_csp_value KEYCLOAK_URL "$KEYCLOAK_URL"
check_csp_value MATOMO_URL "${MATOMO_URL:-}"
check_csp_value S3_ENDPOINT "$S3_ENDPOINT"

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
echo "  DEFAULT_LOCALE: $DEFAULT_LOCALE"
echo "  SUPPORTED_LOCALES: $SUPPORTED_LOCALES"
echo "  PWA_ENABLED: $PWA_ENABLED"
echo "  PWA_APP_NAME: $PWA_APP_NAME"
echo "  MAINTENANCE_MODE: $MAINTENANCE_MODE"
echo "  MAINTENANCE_MESSAGE: $MAINTENANCE_MESSAGE"
echo ""

# Generate inline config script
echo "Injecting runtime configuration into index.html..."

# Every value is escaped for a JS string literal first (see js_escape).
J_POSTGREST_URL=$(js_escape "$POSTGREST_URL")
J_SWAGGER_URL=$(js_escape "$SWAGGER_URL")
J_MAP_TILE_URL=$(js_escape "$MAP_TILE_URL")
J_MAP_ATTRIBUTION=$(js_escape "$MAP_ATTRIBUTION")
J_MAP_DEFAULT_LAT=$(js_escape "$MAP_DEFAULT_LAT")
J_MAP_DEFAULT_LNG=$(js_escape "$MAP_DEFAULT_LNG")
J_MAP_DEFAULT_ZOOM=$(js_escape "$MAP_DEFAULT_ZOOM")
J_KEYCLOAK_URL=$(js_escape "$KEYCLOAK_URL")
J_KEYCLOAK_REALM=$(js_escape "$KEYCLOAK_REALM")
J_KEYCLOAK_CLIENT_ID=$(js_escape "$KEYCLOAK_CLIENT_ID")
J_S3_ENDPOINT=$(js_escape "$S3_ENDPOINT")
J_S3_BUCKET=$(js_escape "$S3_BUCKET")
J_STRIPE_PUBLISHABLE_KEY=$(js_escape "$STRIPE_PUBLISHABLE_KEY")
J_MATOMO_URL=$(js_escape "$MATOMO_URL")
J_MATOMO_SITE_ID=$(js_escape "$MATOMO_SITE_ID")
J_MATOMO_ENABLED=$(js_escape "$MATOMO_ENABLED")
J_SMS_CONFIGURED=$(js_escape "$SMS_CONFIGURED")
J_DEFAULT_THEME=$(js_escape "$DEFAULT_THEME")
J_DEFAULT_LOCALE=$(js_escape "$DEFAULT_LOCALE")
J_SUPPORTED_LOCALES=$(js_escape "$SUPPORTED_LOCALES")
J_APP_TITLE=$(js_escape "$APP_TITLE")
J_FAVICON_URL=$(js_escape "$FAVICON_URL")
J_PWA_ENABLED=$(js_escape "$PWA_ENABLED")
J_PWA_APP_NAME=$(js_escape "$PWA_APP_NAME")

# Create temporary file with config script
cat > "$WORK_DIR/config-script.html" <<EOF
<script>
window.civicOsConfig = {
  postgrestUrl: '${J_POSTGREST_URL}',
  swaggerUrl: '${J_SWAGGER_URL}',
  map: {
    tileUrl: '${J_MAP_TILE_URL}',
    attribution: "${J_MAP_ATTRIBUTION}",
    defaultCenter: [parseFloat('${J_MAP_DEFAULT_LAT}'), parseFloat('${J_MAP_DEFAULT_LNG}')],
    defaultZoom: parseInt('${J_MAP_DEFAULT_ZOOM}')
  },
  keycloak: {
    url: '${J_KEYCLOAK_URL}',
    realm: '${J_KEYCLOAK_REALM}',
    clientId: '${J_KEYCLOAK_CLIENT_ID}'
  },
  s3: {
    endpoint: '${J_S3_ENDPOINT}',
    bucket: '${J_S3_BUCKET}'
  },
  stripe: {
    publishableKey: '${J_STRIPE_PUBLISHABLE_KEY}'
  },
  matomo: {
    url: '${J_MATOMO_URL}',
    siteId: '${J_MATOMO_SITE_ID}',
    enabled: '${J_MATOMO_ENABLED}' === 'true'
  },
  sms: {
    configured: '${J_SMS_CONFIGURED}' === 'true'
  },
  theme: {
    defaultTheme: '${J_DEFAULT_THEME}' || 'corporate'
  },
  locale: {
    defaultLocale: '${J_DEFAULT_LOCALE}' || 'en',
    supportedLocales: ('${J_SUPPORTED_LOCALES}' || 'en').split(',').map(function(s) { return s.trim(); })
  },
  appTitle: '${J_APP_TITLE}' || 'Civic OS',
  faviconUrl: '${J_FAVICON_URL}',
  pwa: {
    enabled: '${J_PWA_ENABLED}' === 'true',
    appName: '${J_PWA_APP_NAME}' || ''
  }
};
</script>
EOF

# Inject the config script right after <head> tag in index.html
# Using awk for more reliable multiline insertion
awk -v cfg="$WORK_DIR/config-script.html" '
/<head>/ {
  print
  while ((getline line < cfg) > 0) print line
  close(cfg)
  next
}
{ print }
' "$HTML_ROOT/index.html" > "$WORK_DIR/index.html.new"

# Replace original with modified version
mv "$WORK_DIR/index.html.new" "$HTML_ROOT/index.html"

echo "✓ Configuration injected into index.html"

# Replace page title if APP_TITLE is set
if [ -n "$APP_TITLE" ] && [ "$APP_TITLE" != "Civic OS" ]; then
  # HTML-escape, then escape for the sed replacement (\, & and the | delimiter)
  TITLE_SED=$(sed_escape "$(html_escape "$APP_TITLE")")
  sed -i "s|<title>Civic OS</title>|<title>${TITLE_SED}</title>|" "$HTML_ROOT/index.html"
  echo "✓ Page title set to: $APP_TITLE"
fi

# Pre-render the default theme on <html> so the first paint uses it (no flash
# of the compiled-in theme). Only simple theme names are accepted. A theme the
# user saved in localStorage still wins: the inline script in index.html's
# <head> applies it before first paint.
if [ -n "$DEFAULT_THEME" ]; then
  if printf '%s' "$DEFAULT_THEME" | grep -Eq '^[a-z0-9-]+$'; then
    sed -i "/<html /s|data-theme=\"corporate\"|data-theme=\"${DEFAULT_THEME}\"|" "$HTML_ROOT/index.html"
    echo "✓ Pre-rendered theme: $DEFAULT_THEME"
  else
    echo "WARNING: DEFAULT_THEME is not a valid theme name; leaving data-theme unchanged"
  fi
fi

# Pre-render the default locale as the document language
if [ -n "$DEFAULT_LOCALE" ]; then
  if printf '%s' "$DEFAULT_LOCALE" | grep -Eq '^[a-z]{2,3}(-[A-Z]{2})?$'; then
    sed -i "/<html /s|lang=\"en\"|lang=\"${DEFAULT_LOCALE}\"|" "$HTML_ROOT/index.html"
    echo "✓ Pre-rendered locale: $DEFAULT_LOCALE"
  else
    echo "WARNING: DEFAULT_LOCALE is not a valid locale code; leaving lang unchanged"
  fi
fi

# Replace favicon URL if FAVICON_URL is set (attribute-escaped, then sed-escaped)
if [ -n "$FAVICON_URL" ]; then
  FAVICON_SED=$(sed_escape "$(html_escape "$FAVICON_URL")")
  sed -i "s|href=\"favicon.ico\"|href=\"${FAVICON_SED}\"|" "$HTML_ROOT/index.html"
  echo "✓ Favicon URL set to: $FAVICON_URL"
fi

# PWA: inject manifest link and substitute app title placeholder
if [ "$PWA_ENABLED" = "true" ]; then
  sed -i 's|</head>|<link rel="manifest" href="manifest.webmanifest"></head>|' "$HTML_ROOT/index.html"
  # The name lands inside a JSON string, then inside a sed replacement
  PWA_NAME_SED=$(sed_escape "$(json_escape "${PWA_APP_NAME:-${APP_TITLE:-Civic OS}}")")
  sed -i "s|PWA_APP_TITLE_PLACEHOLDER|${PWA_NAME_SED}|g" "$HTML_ROOT/manifest.webmanifest"
  echo "✓ PWA enabled (manifest injected)"
fi

# Rehash index.html in ngsw.json so the service worker accepts the modified file
INDEX_HASH=$(sha1sum "$HTML_ROOT/index.html" | cut -d' ' -f1)
sed -i "s|\"\/index.html\": \"[a-f0-9]*\"|\"\/index.html\": \"$INDEX_HASH\"|" "$HTML_ROOT/ngsw.json"
echo "✓ Updated ngsw.json index.html hash"

# Maintenance mode: always write maintenance.json so the frontend can detect
# both activation and deactivation via polling (404 is a no-op in the frontend)
if [ -n "$MAINTENANCE_MODE" ] && [ "$MAINTENANCE_MODE" != "off" ]; then
  echo "Maintenance mode: $MAINTENANCE_MODE"
  M_MODE=$(json_escape "$MAINTENANCE_MODE")
  M_MESSAGE=$(json_escape "$MAINTENANCE_MESSAGE")
  cat > "$HTML_ROOT/maintenance.json" <<MEOF
{"mode":"${M_MODE}","message":"${M_MESSAGE}"}
MEOF
  echo "✓ Maintenance mode signal file written (mode: $MAINTENANCE_MODE)"
else
  cat > "$HTML_ROOT/maintenance.json" <<MEOF
{"mode":"off"}
MEOF
  echo "✓ Maintenance mode signal file written (mode: off)"
fi

echo ""

# Substitute runtime URLs into nginx CSP configuration
echo "Updating nginx CSP header with runtime URLs..."
sed -i "s|POSTGREST_URL_PLACEHOLDER|$(sed_escape "${POSTGREST_URL}")|g" "$NGINX_CONF"
sed -i "s|KEYCLOAK_URL_PLACEHOLDER|$(sed_escape "${KEYCLOAK_URL}")|g" "$NGINX_CONF"
sed -i "s|MATOMO_URL_PLACEHOLDER|$(sed_escape "${MATOMO_URL:-}")|g" "$NGINX_CONF"
sed -i "s|S3_ENDPOINT_PLACEHOLDER|$(sed_escape "${S3_ENDPOINT}")|g" "$NGINX_CONF"
echo "✓ Nginx configuration updated"
echo ""

echo "======================================"
echo "Starting Nginx..."
echo "======================================"

# Execute the CMD (nginx)
exec "$@"
