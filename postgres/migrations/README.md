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

### Instance-Specific Data Is Off-Limits

Migrations manage the **shape** of metadata (adding columns, tables, functions, domains) — never the **content**. Dashboard widgets, entity display names, property labels, notification templates, and other metadata rows are instance-specific data that integrators configure per deployment. A migration that overwrites these rows destroys instance customizations.

**What migrations MAY do:**
- Add/alter/drop metadata tables, columns, and constraints
- Create or replace functions, views, triggers, and domains
- INSERT new metadata rows for new framework features (with `ON CONFLICT DO NOTHING`)
- Backfill a newly added column with computed defaults

**What migrations must NEVER do:**
- Replace the content of existing metadata rows (dashboard widgets, translations, display names)
- UPDATE rows that integrators may have customized after initial setup
- DELETE and re-INSERT metadata rows to "refresh" them

If a migration absolutely must modify existing content (e.g., renaming a metadata column that changes a view's output), it must use a **content-aware guard** such as `WHERE config->>'content' LIKE '%expected_default_text%'` to avoid clobbering instance customizations. Even then, prefer handling the change in the frontend or baseline instead.

> **Incident reference:** The v0-65-1 migration replaced all markdown widgets on the default dashboard to add a login button. This overwrote custom dashboard content on every deployed instance (Mott Park, FFSC, ICGF, Clients Demo), requiring manual restoration on each one.

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

#### 2. Create Migration Scaffolding

Use `sqitch add` to create the migration structure, then populate from a template:

```bash
# Determine the last migration name from sqitch.plan
tail -1 sqitch.plan

# Add new migration (requires the previous migration)
sqitch add v0-66-0-add_tags_table \
  --requires v0-65-1-auth-route-translations \
  -n "Add tags table for issue categorization"

# Start from a template
cp postgres/migrations/templates/add_metadata_table.sql \
   postgres/migrations/deploy/v0-66-0-add_tags_table.sql
```

Available templates in `postgres/migrations/templates/`:
- `add_metadata_table.sql` — New table with metadata entries, grants, RLS
- `add_rpc_function.sql` — New RPC function with grants
- `add_domain.sql` — New custom domain type
- `modify_metadata_view.sql` — Changes to schema_entities/schema_properties views

#### 3. Review and Enhance Migration

**Review deploy script:**
```bash
nano postgres/migrations/deploy/v0-4-0-add_tags_table.sql
```

Add metadata coordination (not included in templates by default):
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
    image: ghcr.io/civic-os/migrations:latest  # Update version
    # ...

  postgrest:
    image: ghcr.io/civic-os/postgrest:latest   # Update version
    # ...

  frontend:
    image: ghcr.io/civic-os/frontend:latest    # Update version
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
  ghcr.io/civic-os/migrations:latest
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
  ghcr.io/civic-os/migrations:latest \
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
│   └── v0-4-0-add_tags_table.sql         # Quick checks
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

## Revert Script Patterns

Writing correct revert scripts requires understanding PostgreSQL's dependency system. The most common bug pattern is **view column dependencies**.

### The View Column Rule

**PostgreSQL's `CREATE OR REPLACE VIEW` cannot remove columns from an existing view.** This causes revert failures when:
1. Deploy adds a column to a metadata table
2. Deploy updates a view to include the new column
3. Revert tries to `CREATE OR REPLACE VIEW` without the column → **ERROR**

**Solution: Always DROP VIEW before CREATE VIEW when removing columns**

```sql
-- ❌ WRONG - Will fail with "cannot drop columns from view"
CREATE OR REPLACE VIEW public.schema_entities AS
SELECT ... -- missing a column that the current view has

-- ✅ CORRECT - Drop first, then create
DROP VIEW IF EXISTS public.schema_properties;  -- Drop dependent views first
DROP VIEW IF EXISTS public.schema_entities;

ALTER TABLE metadata.entities DROP COLUMN some_column;

CREATE VIEW public.schema_entities AS SELECT ...
CREATE VIEW public.schema_properties AS SELECT ...
```

### Common Revert Patterns

| Situation | Pattern |
|-----------|---------|
| Removing view columns | `DROP VIEW` → `ALTER TABLE` → `CREATE VIEW` |
| Foreign key cleanup | Delete from child table first (`permission_roles` before `permissions`) |
| Function with triggers | `DROP TABLE ... CASCADE` removes triggers, then safe to drop functions |
| Multiple function overloads | Use full signature in `COMMENT ON FUNCTION` and `GRANT EXECUTE` |

### Manual Round-Trip Testing

Before releasing migrations, test the full round-trip locally:

```bash
# 1. Deploy all migrations
sqitch deploy dev --verify

# 2. Revert ALL the way to baseline
sqitch revert dev --to v0-4-0-baseline -y

# 3. Re-deploy everything
sqitch deploy dev --verify
```

This catches issues that single-step revert testing (`--to @HEAD^`) misses, particularly in older migrations that haven't been tested recently.

## Best Practices

1. **Always test migrations in dev before production**
   - Deploy, verify, revert, re-deploy

2. **Write complete revert scripts**
   - Don't use `ROLLBACK;` placeholders in production

3. **Use templates for common operations**
   - Start from `postgres/migrations/templates/` for standard patterns
   - Include metadata INSERTs, grants, RLS policies, and NOTIFY in every migration

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

9. **🚨 CRITICAL: Never overwrite instance data in migrations**
   - Migrations change the **shape** of metadata, not the **content**
   - Dashboard widgets, display names, and translations are instance-specific — never UPDATE or replace them
   - See "Instance-Specific Data Is Off-Limits" in the Architecture section above

10. **🚨 CRITICAL: Always include NOTIFY at the end of migrations**
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
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Civic OS Production Deployment Guide](../../docs/deployment/PRODUCTION.md)

## Support

For issues or questions:
- GitHub Issues: https://github.com/civic-os/frontend/issues
- Documentation: https://docs.civic-os.org
