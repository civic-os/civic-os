# Mock Data Generator

This directory contains the Civic OS mock data generator, a TypeScript tool that creates realistic test data for demonstration and testing purposes.

## Overview

The mock data generator:
- Reads your database schema and validation rules from PostgreSQL
- **Validation-aware**: Generates data that complies with min/max, minLength/maxLength, and pattern constraints
- Automatically generates appropriate fake data based on property types
- Handles foreign key dependencies (inserts in correct order)
- Supports all Civic OS property types including geography points
- Inserts directly to database (recommended) or outputs SQL files (legacy)

## Quick Start

### 1. Ensure Database is Running

Make sure your PostgreSQL database is running via Docker Compose:

```bash
cd example
docker-compose up -d
```

### 2. Generate Mock Data

The script needs database credentials to connect. Use one of these approaches:

**Option A: Insert Directly into Database** (RECOMMENDED)

```bash
# Load and export environment variables, then run generator
set -a && source example/.env && set +a && npm run generate:mock
```

Or use the seed alias:
```bash
set -a && source example/.env && set +a && npm run generate:seed
```

This approach:
- Inserts data directly to the database
- Allows schema changes to flow smoothly without static SQL file conflicts
- Generates validation-compliant data every time
- Can be run repeatedly to refresh test data

**Option B: Generate SQL File** (legacy, for reference only)

```bash
# Load and export environment variables, then run generator with --sql flag
set -a && source example/.env && set +a && npm run generate:mock -- --sql
```

This creates `example/init-scripts/05_mock_data.sql.deprecated` which you can review. However, static SQL files are no longer used in init scripts because they become stale when the schema changes.

**Why the `set -a` approach?**
- `source` alone doesn't export variables to child processes
- npm spawns a new shell process that needs exported variables
- `set -a` enables auto-export mode, `set +a` disables it after sourcing

## Configuration

Edit `scripts/mock-data-config.json` to customize:

```json
{
  "recordsPerEntity": {
    "Issue": 25,
    "WorkPackage": 5,
    "Bid": 15,
    "WorkDetail": 30
  },
  "geographyBounds": {
    "minLat": 42.25,
    "maxLat": 42.45,
    "minLng": -83.30,
    "maxLng": -82.90
  },
  "excludeTables": [
    "IssueStatus",
    "WorkPackageStatus"
  ],
  "outputFormat": "sql",
  "outputPath": "./example/init-scripts/03_mock_data.sql",
  "generateUsers": true,
  "userCount": 15
}
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `recordsPerEntity` | Object | Number of records to generate per table. Default: 10 per table |
| `geographyBounds` | Object | Lat/lng bounds for generating geography points |
| `excludeTables` | Array | Tables to skip (e.g., seed data tables like IssueStatus, WorkPackageStatus) |
| `outputFormat` | String | `"sql"` for file output or `"insert"` for direct insertion |
| `outputPath` | String | Where to save the SQL file |
| `generateUsers` | Boolean | Generate mock users (civic_os_users and civic_os_users_private). Default: false |
| `userCount` | Number | Number of mock users to generate. Default: 10 |

## Database Connection

The script connects to PostgreSQL to fetch schema metadata (even in SQL output mode). It uses environment variables that match `example/.env`.

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST` | `localhost` | Database host |
| `POSTGRES_PORT` | `15432` | Database port (Docker mapped port) |
| `POSTGRES_DB` | `civic_os_db` | Database name |
| `POSTGRES_USER` | `postgres` | Database user |
| `POSTGRES_PASSWORD` | `postgres` | Database password |

**Passing Variables:**

```bash
# Option 1: Use set -a to auto-export when sourcing (RECOMMENDED)
set -a && source example/.env && set +a && npm run generate:mock

# Option 2: Inline environment variables
POSTGRES_PASSWORD=your_password npm run generate:mock

# Option 3: Export manually
export POSTGRES_PASSWORD=your_password
npm run generate:mock
```

**Why `set -a`?**
- `set -a` (allexport) makes all variable assignments automatically exported
- Works reliably on both bash and zsh (macOS default since Catalina)
- Safely handles values with spaces, quotes, and special characters
- Avoid unsafe alternatives like `export $(cat .env | xargs)` which break with spaces

## How It Works

### 1. Schema Discovery

The generator connects to your database and fetches:
- `schema_entities` - List of all tables
- `schema_properties` - All columns with metadata
- `metadata.validations` - Validation rules (min, max, minLength, maxLength, pattern)

The validation rules are used to generate compliant data. For example:
- If `Issue.severity_level` has min=1 and max=5, the generator produces integers between 1-5
- If `Tag.display_name` has maxLength=50, the generator produces strings ≤50 characters
- If `Issue.contact_phone` has pattern=`^\d{10}$`, the generator produces 10-digit phone numbers

### 2. User Generation (Optional)

If `generateUsers` is enabled in config, the generator creates mock users FIRST:

**civic_os_users:**
- Generates UUIDs using `faker.string.uuid()`
- Creates unique display names using `faker.person.fullName()`
- Ensures no duplicate names (required by unique constraint)

**civic_os_users_private:**
- Uses **same UUIDs** as civic_os_users (foreign key constraint)
- Copies same display_name from civic_os_users
- Generates realistic emails based on names (e.g., "john.smith@example.com")
- Generates phone numbers in format ###-###-####

The generated user UUIDs are then available for other tables that reference users via foreign keys.

### 3. Dependency Resolution

Foreign key relationships are analyzed to determine insert order. For example:
1. `civic_os_users` (if generateUsers enabled)
2. `civic_os_users_private` (if generateUsers enabled)
3. `IssueStatus` (no dependencies)
4. `WorkPackageStatus` (no dependencies)
5. `WorkPackage` (depends on WorkPackageStatus)
6. `Issue` (depends on IssueStatus, WorkPackage, civic_os_users)
7. `Bid` (depends on WorkPackage, civic_os_users)

### 4. Data Generation

For each table, the generator creates fake data based on property types:

| Property Type | Generated Data |
|---------------|----------------|
| `TextShort` | Product names, lorem ipsum (3 words) |
| `TextLong` | Lorem ipsum paragraphs |
| `IntegerNumber` | Random integers (1-1000) |
| `Money` | Currency values ($10-$10,000) |
| `Boolean` | Random true/false |
| `Date` | Recent dates (last 30 days) |
| `DateTime` | Recent timestamps (last 30 days) |
| `ForeignKeyName` | Random ID from related table |
| `User` | Random user ID from civic_os_users |
| `GeoPoint` | Random coordinates within bounds (EWKT format) |

**Special Handling:**
- `display_name` fields use product names for better readability
- `created_at` and `updated_at` get realistic recent timestamps
- Nullable fields have 30% chance of being null (except display_name)
- Geography points are generated in EWKT format: `SRID=4326;POINT(lng lat)`

### 5. Output

**SQL Mode:**
Creates a properly formatted SQL file with:
- Header comments with generation timestamp
- INSERT statements with proper escaping
- `NOTIFY pgrst, 'reload schema'` at the end

**Insert Mode:**
Executes INSERT statements directly via PostgreSQL client.

## Example Output

Generated SQL looks like this:

```sql
-- =====================================================
-- Mock Data Generated by Civic OS Mock Data Generator
-- Generated at: 2025-01-15T10:30:00.000Z
-- =====================================================

-- Insert mock data for Issue
INSERT INTO "public"."Issue" ("display_name", "status", "created_user", "location") VALUES
  ('Incredible Wooden Shirt', '1', 'a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6', 'SRID=4326;POINT(-83.125678 42.334567)'),
  ('Awesome Steel Gloves', '2', 'b2c3d4e5-f6g7-h8i9-j0k1-l2m3n4o5p6q7', 'SRID=4326;POINT(-83.098234 42.389012)'),
  ('Handmade Cotton Shoes', '1', 'c3d4e5f6-g7h8-i9j0-k1l2-m3n4o5p6q7r8', 'SRID=4326;POINT(-83.245678 42.276543)');

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
```

## Integration with Docker

To use generated SQL in your Docker setup:

1. Generate the SQL file:
   ```bash
   npm run generate:mock
   ```

2. The file is saved to `example/init-scripts/03_mock_data.sql`

3. Recreate your database to apply:
   ```bash
   cd example
   docker-compose down -v  # -v removes volumes
   docker-compose up -d
   ```

Docker init scripts run in alphabetical order:
- `00_init.sh` - Runs core Civic OS SQL
- `01_pot_hole_schema.sql` - Example schema
- `02_pot_hole_data.sql` - Seed data (status tables)
- `03_mock_data.sql` - Your generated test data

## Tips

**Realistic Geography Bounds:**

For different cities, update `geographyBounds` in the config:

```json
// Detroit
"geographyBounds": { "minLat": 42.25, "maxLat": 42.45, "minLng": -83.30, "maxLng": -82.90 }

// San Francisco
"geographyBounds": { "minLat": 37.70, "maxLat": 37.80, "minLng": -122.50, "maxLng": -122.38 }

// New York City
"geographyBounds": { "minLat": 40.70, "maxLat": 40.80, "minLng": -74.02, "maxLng": -73.93 }
```

**Varying Record Counts:**

Generate different amounts of data per table:

```json
"recordsPerEntity": {
  "Issue": 100,        // Many issues
  "WorkPackage": 10,   // Fewer work packages
  "Bid": 50            // Moderate number of bids
}
```

**Preserving Seed Data:**

Always exclude tables with manually crafted seed data:

```json
"excludeTables": [
  "civic_os_users",
  "civic_os_users_private",
  "IssueStatus",
  "WorkPackageStatus"
]
```

**Customizing Display Names:**

The generator uses domain-specific display names for the Pot Hole Observation System:

- **Issue**: `"Large pothole on Main Street"` - Road issue descriptions with size, type, and location
- **WorkPackage**: `"Q2 2024 road repairs - Detroit"` - Project scope with period, year, and area
- **Bid**: `"ABC Construction proposal"` - Contractor bid with company name
- **WorkDetail**: `"Inspected damage extent and recommended materials"` - Work notes with action and finding
- **Default**: Generic product names for other tables

To customize for your domain, edit the `generateDisplayName()` method in `scripts/generate-mock-data.ts`:

```typescript
private generateDisplayName(tableName: string): string {
  switch (tableName) {
    case 'YourTable': {
      // Your custom logic using Faker
      const adjective = faker.word.adjective();
      const noun = faker.word.noun();
      return `${adjective} ${noun}`;
    }
    default:
      return faker.commerce.productName();
  }
}
```

Available Faker modules for building display names:
- `faker.lorem.sentence()`, `words()` - Generic text
- `faker.location.street()`, `city()`, `state()` - Places
- `faker.company.name()`, `catchPhrase()` - Business names
- `faker.word.adjective()`, `noun()`, `verb()` - Building blocks
- `faker.date.month()`, `weekday()` - Time periods
- `faker.helpers.arrayElement([...])` - Pick from custom lists

## Troubleshooting

**Error: "Database not connected"**
- Ensure Docker Compose is running: `docker-compose ps`
- Check connection settings match `.env` file in `example/` directory

**Error: "No users found in civic_os_users table"**
- The database needs at least one user for foreign key references
- Check that core Civic OS migrations have run (`sqitch deploy`)
- User table is created in the baseline migration (`postgres/migrations/deploy/v0-4-0-baseline.sql`)

**Generated SQL has syntax errors**
- Check for special characters in your data
- The generator escapes single quotes automatically
- Report issues at: [GitHub Issues](https://github.com/your-repo/issues)

**Foreign key violations**
- Dependencies are resolved automatically
- If errors occur, check for circular dependencies
- Exclude problematic tables and populate manually

## Development

The generator is written in TypeScript and can be extended:

**File Structure:**
- `generate-mock-data.ts` - Main script
- `mock-data-config.json` - Configuration
- `README.md` - This file

**Adding Custom Data Generators:**

Edit the `generateFakeValue()` method in `generate-mock-data.ts`:

```typescript
if (prop.column_name === 'email') {
  return faker.internet.email();
}
if (prop.column_name === 'phone') {
  return faker.phone.number();
}
```

**Available Faker Methods:**

See [@faker-js/faker documentation](https://fakerjs.dev/) for all available generators.
