# Civic OS - New Deployment Setup Guide

This guide walks you through deploying a **new Civic OS instance** with your own database schema and domain model. Use this when you want to create a custom application (e.g., Library Management, Fleet Tracking, Volunteer Management) using the Civic OS framework.

**Prerequisites**: This guide assumes you have a database ERD or schema design ready to implement. For a quick introduction to Civic OS using the example Pot Hole domain, see the main [README.md](../../README.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Step 1: Create Your Deployment Folder](#step-1-create-your-deployment-folder)
4. [Step 2: Convert Your ERD to SQL Schema](#step-2-convert-your-erd-to-sql-schema)
5. [Step 3: Set Up Database Initialization Scripts](#step-3-set-up-database-initialization-scripts)
6. [Step 4: Configure Docker Compose](#step-4-configure-docker-compose)
7. [Step 5: Configure Environment Variables](#step-5-configure-environment-variables)
8. [Step 6: Set Up Authentication](#step-6-set-up-authentication)
9. [Step 7: Start Your Services](#step-7-start-your-services)
10. [Step 8: Configure File Storage (Optional)](#step-8-configure-file-storage-optional)
11. [Step 9: Configure Metadata (Optional)](#step-9-configure-metadata-optional)
12. [Step 10: Generate Mock Data](#step-10-generate-mock-data)
13. [Step 11: Access Your Application](#step-11-access-your-application)
13. [Schema Design Best Practices](#schema-design-best-practices)
14. [Troubleshooting](#troubleshooting)
15. [Example Walkthrough](#example-walkthrough)

---

## Overview

### What This Guide Covers

This guide helps you:
- Create a new deployment instance parallel to the `examples/pothole/` folder
- Convert your ERD to Civic OS-compatible SQL schema
- Set up Docker Compose with PostgreSQL, PostgREST, Keycloak, and file storage
- Configure permissions and metadata
- Set up S3-compatible file storage for uploads (images, PDFs, documents)
- Generate realistic mock data for testing

### How Civic OS Works

Civic OS is a **metadata-driven framework** that automatically generates UI from your database schema:

```
Your PostgreSQL Schema
  ↓
Civic OS reads metadata via schema_entities & schema_properties views
  ↓
Angular frontend auto-generates List/Detail/Create/Edit pages
  ↓
Smart components adapt to property types (text, date, geography, foreign keys, files, etc.)
  ↓
Go microservices handle file uploads via River job queue
```

**Key Concept**: You define your schema in SQL, and Civic OS handles the UI. No manual form building required!

**File Storage (v0.10.0+)**: Civic OS includes built-in support for file uploads (images, PDFs, documents) with automatic thumbnail generation. Uses S3-compatible storage (AWS S3, MinIO, DigitalOcean Spaces) and Go microservices for reliable background processing.

---

## Prerequisites

Before starting, ensure you have:

- **Node.js 20+** and npm installed
- **Docker** and Docker Compose installed
- **Git** for version control
- **Basic PostgreSQL knowledge** (creating tables, foreign keys, constraints)
- **An ERD or schema design** for your application domain
- **(Optional) pgAdmin or similar** for database inspection

---

## Step 1: Create Your Deployment Folder

Create a new folder parallel to the `examples/pothole/` directory. This keeps your deployment separate from the example Pot Hole system.

```bash
# Navigate to the Civic OS project root
cd civic-os-frontend

# Create your deployment folder (replace 'my-project' with your domain name)
mkdir my-project
cd my-project

# Create required subdirectories
mkdir init-scripts
mkdir src  # Optional: for domain-specific files
```

Your folder structure should look like:

```
civic-os-frontend/
├── examples/pothole/              # Pot Hole example (reference)
├── my-project/           # Your new deployment
│   ├── init-scripts/     # Database initialization SQL
│   ├── docker-compose.yml
│   ├── .env
│   ├── .env.example
│   ├── jwt-secret.jwks
│   └── README.md         # Optional: deployment-specific docs
├── postgres/             # Shared Civic OS core scripts (DO NOT MODIFY)
├── src/                  # Angular frontend (shared across deployments)
└── ...
```

**Important**: The `postgres/` directory contains core Civic OS scripts (PostgREST setup, RBAC, metadata schema). These are **shared** across all deployments. Your application-specific SQL goes in `my-project/init-scripts/`.

---

## Step 2: Convert Your ERD to SQL Schema

Convert your Entity Relationship Diagram to PostgreSQL DDL (Data Definition Language).

### Required Conventions

To work with Civic OS, your schema must follow these conventions:

#### 1. Table Naming
- Use the `public` schema for application tables
- **Preferred**: UpperCamelCase for entity tables (e.g., `WorkPackage`, `ProjectStatus`, `IssueCategory`)
- Alternative: snake_case for entity tables (e.g., `work_package`, `project_status`, `issue_category`)
- **Junction tables**: Always use snake_case (e.g., `issue_tags`, `project_contacts`)
- Avoid reserved PostgreSQL keywords

**Rationale**: UpperCamelCase provides better semantic clarity in routes (`/view/ProjectStatus` vs `/view/project_status`) and aligns with entity-oriented thinking. Junction tables use snake_case by convention to clearly distinguish them as relationship tables.

#### 2. Primary Keys
- Every table **must** have a primary key
- Recommended: Auto-incrementing `SERIAL` or `BIGSERIAL` for `id` columns
- For junction tables (many-to-many), use **composite primary keys** (not surrogate IDs)

#### 3. Required Columns
Each table should have:
- `id` - Primary key (SERIAL or BIGSERIAL)
- `display_name` - User-friendly name (TEXT or VARCHAR) - **REQUIRED** for Civic OS
- `created_at` - Timestamp with timezone (TIMESTAMPTZ) - Default: `NOW()`
- `updated_at` - Timestamp with timezone (TIMESTAMPTZ) - Default: `NOW()`

#### 4. Foreign Keys
- Always create explicit `FOREIGN KEY` constraints
- Use `ON DELETE CASCADE` or `ON DELETE SET NULL` as appropriate
- **CRITICAL**: Create indexes on all foreign key columns (PostgreSQL doesn't auto-index FKs)

Example:
```sql
CREATE INDEX idx_books_author_id ON books(author_id);
```

#### 5. Timestamps
Use trigger functions for automatic timestamp management:

```sql
-- Apply to every table
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON public.my_table
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON public.my_table
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
```

**Note**: The `set_created_at()` and `set_updated_at()` functions are provided by the Civic OS baseline migration (`postgres/migrations/deploy/v0-4-0-baseline.sql`).

### Property Types

Civic OS automatically detects property types based on PostgreSQL data types. Here's the mapping:

| PostgreSQL Type | Civic OS Type | UI Component |
|----------------|---------------|--------------|
| `TEXT`, `VARCHAR` (short) | `TextShort` | Single-line input |
| `TEXT`, `VARCHAR` (long) | `TextLong` | Textarea |
| `INT4`, `INT8`, `SERIAL`, `BIGSERIAL` | `IntegerNumber` | Number input |
| `NUMERIC`, `DECIMAL` | `DecimalNumber`* | Number input with decimals |
| `MONEY` | `Money` | Currency input |
| `BOOL`, `BOOLEAN` | `Boolean` | Checkbox |
| `DATE` | `Date` | Date picker |
| `TIMESTAMP` | `DateTime` | Date + time picker (no TZ conversion) |
| `TIMESTAMPTZ` | `DateTimeLocal` | Date + time picker (with TZ conversion) |
| `UUID` (FK to civic_os_users) | `User` | User selector |
| `INT`/`BIGINT` (with FK) | `ForeignKeyName` | Dropdown with related entity |
| `geography(Point, 4326)` | `GeoPoint` | Interactive Leaflet map |
| `hex_color` domain | `Color` | Color picker with swatch |

*`DecimalNumber`: Partial support - display works but type detection from PostgreSQL schema not yet implemented. Use `money` type for currency or `int4`/`int8` for integers.

#### Geography (GeoPoint) Pattern

For location columns, use PostGIS geography type with a computed text field:

```sql
-- Add geography column
ALTER TABLE my_table ADD COLUMN location postgis.geography(Point, 4326);

-- Create computed field function for PostgREST (REQUIRED)
CREATE OR REPLACE FUNCTION public.location_text(my_table)
RETURNS text AS $$
  SELECT postgis.ST_AsText($1.location);
$$ LANGUAGE SQL STABLE;

GRANT EXECUTE ON FUNCTION public.location_text(my_table) TO web_anon, authenticated;
```

**Data Format**:
- **Insert/Update**: EWKT format: `'SRID=4326;POINT(lng lat)'`
- **Read**: WKT format: `'POINT(lng lat)'` (via computed field)

#### Color Pattern

Use the `hex_color` domain (defined in core Civic OS scripts):

```sql
CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(50) NOT NULL,
  color hex_color NOT NULL DEFAULT '#3B82F6',  -- Blue
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

The domain enforces `#RRGGBB` format automatically.

### Many-to-Many Relationships

For many-to-many relationships, create a junction table with a **composite primary key**:

```sql
-- Example: Books can have multiple authors, authors can write multiple books
CREATE TABLE book_authors (
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id BIGINT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (book_id, author_id)  -- Composite key (NOT surrogate id)
);

-- REQUIRED: Index both foreign keys
CREATE INDEX idx_book_authors_book_id ON book_authors(book_id);
CREATE INDEX idx_book_authors_author_id ON book_authors(author_id);
```

**Important**: Civic OS auto-detects junction tables and hides them from the menu. The many-to-many editor appears on Detail pages.

---

## Step 3: Set Up Database Initialization Scripts

Create SQL scripts in `my-project/init-scripts/`. Docker runs these scripts **in alphabetical order** when the database is first created.

### Required Scripts

#### `00_init.sh` - Core Script Runner

This script runs all Civic OS core scripts from the `postgres/` directory.

**Copy from example:**
```bash
cp ../examples/pothole/init-scripts/00_init.sh ./init-scripts/00_init.sh
```

**Contents** (should look like this):
```bash
#!/bin/bash
set -e

echo "======================================"
echo "Running Civic OS Core Scripts"
echo "======================================"

# Run all SQL scripts from the postgres directory in order
for script in /civic-os-core/*.sql; do
    if [ -f "$script" ]; then
        echo "Executing: $(basename $script)"
        psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$script"
    fi
done

echo "======================================"
echo "Civic OS Core Scripts Complete"
echo "======================================"
```

**Make it executable:**
```bash
chmod +x ./init-scripts/00_init.sh
```

#### `01_<domain>_schema.sql` - Your Application Tables

This is where you define your application tables. Replace `<domain>` with your domain name (e.g., `01_library_schema.sql`).

**Template:**
```sql
-- =====================================================
-- Your Application Name - Schema
-- =====================================================

-- Table 1: Example entity
CREATE TABLE public.authors (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  display_name TEXT NOT NULL,
  bio TEXT,
  birth_year INT
);

-- Table 2: Entity with foreign key
CREATE TABLE public.books (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  display_name TEXT NOT NULL,
  isbn VARCHAR(13),
  publication_year INT,
  author_id BIGINT NOT NULL REFERENCES authors(id)
);

-- Create indexes (CRITICAL for foreign keys)
CREATE INDEX idx_books_author_id ON public.books(author_id);

-- Grant permissions to PostgREST roles
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.authors TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.books TO web_anon, authenticated;

-- Grant sequence permissions (for SERIAL columns)
GRANT USAGE ON SEQUENCE public.authors_id_seq TO web_anon, authenticated;
GRANT USAGE ON SEQUENCE public.books_id_seq TO web_anon, authenticated;

-- Enable Row Level Security (RLS)
ALTER TABLE public.authors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;

-- Apply timestamp triggers
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON public.authors
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON public.authors
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON public.books
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON public.books
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
```

#### `02_<domain>_permissions.sql` - Row Level Security Policies

Define RLS policies for role-based access control.

**⚠️ CRITICAL: Permission Naming Convention**

The second parameter of `has_permission()` **MUST** use lowercase semantic names, NOT uppercase SQL operations:

| ✅ CORRECT | ❌ WRONG |
|-----------|---------|
| `'read'` | `'SELECT'` |
| `'create'` | `'INSERT'` |
| `'update'` | `'UPDATE'` |
| `'delete'` | `'DELETE'` |

**Why This Matters**: The `metadata.permissions` table stores permissions as `'read'`, `'create'`, `'update'`, `'delete'`. Using uppercase SQL operations (`'SELECT'`, `'INSERT'`, etc.) causes **complete data invisibility** - all tables will appear empty because permission checks fail silently.

If you copy-paste RLS policies from other PostgreSQL resources, you **must** convert the permission names to lowercase semantic equivalents. This is the #1 cause of "permission denied" errors in new deployments.

**Template:**
```sql
-- =====================================================
-- Your Application Name - Permissions
-- =====================================================

-- RLS Policies for authors table
CREATE POLICY "authors: read permission" ON public.authors
  FOR SELECT
  TO PUBLIC
  USING (public.has_permission('authors', 'read'));

CREATE POLICY "authors: create permission" ON public.authors
  FOR INSERT
  TO PUBLIC
  WITH CHECK (public.has_permission('authors', 'create'));

CREATE POLICY "authors: update permission" ON public.authors
  FOR UPDATE
  TO PUBLIC
  USING (public.has_permission('authors', 'update'))
  WITH CHECK (public.has_permission('authors', 'update'));

CREATE POLICY "authors: delete permission" ON public.authors
  FOR DELETE
  TO PUBLIC
  USING (public.has_permission('authors', 'delete'));

-- Repeat for other tables...
```

**Note**: The `has_permission()` function is provided by the Civic OS baseline migration (`postgres/migrations/deploy/v0-4-0-baseline.sql`).

#### `03_<domain>_data.sql` - Seed Data

Insert initial/seed data (status lookup tables, initial users, etc.).

**Template:**
```sql
-- =====================================================
-- Your Application Name - Seed Data
-- =====================================================

-- Seed data for authors
INSERT INTO public.authors (display_name, bio, birth_year) VALUES
  ('J.K. Rowling', 'British author best known for Harry Potter', 1965),
  ('Stephen King', 'American author of horror and suspense', 1947),
  ('Agatha Christie', 'English writer known for detective novels', 1890);

-- Metadata: Configure entity display names and descriptions
INSERT INTO metadata.entities (table_name, display_name, description, sort_order) VALUES
  ('authors', 'Authors', 'Book authors and writers', 10),
  ('books', 'Books', 'Library book collection', 20)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
```

#### Optional: `04_<domain>_validation.sql` - Validation Rules

Add frontend validation rules and CHECK constraints. See `examples/pothole/init-scripts/02_validation_examples.sql` for patterns.

**Example:**
```sql
-- CHECK constraint (backend enforcement)
ALTER TABLE public.books
  ADD CONSTRAINT isbn_valid_length CHECK (char_length(isbn) = 13 OR isbn IS NULL);

-- Validation metadata (frontend UX)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('books', 'isbn', 'minLength', '13', 'ISBN must be exactly 13 digits', 1);

-- Constraint error message mapping
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES ('isbn_valid_length', 'books', 'isbn', 'ISBN must be exactly 13 digits');
```

#### Optional: `05_<domain>_indexes.sql` - Additional Indexes

Create performance indexes for frequently queried columns.

**Example:**
```sql
-- Index for text search
CREATE INDEX idx_books_display_name ON public.books USING btree (display_name);

-- Index for filtering
CREATE INDEX idx_books_publication_year ON public.books(publication_year);
```

---

## Step 4: Configure Docker Compose

Copy the example Docker Compose file and customize it for your deployment.

```bash
# From your my-project directory
cp ../examples/pothole/docker-compose.yml ./docker-compose.yml
```

### Services Included

The Docker Compose configuration includes:

**Core Services:**
- **PostgreSQL** with PostGIS - Database with spatial extensions
- **PostgREST** - REST API layer with JWT authentication
- **Swagger UI** (optional) - API documentation viewer

**File Storage Services (v0.10.0+):**
- **MinIO** - S3-compatible object storage for local development
- **S3 Signer** - Go microservice that generates presigned upload URLs
- **Thumbnail Worker** - Go microservice that generates image/PDF thumbnails
- **MinIO Init** - One-time setup container to create S3 bucket

**Authentication (optional):**
- **Keycloak** - Identity provider for RBAC (commented out by default)

### Key Configuration Points

The default configuration should work out of the box, but review these sections:

#### PostgreSQL Service
```yaml
postgres:
  image: postgis/postgis:17-3.5-alpine
  platform: linux/amd64
  container_name: postgres_db  # Change if running multiple instances
  ports:
    - "15432:5432"  # Change external port to avoid conflicts
  environment:
    POSTGRES_DB: ${POSTGRES_DB}
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
  volumes:
    - postgres_data:/var/lib/postgresql/data
    - ../postgres:/civic-os-core:ro  # Core Civic OS scripts
    - ./init-scripts:/docker-entrypoint-initdb.d  # Your scripts
```

**Important Volume Mounts**:
- `../postgres:/civic-os-core:ro` - Mounts shared core scripts (read-only)
- `./init-scripts:/docker-entrypoint-initdb.d` - Mounts your init scripts

#### PostgREST Service
```yaml
postgrest:
  image: postgrest/postgrest:latest
  container_name: postgrest_api  # Change if running multiple instances
  ports:
    - "3000:3000"  # Change external port to avoid conflicts
  environment:
    PGRST_DB_URI: postgres://authenticator:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    PGRST_DB_SCHEMA: public
    PGRST_DB_ANON_ROLE: web_anon
    PGRST_DB_PRE_REQUEST: "metadata.check_jwt"
    PGRST_JWT_SECRET: "@/etc/postgrest/jwt-secret.jwks"
    PGRST_JWT_AUD: "account"
  volumes:
    - ./jwt-secret.jwks:/etc/postgrest/jwt-secret.jwks:ro
```

**Key Settings**:
- `PGRST_DB_SCHEMA: public` - Exposes public schema via API (internal helpers are in metadata, accessed via search_path)
- `PGRST_DB_PRE_REQUEST: "metadata.check_jwt"` - Enables JWT validation
- `PGRST_JWT_SECRET` - Path to Keycloak public key (JWKS format)

#### File Storage Services (Optional - Required for File Uploads)

If your application needs file upload capabilities (images, PDFs, documents), the example docker-compose includes:

**MinIO (S3-Compatible Storage):**
```yaml
minio:
  image: minio/minio:latest
  ports:
    - "9000:9000"  # API
    - "9001:9001"  # Web Console
  environment:
    MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
    MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
  command: server /data --console-address ":9001"
```

**Consolidated Worker (File Storage + Thumbnails + Notifications):**
```yaml
consolidated-worker:
  build:
    context: ../../services/consolidated-worker-go
  environment:
    # Database Configuration (shared pool with explicit limits)
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    - DB_MAX_CONNS=${DB_MAX_CONNS:-4}  # Total connections for all workers (default: 4)
    - DB_MIN_CONNS=${DB_MIN_CONNS:-1}

    # S3 Configuration (for S3 Signer and Thumbnail Worker)
    - S3_ENDPOINT=http://minio:9000
    - S3_PUBLIC_ENDPOINT=${S3_PUBLIC_ENDPOINT:-http://localhost:9000}
    - S3_BUCKET=${S3_BUCKET:-civic-os-files}
    - S3_ACCESS_KEY_ID=${MINIO_ROOT_USER:-minioadmin}
    - S3_SECRET_ACCESS_KEY=${MINIO_ROOT_PASSWORD:-minioadmin}
    - S3_REGION=us-east-1

    # Thumbnail Worker Configuration
    - THUMBNAIL_MAX_WORKERS=${THUMBNAIL_MAX_WORKERS:-3}

    # Notification Worker Configuration
    - SITE_URL=${SITE_URL:-http://localhost:4200}
    - NOTIFICATION_TIMEZONE=${NOTIFICATION_TIMEZONE:-America/New_York}
    - SMTP_HOST=${SMTP_HOST:-inbucket}  # Default to Inbucket for local dev
    - SMTP_PORT=${SMTP_PORT:-2500}
    - SMTP_USERNAME=${SMTP_USERNAME:-}
    - SMTP_PASSWORD=${SMTP_PASSWORD:-}
    - SMTP_FROM=${SMTP_FROM:-noreply@example.com}
```

**Key Points:**
- MinIO provides S3-compatible storage for local development
- Consolidated Worker combines S3 presigning, thumbnail generation, and notifications in a single service
- Uses shared PostgreSQL connection pool (4 connections vs 12 with separate services)
- Processes jobs using River queue for reliable background processing
- For production, replace MinIO with AWS S3, DigitalOcean Spaces, or similar
- See `docs/development/FILE_STORAGE.md` and `docs/development/NOTIFICATIONS.md` for implementation guides

---

## Step 5: Configure Environment Variables

Create environment files for your deployment.

### `.env.example` - Template
```bash
# ======================================
# Database Configuration
# ======================================
POSTGRES_DB=my_app_db
POSTGRES_PASSWORD=CHANGE_ME_TO_SECURE_PASSWORD

# ======================================
# Keycloak Settings (update if using your own Keycloak)
# ======================================
KEYCLOAK_URL=https://auth.civic-os.org
KEYCLOAK_REALM=civic-os-dev
KEYCLOAK_CLIENT_ID=myclient

# ======================================
# S3 / File Storage Configuration (Optional)
# Required only if using file upload features
# ======================================
# MinIO credentials (for local development)
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin

# S3 bucket configuration
S3_BUCKET=civic-os-files
S3_PUBLIC_ENDPOINT=http://localhost:9000

# For production: replace MinIO with AWS S3 or DigitalOcean Spaces
# S3_ACCESS_KEY_ID=your-access-key-id
# S3_SECRET_ACCESS_KEY=your-secret-access-key
# S3_REGION=us-east-1
# S3_ENDPOINT=  # Leave empty for AWS, set for MinIO/S3-compatible
# S3_PUBLIC_ENDPOINT=https://s3.yourdomain.com
```

### `.env` - Actual Configuration
```bash
# Copy the example and edit
cp .env.example .env

# Edit .env and set your database password
nano .env  # or vim, code, etc.
```

**Important**: Add `.env` to `.gitignore` to avoid committing secrets:
```bash
echo ".env" >> .gitignore
```

---

## Step 6: Set Up Authentication

Civic OS uses Keycloak for authentication. You have two options:

### Option A: Use Shared Keycloak (Quick Start)

Use the default shared instance at `auth.civic-os.org`:

```bash
# Fetch the public key (JWKS)
./fetch-keycloak-jwk.sh
```

**Limitations**:
- Cannot create custom roles or users
- Cannot test RBAC features fully
- Good for initial development only

### Option B: Run Your Own Keycloak (Recommended)

For full RBAC testing and production deployments, run your own Keycloak instance.

**See**: [docs/AUTHENTICATION.md](../AUTHENTICATION.md) for complete setup instructions.

**Quick Steps**:
1. Uncomment the Keycloak service in `docker-compose.yml`
2. Start Keycloak: `docker-compose up -d keycloak`
3. Access admin console: `http://localhost:8081` (admin/admin)
4. Create realm, client, roles, and users (see AUTHENTICATION.md)
5. Update `.env` with your Keycloak URL
6. Fetch JWKS: `./fetch-keycloak-jwk.sh`

---

## Step 7: Start Your Services

Launch the PostgreSQL and PostgREST services:

```bash
# From your my-project directory
docker-compose up -d
```

**Check logs**:
```bash
# View all logs
docker-compose logs -f

# View specific service
docker-compose logs -f postgres
docker-compose logs -f postgrest
```

**Verify services are running**:
```bash
docker-compose ps
```

Expected output:
```
NAME                  IMAGE                          STATUS
postgres_db           postgis/postgis:17-3.5-alpine  Up (healthy)
postgrest_api         postgrest/postgrest:latest     Up
swagger_ui            swaggerapi/swagger-ui          Up
minio_local           minio/minio:latest            Up (healthy)
consolidated_worker   civic-os-consolidated-worker   Up
```

**Note**: minio_init will show as "Exit 0" (this is normal - it's a one-time setup container)

**Test PostgREST API**:
```bash
# Fetch entities (should return your tables)
curl http://localhost:3000/schema_entities

# Fetch properties
curl http://localhost:3000/schema_properties
```

---

## Step 8: Configure File Storage (Optional)

Skip this step if your application doesn't need file upload capabilities.

### What You Get

File storage features (v0.10.0+) enable:
- **Image uploads** with automatic thumbnail generation
- **PDF uploads** with thumbnail previews
- **Document storage** (any file type)
- **Presigned URLs** for secure, direct-to-S3 uploads
- **Background processing** via River job queue (reliable, at-least-once delivery)

### Architecture

The file storage system uses:
1. **Frontend** - File upload UI component
2. **metadata.files table** - Stores file metadata (UUID, size, MIME type, S3 key)
3. **S3 Signer (Go)** - Generates presigned upload URLs via River jobs
4. **Thumbnail Worker (Go)** - Processes uploaded files and generates thumbnails
5. **S3-compatible storage** - MinIO (local dev) or AWS S3/DigitalOcean Spaces (production)

### Adding File Properties to Your Schema

To add file upload capability to a table:

```sql
-- Add file column (foreign key to metadata.files)
ALTER TABLE my_table
  ADD COLUMN photo_id UUID REFERENCES metadata.files(id) ON DELETE SET NULL;

-- REQUIRED: Create index for performance
CREATE INDEX idx_my_table_photo_id ON my_table(photo_id);
```

**File Type Validation**: Use domain types for type safety:

```sql
-- For images only (JPEG, PNG, WebP, AVIF)
ALTER TABLE profiles
  ADD COLUMN avatar_id file_image REFERENCES metadata.files(id) ON DELETE SET NULL;

-- For PDFs only
ALTER TABLE documents
  ADD COLUMN contract_id file_pdf REFERENCES metadata.files(id) ON DELETE SET NULL;

-- For any file type
ALTER TABLE attachments
  ADD COLUMN file_id UUID REFERENCES metadata.files(id) ON DELETE SET NULL;
```

The UI will automatically:
- Show file upload button
- Display thumbnails for images/PDFs
- Provide download links
- Handle validation based on column type

### Verify File Storage is Working

```bash
# Check MinIO web console
open http://localhost:9001
# Login: minioadmin / minioadmin
# Verify bucket exists and is accessible

# Check Consolidated Worker logs (includes S3, thumbnail, and notification workers)
docker-compose logs consolidated-worker
# Should show: "Connected to database" and worker startup messages for all three services
# Should show: "Worker started" and "Polling for jobs..."
```

### Test File Upload

1. Navigate to a create/edit form for a table with file columns
2. Click the file upload button
3. Select an image or PDF
4. Submit the form
5. Check the detail page - should show thumbnail and download link
6. Check MinIO console - should see uploaded file in the bucket

**Troubleshooting**: See `docs/development/FILE_STORAGE.md` for complete troubleshooting guide including S3 connection issues, thumbnail generation failures, and permission problems.

### Production S3 Configuration

For production, replace MinIO with AWS S3 or DigitalOcean Spaces:

**Update `.env`:**
```bash
# Remove MinIO credentials
# Add AWS credentials
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_REGION=us-east-1
S3_ENDPOINT=  # Leave empty for AWS S3

# Update public endpoint for HTTPS
S3_PUBLIC_ENDPOINT=https://civic-os-files-prod.s3.amazonaws.com
S3_BUCKET=civic-os-files-prod
```

**Update `docker-compose.yml`:**
```yaml
# Comment out or remove minio and minio-init services

# Update consolidated-worker:
consolidated-worker:
  environment:
    - S3_ENDPOINT=  # Empty for AWS S3
    - S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
    - S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
    - S3_REGION=${S3_REGION}
    - S3_PUBLIC_ENDPOINT=${S3_PUBLIC_ENDPOINT}
    - S3_BUCKET=${S3_BUCKET}
```

**DigitalOcean Spaces Example:**
```bash
S3_ACCESS_KEY_ID=DO00EXAMPLE
S3_SECRET_ACCESS_KEY=DOEXAMPLE
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_REGION=nyc3
S3_PUBLIC_ENDPOINT=https://civic-os-files-prod.nyc3.digitaloceanspaces.com
S3_BUCKET=civic-os-files-prod
```

---

## Step 9: Configure Metadata (Optional)

Customize how your entities and properties appear in the UI using the metadata tables.

### Entity Metadata

Configure display names, descriptions, and menu order:

```sql
-- Connect to your database
docker exec -it postgres_db psql -U postgres -d my_app_db

-- Insert entity metadata
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES
  ('authors', 'Authors', 'Book authors and writers', 10),
  ('books', 'Books', 'Library book collection', 20),
  ('loans', 'Loans', 'Book lending records', 30)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;
```

### Property Metadata

Customize column labels, ordering, and visibility:

```sql
-- Configure property display
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create)
VALUES
  ('books', 'isbn', 'ISBN', '13-digit ISBN number', 2, true, true),
  ('books', 'publication_year', 'Published', 'Year of publication', 3, true, true),
  ('books', 'author_id', 'Author', 'Book author', 4, true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;
```

### Permission Configuration

Set up role-based permissions:

```sql
-- Create permission entries
INSERT INTO metadata.permissions (table_name, permission)
VALUES
  ('books', 'create'),
  ('books', 'read'),
  ('books', 'update'),
  ('books', 'delete');

-- Assign permissions to roles (assumes roles exist)
-- Example: Give 'user' role read permission on books
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'books'
  AND p.permission = 'read'
  AND r.display_name = 'user';
```

**Note**: Default roles (anonymous, user, editor, admin) are defined in the Civic OS baseline migration (`postgres/migrations/deploy/v0-4-0-baseline.sql`).

---

## Step 10: Generate Mock Data

Create domain-specific mock data for your deployment.

### Copy and Customize Mock Data Generator

Each deployment should have its own mock data generator customized for its domain:

```bash
# From your my-project directory
cp ../scripts/generate-mock-data.ts ./generate-mock-data.ts
```

### Customize for Your Domain

Edit `generate-mock-data.ts` to customize for your domain:

1. **Update DEFAULT_CONFIG**:
   ```typescript
   const DEFAULT_CONFIG: MockDataConfig = {
     recordsPerEntity: {},
     geographyBounds: { minLat: 42.25, maxLat: 42.45, minLng: -83.30, maxLng: -82.90 },
     excludeTables: ['lookup_tables'],
     outputFormat: 'insert',
     outputPath: './mock_data.sql',
     generateUsers: false,
     userCount: 10,
   };
   ```

2. **Customize `generateDisplayName()` method**:
   ```typescript
   private generateDisplayName(tableName: string): string {
     switch (tableName) {
       case 'books':
         return faker.book.title();  // Domain-specific generation
       case 'authors':
         return faker.person.fullName();
       default:
         return faker.commerce.productName();
     }
   }
   ```

3. **Update config path** (line ~913):
   ```typescript
   const configPath = './mock-data-config.json';
   ```

### Field-Specific Generation Patterns

For certain fields (like human names, emails, phone numbers), you need custom generation logic beyond simple type-based detection. **Always place field-specific checks BEFORE type-based switch statements** to ensure they work regardless of the field's data type.

**Pattern**: In your `generateFakeValue()` method, add field-specific logic at the top:

```typescript
private generateFakeValue(prop: SchemaEntityProperty, relatedIds?: any[]): any {
  // Skip auto-generated fields
  if (prop.is_identity || prop.is_generated || prop.column_name === 'id') {
    return null;
  }

  // ⭐ FIELD-SPECIFIC LOGIC (before type detection)
  // Handle human names for contacts table
  if (prop.table_name === 'contacts' && prop.column_name === 'first_name') {
    return faker.person.firstName();  // Works for TEXT or VARCHAR
  }
  if (prop.table_name === 'contacts' && prop.column_name === 'last_name') {
    return faker.person.lastName();
  }

  // Handle email fields (works for any table)
  if (prop.column_name === 'email') {
    return faker.internet.email();
  }

  // Handle phone numbers
  if (prop.column_name === 'phone') {
    return faker.phone.number('###-###-####');
  }

  // Exclude critical fields from random NULL assignment
  const excludeFromNull = ['display_name', 'first_name', 'last_name', 'email'];
  if (prop.is_nullable && !excludeFromNull.includes(prop.column_name) &&
      faker.datatype.boolean({ probability: 0.3 })) {
    return null;
  }

  // Now proceed with type-based generation...
  const type = this.getPropertyType(prop);
  switch (type) {
    case 'TextShort':
      return faker.lorem.sentence(5);
    // ... rest of type cases
  }
}
```

**Why This Matters**: If `first_name` is defined as `TEXT` instead of `VARCHAR(50)`, type detection returns `TextLong` instead of `TextShort`. Field-specific logic placed inside the `TextShort` case would be skipped, generating Lorem Ipsum instead of real names.

**Common Field-Specific Patterns**:

| Field Name Pattern | Generator | Use Case |
|-------------------|-----------|----------|
| `first_name` | `faker.person.firstName()` | Human first names |
| `last_name` | `faker.person.lastName()` | Human last names |
| `email` | `faker.internet.email()` | Email addresses |
| `phone` | `faker.phone.number()` | Phone numbers |
| `website` | `faker.internet.url()` | URLs |
| `address` | `faker.location.streetAddress()` | Street addresses |
| `city` | `faker.location.city()` | City names |
| `zip_code` | `faker.location.zipCode()` | Postal codes |

### Configure Mock Data

Create `my-project/mock-data-config.json`:

```json
{
  "recordsPerEntity": {
    "books": 50,
    "authors": 20,
    "loans": 100
  },
  "geographyBounds": {
    "minLat": 42.25,
    "maxLat": 42.45,
    "minLng": -83.30,
    "maxLng": -82.90
  },
  "excludeTables": ["authors"],
  "outputFormat": "insert",
  "generateUsers": false,
  "userCount": 15
}
```

### Generate Data

```bash
cd my-project
set -a && source .env && set +a  # Load database connection vars
npx ts-node generate-mock-data.ts       # Direct insert to database
npx ts-node generate-mock-data.ts --sql # Generate SQL file
```

**Benefits of Local Generators**:
- Domain-specific display names (e.g., "Large pothole on Main Street" vs "Study of Community Health Outcomes")
- Custom field generation logic for your entities
- Tailored validation handling
- No cross-deployment conflicts

**Examples**: See `examples/pothole/generate-mock-data.ts` (pot-hole domain) and `examples/broader-impacts/generate-mock-data.ts` (research tracking domain) for reference implementations.

---

## Step 11: Access Your Application

### Start the Frontend

```bash
# From project root
npm start
```

### Update Frontend Configuration (If Needed)

If you changed PostgREST port or URL, update the Angular environment file:

**`src/environments/environment.development.ts`**:
```typescript
export const environment = {
  production: false,
  apiUrl: 'http://localhost:3000/',  // Update if you changed PostgREST port
};
```

### Access Your Application

Open your browser to: **http://localhost:4200**

You should see:
- **Dashboard** - Overview with entity cards
- **Menu** - Your entities listed (based on `sort_order` in metadata.entities)
- **List Page** - Click an entity to see table view
- **Detail/Create/Edit** - Automatically generated forms

### Test CRUD Operations

1. **List Page**: Navigate to `/view/books` - Should show table of books
2. **Detail Page**: Click a row - Should show detail view with all fields
3. **Create**: Click "Create New" - Should show form with all editable fields
4. **Edit**: Click "Edit" on detail page - Should show pre-filled form
5. **Delete**: Click "Delete" on detail page - Should prompt for confirmation

### Test Foreign Key Relationships

- Foreign key fields should show as dropdowns with related entity's `display_name`
- Selecting a value should populate the foreign key ID
- Detail pages should show inverse relationships (e.g., "Books by this Author")

---

## Schema Design Best Practices

### 1. Always Use `display_name`

Every table should have a `display_name` column. This is used throughout the UI:
- Entity titles in lists and details
- Foreign key dropdown labels
- Search results
- Breadcrumbs

**Bad**:
```sql
CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  title TEXT  -- Not called display_name
);
```

**Good**:
```sql
CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,  -- Used by Civic OS
  isbn VARCHAR(13)
);
```

### 2. Create Indexes on Foreign Keys

PostgreSQL does **not** automatically index foreign keys. Always create them manually:

```sql
-- Foreign key definition
ALTER TABLE books ADD CONSTRAINT books_author_fkey
  FOREIGN KEY (author_id) REFERENCES authors(id);

-- REQUIRED: Index for performance
CREATE INDEX idx_books_author_id ON books(author_id);
```

**Why**: Without indexes, inverse relationship queries (showing all books by an author) will be slow.

### 3. Use Descriptive Table Names

Table names become route paths and menu items. Use clear, user-friendly names:

- ✅ `books`, `authors`, `loan_records`
- ❌ `bk`, `auth`, `lr`

### 4. Leverage Property Types

Choose PostgreSQL types that map to the UI components you want:

**Need a map?** → Use `postgis.geography(Point, 4326)` with computed field

**Need currency?** → Use `MONEY` type

**Need color picker?** → Use `hex_color` domain

**Need user selector?** → Use `UUID` with FK to `civic_os_users`

### 5. Validation Strategy: Dual Enforcement

Implement validation at **both** levels:

**Frontend (UX)**:
```sql
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES ('books', 'isbn', 'pattern', '^\d{13}$', 'ISBN must be 13 digits');
```

**Backend (Security)**:
```sql
ALTER TABLE books
  ADD CONSTRAINT isbn_format CHECK (isbn ~ '^\d{13}$' OR isbn IS NULL);

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES ('isbn_format', 'books', 'isbn', 'ISBN must be 13 digits');
```

### 6. Many-to-Many: Use Composite Keys

Junction tables should use composite primary keys, not surrogate IDs:

**Bad**:
```sql
CREATE TABLE book_authors (
  id SERIAL PRIMARY KEY,  -- Surrogate key (can cause duplicates)
  book_id BIGINT REFERENCES books(id),
  author_id BIGINT REFERENCES authors(id)
);
```

**Good**:
```sql
CREATE TABLE book_authors (
  book_id BIGINT REFERENCES books(id) ON DELETE CASCADE,
  author_id BIGINT REFERENCES authors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (book_id, author_id)  -- Composite key (prevents duplicates)
);
```

### 7. Full-Text Search

Add a `civic_os_text_search` tsvector column for search functionality:

```sql
-- Add search column (generated from multiple fields)
ALTER TABLE books ADD COLUMN civic_os_text_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(display_name, '') || ' ' || coalesce(isbn, ''))
  ) STORED;

-- Create index
CREATE INDEX idx_books_text_search ON books USING gin(civic_os_text_search);

-- Configure search fields in metadata
INSERT INTO metadata.entities (table_name, search_fields)
VALUES ('books', ARRAY['display_name', 'isbn'])
ON CONFLICT (table_name) DO UPDATE
  SET search_fields = EXCLUDED.search_fields;
```

**See**: `examples/pothole/init-scripts/05_add_text_search.sql` for complete pattern.

---

## Troubleshooting

### Issue: Tables Don't Appear in Menu

**Possible Causes**:
1. Table not in `public` schema
2. No permissions granted to `web_anon` or `authenticated` roles
3. No RLS policies defined
4. Table name is `civic_os_users` or `civic_os_users_private` (hidden by design)

**Solution**:
```sql
-- Check schema
SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'your_table';

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO web_anon, authenticated;

-- Enable RLS
ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;

-- Create basic read policy
CREATE POLICY "public_read" ON public.your_table
  FOR SELECT TO PUBLIC USING (true);
```

### Issue: Foreign Keys Don't Show as Dropdowns

**Possible Causes**:
1. Foreign key constraint not created
2. Referenced table doesn't have `display_name` column
3. No permissions on referenced table

**Solution**:
```sql
-- Verify foreign key exists
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = 'your_table';

-- Ensure referenced table has display_name
ALTER TABLE referenced_table ADD COLUMN display_name TEXT;
UPDATE referenced_table SET display_name = 'Default Name';
ALTER TABLE referenced_table ALTER COLUMN display_name SET NOT NULL;
```

### Issue: Geography/Maps Not Working

**Possible Causes**:
1. Computed text field function not created
2. Function not granted to PostgREST roles
3. Wrong geography format

**Solution**:
```sql
-- Create computed field function (replace 'your_table' and 'location')
CREATE OR REPLACE FUNCTION public.location_text(your_table)
RETURNS text AS $$
  SELECT postgis.ST_AsText($1.location);
$$ LANGUAGE SQL STABLE;

GRANT EXECUTE ON FUNCTION public.location_text(your_table) TO web_anon, authenticated;

-- Verify PostgREST can access the computed field
-- curl http://localhost:3000/your_table?select=id,location_text
```

### Issue: Init Scripts Don't Run

**Possible Causes**:
1. Scripts already ran (database volume exists)
2. Script not executable (`00_init.sh`)
3. SQL syntax error in scripts

**Solution**:
```bash
# Recreate database (WARNING: Deletes all data)
docker-compose down -v  # -v removes volumes
docker-compose up -d

# Check PostgreSQL logs for errors
docker-compose logs postgres

# Make init script executable
chmod +x init-scripts/00_init.sh
```

### Issue: Permission Denied Errors

**Possible Causes**:
1. RLS policies too restrictive
2. User doesn't have required roles
3. Missing permissions on sequences (for SERIAL columns)

**Solution**:
```sql
-- Grant sequence permissions
GRANT USAGE ON SEQUENCE public.your_table_id_seq TO web_anon, authenticated;

-- Check user roles
SELECT public.get_user_roles();  -- Must be called via PostgREST with JWT

-- Temporarily test without RLS (DEVELOPMENT ONLY)
ALTER TABLE public.your_table DISABLE ROW LEVEL SECURITY;
```

### Issue: Validation Not Working

**Possible Causes**:
1. Validation metadata not inserted
2. Validation type misspelled
3. Frontend not re-fetching schema

**Solution**:
```sql
-- Verify validation rules exist
SELECT * FROM metadata.validations WHERE table_name = 'your_table';

-- Force schema cache reload
NOTIFY pgrst, 'reload schema';

-- Restart PostgREST
docker-compose restart postgrest

-- Clear browser cache and reload frontend
```

### Common Mistakes (Lessons from Production Deployments)

These are critical mistakes discovered during real deployment scenarios. Avoiding these will save hours of debugging.

#### 1. RLS Permission Naming Mismatch (CRITICAL)

**Symptom**: All data invisible in application, "permission denied" errors, empty list pages.

**Mistake**: Using uppercase SQL operations in RLS policies instead of lowercase semantic names:

```sql
-- WRONG: This breaks all data access
CREATE POLICY "books: read permission" ON public.books
  FOR SELECT TO PUBLIC
  USING (public.has_permission('books', 'SELECT'));  -- ❌ Wrong!

-- CORRECT: Use lowercase semantic names
CREATE POLICY "books: read permission" ON public.books
  FOR SELECT TO PUBLIC
  USING (public.has_permission('books', 'read'));  -- ✅ Correct
```

**Why**: The `metadata.permissions` table stores lowercase semantic names ('read', 'create', 'update', 'delete'), NOT uppercase SQL operations ('SELECT', 'INSERT', 'UPDATE', 'DELETE'). Mismatched names cause ALL permission checks to fail.

**Fix**: Replace ALL occurrences:
- `'SELECT'` → `'read'`
- `'INSERT'` → `'create'`
- `'UPDATE'` → `'update'`
- `'DELETE'` → `'delete'`

#### 2. Human Name Generation in Mock Data

**Symptom**: Mock data generates Lorem Ipsum text for `first_name` and `last_name` fields instead of real person names.

**Mistake**: Placing field-specific generation logic inside type-specific switch cases:

```typescript
// WRONG: Won't work if field type is TEXT instead of VARCHAR
switch (type) {
  case 'TextShort':
    if (prop.column_name === 'first_name') {
      return faker.person.firstName();  // ❌ Skipped if type is TextLong!
    }
}

// CORRECT: Check field names BEFORE type detection
if (prop.table_name === 'contacts' && prop.column_name === 'first_name') {
  return faker.person.firstName();  // ✅ Works for any type
}
if (prop.table_name === 'contacts' && prop.column_name === 'last_name') {
  return faker.person.lastName();
}
// Then proceed with type-based switch statement
```

**Why**: If `first_name` is defined as `TEXT` instead of `VARCHAR(50)`, it hits the `TextLong` case, bypassing the `TextShort` case where the special handling was placed.

#### 3. Missing Foreign Key Indexes

**Symptom**: Slow queries, especially when viewing detail pages with inverse relationships (e.g., "Books by this Author").

**Mistake**: Creating foreign key constraints without corresponding indexes:

```sql
-- WRONG: No index on FK column
CREATE TABLE books (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT,
  author_id BIGINT REFERENCES authors(id)  -- ❌ No index!
);

-- CORRECT: Always create indexes on FK columns
CREATE TABLE books (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT,
  author_id BIGINT REFERENCES authors(id)
);
CREATE INDEX idx_books_author_id ON books(author_id);  -- ✅ Required!
```

**Why**: PostgreSQL does NOT automatically create indexes on foreign key columns. Without indexes, queries like `SELECT * FROM books WHERE author_id = 1` perform full table scans.

#### 4. Surrogate IDs in Junction Tables

**Symptom**: Duplicate relationships in many-to-many tables (e.g., same book linked to same author twice).

**Mistake**: Using surrogate SERIAL keys instead of composite primary keys:

```sql
-- WRONG: Allows duplicates
CREATE TABLE book_authors (
  id SERIAL PRIMARY KEY,  -- ❌ Allows (book_id=1, author_id=1) multiple times
  book_id BIGINT REFERENCES books(id),
  author_id BIGINT REFERENCES authors(id)
);

-- CORRECT: Use composite primary key
CREATE TABLE book_authors (
  book_id BIGINT REFERENCES books(id) ON DELETE CASCADE,
  author_id BIGINT REFERENCES authors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (book_id, author_id)  -- ✅ Prevents duplicates
);
```

**Why**: Composite keys enforce uniqueness on the relationship pair, preventing duplicate entries. The many-to-many editor in Civic OS expects this constraint.

#### 5. Random NULL Assignment to Critical Fields

**Symptom**: Mock data generates NULL values for `display_name`, `first_name`, `last_name`, causing validation errors or missing UI labels.

**Mistake**: Applying random NULL logic to all nullable fields without exclusions:

```typescript
// WRONG: Can set display_name to NULL
if (prop.is_nullable && faker.datatype.boolean({ probability: 0.3 })) {
  return null;  // ❌ May break display_name!
}

// CORRECT: Exclude critical fields from random NULL
const excludeFromNull = ['display_name', 'first_name', 'last_name'];
if (prop.is_nullable && !excludeFromNull.includes(prop.column_name) &&
    faker.datatype.boolean({ probability: 0.3 })) {
  return null;  // ✅ Safe
}
```

**Why**: Fields like `display_name` are required by Civic OS for UI rendering. Setting them to NULL breaks foreign key dropdowns, list views, and breadcrumbs.

---

## Example Walkthrough

Let's create a **Library Management System** from scratch.

### Step 1: Create Folder
```bash
mkdir library
cd library
mkdir init-scripts
```

### Step 2: Create Schema

**`init-scripts/01_library_schema.sql`**:
```sql
-- =====================================================
-- Library Management System - Schema
-- =====================================================

-- Authors table
CREATE TABLE public.authors (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  display_name TEXT NOT NULL,
  bio TEXT,
  birth_year INT
);

-- Books table
CREATE TABLE public.books (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  display_name TEXT NOT NULL,
  isbn VARCHAR(13),
  publication_year INT,
  author_id BIGINT NOT NULL REFERENCES authors(id),
  available_copies INT NOT NULL DEFAULT 1
);

-- Patrons table (library members)
CREATE TABLE public.patrons (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  display_name TEXT NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(20),
  member_since DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Loans table
CREATE TABLE public.loans (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  display_name TEXT NOT NULL,  -- e.g., "Harry Potter - loaned to John Doe"
  book_id BIGINT NOT NULL REFERENCES books(id),
  patron_id BIGINT NOT NULL REFERENCES patrons(id),
  loan_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  return_date DATE
);

-- Create indexes on foreign keys
CREATE INDEX idx_books_author_id ON public.books(author_id);
CREATE INDEX idx_loans_book_id ON public.loans(book_id);
CREATE INDEX idx_loans_patron_id ON public.loans(patron_id);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.authors TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.books TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.patrons TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loans TO web_anon, authenticated;

-- Grant sequence permissions
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO web_anon, authenticated;

-- Enable Row Level Security
ALTER TABLE public.authors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patrons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;

-- Apply timestamp triggers
CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON public.authors FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON public.authors FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON public.books FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON public.books FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON public.patrons FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON public.patrons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON public.loans FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON public.loans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

NOTIFY pgrst, 'reload schema';
```

### Step 3: Create Permissions

**`init-scripts/02_library_permissions.sql`**:
```sql
-- =====================================================
-- Library Management System - Permissions
-- =====================================================

-- Authors policies
CREATE POLICY "authors: read" ON public.authors FOR SELECT TO PUBLIC USING (public.has_permission('authors', 'read'));
CREATE POLICY "authors: create" ON public.authors FOR INSERT TO PUBLIC WITH CHECK (public.has_permission('authors', 'create'));
CREATE POLICY "authors: update" ON public.authors FOR UPDATE TO PUBLIC USING (public.has_permission('authors', 'update'));
CREATE POLICY "authors: delete" ON public.authors FOR DELETE TO PUBLIC USING (public.has_permission('authors', 'delete'));

-- Books policies
CREATE POLICY "books: read" ON public.books FOR SELECT TO PUBLIC USING (public.has_permission('books', 'read'));
CREATE POLICY "books: create" ON public.books FOR INSERT TO PUBLIC WITH CHECK (public.has_permission('books', 'create'));
CREATE POLICY "books: update" ON public.books FOR UPDATE TO PUBLIC USING (public.has_permission('books', 'update'));
CREATE POLICY "books: delete" ON public.books FOR DELETE TO PUBLIC USING (public.has_permission('books', 'delete'));

-- Patrons policies
CREATE POLICY "patrons: read" ON public.patrons FOR SELECT TO PUBLIC USING (public.has_permission('patrons', 'read'));
CREATE POLICY "patrons: create" ON public.patrons FOR INSERT TO PUBLIC WITH CHECK (public.has_permission('patrons', 'create'));
CREATE POLICY "patrons: update" ON public.patrons FOR UPDATE TO PUBLIC USING (public.has_permission('patrons', 'update'));
CREATE POLICY "patrons: delete" ON public.patrons FOR DELETE TO PUBLIC USING (public.has_permission('patrons', 'delete'));

-- Loans policies
CREATE POLICY "loans: read" ON public.loans FOR SELECT TO PUBLIC USING (public.has_permission('loans', 'read'));
CREATE POLICY "loans: create" ON public.loans FOR INSERT TO PUBLIC WITH CHECK (public.has_permission('loans', 'create'));
CREATE POLICY "loans: update" ON public.loans FOR UPDATE TO PUBLIC USING (public.has_permission('loans', 'update'));
CREATE POLICY "loans: delete" ON public.loans FOR DELETE TO PUBLIC USING (public.has_permission('loans', 'delete'));
```

### Step 4: Add Seed Data

**`init-scripts/03_library_data.sql`**:
```sql
-- =====================================================
-- Library Management System - Seed Data
-- =====================================================

-- Seed authors
INSERT INTO public.authors (display_name, bio, birth_year) VALUES
  ('J.K. Rowling', 'British author best known for the Harry Potter series', 1965),
  ('Stephen King', 'American author of horror, suspense, and fantasy', 1947),
  ('Agatha Christie', 'English writer known for detective novels', 1890);

-- Metadata configuration
INSERT INTO metadata.entities (table_name, display_name, description, sort_order) VALUES
  ('authors', 'Authors', 'Book authors and writers', 10),
  ('books', 'Books', 'Library book collection', 20),
  ('patrons', 'Patrons', 'Library members', 30),
  ('loans', 'Loans', 'Book lending records', 40)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

NOTIFY pgrst, 'reload schema';
```

### Step 5: Copy Supporting Files
```bash
# Copy init script runner
cp ../examples/pothole/init-scripts/00_init.sh ./init-scripts/00_init.sh
chmod +x ./init-scripts/00_init.sh

# Copy Docker Compose
cp ../examples/pothole/docker-compose.yml ./docker-compose.yml

# Copy environment files
cp ../examples/pothole/.env.example ./.env.example
cp ../examples/pothole/.env.example ./.env

# Copy Keycloak fetch script
cp ../examples/pothole/fetch-keycloak-jwk.sh ./fetch-keycloak-jwk.sh
chmod +x ./fetch-keycloak-jwk.sh
```

### Step 6: Configure Environment
```bash
# Edit .env and set database password
nano .env
```

Change:
```bash
POSTGRES_DB=library_db
POSTGRES_PASSWORD=your_secure_password_here
```

### Step 7: Fetch Keycloak Key
```bash
./fetch-keycloak-jwk.sh
```

### Step 8: Start Services
```bash
docker-compose up -d

# Watch logs
docker-compose logs -f
```

### Step 9: Start Frontend
```bash
# From project root
cd ..
npm start
```

### Step 10: Access Application

Open http://localhost:4200

You should see:
- Dashboard with 4 entity cards: Authors, Books, Patrons, Loans
- Menu with all entities
- Click "Authors" → See list of 3 seed authors
- Click an author → See detail page with bio and birth year
- See "Books" section showing related books (inverse relationship)
- Click "Create New Author" → See form with all fields

**Congratulations!** You've deployed a custom Civic OS instance.

---

## Next Steps

After completing this guide, you can:

1. **Add More Tables** - Expand your schema with additional entities
2. **Configure Validation** - Add frontend and backend validation rules
3. **Customize Metadata** - Fine-tune display names, descriptions, and field ordering
4. **Generate Mock Data** - Create realistic test data with the mock data generator
5. **Set Up Production Keycloak** - Deploy your own Keycloak for RBAC testing
6. **Add Full-Text Search** - Enable search functionality on key tables
7. **Configure Many-to-Many** - Add junction tables for complex relationships
8. **Deploy to Production** - See production deployment documentation (coming soon)

---

## Additional Resources

- **[README.md](../../README.md)** - Project overview and quick start
- **[CLAUDE.md](../../CLAUDE.md)** - Comprehensive developer guide
- **[AUTHENTICATION.md](../AUTHENTICATION.md)** - Complete Keycloak setup
- **[TROUBLESHOOTING.md](../TROUBLESHOOTING.md)** - Common issues and solutions
- **[examples/pothole/README.md](../../examples/pothole/README.md)** - Example deployment reference
- **[scripts/README.md](../../scripts/README.md)** - Mock data generator docs

---

## Getting Help

If you encounter issues:

1. Check the [Troubleshooting](#troubleshooting) section above
2. Review [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) for common issues
3. Check PostgreSQL logs: `docker-compose logs postgres`
4. Check PostgREST logs: `docker-compose logs postgrest`
5. Verify schema detection: `curl http://localhost:3000/schema_entities`
6. Open an issue on GitHub with detailed logs and schema

---

**License**: This guide and Civic OS are licensed under AGPL-3.0-or-later. See [LICENSE](../../LICENSE) for details.
