# File Storage Implementation Guide

This document provides a comprehensive guide to implementing file storage features in Civic OS using S3-compatible storage (MinIO for development, AWS S3 for production).

## Overview

**File Storage Types** (`FileImage`, `FilePDF`, `File`): UUID foreign keys to `metadata.files` table for S3-based file storage with automatic thumbnail generation. Civic OS provides complete file upload workflow via PostgreSQL functions and background workers. Files are stored in S3-compatible storage with presigned URL workflow that maintains PostgREST-only communication from Angular.

## Architecture

### Components

- **Database**: `metadata.files` table stores file metadata and S3 keys, `file_upload_requests` table manages presigned URL workflow
- **S3 Signer Service**: Node.js service listens to PostgreSQL NOTIFY events and generates presigned upload URLs
- **Thumbnail Worker**: Background service processes uploaded images (3 sizes: 150px, 400px, 800px) and PDFs (first page at 400px) using Sharp and Poppler
- **S3 Key Structure**: `{entity_type}/{entity_id}/{file_id}/original.{ext}` and `/thumb-{size}.jpg` for thumbnails
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
File properties are filtered out of Create forms (files require existing entity ID)

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

## S3 Configuration

**Current**: Hardcoded to `http://localhost:9000/civic-os-files/` for MinIO development.

**Production TODO**: Use environment configuration with CloudFront or S3 bucket URLs.

**Files to update**:
- `FileUploadService.getS3Url()`
- `DisplayPropertyComponent.getS3Url()`
- `PdfViewerComponent.getS3Url()`

## Services

### FileUploadService

**Location**: `src/app/services/file-upload.service.ts`

**Functionality**: Handles complete upload workflow:
1. Request presigned URL from database
2. Upload file to S3 using presigned URL
3. Create file record in database
4. Poll for thumbnail generation completion

## Development Setup

### Docker Compose Services

The `examples/pothole/docker-compose.yml` includes:
- **MinIO** (ports 9000/9001) - S3-compatible storage
- **s3-signer service** - Generates presigned URLs
- **thumbnail-worker service** - Processes uploaded files

### Database Migration

**Migration**: `postgres/migrations/deploy/v0-5-0-add-file-storage.sql` adds core file storage infrastructure

## Example Usage

See `examples/pothole/init-scripts/07_add_file_fields.sql` for complete example with:
- `Issue.photo` (image field)
- `WorkPackage.report_pdf` (PDF field)

## Related Documentation

- Main documentation: `CLAUDE.md` - Property Type System section
- Research notes: `docs/notes/FILE_STORAGE_OPTIONS.md` - Historical design decisions (v0.5.0 planning)
- Migration: `postgres/migrations/deploy/v0-5-0-add-file-storage.sql`
