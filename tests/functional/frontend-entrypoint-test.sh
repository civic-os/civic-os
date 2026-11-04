#!/bin/bash
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
#
# Runs docker/frontend/docker-entrypoint.sh's templating against a copy of the
# source index.html, manifest and nginx config with hostile environment values,
# and asserts the generated JS, JSON and HTML still parse and round-trip the
# values. No Docker, database or build needed; requires node. The entrypoint is
# run with `sh` (busybox ash in the real image; dash or bash elsewhere).
#
# Usage: tests/functional/frontend-entrypoint-test.sh

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0

# BSD sed (macOS) needs `sed -i ''`; shim it so the script runs unchanged.
mkdir -p "$TMP/bin"
if [ "$(uname)" = "Darwin" ]; then
  cat > "$TMP/bin/sed" <<'SHIM'
#!/bin/sh
if [ "$1" = "-i" ]; then shift; exec /usr/bin/sed -i '' "$@"; fi
exec /usr/bin/sed "$@"
SHIM
  chmod +x "$TMP/bin/sed"
fi
# sha1sum is missing on macOS
if ! command -v sha1sum >/dev/null 2>&1; then
  printf '#!/bin/sh\nexec shasum -a 1 "$@"\n' > "$TMP/bin/sha1sum"
  chmod +x "$TMP/bin/sha1sum"
fi
export PATH="$TMP/bin:$PATH"

sha1_of() { sha1sum "$1" | cut -d' ' -f1; }

setup() {
  rm -rf "$TMP/html" "$TMP/work"
  mkdir -p "$TMP/html" "$TMP/work"
  cp "$ROOT/src/index.html" "$ROOT/src/manifest.webmanifest" "$TMP/html/"
  printf '{"hashTable":{"/index.html": "0000000000000000000000000000000000000000"}}\n' > "$TMP/html/ngsw.json"
  cp "$ROOT/docker/frontend/nginx.conf" "$TMP/nginx.conf"
}

# Extract window.civicOsConfig from index.html, run it in node, print JSON.
EXTRACT='
const fs=require("fs"),vm=require("vm");
const html=fs.readFileSync(process.argv[1],"utf8");
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const cfg=scripts.find(s=>s.includes("civicOsConfig"));
if(!cfg){console.error("no config script");process.exit(2)}
const ctx={window:{}};vm.createContext(ctx);vm.runInContext(cfg,ctx);
const opens=(html.match(/<script[ >]/g)||[]).length, closes=(html.match(/<\/script>/g)||[]).length;
if(opens!==closes){console.error("script tag imbalance",opens,closes);process.exit(3)}
console.log(JSON.stringify(ctx.window.civicOsConfig));
'

check() {
  if [ "$2" = "0" ]; then echo "  PASS $1"; else echo "  FAIL $1"; FAIL=1; fi
}

run_entrypoint() {
  HTML_ROOT="$TMP/html" NGINX_CONF="$TMP/nginx.conf" WORK_DIR="$TMP/work" \
    "${ENTRYPOINT_SHELL:-sh}" "$ROOT/docker/frontend/docker-entrypoint.sh" true >"$TMP/out.txt" 2>&1
}

NL='
'
TABCH=$(printf '\t')

echo "Case 1: hostile values, PWA and maintenance on"
setup
export APP_TITLE="It's a \"test\" </script> <!-- \\ back & amp | pipe"
export PWA_APP_NAME="Pwa's \"name\" \\ | & </script>"
export PWA_ENABLED=true
export MAINTENANCE_MODE=readonly
export MAINTENANCE_MESSAGE="Line one \\ back \"quoted\" it's${NL}line two${TABCH}tab"
export MAP_ATTRIBUTION="&copy; <a href='x'>OSM</a> \"q\" \\"
export FAVICON_URL='/fav|icon&"x".png'
export POSTGREST_URL="http://pg.example/?a=1&b=2"
export KEYCLOAK_URL="http://kc.example" KEYCLOAK_REALM="r" KEYCLOAK_CLIENT_ID="c" S3_ENDPOINT="http://s3" S3_BUCKET="b"
export DEFAULT_THEME=nord DEFAULT_LOCALE=en SUPPORTED_LOCALES=en MAP_DEFAULT_LAT=43.1 MAP_DEFAULT_LNG=-83.6 MAP_DEFAULT_ZOOM=13
export MATOMO_URL="" SWAGGER_URL="http://sw" MAP_TILE_URL="https://{s}.tile/{z}.png"
run_entrypoint
check "entrypoint exits 0" $?

CFG=$(node -e "$EXTRACT" "$TMP/html/index.html")
check "config script parses and runs" $?
node -e '
const c=JSON.parse(process.argv[1]), e=process.env;
const eq=(a,b,n)=>{if(a!==b){console.error("MISMATCH",n,JSON.stringify(a),JSON.stringify(b));process.exit(1)}};
eq(c.appTitle,e.APP_TITLE,"appTitle"); eq(c.pwa.appName,e.PWA_APP_NAME,"pwa.appName");
eq(c.map.attribution,e.MAP_ATTRIBUTION,"attribution"); eq(c.faviconUrl,e.FAVICON_URL,"favicon");
eq(c.postgrestUrl,e.POSTGREST_URL,"postgrestUrl"); eq(c.theme.defaultTheme,"nord","theme");
' "$CFG"
check "config values round-trip exactly" $?

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP/html/manifest.webmanifest"
check "manifest.webmanifest parses" $?
node -e '
const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(m.name!==process.env.PWA_APP_NAME||m.short_name!==process.env.PWA_APP_NAME){console.error(m.name);process.exit(1)}
' "$TMP/html/manifest.webmanifest"
check "manifest name round-trips" $?
node -e '
const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(m.mode!=="readonly"||m.message!==process.env.MAINTENANCE_MESSAGE){console.error(JSON.stringify(m));process.exit(1)}
' "$TMP/html/maintenance.json"
check "maintenance.json parses and round-trips" $?
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP/html/ngsw.json"
check "ngsw.json still parses" $?
grep -q "<title>It's a &quot;test&quot; &lt;/script&gt; &lt;!-- " "$TMP/html/index.html"
check "title is HTML-escaped" $?
grep -q 'rel="icon" type="image/x-icon" href="/fav|icon&amp;&quot;x&quot;.png"' "$TMP/html/index.html"
check "favicon href escaped, | and & literal" $?
grep -q 'data-theme="nord"' "$TMP/html/index.html"
check "default theme pre-rendered on <html>" $?
grep -q "localStorage.getItem('civic-os-theme')" "$TMP/html/index.html"
check "theme-before-paint script survives the rewrite" $?
grep -q "\"/index.html\": \"$(sha1_of "$TMP/html/index.html")\"" "$TMP/html/ngsw.json"
check "ngsw.json hash matches final index.html" $?
! grep -q "_PLACEHOLDER" "$TMP/nginx.conf"
check "nginx placeholders all substituted" $?
grep -q "a=1&b=2" "$TMP/nginx.conf"
check "nginx substitution keeps & literal" $?

echo "Case 2: defaults (no PWA, no maintenance, plain values)"
setup
unset PWA_APP_NAME MAINTENANCE_MESSAGE FAVICON_URL
export APP_TITLE="Civic OS" PWA_ENABLED=false MAINTENANCE_MODE=off MAP_ATTRIBUTION="plain" POSTGREST_URL="http://localhost:3000/"
run_entrypoint
check "entrypoint exits 0" $?
node -e "$EXTRACT" "$TMP/html/index.html" >/dev/null
check "config script parses" $?
grep -q '"mode":"off"' "$TMP/html/maintenance.json"
check "maintenance off" $?

echo "Case 3: trailing-newline and multi-line theme/locale (must not crash)"
for THEME in "dark${NL}" "dark${NL}evil" "bad theme" "no|pipe"; do
  setup
  export DEFAULT_THEME="$THEME" DEFAULT_LOCALE="en${NL}" APP_TITLE="Civic OS" PWA_ENABLED=false MAINTENANCE_MODE=off
  run_entrypoint
  check "exits 0 for theme $(printf '%s' "$THEME" | tr '\n' '~')" $?
  node -e "$EXTRACT" "$TMP/html/index.html" >/dev/null
  check "  config script parses" $?
done
setup
export DEFAULT_THEME="dark${NL}" DEFAULT_LOCALE="en${NL}"
run_entrypoint
grep -q 'data-theme="dark"' "$TMP/html/index.html"
check "trailing newline trimmed, theme applied" $?

echo "Case 4: single-line values agree across sinks"
setup
export APP_TITLE="t${NL}u" PWA_APP_NAME="" PWA_ENABLED=true DEFAULT_THEME=corporate DEFAULT_LOCALE=en
run_entrypoint
CFG=$(node -e "$EXTRACT" "$TMP/html/index.html")
node -e 'if(JSON.parse(process.argv[1]).appTitle!=="t u"){process.exit(1)}' "$CFG"
check "appTitle newline mapped to space" $?
grep -q "<title>t u</title>" "$TMP/html/index.html"
check "html title matches" $?
node -e 'if(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name!=="t u")process.exit(1)' "$TMP/html/manifest.webmanifest"
check "manifest name matches" $?

echo "Case 5: CSP URLs with unsafe characters are rejected loudly"
for BAD in 'http://x/"y' 'http://x;add_header X y' 'http://x y' 'http://x\y' "http://x'y"; do
  setup
  export APP_TITLE="Civic OS" PWA_ENABLED=false MAINTENANCE_MODE=off DEFAULT_THEME=corporate
  export POSTGREST_URL="$BAD"
  run_entrypoint
  RC=$?
  [ $RC -ne 0 ] && grep -q "ERROR: POSTGREST_URL" "$TMP/out.txt"
  check "rejects POSTGREST_URL=$BAD" $?
done

if [ $FAIL -eq 0 ]; then
  echo "All frontend entrypoint checks passed"
else
  echo "FRONTEND ENTRYPOINT TEST FAILED"
  tail -5 "$TMP/out.txt"
  exit 1
fi
