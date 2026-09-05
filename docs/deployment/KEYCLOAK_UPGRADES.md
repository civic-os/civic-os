# Keycloak Upgrade Guide

This guide covers upgrading the hosted Keycloak server for Civic OS deployments and establishing a routine upgrade process.

## Civic OS Integration Surface

Before upgrading, understand what Civic OS depends on in Keycloak:

| Component | Integration Method | What Could Break |
|---|---|---|
| **Frontend** | `keycloak-js` (OIDC Authorization Code + PKCE) | Login/logout flow, token refresh |
| **PostgREST** | JWKS file (RS256 public key from `/protocol/openid-connect/certs`) | JWT validation → all API calls |
| **Go Worker** | Admin REST API (client credentials grant) | User provisioning, role sync |
| **Database** | JWT claims (`sub`, `email`, `realm_access.roles`) via `request.jwt.claims` | RLS policies, `current_user_id()` |

**Key resilience factor:** Civic OS uses only standard OIDC protocols and the Admin REST API — no custom Keycloak SPIs, custom authenticators, or theme overrides. This makes upgrades within a major version (e.g., 26.x) generally safe.

## Pre-Upgrade Checklist

### 1. Read the Release Notes

Always review the official docs for your version range:

- **Release Notes**: https://www.keycloak.org/docs/latest/release_notes/index.html
- **Upgrading Guide**: https://www.keycloak.org/docs/latest/upgrading/index.html

Scan for changes in these categories (in priority order):

1. **Admin REST API** — breaking changes affect the Go worker
2. **OIDC / Token format** — affects PostgREST JWT validation and frontend auth
3. **Client configuration** — stricter validation of redirect URIs, auth methods
4. **Database migration** — automatic schema changes that could modify auth flows
5. **JWKS / Signing** — key format or rotation behavior changes

### 2. Pre-Flight: Service Account Roles

Starting with Keycloak 26.7.1, admin roles granted via **protocol mappers** no longer provide Admin API access — only directly assigned roles work. Before upgrading to 26.7+, verify:

1. **Keycloak Admin → Clients → `civic-os-service-account` → Service Account Roles** — confirm `manage-users`, `view-users`, `view-realm`, `manage-realm` are **directly assigned** (shown under the "Service Account Roles" tab), not injected via protocol mappers.

2. **Keycloak Admin → Clients → each frontend client → Valid Redirect URIs** — starting with 26.7.3, redirect URIs containing OIDC response parameters (`state`, `code`, `session_state`) are rejected. Clean app URLs like `https://example.com/*` are fine.

### 3. Test in Dev First

The dev `docker-compose.yml` uses an unpinned Keycloak image, so local dev may already be running the target version. Verify:

```bash
# Check what version dev is running
docker exec <keycloak-container> /opt/keycloak/bin/kc.sh --version

# If it's already the target version, dev has been your integration test
```

If dev is on an older version, pull the target version explicitly:

```bash
# In your example directory
docker-compose pull keycloak
docker-compose up -d keycloak
```

Then run through the verification checklist (see Post-Upgrade Verification below).

### 3. Back Up the Database

Keycloak runs automatic database migrations on startup. These are **not reversible** without a database backup. **Always back up the database before the realm export** — the database backup is the critical one.

```bash
# If using peer authentication (common on bare-metal), run as the postgres OS user:
sudo -u postgres pg_dump keycloak > /root/keycloak-db-backup-$(date +%Y%m%d).sql

# If using password authentication or remote connection:
pg_dump -h localhost -U postgres keycloak > keycloak-db-backup-$(date +%Y%m%d).sql
```

**Note on peer auth:** PostgreSQL's default `pg_hba.conf` uses `peer` authentication for local Unix socket connections, which requires the OS username to match the PostgreSQL username. Running `pg_dump -U keycloak` as root will fail with `Peer authentication failed`. Use `sudo -u postgres` to run as the superuser.

### 4. Back Up the Realm

Export all realms before upgrading. This is a secondary safety net — the database backup from step 3 is the authoritative restore point.

**For bare-metal installations**, the export CLI needs the database password explicitly — it does not inherit credentials from the systemd unit's `ExecStart` line:

```bash
# Export ALL realms (omit --realm to get everything)
sudo -u keycloak /opt/keycloak/bin/kc.sh export \
  --dir /opt/keycloak/data/export \
  --users realm_file \
  --db-password=<YOUR_DB_PASSWORD>

# Save the export
cp -r /opt/keycloak/data/export /root/keycloak-realm-backup-$(date +%Y%m%d)
```

**For Docker installations:**

```bash
docker exec <keycloak-container> /opt/keycloak/bin/kc.sh export \
  --dir /opt/keycloak/data/export \
  --users realm_file

docker cp <keycloak-container>:/opt/keycloak/data/export ./keycloak-backup-$(date +%Y%m%d)
```

**Tip:** Don't use `--realm <name>` unless you only need one realm. Omitting it exports all realms as separate JSON files, which is a better backup when the server hosts multiple realms.

## Upgrade Procedure

### Recommended Order: Server First, Then Client Libraries

1. **Upgrade the Keycloak server** — this is the riskier step (database migration, potential key rotation)
2. **Verify all Civic OS components** — frontend login, worker provisioning, API calls
3. **Bump `keycloak-js` later** — in a routine app release, not simultaneously

This ordering isolates risk. If something breaks after the server upgrade, you know it's the server — not a simultaneous client library change.

### Step 1: Upgrade the Server

```bash
# SSH to production

# Pull the new image
docker pull quay.io/keycloak/keycloak:26.6.1

# Update your docker-compose or deployment config to pin the new version
# e.g., image: quay.io/keycloak/keycloak:26.6.1

# Stop Keycloak (other services stay up — users will see login errors briefly)
docker-compose stop keycloak

# Start with new version (runs automatic DB migration on boot)
docker-compose up -d keycloak

# Watch startup logs for migration output and errors
docker-compose logs -f keycloak
```

**What to watch for in logs:**
- `Updating the configuration and target database` — normal migration
- `Migrating database from X to Y` — schema migration steps
- Any `ERROR` or `FATAL` lines during startup
- `Keycloak ... started in Xs` — successful boot

### Step 2: Restart PostgREST to Re-fetch JWKS

The VPS PostgREST image auto-fetches JWKS from Keycloak on startup. Restart it to pick up any new signing keys:

```bash
docker-compose restart postgrest

# Verify JWKS was fetched successfully
docker-compose logs postgrest | grep -i "jwk\|jwt\|error"
```

For dev environments, PostgREST auto-fetches JWKS on startup:

```bash
docker-compose restart postgrest
```

### Step 3: Restart the Go Worker

The worker caches Keycloak tokens with a 30-second refresh buffer. Restart it to clear the cache:

```bash
docker-compose restart worker

# Check worker can authenticate
docker-compose logs worker | grep -i "keycloak\|token\|error"
```

### Step 4: Verify (see Post-Upgrade Verification below)

## Bare-Metal Installation

For non-containerized Keycloak installations (e.g., direct install on a Linux server), use this procedure instead.

### Pre-Upgrade

```bash
# Back up the database (use sudo -u postgres for peer auth)
sudo -u postgres pg_dump keycloak > /root/keycloak-db-backup-$(date +%Y%m%d).sql

# Export all realms (requires --db-password since CLI doesn't inherit from systemd)
sudo -u keycloak /opt/keycloak/bin/kc.sh export \
  --dir /opt/keycloak/data/export \
  --users realm_file \
  --db-password=<YOUR_DB_PASSWORD>

cp -r /opt/keycloak/data/export /root/keycloak-realm-backup-$(date +%Y%m%d)
```

### Upgrade the Server

First, download and extract the new Keycloak distribution. `kc.sh build` does NOT download new versions — it only rebuilds the Quarkus configuration for the installed binaries.

```bash
# Download new version (update version number as needed)
KC_VERSION=26.7.3
cd /tmp
curl -LO https://github.com/keycloak/keycloak/releases/download/$KC_VERSION/keycloak-$KC_VERSION.tar.gz

# Extract to a staging directory (old Keycloak keeps running)
sudo tar xzf keycloak-$KC_VERSION.tar.gz
sudo rsync -a keycloak-$KC_VERSION/ /opt/keycloak-new/
sudo cp /opt/keycloak/conf/keycloak.conf /opt/keycloak-new/conf/
sudo chown -R keycloak:keycloak /opt/keycloak-new
rm -rf keycloak-$KC_VERSION keycloak-$KC_VERSION.tar.gz

# Build in staging directory (old Keycloak still running)
# Omitting --db=postgres defaults to H2 and breaks startup
sudo -u keycloak /opt/keycloak-new/bin/kc.sh build --db=postgres

# Stop, swap directories, and start — only downtime is this step (~10-15 seconds)
sudo systemctl stop keycloak
sudo mv /opt/keycloak /opt/keycloak.bak
sudo mv /opt/keycloak-new /opt/keycloak
sudo systemctl start keycloak

# Watch logs for migration output
journalctl -u keycloak -f
```

**What to watch for in logs:**
- `Updating the configuration and target database` — normal migration
- `Migrating database from X to Y` — schema migration steps
- Any `ERROR` or `FATAL` lines during startup
- `Keycloak ... started in Xs` — successful boot

### Restart Dependent Services

After upgrading, restart PostgREST (to re-fetch JWKS) and the consolidated worker (to clear the token cache) on **every instance** that depends on this Keycloak server.

```bash
# VPS instances (Docker Compose):
docker compose restart postgrest consolidated-worker

# Kubernetes instances — repeat for each namespace:
kubectl rollout restart deployment postgrest consolidated-worker -n <namespace>
```

Verify each instance after restart:
- PostgREST logs should show `Successfully connected` and `Schema cache loaded`
- Worker logs should show `✓ Keycloak client configured`

### Total Downtime

**~10-15 seconds** for bare-metal upgrades (restart only — the build runs while the old instance serves traffic).

## Post-Upgrade Verification

Run through these checks after every Keycloak upgrade:

### Frontend Authentication
- [ ] Log in with a test user — confirms OIDC flow works
- [ ] Log out and log back in — confirms session handling
- [ ] Refresh the page while logged in — confirms token refresh
- [ ] Check browser console for auth errors

### PostgREST API
```bash
# Get a token (login via browser, copy from Network tab, or use direct grant)
TOKEN="<paste bearer token>"

# Test authenticated API call
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  https://your-instance.example.com/api/schema_entities

# Should return 200, not 401
```

### Go Worker
- [ ] Create a user via the Civic OS Admin UI → User Management
- [ ] Check worker logs for successful Keycloak provisioning
- [ ] Assign a role to a user and verify it appears in their JWT

### Authentication Flows
- [ ] Log into Keycloak Admin Console
- [ ] Navigate to Authentication → Browser flow
- [ ] Verify no unexpected sub-flows were injected (e.g., Organization)
- [ ] If unwanted flows appear, remove them

### Service Account
- [ ] Keycloak Admin → Clients → `civic-os-service-account`
- [ ] Verify Credentials tab shows correct authentication method
- [ ] Verify Service Account Roles still include `manage-users`, `view-users`, `view-realm`, `manage-realm`

## Bumping keycloak-js (Separate Step)

After the server is stable, update the JS adapter in a routine app release:

```bash
cd civic-os-frontend
npm install keycloak-js@^26.7.0
```

Run tests and verify:

```bash
npm run test:headless
npm start  # manual smoke test: login, logout, page refresh
```

The `keycloak-angular` library (`^22.0.0`) wraps `keycloak-js` and is version-independent — it doesn't need to be bumped for minor Keycloak updates.

## Routine Upgrade Cadence

### How Often to Upgrade

Keycloak releases patch versions frequently (every 2-4 weeks). Recommended cadence:

| Release Type | Example | Cadence | Urgency |
|---|---|---|---|
| **Patch** (x.y.Z) | 26.6.0 → 26.6.1 | Monthly or as-needed | Low — bug/security fixes only |
| **Minor** (x.Y.0) | 26.5 → 26.6 | Quarterly | Medium — review breaking changes |
| **Major** (X.0.0) | 26.x → 27.0 | Plan ahead, test thoroughly | High — expect breaking changes |

### Staying Informed

- **Watch releases**: https://github.com/keycloak/keycloak/releases
- **Security advisories**: https://www.keycloak.org/security — subscribe to these; security patches are the main reason to upgrade promptly

### Patch Upgrades (Low Risk)

Patch releases (e.g., 26.6.0 → 26.6.1) contain only bug fixes and security patches. These rarely require reading the full upgrading guide:

1. Back up the database
2. Pull new image, restart Keycloak
3. Restart PostgREST (JWKS refresh)
4. Quick smoke test (login, API call)

### Minor Upgrades (Medium Risk)

Minor releases (e.g., 26.5 → 26.6) may include breaking changes. Follow the full procedure:

1. Read the Upgrading Guide for your version range
2. Test in dev first
3. Back up realm + database
4. Follow the full upgrade procedure above
5. Run all post-upgrade verification checks

### Major Upgrades (High Risk)

Major releases are rare but can include protocol-level changes, removed features, and mandatory configuration changes. Plan these as a project:

1. Read the full Upgrading Guide cover-to-cover
2. Test in an isolated staging environment
3. Check `keycloak-js` and `keycloak-angular` for required major version bumps
4. Review the Go worker's Admin API calls against the new API docs
5. Plan for potential downtime
6. Back up everything
7. Upgrade and verify exhaustively

## Known Civic OS-Specific Considerations

These are integration details worth checking during any upgrade:

### Go Worker Token Authentication
The worker sends `client_id` and `client_secret` in the POST body (`client_secret_post` method). If Keycloak changes the default or enforced `token_endpoint_auth_method` for confidential clients, the worker will get 401 errors. Check: Keycloak Admin → Clients → `civic-os-service-account` → Credentials tab.

### JWT Audience Claim
PostgREST validates `aud: "account"` (`PGRST_JWT_AUD` in docker-compose). If Keycloak changes the default audience in access tokens, PostgREST will reject all tokens. This is a standard Keycloak default that hasn't changed across 26.x.

### Role Claim Path
The frontend reads roles from `realm_access.roles` in the JWT (with fallbacks to `resource_access` and top-level `roles`). The database's `get_user_roles()` function also reads from `realm_access.roles` via `request.jwt.claims`. If Keycloak changes where roles appear in the token, both frontend and backend break simultaneously.

### PKCE Requirement
The frontend uses PKCE with S256. If a future Keycloak version changes PKCE defaults or requirements for public clients, verify `keycloak-angular`'s `initOptions.pkceMethod` still works.

## Rollback

### Containerized (Docker Compose)

If the upgrade fails and Civic OS is broken:

1. **Stop Keycloak**: `docker-compose stop keycloak`
2. **Restore database**: `psql -U postgres keycloak_db < keycloak-db-backup-YYYYMMDD.sql`
3. **Revert image**: Change docker-compose back to the previous version
4. **Restart**: `docker-compose up -d keycloak`
5. **Restart PostgREST**: `docker-compose restart postgrest` (re-fetch JWKS)

### Bare-Metal

If the upgrade fails:

1. **Stop Keycloak**: `sudo systemctl stop keycloak`
2. **Restore database** (drop and recreate to ensure clean state):
   ```bash
   sudo -u postgres psql -c "DROP DATABASE keycloak;"
   sudo -u postgres psql -c "CREATE DATABASE keycloak OWNER keycloak;"
   sudo -u postgres psql keycloak < /root/keycloak-db-backup-YYYYMMDD.sql
   ```
3. **Revert Keycloak binary**:
   ```bash
   sudo mv /opt/keycloak /opt/keycloak-failed
   sudo mv /opt/keycloak.bak /opt/keycloak
   ```
4. **Start Keycloak**: `sudo systemctl start keycloak`
5. **Restart dependent services** on all instances (see Restart Dependent Services above)

**Important:** Keycloak's database migrations are forward-only. You cannot run an older Keycloak binary against a migrated database. Always restore from backup if rolling back.
