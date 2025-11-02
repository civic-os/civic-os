# Broader Impacts Tracking System

A Civic OS deployment for tracking organizations, contacts, projects, and their broader societal impact categories.

## Overview

This deployment tracks:
- **Organizations** - Academic, non-profit, government, corporate, and foundation partners
- **Contacts** - Individual collaborators and project contributors
- **Projects** - Research and engagement initiatives with impact tracking
- **Interest Centers** - Areas of focus (Education, Environment, Health, etc.)
- **Broader Impact Categories** - NSF-style broader impact classifications

### Key Features

- **Full-text search** on organizations, contacts, and projects
- **Many-to-many relationships** for projects ↔ contacts, organizations/contacts/projects ↔ impact categories
- **Role-based permissions**:
  - User/Collaborator: Read-only access
  - Admin: Full CRUD access
- **Auto-generated contact display names** from first_name + last_name
- **Lookup tables** for organization types and project statuses

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Node.js 20+ and npm (for Angular frontend)
- jq (for Keycloak JWKS script)

### 1. Review Environment Settings

Check the `.env` file and update the database password if needed:

```bash
cat .env
# Update POSTGRES_PASSWORD if you want a different password
```

### 2. Fetch Keycloak JWT Secret

```bash
./fetch-keycloak-jwk.sh
```

This fetches the public key from the shared Keycloak instance at `auth.civic-os.org`.

### 3. Start Database Services

```bash
docker-compose up -d
```

This will:
- Create PostgreSQL 17 + PostGIS database
- Run all initialization scripts in `init-scripts/` (creates tables, permissions, seed data, search indexes)
- Start PostgREST API on port 3001
- Start Swagger UI on port 8082

### 4. Verify Database Initialization

Check that all tables were created successfully:

```bash
# View PostgreSQL logs
docker-compose logs postgres

# Test PostgREST API
curl http://localhost:3001/schema_entities
curl http://localhost:3001/organizations
```

### 5. Start Angular Frontend

From the **project root** (not this directory):

```bash
cd ..
npm start
```

The frontend will be available at http://localhost:4200

**Important**: The Angular app is shared across all Civic OS deployments. To point it at this database, you may need to update the API URL in `src/environments/environment.development.ts` to `http://localhost:3001/` (note the port 3001 instead of 3000).

### 6. Access the Application

Open http://localhost:4200 in your browser. You should see:

- Dashboard with entity cards for Organizations, Contacts, Projects, etc.
- Menu with all entities (sorted by display order)
- Full CRUD functionality (if you have admin role)

## Database Schema

### Core Entities

| Table | Description | Key Fields |
|-------|-------------|------------|
| `organizations` | Partner organizations | display_name, organization_type_id, address, email, website, description |
| `contacts` | Individual collaborators | first_name, last_name, email, phone, organization_id, title, description |
| `projects` | Research/engagement projects | display_name, organization_id, interest_center_id, start_date, end_date, status_id, description |
| `interest_centers` | Areas of focus | display_name, description |
| `broader_impact_categories` | Impact classifications | display_name, description |

### Lookup Tables

| Table | Description | Seed Values |
|-------|-------------|-------------|
| `organization_types` | Types of organizations | Academic, Non-Profit, Government, Corporate, Foundation |
| `project_statuses` | Project lifecycle states | Planning, Active, Completed, On Hold, Cancelled |

### Junction Tables (Many-to-Many)

| Table | Relationship | Purpose |
|-------|--------------|---------|
| `organization_broader_impact_categories` | Organizations ↔ Impact Categories | Tag organizations with impact areas |
| `contact_projects` | Contacts ↔ Projects | Track which contacts work on which projects |
| `contact_broader_impact_categories` | Contacts ↔ Impact Categories | Tag contacts with expertise areas |
| `project_broader_impact_categories` | Projects ↔ Impact Categories | Classify projects by impact categories |

**Note**: Junction tables are automatically hidden from the menu and managed via the many-to-many editor on Detail pages.

## Permissions & Roles

This deployment uses a **moderate RBAC model**:

| Role | Permissions | Use Case |
|------|-------------|----------|
| `anonymous` | No access | Public users (no dashboard access yet) |
| `user` | Read-only | Authenticated users with basic access |
| `collaborator` | Read-only (all data) | Partners with full dataset visibility |
| `admin` | Full CRUD | Data managers and administrators |

**Current Setup**: User and collaborator roles have identical permissions (read-only). Future enhancements can differentiate field-level visibility.

### Assigning Roles

Roles are assigned via Keycloak JWT claims. To test with different roles:

1. Use your own Keycloak instance (see `docs/AUTHENTICATION.md`)
2. Create users and assign roles in Keycloak admin console
3. The `collaborator` role is auto-created in `02_broader_impacts_permissions.sql`

## Full-Text Search

Search is enabled on:
- **Organizations**: Searches display_name and description
- **Contacts**: Searches first_name, last_name, and email
- **Projects**: Searches display_name and description

Search is powered by PostgreSQL tsvector columns with GIN indexes for fast queries.

## Mock Data Generation

The broader-impacts deployment includes a domain-specific mock data generator customized for research impact tracking.

### Running Mock Data Generator

```bash
cd broader-impacts
set -a && source .env && set +a  # Load database connection vars
npx ts-node generate-mock-data.ts       # Direct insert to database
npx ts-node generate-mock-data.ts --sql # Generate SQL file (default)
```

The SQL file will be saved to `mock_data.sql`. To load it:

```bash
docker exec -i broader_impacts_postgres psql -U postgres -d broader_impacts_db < mock_data.sql
```

### Configuration

Edit `mock-data-config.json` to control:
- **Record counts**: Organizations (30), Contacts (75), Projects (40), Junction tables (60-120)
- **Geographic bounds**: US continental area for any geography fields
- **Excluded tables**: Lookup tables only (organization_types, project_statuses)
- **Output format**: SQL file generation (default)

### Domain-Specific Generation

The generator creates realistic broader impacts data:
- **Organizations**: "Institute for Sustainable Development", "Foundation for Climate Action"
- **Projects**: "Study of Community Health Outcomes in Underserved Communities"
- **Contacts**: Realistic human names (first_name/last_name) with associated organizations
- **Junction tables**: Automatically generates unique combinations with duplicate prevention
- Validates all field length and constraint rules

**Many-to-Many Relationships**: The generator automatically detects junction tables and creates unique relationship combinations, preventing duplicates. Each junction table respects composite primary key constraints.

## Ports and Services

This deployment uses different ports than the example Pot Hole system to avoid conflicts:

| Service | Port | URL |
|---------|------|-----|
| PostgreSQL | 15433 | `localhost:15433` |
| PostgREST | 3001 | `http://localhost:3001` |
| Swagger UI | 8082 | `http://localhost:8082` |
| Angular Frontend | 4200 | `http://localhost:4200` |

## Customization

### Adding New Impact Categories

```sql
docker exec -it broader_impacts_postgres psql -U postgres -d broader_impacts_db

INSERT INTO broader_impact_categories (display_name, description) VALUES
  ('New Category', 'Description of the new impact area');
```

### Adding New Organization Types

```sql
INSERT INTO organization_types (display_name, description) VALUES
  ('New Type', 'Description of the organization type');
```

### Customizing Entity Display

Update metadata to change labels, descriptions, and field ordering:

```sql
-- Change how an entity appears in the menu
UPDATE metadata.entities
SET display_name = 'Custom Name', description = 'Custom description'
WHERE table_name = 'organizations';

-- Change a field label
UPDATE metadata.properties
SET display_name = 'Custom Label'
WHERE table_name = 'organizations' AND column_name = 'email';
```

## Troubleshooting

### Tables don't appear in the UI

1. Check that PostgREST is running: `docker-compose ps`
2. Verify tables exist: `curl http://localhost:3001/schema_entities`
3. Check permissions: Ensure you're logged in with a valid Keycloak token

### Permission denied errors

1. Verify your JWT contains the correct roles:
   - Decode your token at https://jwt.io
   - Check the `resource_access.myclient.roles` claim
2. Ensure you have at least the `user` role for read access
3. Admin operations require the `admin` role

### Search not working

1. Verify text search columns exist:
   ```sql
   \d organizations
   # Should show civic_os_text_search column
   ```
2. Check that indexes were created: `\di` (should show idx_organizations_text_search, etc.)
3. Verify search_fields are configured:
   ```sql
   SELECT table_name, search_fields FROM metadata.entities WHERE search_fields IS NOT NULL;
   ```

### Database initialization failed

1. Check logs: `docker-compose logs postgres`
2. Recreate database: `docker-compose down -v && docker-compose up -d`
3. Verify init scripts are executable: `ls -l init-scripts/`

## Database Maintenance

### Resetting the Database

To completely reset and reinitialize:

```bash
# WARNING: This deletes all data
docker-compose down -v
docker-compose up -d
```

### Backing Up Data

```bash
docker exec broader_impacts_postgres pg_dump -U postgres broader_impacts_db > backup.sql
```

### Restoring Data

```bash
docker exec -i broader_impacts_postgres psql -U postgres -d broader_impacts_db < backup.sql
```

## Next Steps

1. **Customize Metadata** - Fine-tune display names, field ordering, and visibility
2. **Generate Mock Data** - Create test data for development and demos
3. **Configure Roles** - Set up your own Keycloak for custom role definitions
4. **Add Validation** - Implement field validation rules (see `docs/development/ADVANCED_VALIDATION.md`)
5. **Deploy to Production** - See production deployment guide (coming soon)

## Related Documentation

- **[Civic OS Main README](../README.md)** - Project overview and getting started
- **[CLAUDE.md](../CLAUDE.md)** - Comprehensive developer guide
- **[NEW_DEPLOYMENT.md](../docs/deployment/NEW_DEPLOYMENT.md)** - Creating custom deployments
- **[AUTHENTICATION.md](../docs/AUTHENTICATION.md)** - Keycloak setup and RBAC
- **[TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md)** - Common issues and solutions

## License

This deployment is part of Civic OS, licensed under AGPL-3.0-or-later. See [LICENSE](../LICENSE) for details.
