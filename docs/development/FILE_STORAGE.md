# File Storage Implementation Guide

This document provides a comprehensive guide to implementing file storage features in Civic OS using S3-compatible storage (RustFS for development, AWS S3 for production).

## Overview

**File Storage Types** (`FileImage`, `FilePDF`, `File`): UUID foreign keys to `metadata.files` table for S3-based file storage with automatic thumbnail generation. Civic OS provides complete file upload workflow via PostgreSQL functions and background workers. Files are stored in S3-compatible storage with presigned URL workflow that maintains PostgREST-only communication from Angular. Since v0.88.0 files are private by default: the database signs every upload and every read URL, so RLS on `metadata.files` decides who can open a file and URLs expire (see Signed URLs and Private Files below).

## Architecture

### Components

- **Database**: `metadata.files` table stores file metadata and S3 keys; the `public.files` view adds signed URLs (v0.88.0); `request_file_upload()` signs uploads and records each issued upload in `file_upload_requests`; `metadata.river_job` queues background jobs
- **Consolidated Worker**: Single Go microservice (v0.11.0+) combining the Thumbnail Worker, the Notification Worker and the jobs below with a shared database connection pool. Until v0.88.0 it also signed upload URLs (the `s3_presign` job); the database does that now, with the S3 settings the worker publishes at startup
  - **Thumbnail Worker**: Processes uploaded images (3 sizes: 150x150, 400x400, 800x800) and PDFs (first page) using bimg (libvips) and pdftoppm with white background letterboxing
  - **File Reconcile Cron** (v0.87.0): Moves files staged on Create pages to their record's folder and deletes staged files nothing references (see Staged Uploads and File Reconcile below)
- **S3 Key Structure**: `{entity_type}/{entity_id}/{file_id}/original.{ext}` and `/thumb-{size}.jpg` for thumbnails; a file uploaded before its record exists (Create page) is staged as `{entity_type}/_new/{file_id}/…` with `entity_id = ''` (since v0.87.0, issue #141); the file reconcile job moves it to its record's folder once the record is saved (v0.87.0, see Staged Uploads and File Reconcile below)
- **UUIDv7**: Time-ordered UUIDs improve B-tree index performance

## Property Type Detection

The SchemaService automatically detects file types from validation metadata:

```typescript
// SchemaService.getPropertyType() detects file types from validation metadata
if (column.udt_name === 'uuid' && column.join_table === 'files') {
  const fileTypeValidation = column.validation_rules?.find(v => v.type === 'fileType');
  if (fileTypeValidation?.value?.startsWith('image/')) {
    return EntityPropertyType.FileImage;  // Thumbnails + lightbox viewer
  } else if (fileTypeValidation?.value === 'application/pdf') {
    return EntityPropertyType.FilePDF;    // First-page thumbnail + iframe viewer
  }
  return EntityPropertyType.File;         // Generic file with download link
}
```

## UI Behavior

### Display Mode
`DisplayPropertyComponent` shows thumbnails (with loading/error states), opens lightbox for images, iframe viewer for PDFs

### Edit Mode
`EditPropertyComponent` provides file input with drag-drop, validates type/size, uploads immediately on selection, shows progress

### Create Forms
File properties are on Create forms (since v0.87.0). A file chosen there is uploaded before the record exists, staged under `{entity_type}/_new/`, and its id is saved with the record; the file reconcile job then moves it to the record's folder (v0.87.0).

### Validation
Frontend validates before upload; backend enforces via validation metadata

## Adding File Properties to Your Schema

### Step 1: Add UUID Column with Foreign Key

```sql
-- 1. Add UUID column with FK to files table
ALTER TABLE issues ADD COLUMN photo UUID REFERENCES metadata.files(id);

-- 2. Create index (required for performance)
CREATE INDEX idx_issues_photo ON issues(photo);
```

### Step 2: Add Validation Metadata

```sql
-- 3. Add validation metadata
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('issues', 'photo', 'fileType', 'image/*', 'Only image files are allowed', 1),
  ('issues', 'photo', 'maxFileSize', '5242880', 'File size must not exceed 5 MB', 2);
```

### Step 3 (Optional): Add Custom Display Name

```sql
-- 4. (Optional) Add custom display name
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order)
VALUES ('issues', 'photo', 'Photo', 'Upload a photo of the issue', 50);
```

## Validation Types

- **`fileType`**: MIME type constraint (e.g., `image/*`, `image/jpeg`, `application/pdf`)
- **`maxFileSize`**: Maximum size in bytes
  - `5242880` = 5 MB
  - `10485760` = 10 MB

## Signed URLs and Private Files (v0.88.0)

Before v0.88.0 every object was uploaded `public-read` and the frontend built URLs from the S3 keys, so anyone holding a key could read the file forever. Since v0.88.0:

- **Reads**: `public.files` (security_invoker) returns `url`, `thumb_small_url`, `thumb_medium_url`, `thumb_large_url` and `download_url`. RLS on `metadata.files` runs first, so a caller who may not see the row gets no URL. Private files' URLs are SigV4-signed in SQL (`metadata.file_urls()`); the signing time is rounded down to 5 minutes and the expiry is 20 minutes, so a file keeps the same URL for 5 minutes (stable `<img src>`, browser cache hits) and every URL is valid for at least 15 minutes after it is read. `download_url` is signed with `Content-Disposition: attachment` and the file's name; clients fetch it when the user downloads (`FileAccessService`), never from a page that may have been open for an hour. URLs are NULL until the S3 settings are published (below).
- **Public files**: only static assets (`metadata.file_is_public()`: `entity_type = 'static_assets'`), which emails and dashboards need at stable addresses. They get direct URLs and `public-read` objects. Anonymous visitors still open other files on records they may read, through signed URLs.
- **Uploads**: `request_file_upload(entity_type, entity_id, file_name, file_type)` returns `{url, file_id, bucket, key, is_public}` synchronously (no worker, no polling). The PUT sends `x-amz-acl: public-read` only when `is_public` is true, since S3 refuses an unsigned `x-amz-*` header. `create_file_record()` registers only an upload the database issued to the same user, with its bucket and key, once, and returns the file as `public.files` shows it, URLs included. Uploading a static asset requires `static_assets:create`. Without the S3 settings the RPC raises `file_storage_not_configured` (55000), shown translated (`file_upload.storage_not_configured`).
- **Thumbnails and moves** follow the file: the thumbnail worker sets `public-read` only for public files, and the reconcile copy is private.
- **Credentials**: the consolidated worker publishes `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, the browser-facing endpoint (`S3_PUBLIC_ENDPOINT`, else `S3_ENDPOINT`, else `https://s3.<region>.amazonaws.com`) and `S3_BUCKET` at startup into the deployment-managed secret keys of `metadata.instance_config` (`metadata.publish_deployment_config()`), which no API role can read. `/admin/config` shows their status under File storage. See `docs/notes/INSTANCE_SETUP_DESIGN.md` (Secret Keys).
- **URL style**: path-style only (`{endpoint}/{bucket}/{key}`), the same as the worker's S3 client.
- **Deprecated shims**: `request_upload_url()` / `get_upload_url()` still work (signed in SQL, complete at once) so an SPA loaded before the upgrade can upload; they sign `x-amz-acl: public-read` because that SPA always sends it, and `privatize-acls` makes those objects private again. `get_upload_url()` returns only the caller's own request. They will be removed in a later release.
- **Existing objects**: after upgrading, run the operator command `consolidated-worker privatize-acls` (in the worker image) to make the objects of this instance's private files private: `--dry-run` to count, `--after <file id>` to resume, `--acl public-read` to roll back. It walks `metadata.files`, never the bucket, so on a bucket several instances share it touches only this instance's objects. See `docs/deployment/PRODUCTION.md` (Signed file URLs).

The frontend never builds an S3 URL: components read the view's URL columns (core's `fileDisplayUrl()` picks a size with fallbacks), and `getS3Config()` is gone. Design and amendments: `docs/notes/SIGNED_FILE_URLS_DESIGN.md`.

## Services

### FileUploadService

**Location**: `src/app/services/file-upload.service.ts`

**Functionality**: Handles complete upload workflow:
1. Ask the database to issue the upload (`request_file_upload`: file id, key, presigned PUT)
2. Upload file to S3 using presigned URL (with `x-amz-acl` only for a public file)
3. Register the file record (`create_file_record`), which returns it with its URLs
4. Optionally poll for thumbnail generation completion

`FileAccessService` (`src/app/services/file-access.service.ts`) downloads and opens files with URLs read at click time.

## Development Setup

### Docker Compose Services

The `examples/pothole/docker-compose.yml` includes:
- **s3** (RustFS, ports 9000/9001) - S3-compatible storage
- **s3-init** - One-time container that creates the bucket, sets a public-read policy for `static_assets/` only (v0.88.0) and the CORS rule
- **consolidated-worker** - Thumbnails, file reconcile, notifications; publishes the S3 settings the database signs with

### Database Migration

**Migration**: `postgres/migrations/deploy/v0-5-0-add-file-storage.sql` adds core file storage infrastructure

### Checking the Production Image and DigitalOcean Spaces

`ng serve` sends no Content-Security-Policy, and RustFS ignores object ACLs by design, so two things are only visible with the production frontend image and a real Spaces bucket: whether the CSP lets the browser load, upload and frame files from the store, and whether objects are private or public as intended. Two compose overrides in `examples/pothole/` cover them. Nothing has to be published: every image is built from the checkout.

- `docker-compose.frontend-image.yml` serves the production frontend image, built locally, on `http://localhost:4200` (the only origin the dev Keycloak client accepts), so stop `ng serve` first. On its own it checks the CSP against the local RustFS.
- `docker-compose.spaces.yml` points the consolidated worker (and so the URLs the database signs) and the frontend's CSP at a Spaces bucket. Its values come from `spaces.env` (copy `spaces.env.example`; gitignored, it holds the key).

Use a scratch bucket made for the check, never one that holds an instance's files, and a key with read, write and delete on it. A per-bucket (limited) key cannot change bucket settings, so add the CORS rule in the DigitalOcean control panel: origin `http://localhost:4200`, methods GET, PUT and HEAD, headers `*` (`spaces-cors.xml` holds the same rule for an all-buckets key). Run the stack under its own project name, so the example's usual volumes are left alone:

```bash
cd examples/pothole
docker compose -p spaces-check --env-file .env --env-file spaces.env \
  -f docker-compose.yml -f docker-compose.frontend-image.yml -f docker-compose.spaces.yml up -d --build
npm run generate pothole    # from the repo root, once the stack is healthy
```

Then check, against the bucket:

1. The worker logs `published s3 config`, and `/admin/config` (File storage) names the Spaces endpoint and bucket.
2. A file uploaded on an Issue or WorkPackage is stored, its thumbnails are generated, and its signed URL and thumbnail URLs load. The same URL with a changed signature, an unsigned URL to the object and a URL signed more than 20 minutes ago return 403.
3. The PDF viewer shows a PDF (the CSP's `frame-src` must name the store), and `download_url` answers with `Content-Disposition: attachment`.
4. A static asset is public: its direct, unsigned original and thumbnail URLs load anonymously.
5. `privatize-acls --acl public-read` makes private files' objects readable without a signature, `privatize-acls` makes them refuse it again, static assets stay public, and a second run changes nothing. Run it with `run -T --rm --no-deps consolidated-worker /app/consolidated-worker privatize-acls` and the same `-p`, `--env-file` and `-f` options.
6. The browser console shows no CSP violations.

Afterwards run `docker compose -p spaces-check ... down -v`, then delete the bucket and the key.

---

## Production Configuration

### Environment Variables

The consolidated worker requires these environment variables. Since v0.88.0 it also publishes them (except `DATABASE_URL`) to the database at startup, which signs file URLs with them.

#### Required

```bash
# PostgreSQL
DATABASE_URL=postgres://user:password@host:5432/database

# AWS Credentials
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key

# S3 Bucket
S3_BUCKET=your-production-bucket
```

#### Endpoints

```bash
# Browser-facing endpoint: the base of every upload and file URL the database signs (path-style)
S3_PUBLIC_ENDPOINT=https://nyc3.digitaloceanspaces.com   # local RustFS: http://localhost:9000

# Internal endpoint the worker reads and writes objects through
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com          # local RustFS: http://s3:9000
```

Leave both empty for AWS S3: the worker then uses `https://s3.<region>.amazonaws.com`. When only `S3_ENDPOINT` is set, it is also the browser-facing endpoint.

#### File Reconcile (v0.87.0, consolidated worker)

```bash
FILE_RECONCILE_INTERVAL=5m   # Go duration between ticks; 0 disables the job
FILE_ORPHAN_TTL=168h         # unreferenced staged files older than this are deleted (at least 1h)
```

**Bucket CORS**: Browsers upload straight to the store with a presigned PUT, so the bucket needs a CORS rule. MinIO allowed every origin by default; RustFS allows none until a rule is set. The `s3-init` service in each example compose file sets the rule (any origin; GET, PUT and HEAD; all headers; `ETag` exposed) together with a public-read policy limited to `static_assets/` (RustFS ignores object ACLs by design: its S3 compatibility matrix lists ACL authorization as intentionally unsupported, `PutObjectAcl` accepts canned headers without storing them, and `GetObjectAcl` always reports owner-only `FULL_CONTROL`, unchanged through 1.0.7. So in development the policy is what makes static assets public, and every other object is reachable only through signed URLs), using `curl --aws-sigv4` from the RustFS image, so no separate client image is needed. If you build your own compose file around RustFS, copy that service. Root credentials come from `S3_ROOT_USER` and `S3_ROOT_PASSWORD` (both default to `minioadmin`).

**Upgrading a local stack from MinIO**: the store's volume is now `s3_data` (it was `minio_data`), so uploads from an older stack are not carried over. Run `docker compose down -v`, then `up -d` and re-seed. If your `.env` set `MINIO_ROOT_USER` or `MINIO_ROOT_PASSWORD`, rename them to `S3_ROOT_USER` and `S3_ROOT_PASSWORD`; the old names are no longer read.

---

### System Requirements

#### Consolidated Worker (thumbnails)
- **Runtime**: Docker image or Go 1.23+ binary
- **Dependencies** (if running binary directly):
  - libvips 8.x+ (`libvips-dev` or `vips-devel` package)
  - poppler-utils (`pdftoppm` command)
- **Network**: Outbound HTTPS to AWS S3 and PostgreSQL

**Recommended**: Use Docker images which include all dependencies pre-installed.

---

### IAM Permissions (AWS S3)

The services require the following S3 permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:PutObjectAcl",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::your-bucket-name"
    }
  ]
}
```

`s3:PutObjectAcl` sets `public-read` on static assets and is what `privatize-acls` uses. `s3:DeleteObject` is new in v0.87.0: the file reconcile job deletes the staged copy after moving a file, and orphaned staged files. Without it those deletes fail (logged by the worker) and the objects stay in the bucket; claiming still works. `s3:ListBucket` lets the job find objects left under `{type}/_new/`.

**Security Best Practice**: Use IAM roles (EC2/ECS task roles) instead of access keys when possible.

---

### Deployment Options

#### Option 1: Docker Compose (Recommended)

```yaml
services:
  consolidated-worker:
    image: ghcr.io/civic-os/consolidated-worker:latest  # Pin to specific version for reproducible builds
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - DB_MAX_CONNS=4  # Shared pool for all workers
      - S3_REGION=us-east-1
      - S3_BUCKET=${S3_BUCKET}
      - S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
      - S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
      - THUMBNAIL_MAX_WORKERS=3
    restart: unless-stopped
```

#### Option 2: Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: civic-os-consolidated-worker
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: consolidated-worker
        image: ghcr.io/civic-os/consolidated-worker:latest  # Pin to specific version for reproducible builds
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: civic-os-secrets
              key: database-url
        - name: DB_MAX_CONNS
          value: "4"
        - name: S3_REGION
          value: "us-east-1"
        - name: S3_BUCKET
          value: "your-bucket"
        - name: THUMBNAIL_MAX_WORKERS
          value: "3"
```

#### Option 3: Systemd Service

Run the `consolidated-worker` binary with the same environment as the Docker Compose example. It needs libvips and poppler-utils (above).

---

### Scaling

#### Horizontal Scaling

The consolidated worker scales horizontally - run multiple instances:

```bash
# Docker Compose
docker-compose up -d --scale consolidated-worker=3

# Kubernetes
kubectl scale deployment civic-os-file-workers --replicas=5
```

River's row-level locking ensures each job is processed by only one worker, even with multiple instances.

#### Vertical Scaling

The **Consolidated Worker** (v0.11.0+) combines the Thumbnail Worker, the Notification Worker and the other jobs in a single service. Resources scale primarily with thumbnail worker count:

**Resource Characteristics:**
- **Thumbnail Worker**: 3 concurrent workers by default (CPU/memory intensive)
- **Notification Worker**: 30 concurrent workers (I/O-bound, minimal resources)

**Memory Formula:**
```
Total Memory = (THUMBNAIL_MAX_WORKERS × 150MB) + 200MB baseline
```

**Scaling Configuration:**

| THUMBNAIL_MAX_WORKERS | Memory Needed | CPU (Burst) | Use Case |
|----------------------|---------------|-------------|----------|
| 2 | 500MB | 1 CPU | Development |
| 3-4 | 800MB | 2 CPUs | Small production (<100 uploads/day) |
| 6-8 | 1.4GB | 4 CPUs | Medium production (100-500 uploads/day) |
| 8+ | Scale horizontally | - | High traffic (>500 uploads/day) |

Adjust `THUMBNAIL_MAX_WORKERS` environment variable based on your container memory limits. See `docs/deployment/PRODUCTION.md` for complete tuning guide.

---

## Example Usage

See `examples/pothole/init-scripts/07_add_file_fields.sql` for complete example with:
- `Issue.photo` (image field)
- `WorkPackage.report_pdf` (PDF field)

## Staged Uploads and File Reconcile (v0.87.0)

A file attached on a Create page is uploaded before its record exists. It is staged as `{entity_type}/_new/{file_id}/…` with `metadata.files.entity_id = ''`, and the record's file column holds its id once the record is saved. `FileReconcileCron` in the consolidated worker runs every `FILE_RECONCILE_INTERVAL` (default 5 minutes) and:

1. **Claims** staged files that a public table references. It reads the foreign keys to `metadata.files(id)` from `pg_constraint`, so no per-table setup is needed. It copies the original and its thumbnails to `{entity_type}/{entity_id}/{file_id}/`, claims the row in one guarded statement, then deletes the old objects. A file whose thumbnail job is still queued, running or retrying waits for the next tick. A file several rows reference is claimed for the first (table name, then lowest key); the others keep pointing at it. Legacy rows with an id-less `{type}//{file_id}` key are repaired the same way.
2. **Deletes orphans**: staged files that nothing references, in any schema, once older than `FILE_ORPHAN_TTL` (default 7 days). The row goes first, then its objects.
3. **Sweeps** objects left under `{type}/_new/` by an interrupted move, or by an upload whose row was never created (after the TTL).
4. **Deletes** `metadata.file_upload_requests` rows older than 24 hours.

A Create page left open longer than the TTL saves an id whose row is gone; the save fails with a foreign-key violation and the page says which field to upload again (`error.attachment_expired`).

Deleting the objects of files that were already claimed, when their row or record is deleted, is not done yet (issue #165). Since v0.88.0 such objects are private, so they are unreadable once the row is gone (no row, no signed URL); before v0.88.0 they stayed readable at their public URL.

The worker calls `metadata.unclaimed_file_references()`, `claim_file()`, `delete_orphaned_staged_files()`, `staged_file_states()` and `delete_stale_upload_requests()`; none is exposed through PostgREST. See `docs/notes/FILE_RECONCILE_DESIGN.md` for the design and its amendments.

## File Administration (v0.39.0)

Admin page at `/admin/files` provides centralized file browsing with two modes:
- **All Files**: Direct query with file type, date range, and filename search filters
- **Entity Files**: Two-phase query — filter entities → extract linked file UUIDs → query files by ID

Requires `files:read` permission (admin role by default). Uses `property_name` column to track which entity property each file was uploaded through, hybrid RLS policy with `can_view_entity_record()`, and `get_file_storage_stats()` RPC for storage summary.

See `docs/notes/ADMIN_PAGE_PITFALLS.md` for architecture patterns and lessons learned.

## Photo Gallery Integration (v0.47.0)

The PhotoGallery property type builds on the file storage system to manage ordered collections of images per entity column. Gallery files are standard `metadata.files` records — they use the same presigned URL upload workflow, the same thumbnail generation pipeline (consolidated worker), and appear in the File Admin page alongside all other files.

### How Gallery Files Relate to File Storage

- **Storage**: Gallery images are stored in `metadata.files` like all other uploaded files. There is no separate file storage mechanism.
- **S3 key pattern**: Gallery files use the prefix `photo_gallery/{gallery_id}/{file_id}/original.{ext}` (and `/thumb-{size}.jpg` for thumbnails), grouping all images for a gallery under one S3 prefix.
- **Thumbnail generation**: The same consolidated worker thumbnail pipeline generates 150x150, 400x400, and 800x800 thumbnails for gallery images.
- **Junction table**: `metadata.photo_gallery_files` links galleries to files with additional columns for `sort_order`, `caption`, and `alt_text`. This is a separate junction table from the direct FK pattern used by `FileImage`/`FilePDF`/`File` property types.
- **File Admin visibility**: Gallery files appear in the File Admin page (`/admin/files`) automatically, since they are rows in `metadata.files`. The `property_name` column tracks which gallery property uploaded each file.
- **Orphan cleanup**: Draft galleries (from abandoned Create pages) are cleaned up after 12 hours by `metadata.cleanup_draft_galleries` (server-side function, hidden from PostgREST), which cascades deletion to `photo_gallery_files` and then to `metadata.files`, triggering S3 cleanup via the consolidated worker.

### Key Differences from Single-File Properties

| Aspect | FileImage / FilePDF / File | PhotoGallery |
|--------|---------------------------|--------------|
| Files per column | 1 | Many (configurable via `max_images`) |
| Entity FK target | `metadata.files` directly | `metadata.photo_galleries` (junction to files) |
| Ordering | N/A | `sort_order` on `photo_gallery_files` |
| Per-file metadata | None (just the file record) | `caption`, `alt_text` per image |
| S3 key prefix | `{entity_type}/{entity_id}/{file_id}/` | `photo_gallery/{gallery_id}/{file_id}/` |
| Create page behavior | Uploaded before the record exists, staged under `_new`, id saved with the record (v0.87.0), moved to the record's folder by the reconcile job (v0.87.0) | Draft gallery pattern (create gallery first, link after) |

See `docs/notes/PHOTO_GALLERY_DESIGN.md` for the full architecture, lifecycle, and RPC reference.

## Related Documentation

- Main documentation: `CLAUDE.md` - Property Type System section
- Research notes: `docs/notes/FILE_STORAGE_OPTIONS.md` - Historical design decisions (v0.5.0 planning)
- Admin page lessons: `docs/notes/ADMIN_PAGE_PITFALLS.md` - Reactive architecture and testing patterns (v0.39.0)
- Photo gallery design: `docs/notes/PHOTO_GALLERY_DESIGN.md` - Gallery architecture and lifecycle (v0.47.0)
- Migrations: `postgres/migrations/deploy/v0-5-0-add-file-storage.sql` (core), `v0-39-0-add-file-admin.sql` (admin features)
