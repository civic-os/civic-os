# Photo Gallery Feature Design

**Status:** Implemented (v0.47.0)
**Created:** 2026-04-20
**Author:** System Design Document

## Overview

PhotoGallery is a **column-level property type** (like Status and Category) backed by dedicated metadata tables. It enables any entity to have one or more image galleries with drag-drop upload, reordering, lightbox viewing, and admin management. The design follows Civic OS conventions: metadata-driven configuration, polymorphic data model, RLS-based security, and RPC-driven mutations.

Unlike file storage properties (`FileImage`, `FilePDF`, `File`) which store a single file per column, PhotoGallery manages an ordered collection of images associated with an entity column, with metadata (caption, alt text) per image.

## Data Model

Three tables in the `metadata` schema support the feature:

### metadata.photo_galleries

The primary gallery registry. Uses the same `entity_type`/`entity_id` polymorphic pattern as Entity Notes and File Storage for back-referencing the owning entity.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PRIMARY KEY` | UUIDv7 gallery identifier |
| `entity_table` | `TEXT NOT NULL` | Table name of owning entity (e.g., `'issues'`) |
| `entity_id` | `TEXT NOT NULL` | ID of owning record (cast to text for polymorphic support) |
| `property_name` | `TEXT NOT NULL` | Column name on the entity (e.g., `'photos'`) |
| `created_by` | `UUID` | User who created the gallery |
| `created_at` | `TIMESTAMPTZ` | Gallery creation timestamp |
| `is_draft` | `BOOLEAN DEFAULT FALSE` | Draft galleries are unlinked (Create page pattern) |

**Unique constraint**: `(entity_table, entity_id, property_name)` ensures one gallery per column per record.

### metadata.photo_gallery_files

Junction table linking galleries to files. Supports ordering and per-image metadata.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PRIMARY KEY` | UUIDv7 row identifier |
| `gallery_id` | `UUID NOT NULL` | FK to `photo_galleries` |
| `file_id` | `UUID NOT NULL` | FK to `metadata.files` |
| `sort_order` | `INT NOT NULL` | Display ordering (0-based) |
| `caption` | `TEXT` | Optional image caption |
| `alt_text` | `TEXT` | Accessibility alt text |
| `created_at` | `TIMESTAMPTZ` | When image was added |

**Unique constraint**: `(gallery_id, file_id)` prevents duplicate images in a gallery.

### metadata.photo_gallery_config

Configuration table controlling gallery behavior per entity type.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `SERIAL PRIMARY KEY` | Auto-generated ID |
| `entity_table` | `TEXT NOT NULL` | Target entity table |
| `property_name` | `TEXT NOT NULL` | Column name on the entity |
| `max_images` | `INT DEFAULT 20` | Maximum images per gallery |
| `allowed_types` | `TEXT[] DEFAULT '{image/jpeg,image/png,image/webp}'` | Allowed MIME types |
| `max_file_size` | `BIGINT DEFAULT 10485760` | Max file size in bytes (default 10 MB) |

**Unique constraint**: `(entity_table, property_name)` ensures one config per gallery column.

### Entity Table Column

The entity itself has a nullable UUID FK column pointing to `metadata.photo_galleries`:

```sql
ALTER TABLE issues ADD COLUMN photos UUID REFERENCES metadata.photo_galleries(id);
CREATE INDEX idx_issues_photos ON issues(photos);
```

## Gallery Lifecycle

### Existing Entities (Detail / Edit Pages)

On existing entities, galleries are **lazily created** on first interaction:

1. User navigates to Detail or Edit page for a record with a gallery column
2. If the column value is NULL (no gallery yet), the frontend calls `create_draft_gallery` RPC
3. The RPC creates a `photo_galleries` row with `is_draft = FALSE`, links it to the entity by updating the FK column, and returns the gallery ID
4. Subsequent image uploads use `add_gallery_image` RPC which creates file records and inserts into `photo_gallery_files`

### New Entities (Create Page)

Create pages need a gallery before the entity record exists. This uses the **draft gallery pattern**:

1. When a Create page renders a gallery property, it calls `create_draft_gallery` with no `entity_id`
2. The RPC creates a gallery with `is_draft = TRUE` and returns the gallery ID
3. User uploads images to the draft gallery — images are stored in S3 immediately
4. On form submission, the entity record is created, then `link_gallery_to_entity` RPC is called
5. `link_gallery_to_entity` sets `entity_table`, `entity_id`, and `is_draft = FALSE`
6. The entity FK column is updated to point at the gallery

### Orphan Cleanup

Draft galleries that are never linked (user abandons Create page) are cleaned up:

- `metadata.cleanup_draft_galleries` function deletes draft galleries older than 12 hours (in metadata schema, hidden from PostgREST — called only by consolidated worker)
- Associated `photo_gallery_files` rows are CASCADE-deleted
- Associated `metadata.files` rows are CASCADE-deleted (triggering S3 cleanup by the consolidated worker)
- Cleanup runs automatically via the consolidated worker's daily cron job (~3:00 AM)

### Entity Deletion

When an entity record is deleted:

1. The FK column on the entity is set to NULL (or the gallery is CASCADE-deleted if configured)
2. `photo_galleries` row deletion cascades to `photo_gallery_files`
3. `metadata.files` cleanup happens via the consolidated worker's orphan file detection

## Frontend Components

### PhotoGalleryEditorComponent

**Location**: `src/app/components/photo-gallery-editor/`

The primary editor for uploading, reordering, and managing gallery images. Used on Detail, Edit, and Create pages.

**Features**:
- **Drag-drop upload**: File input and drop zone for adding images (validates against gallery config)
- **CDK DragDrop reorder**: Angular CDK DragDrop for visual reordering of thumbnails
- **Thumbnail grid**: Responsive grid showing image thumbnails with sort handles
- **Image metadata**: Inline editing of caption and alt text per image
- **Remove images**: Delete button per image with confirmation
- **Upload progress**: Progress indicator during file upload
- **Gallery config awareness**: Reads `max_images`, `allowed_types`, `max_file_size` from config to enforce limits client-side

**Inputs**:
- `galleryId: Signal<string | undefined>` - The gallery UUID
- `entityTable: string` - Entity table name (for RPC calls)
- `propertyName: string` - Property name (for config lookup)
- `readonly: boolean` - Disable editing (Display mode on Detail page)

**Outputs**:
- `galleryCreated: EventEmitter<string>` - Emitted when a new gallery is created (draft or linked)
- `imagesChanged: EventEmitter<void>` - Emitted after add/remove/reorder to trigger parent refresh

### GalleryLightboxComponent

**Location**: `src/app/components/gallery-lightbox/`

Full-screen image viewer for browsing gallery images.

**Features**:
- Full-screen overlay with backdrop
- Previous/next navigation with keyboard arrow support
- Image counter (e.g., "3 of 12")
- Caption display
- Close on Escape key or backdrop click
- Preloads adjacent images for smooth navigation

## Gallery Admin Page

**Route**: `/admin/galleries`

Administrative page for browsing and managing all photo galleries across the system.

**Features**:
- List all galleries with entity type, record ID, image count, and storage size
- Filter by entity type
- View gallery contents (thumbnails)
- Storage statistics via `get_gallery_storage_stats` RPC
- Delete orphaned/draft galleries manually

**Permissions**: Requires admin role.

## Row-Level Security

Gallery RLS implements **tiered visibility** that inherits from the entity's own permissions:

### Visibility Tiers (evaluated in order)

1. **Admin**: Users with `is_admin()` can see and manage all galleries
2. **Owner**: Gallery `created_by` matches `current_user_id()`
3. **Table RBAC**: User has `has_permission(entity_table, 'read')` for the gallery's parent entity
4. **Record-level**: If the parent entity has record-level RLS policies, gallery access respects them via `can_view_entity_record(entity_table, entity_id)`

### Policy Implementation

```
-- Simplified policy logic:
-- SELECT: admin OR owner OR (has table read permission AND can view entity record)
-- INSERT: admin OR has table create permission
-- UPDATE: admin OR owner OR has table update permission
-- DELETE: admin OR owner OR has table delete permission
```

The `photo_gallery_files` table inherits access from its parent gallery via FK join — if a user can see the gallery, they can see its files.

## RPCs

All gallery mutations go through PostgreSQL RPCs for consistent business logic enforcement:

| Function | Description |
|----------|-------------|
| `create_draft_gallery(entity_table, property_name, entity_id?)` | Creates a gallery. If `entity_id` is provided, links immediately; otherwise creates draft |
| `link_gallery_to_entity(gallery_id, entity_table, entity_id)` | Links a draft gallery to its entity after record creation |
| `add_gallery_image(gallery_id, file_data)` | Uploads a new image to the gallery (creates file record + gallery junction) |
| `add_gallery_image_by_id(gallery_id, file_id)` | Links an existing `metadata.files` record to the gallery |
| `remove_gallery_image(gallery_id, file_id)` | Removes an image from the gallery (deletes junction row) |
| `reorder_gallery_images(gallery_id, file_ids[])` | Updates `sort_order` for all images based on the provided array order |
| `update_gallery_image_meta(gallery_id, file_id, caption?, alt_text?)` | Updates caption and/or alt text for a gallery image |
| `get_gallery_storage_stats()` | Returns aggregate storage statistics (total galleries, total images, total bytes) |
| `metadata.cleanup_draft_galleries()` | Deletes draft galleries older than 12 hours and their associated files. In metadata schema (hidden from PostgREST, server-side only). |

## Edge Cases

### Entity Deletion

When an entity record is deleted (e.g., `DELETE FROM issues WHERE id = 5`):
- If the FK column uses `ON DELETE CASCADE`, the gallery row is deleted, cascading to `photo_gallery_files`
- If the FK column uses `ON DELETE SET NULL`, the gallery becomes orphaned and should be cleaned up by `metadata.cleanup_draft_galleries` or manual admin action
- File records in `metadata.files` are cleaned up by the consolidated worker's orphan detection

### Browser Crash During Upload

If the browser crashes mid-upload:
- Files that completed S3 upload have their `metadata.files` record — they persist server-side
- The `photo_gallery_files` junction row is created atomically with the file record via `add_gallery_image` RPC, so partial state is avoided
- Draft galleries from abandoned Create pages are cleaned up by the 12-hour orphan cleanup

### Concurrent Edits

If two users edit the same gallery simultaneously:
- `reorder_gallery_images` uses a transaction with `SELECT ... FOR UPDATE` on the gallery row to serialize reorder operations
- `add_gallery_image` and `remove_gallery_image` operate on individual junction rows and don't conflict
- Optimistic concurrency: the frontend refreshes the gallery after each mutation to pick up changes from other users

### Gallery Config Changes

If `photo_gallery_config` is updated (e.g., `max_images` reduced):
- Existing galleries that exceed the new limit are not retroactively modified
- The frontend enforces the new limit on subsequent uploads
- Admin can manually remove excess images via the Gallery Admin page

## S3 Key Pattern

Gallery files use a distinct S3 key prefix:

```
photo_gallery/{gallery_id}/{file_id}/original.{ext}
photo_gallery/{gallery_id}/{file_id}/thumb-150.jpg
photo_gallery/{gallery_id}/{file_id}/thumb-400.jpg
photo_gallery/{gallery_id}/{file_id}/thumb-800.jpg
```

This groups all images for a gallery under one prefix, enabling efficient S3 listing and bulk deletion.

## Related Documentation

- `CLAUDE.md` - Property Type System section (PhotoGallery entry)
- `docs/INTEGRATOR_GUIDE.md` - PhotoGallery System section (setup SQL, configuration)
- `docs/development/PROPERTY_TYPE_REFERENCE.md` - PhotoGallery type detection and display
- `docs/development/FILE_STORAGE.md` - Underlying file storage architecture
- `docs/notes/ADMIN_PAGE_PITFALLS.md` - Admin page patterns (applies to Gallery Admin)
