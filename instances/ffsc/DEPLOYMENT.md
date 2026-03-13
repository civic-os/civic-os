# FFSC Pilot Deployment

**Organization**: Flint Freedom Schools Collaborative
**Application**: Staff Portal
**Domain**: `ffsc.pilot.civic-os.org` → vanity `staff.freedomschoolscollab.org`
**Payments**: Not enabled
**Civic OS Version**: 0.36.0

## Infrastructure

| Resource | Details |
|----------|---------|
| VPS | New DigitalOcean droplet (`civic-os-ffsc`) |
| Database | `ffsc` database on existing managed PostgreSQL cluster |
| Keycloak | `ffsc` realm on `auth.civic-os.org` |
| S3 | Shared `civic-os-files-demo` bucket on DO Spaces |
| SMTP | Shared AWS SES credentials |
| Analytics | Matomo site ID 11 |

## SQL Scripts Applied

These files are the offline record of what is installed in the production database.
They originate from `examples/staff-portal/init-scripts/` at v0.34.2, plus instance-specific patches.

| Script | Description |
|--------|-------------|
| `01_staff_portal_schema.sql` | Tables, RLS policies, triggers, indexes |
| `02_staff_portal_permissions.sql` | RBAC roles and permission matrix |
| `03_staff_portal_metadata.sql` | Entity/property display config, validations |
| `04_staff_portal_actions.sql` | Action buttons, RPC functions, action params |
| `05_staff_portal_notifications.sql` | Email/SMS templates and notification triggers |
| `06_staff_portal_seed_data.sql` | Document requirements, default sites |
| `08_staff_portal_schema_decisions.sql` | Architectural decision records |
| `09_staff_portal_causal_bindings.sql` | Status transitions, property change triggers |
| `10_staff_tasks.sql` | Staff task assignment entity |
| `11_staff_portal_dashboards.sql` | Dashboard widgets (Staff Portal + Admin Overview) |
| `12_role_key_patch.sql` | Update `get_users_with_role()` to use `role_key` instead of `display_name` (v0.36.0) |
| `13_role_renames_and_bookkeeper.sql` | Rename editor→"Site Coordinator", user→"Seasonal Staff", create Bookkeeper role (v0.36.0) |

Future FFSC-specific customizations go into new numbered scripts (e.g., `14_ffsc_*.sql`).

## Deployment Steps

### 1. Provision Droplet

```bash
cd infrastructure/vps
./provision.sh ffsc
# Note the DROPLET_IP from the output
```

### 2. Create Database

```bash
psql "postgres://doadmin:<password>@db-postgresql-nyc1-demo-do-user-21553152-0.l.db.ondigitalocean.com:25060/defaultdb?sslmode=require"
```

```sql
CREATE DATABASE ffsc;
\q
```

Add the droplet IP to the managed database firewall:

```bash
doctl databases list  # get cluster ID
doctl databases firewalls append <DB_CLUSTER_ID> --rule ip_addr:<DROPLET_IP>
```

### 3. Set Up Keycloak Realm

On https://auth.civic-os.org admin console:

1. **Create realm** — name: `ffsc`
   - Import `examples/keycloak/civic-os-dev.json` as starting point, rename to `ffsc`

2. **Create client** — `ffsc-client`
   - Client type: OpenID Connect
   - Client authentication: OFF (public client)
   - Valid redirect URIs: `https://staff.freedomschoolscollab.org/*`, `https://ffsc.pilot.civic-os.org/*`
   - Web origins: `https://staff.freedomschoolscollab.org`, `https://ffsc.pilot.civic-os.org`

3. **Create service account** — `civic-os-service-account`
   - Client authentication: ON
   - Service account roles: ON
   - Assign realm-management roles: `manage-users`, `view-users`, `manage-realm`
   - Copy client secret → update `KEYCLOAK_SERVICE_CLIENT_SECRET` in `.env.ffsc`

4. **Configure JWT mapper** for RBAC
   - Client scopes → `roles` → Mappers → realm roles
   - Token claim name: `civic_os_roles`
   - Add to ID token: ON, Access token: ON

5. **Configure realm email/SMTP** (required for welcome emails and password resets)
   - Realm Settings → Email tab
   - From: `noreply@civic-os.org`
   - From Display Name: `FFSC Staff Portal`
   - Host: same as `SMTP_HOST` in `.env` (e.g., `email-smtp.us-east-2.amazonaws.com`)
   - Port: same as `SMTP_PORT` in `.env` (e.g., `2587`)
   - Enable StartTLS: Yes
   - Authentication: Enabled, using same `SMTP_USERNAME`/`SMTP_PASSWORD` from `.env`
   - **Note**: This is separate from the worker's SMTP config. Keycloak uses its own
     SMTP settings for all user-facing emails (welcome, password reset, verify email).
     Without this, user provisioning succeeds but these emails silently fail.

6. **Create initial admin user**
   - Set temporary password
   - Assign `admin` realm role

### 4. Deploy to Droplet

```bash
DROPLET_IP=<from step 1>

# Copy deployment files
scp docker-compose.vps.yml Caddyfile deploy.sh deploy@${DROPLET_IP}:/opt/civic-os/

# Copy env (rename to .env on the server)
scp .env.ffsc deploy@${DROPLET_IP}:/opt/civic-os/.env

# Copy ONLY the FFSC caddy config (not mottpark's)
ssh deploy@${DROPLET_IP} "mkdir -p /opt/civic-os/conf.d"
scp conf.d/staff-ffsc.caddy deploy@${DROPLET_IP}:/opt/civic-os/conf.d/

# Deploy (runs core Sqitch migrations + starts services)
ssh deploy@${DROPLET_IP} "cd /opt/civic-os && ./deploy.sh"
```

### 5. Set Authenticator Password

After the first deploy, the core migrations create the `authenticator` role.
Connect to the `ffsc` database and check its password, then update `.env.ffsc` on the droplet:

```bash
ssh deploy@${DROPLET_IP}
nano /opt/civic-os/.env  # Update AUTHENTICATOR_PASSWORD
cd /opt/civic-os && docker compose -f docker-compose.vps.yml restart postgrest
```

### 6. Apply Staff Portal Schema

From your local machine:

```bash
PGURI="postgres://doadmin:<password>@db-postgresql-nyc1-demo-do-user-21553152-0.l.db.ondigitalocean.com:25060/ffsc?sslmode=require"

cd instances/ffsc/
psql "$PGURI" -f 01_staff_portal_schema.sql
psql "$PGURI" -f 02_staff_portal_permissions.sql
psql "$PGURI" -f 03_staff_portal_metadata.sql
psql "$PGURI" -f 04_staff_portal_actions.sql
psql "$PGURI" -f 05_staff_portal_notifications.sql
psql "$PGURI" -f 06_staff_portal_seed_data.sql
psql "$PGURI" -f 08_staff_portal_schema_decisions.sql
psql "$PGURI" -f 09_staff_portal_causal_bindings.sql
psql "$PGURI" -f 10_staff_tasks.sql
psql "$PGURI" -f 11_staff_portal_dashboards.sql
```

### 7. Customize Seed Data

Update the default "Freedom School Site A/B/C" entries to real FFSC locations:

```sql
-- Example: Update to actual site names and addresses
UPDATE sites SET display_name = '...', address = '...' WHERE id = 1;
UPDATE sites SET display_name = '...', address = '...' WHERE id = 2;
UPDATE sites SET display_name = '...', address = '...' WHERE id = 3;
```

### 8. DNS Records

**civic-os.org** (your DNS):

| Type | Name | Value |
|------|------|-------|
| A | `ffsc.pilot.civic-os.org` | `<DROPLET_IP>` |
| A | `api.ffsc.pilot.civic-os.org` | `<DROPLET_IP>` |
| A | `docs.ffsc.pilot.civic-os.org` | `<DROPLET_IP>` |

**freedomschoolscollab.org** (FFSC's DNS — when available):

| Type | Name | Value |
|------|------|-------|
| A | `staff.freedomschoolscollab.org` | `<DROPLET_IP>` |

Until the vanity domain DNS is set up, the site works at `ffsc.pilot.civic-os.org`
(remove the `VANITY_DOMAIN` line from `.env` temporarily to skip the redirect).

### 9. Configure S3 CORS (required for file uploads)

File uploads use presigned URLs — the browser PUTs files directly to DO Spaces.
Without CORS, the browser blocks these requests.

In DigitalOcean console → Spaces → `civic-os-files-demo` → Settings → CORS Configuration,
add rules for each frontend origin:

| Origin | Allowed Methods | Allowed Headers | Max Age |
|--------|----------------|-----------------|---------|
| `https://ffsc.pilot.civic-os.org` | `GET, PUT` | `*` | `3600` |
| `https://staff.freedomschoolscollab.org` | `GET, PUT` | `*` | `3600` |

Or via AWS CLI (with a DO Spaces-configured profile):

```bash
aws s3api put-bucket-cors --bucket civic-os-files-demo \
  --endpoint-url https://nyc3.digitaloceanspaces.com \
  --profile digitalocean \
  --cors-configuration '{
    "CORSRules": [
      {
        "AllowedOrigins": ["https://ffsc.pilot.civic-os.org", "https://staff.freedomschoolscollab.org"],
        "AllowedMethods": ["GET", "PUT"],
        "AllowedHeaders": ["*"],
        "MaxAgeSeconds": 3600
      }
    ]
  }'
```

**Note**: If multiple instances share the same bucket, their origins must all be
included in a single CORS configuration (S3 CORS replaces, not appends).

### 10. Verify

- https://ffsc.pilot.civic-os.org — login page
- https://ffsc.pilot.civic-os.org/_/api/ — PostgREST schema
- https://ffsc.pilot.civic-os.org/_/docs/ — Swagger UI

## Updating

```bash
ssh deploy@<DROPLET_IP>
cd /opt/civic-os
# Edit .env to update VERSION, then:
./deploy.sh
```

## Instance-Specific Changes

All production customizations go in this directory as numbered SQL scripts:

```
instances/ffsc/
├── DEPLOYMENT.md                          # This file
├── operations-transaction-form.json       # Original form spec (reference)
├── 01_staff_portal_schema.sql             # Baseline schema (v0.34.2)
├── 02_staff_portal_permissions.sql
├── ...
├── 11_staff_portal_dashboards.sql
├── 12_role_key_patch.sql                  # v0.36.0 role_key migration
├── 13_role_renames_and_bookkeeper.sql     # v0.36.0 role renames + new role
└── 14_ffsc_site_customizations.sql        # (future) FFSC-specific changes
```
