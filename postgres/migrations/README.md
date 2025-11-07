# Civic OS Database Migrations

This directory contains the Sqitch-based database migration system for Civic OS. The migration system ensures schema consistency across development, staging, and production environments while supporting rollback capabilities.

## Architecture Overview

Civic OS uses a **metadata-driven architecture** where the database schema defines the UI structure. The migration system manages two categories of database objects:

### Civic OS Core Objects (We Control)
- `metadata.*` schema - All tables, views, functions
- Public RPCs: `check_jwt()`, `get_user_roles()`, `has_permission()`, `is_admin()`
- Public views: `schema_entities`, `schema_properties`, `civic_os_users`
- Custom domains: `hex_color`, `email_address`, `phone_number`
- PostgREST roles and permissions

### User Application Objects (Users Control)
- `public.issues`, `public.tags`, etc. - Application-specific tables
- User-defined functions, triggers, constraints
- Application data

**Critical:** Migrations only manage Civic OS core objects. User applications evolve independently.

## Migration Naming Convention

Migrations use version-based naming: `v<major>-<minor>-<patch>-<note>`

Examples:
- `v0-4-0-add_validation_metadata`
- `v0-4-1-add_geography_support`
- `v0-5-0-rbac_enhancements`

This format:
- ✅ Ties migrations to release versions
- ✅ Sorts alphabetically
- ✅ Makes production tracking clear

## Database Prerequisites

Before running Civic OS migrations, the database must have the `authenticator` role created:

### Creating the Authenticator Role

**Development (automated):**
The example docker-compose setup automatically creates the authenticator role via init scripts.

**Production (manual):**
```bash
psql $DATABASE_URL -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'your-secure-password'; END IF; END \$\$;"
```

**Important Notes:**
- The `authenticator` role is a **cluster-level resource** shared across all databases
- Use a strong, unique password (32+ characters recommended)
- Store the password securely (use secrets manager in production)
- The migrations will create `web_anon` and `authenticated` roles automatically

### Multi-Tenant Deployments

In multi-tenant setups where multiple Civic OS instances share a PostgreSQL cluster:

- The `authenticator`, `web_anon`, and `authenticated` roles are **shared** across all tenants
- Each tenant uses a separate schema (e.g., `tenant1.public`, `tenant2.public`)
- The v0.4.1+ migrations check for role existence before creation to prevent conflicts
- Reverting one tenant's migrations does NOT drop shared roles

**Example multi-tenant setup:**
```sql
-- Create authenticator once (shared)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'shared-password';
  END IF;
END $$;

-- Run migrations for each tenant
psql tenant1_db -c "SELECT sqitch.deploy();"
psql tenant2_db -c "SELECT sqitch.deploy();"
```

## Quick Start

### Prerequisites

Install Sqitch with PostgreSQL support:

```bash
# macOS
brew install sqitch --with-postgres-support

# Linux (Debian/Ubuntu)
apt-get install sqitch libdbd-pg-perl postgresql-client

# Verify installation
sqitch --version
```

Install Atlas for migration generation:

```bash
# macOS
brew install ariga/tap/atlas

# Linux
curl -sSf https://atlasgo.sh | sh

# Verify
atlas version
```

### Development Workflow

#### 1. Make Schema Changes in Dev Database

Apply schema changes to your development database using any method:
- psql
- PgAdmin
- Direct SQL files

Example:
```bash
psql $DEV_DB_URL -c "CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(50) NOT NULL,
  color hex_color NOT NULL DEFAULT '#3B82F6'
);"
```

#### 2. Generate Migration

Run the migration generator:

```bash
./scripts/generate-migration.sh add_tags_table "Add tags table for issue categorization"
```

This script will:
- Start a temporary clean database
- Apply existing migrations
- Use Atlas to diff dev → clean
- Generate `deploy.sql`, `revert.sql`, `verify.sql`
- Update `sqitch.plan`
- Clean up temp resources

#### 3. Review and Enhance Migration

**Review deploy script:**
```bash
nano postgres/migrations/deploy/v0-4-0-add_tags_table.sql
```

Add metadata coordination that Atlas can't detect:
```sql
-- Add metadata entries
INSERT INTO metadata.entities (table_name, display_name, description, icon, sort_order)
VALUES ('tags', 'Tags', 'Labels for categorizing issues', 'tag', 20);

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_in_list, show_in_detail)
VALUES
  ('tags', 'id', 'ID', 1, true, true),
  ('tags', 'display_name', 'Name', 2, true, true),
  ('tags', 'color', 'Color', 3, true, true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tags_id_seq TO authenticated;

-- Add RLS policies (if needed)
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tags_select ON tags FOR SELECT
  TO authenticated
  USING (public.has_permission('tags:read'));
```

**Complete revert script:**
```bash
nano postgres/migrations/revert/v0-4-0-add_tags_table.sql
```

Write logic to undo deploy changes:
```sql
BEGIN;

-- Remove RLS policies
DROP POLICY IF EXISTS tags_select ON tags;

-- Revoke permissions
REVOKE ALL ON SEQUENCE tags_id_seq FROM authenticated;
REVOKE ALL ON tags FROM authenticated;

-- Remove metadata entries
DELETE FROM metadata.properties WHERE table_name = 'tags';
DELETE FROM metadata.entities WHERE table_name = 'tags';

-- Drop table
DROP TABLE IF EXISTS tags CASCADE;

COMMIT;
```

**Enhance verify script:**
```bash
nano postgres/migrations/verify/v0-4-0-add_tags_table.sql
```

Add specific checks:
```sql
BEGIN;

-- Verify table exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables WHERE tablename = 'tags';

-- Verify domain exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_type WHERE typname = 'hex_color';

-- Verify metadata entries
SELECT 1/COUNT(*) FROM metadata.entities WHERE table_name = 'tags';
SELECT 1/COUNT(*) FROM metadata.properties WHERE table_name = 'tags' AND column_name = 'display_name';

-- Verify permissions
SELECT 1/COUNT(*) FROM information_schema.table_privileges
WHERE table_name = 'tags' AND grantee = 'authenticated' AND privilege_type = 'SELECT';

ROLLBACK;
```

#### 4. Test Migration Locally

Deploy migration:
```bash
sqitch deploy dev --verify
```

If it fails, fix the migration and redeploy:
```bash
sqitch rebase dev --verify
```

Test rollback:
```bash
sqitch revert dev --to @HEAD^
```

Re-deploy to confirm idempotency:
```bash
sqitch deploy dev --verify
```

#### 5. Commit to Git

```bash
git add postgres/migrations/ sqitch.plan
git commit -m "Add migration: Add tags table for issue categorization"
git push
```

GitHub Actions will automatically test the migration.

## Production Deployment

### Using Docker Compose

Update `docker-compose.prod.yml` to use the new version:

```yaml
services:
  migrations:
    image: ghcr.io/civic-os/migrations:v0.4.0  # Update version
    # ...

  postgrest:
    image: ghcr.io/civic-os/postgrest:v0.4.0   # Update version
    # ...

  frontend:
    image: ghcr.io/civic-os/frontend:v0.4.0    # Update version
    # ...
```

Deploy:
```bash
docker-compose -f docker-compose.prod.yml pull
docker-compose -f docker-compose.prod.yml up -d
```

The `migrations` init container will run automatically before PostgREST starts.

### Using Migration Script

Run migrations directly:

```bash
./scripts/migrate-production.sh v0.4.0 postgres://user:pass@host:5432/civic_os
```

### Manual Docker Run

```bash
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  ghcr.io/civic-os/migrations:v0.4.0
```

## Rollback Procedure

### Rollback to Previous Migration

```bash
./scripts/migrate-production.sh v0.4.0 $DATABASE_URL revert --to @HEAD^
```

Or using Docker directly:

```bash
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  ghcr.io/civic-os/migrations:v0.4.0 \
  revert --to @HEAD^
```

### Rollback to Specific Migration

```bash
sqitch revert prod --to v0-3-0-baseline
```

## Common Commands

### Show Migration Status

```bash
sqitch status dev
```

### Show Migration History

```bash
sqitch log dev
```

### Show Migration Plan

```bash
sqitch plan
```

### Deploy All Migrations

```bash
sqitch deploy dev --verify
```

### Revert Last Migration

```bash
sqitch revert dev --to @HEAD^ -y
```

### Revert All Migrations

```bash
sqitch revert dev --to @ROOT -y
```

## Directory Structure

```
postgres/migrations/
├── deploy/                      # Deploy scripts (forward migrations)
│   └── v0-4-0-add_tags_table.sql
├── revert/                      # Revert scripts (rollback)
│   └── v0-4-0-add_tags_table.sql
├── verify/                      # Verification scripts
│   ├── v0-4-0-add_tags_table.sql         # Quick checks
│   └── v0-4-0-add_tags_table.expected.sql # Full schema snapshot
├── scripts/                     # Helper scripts
│   └── verify-full.sh           # Comprehensive verification
└── templates/                   # Migration templates
    ├── add_metadata_table.sql
    ├── add_rpc_function.sql
    ├── add_domain.sql
    └── modify_metadata_view.sql
```

## Migration Templates

Use templates as starting points for common operations:

### Add Metadata Table

```bash
cp postgres/migrations/templates/add_metadata_table.sql \
   postgres/migrations/deploy/v0-4-0-add_permissions_table.sql
```

### Add RPC Function

```bash
cp postgres/migrations/templates/add_rpc_function.sql \
   postgres/migrations/deploy/v0-4-0-add_get_related_issues.sql
```

## Troubleshooting

### Migration Fails to Deploy

**Check logs:**
```bash
sqitch deploy dev --verify
# Review error output
```

**Common issues:**
- Syntax errors in SQL
- Missing dependencies (wrong --requires)
- Conflicts with existing objects

**Fix:**
1. Edit the migration file
2. Revert to before the failed migration: `sqitch revert dev --to @HEAD^`
3. Redeploy: `sqitch deploy dev --verify`

### Schema Drift Detected

**Symptoms:**
- Full verification fails
- Actual schema doesn't match expected

**Causes:**
- Manual hotfixes applied to production
- Migration didn't complete successfully
- Expected schema file is outdated

**Resolution:**
1. Export actual schema: `pg_dump --schema-only`
2. Compare to expected: `diff expected.sql actual.sql`
3. Either:
   - Create a migration to reconcile differences
   - Update expected schema file (if differences are acceptable)

### Rollback Fails

**Check revert script:**
```bash
cat postgres/migrations/revert/v0-4-0-migration_name.sql
```

**Common issues:**
- Revert logic incomplete
- Dependencies prevent dropping objects
- Data loss concerns

**Fix:**
1. Complete the revert script manually
2. Test in dev: `sqitch revert dev --to @HEAD^`
3. Commit fix: `git add postgres/migrations/revert/ && git commit`

## Best Practices

1. **Always test migrations in dev before production**
   - Deploy, verify, revert, re-deploy

2. **Write complete revert scripts**
   - Don't use `ROLLBACK;` placeholders in production

3. **Add metadata coordination**
   - Atlas only detects schema, not metadata insertions
   - Manually add INSERT INTO metadata.* statements

4. **Use meaningful migration notes**
   - Good: `add_tags_table "Add tags table for issue categorization"`
   - Bad: `migration1 "update"`

5. **Test rollback scenarios**
   - Ensure revert scripts work correctly
   - Test data preservation during rollback

6. **Version migrations with releases**
   - Each release gets its migrations: v0-4-0-*, v0-4-1-*
   - Keeps migration history tied to application versions

7. **Never edit deployed migrations**
   - Once pushed to prod, migrations are immutable
   - Create new migration to fix issues

8. **Use full verification in CI/CD**
   - Set `CIVIC_OS_VERIFY_FULL=true` in GitHub Actions
   - Catches schema drift before production

9. **🚨 CRITICAL: Always include NOTIFY at the end of migrations**
   - PostgREST caches the database schema in memory
   - Schema changes are NOT automatically detected
   - Add `NOTIFY pgrst, 'reload schema';` before `COMMIT;` in deploy scripts
   - **Failure to include NOTIFY will cause 404 errors and schema cache issues**
   - Example:
     ```sql
     -- Your migration changes here
     ALTER TABLE metadata.files ADD COLUMN new_field TEXT;

     -- Force PostgREST to reload schema cache
     NOTIFY pgrst, 'reload schema';

     COMMIT;
     ```
   - Note: Revert scripts should also include NOTIFY if they modify schema

## Additional Resources

- [Sqitch Tutorial](https://sqitch.org/docs/manual/sqitchtutorial/)
- [Atlas Migration Guides](https://atlasgo.io/guides)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Civic OS Production Deployment Guide](../../docs/deployment/PRODUCTION.md)

## Support

For issues or questions:
- GitHub Issues: https://github.com/civic-os/frontend/issues
- Documentation: https://docs.civic-os.org
