# Signed File Access URLs — Design Document

> **Status**: Designed, ready to build
> **Dependencies**: Instance Config Store (`docs/notes/INSTANCE_SETUP_DESIGN.md`), `pgcrypto` extension
> **See also**: `docs/notes/SIGV4_SIGNING_REFERENCE.md` (algorithm reference)

## Problem

Files are uploaded to S3 with `public-read` ACL. Anyone who obtains the UUID-based S3 key can access a file forever — even after losing their role or RLS access. The system cannot revoke file access because S3 doesn't check PostgreSQL permissions.

**Goal**: Check the user's current RLS permissions before granting file access, and make URLs expire so revoked access is enforced.

## Architecture: In-Database SigV4 Signing via the `public.files` VIEW

S3 presigned URL generation is purely local HMAC-SHA256 computation — no network call to AWS/MinIO. PostgreSQL's `pgcrypto` extension provides `hmac()` and `digest()`, the only two primitives needed. This means the `public.files` VIEW can include **computed columns** that return presigned GET URLs, keeping everything in PostgREST with zero new infrastructure.

### Data flow

```
Frontend: GET /files?id=eq.{uuid}
    → PostgREST evaluates public.files VIEW (security_invoker = true)
    → RLS on metadata.files filters to rows the caller can see
    → For each visible row, computed columns call metadata.generate_presigned_get_url()
    → That SECURITY DEFINER function reads S3 credentials from get_config(), signs the URL
    → Response includes url, thumb_small_url, thumb_medium_url, etc.
Frontend: <img [src]="file.thumb_medium_url" />
    → Browser fetches presigned URL directly from S3 (15-min TTL)
```

### Why this approach

**Why not the worker HTTP endpoint approach?** Civic OS is PostgREST-first. Every data operation goes through PostgREST RPCs. A Go HTTP endpoint for file access would be the first non-PostgREST path handling user-facing data — an architectural departure. In-database signing keeps the single-API-layer pattern and requires no new HTTP servers, ports, JWT validation in Go, Caddy routing, or RLS emulation.

**Why not the upload-style async polling?** Reads happen on every page render. A list page with 25 images would need 25 poll cycles (~500ms each). Synchronous signing in the VIEW is instant (5 HMAC operations per URL = microseconds).

**Why not a proxy endpoint?** Streaming file bytes through a proxy doubles bandwidth cost and adds latency. Presigned URLs let the browser fetch directly from S3 while still enforcing access control at the PostgreSQL layer.

## Database Changes

### Migration: `v0-XX-0-signed-file-urls`

**Requires**: `pgcrypto` extension (already available)

#### 1. Add `is_public` column to `metadata.files`

```sql
ALTER TABLE metadata.files ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT false;
```

Controls two things:
- **S3 ACL at upload time**: Public files get `public-read`; private files get default (private)
- **URL in VIEW**: Public files return direct S3 URLs; private files return presigned URLs

Set per-file at upload time via the `create_file_record` RPC (`p_is_public` parameter). Defaults to `false`. Callers that need public files (e.g., static assets page) explicitly pass `true`. If an entity-level automation is needed later, a `files_public` flag on `metadata.entities` can be added as a convenience.

**Data migration**: Set `is_public = true` for existing `static_assets` files (`entity_type = 'static_assets'`), `false` for everything else.

#### 2. URI encoding helpers

```sql
-- AWS-compliant URI encoding (uppercase hex, encode everything except A-Z a-z 0-9 - . _ ~)
CREATE FUNCTION metadata.aws_uri_encode(p_input TEXT, p_encode_slash BOOLEAN DEFAULT true) RETURNS TEXT

-- Convenience: encode path segments (don't encode /)
CREATE FUNCTION metadata.aws_uri_encode_path(p_input TEXT) RETURNS TEXT
```

AWS SigV4 requires its own URI encoding rules — not standard `percent_encode`. Slashes in S3 key paths stay literal, but slashes in the credential scope get encoded as `%2F`. See `docs/notes/SIGV4_SIGNING_REFERENCE.md` for the exact encoding rules.

#### 3. Core signing function

```sql
CREATE FUNCTION metadata.generate_presigned_get_url(
  p_bucket TEXT,
  p_key TEXT,
  p_expires_in INTEGER DEFAULT 900,            -- 15 minutes
  p_content_disposition TEXT DEFAULT NULL       -- for download URLs
) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
```

This function:
- Returns NULL if `p_key` is NULL (thumbnail not yet generated)
- Reads S3 credentials via `get_config()` (see Credential Storage below)
- Builds canonical request with `UNSIGNED-PAYLOAD` (standard for presigned GET)
- Derives signing key via 4 chained HMAC-SHA256 operations (intermediates stay `bytea`)
- Supports both path-style (MinIO/DO Spaces) and virtual-hosted (AWS) URLs
- Includes `response-content-disposition` in signature when provided (for downloads)

`SECURITY DEFINER` is needed to read credentials. The function only takes `bucket` + `key` as input — it cannot bypass file access control because it doesn't know which files exist. RLS on `metadata.files` (via the `security_invoker` VIEW) ensures only authorized rows reach the signing function.

#### 4. VIEW wrapper function

```sql
CREATE FUNCTION metadata.get_file_url(
  p_bucket TEXT, p_key TEXT, p_is_public BOOLEAN
) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
```

- If `p_key` is NULL → returns NULL
- If `p_is_public` → returns direct S3 URL (no signing)
- Otherwise → calls `generate_presigned_get_url()`

#### 5. Updated `public.files` VIEW

```sql
CREATE OR REPLACE VIEW public.files
  WITH (security_invoker = true) AS
SELECT
  f.id, f.entity_type, f.entity_id, f.file_name, f.file_type, f.file_size,
  f.s3_key_prefix, f.s3_original_key, f.s3_thumbnail_small_key,
  f.s3_thumbnail_medium_key, f.s3_thumbnail_large_key,
  f.thumbnail_status, f.thumbnail_error, f.property_name,
  f.created_by, f.created_at, f.updated_at, f.s3_bucket, f.is_public,
  -- Signed access URLs (computed on read)
  metadata.get_file_url(f.s3_bucket, f.s3_original_key, f.is_public) AS url,
  metadata.get_file_url(f.s3_bucket, f.s3_thumbnail_small_key, f.is_public) AS thumb_small_url,
  metadata.get_file_url(f.s3_bucket, f.s3_thumbnail_medium_key, f.is_public) AS thumb_medium_url,
  metadata.get_file_url(f.s3_bucket, f.s3_thumbnail_large_key, f.is_public) AS thumb_large_url,
  -- Download URL (always signed, includes Content-Disposition header)
  metadata.generate_presigned_get_url(
    f.s3_bucket, f.s3_original_key, 900,
    'attachment; filename="' || replace(f.file_name, '"', '_') || '"'
  ) AS download_url
FROM metadata.files f;
```

**How RLS is enforced**: `security_invoker = true` means the query evaluates as the calling user. The existing tiered RLS policy on `metadata.files` filters rows *before* the signing functions run. If you can't see the file record, you never get a signed URL.

**Performance**: 25 files × 5 URL columns = 125 presigned URL generations. Each is ~5 HMAC-SHA256 operations (microseconds). Total overhead: ~2-5ms. Negligible.

#### 6. Credential storage

Depends on `metadata.instance_config` (Instance Config Store design). S3 signing credentials stored as config keys:

| Config Key | Example Value | Notes |
|---|---|---|
| `s3_access_key_id` | `AKIAIOSFODNN7EXAMPLE` | IAM user long-term key (not STS) |
| `s3_secret_access_key` | `wJalrXUtnFEMI/...` | Never displayed in admin UI |
| `s3_region` | `us-east-1` | Must match bucket's actual region |
| `s3_public_endpoint` | `http://localhost:9000` | Path-style URL base (MinIO/DO Spaces) |
| `s3_path_style` | `true` | `true` for MinIO/DO Spaces, `false` for AWS |
| `s3_bucket` | `civic-os-files` | Default bucket name |

**Bridge implementation**: If `instance_config` is not yet implemented, create a minimal `get_config()` that reads GUCs via `current_setting('app.' || p_key, true)`. The signing function API stays the same either way.

**Security**: The signing function is `SECURITY DEFINER` — it reads credentials as its owner, regardless of caller. Credentials table/config has `REVOKE ALL FROM public`. No credential data is ever returned to the caller — only the computed presigned URL.

#### 7. `create_file_record()` RPC update

Add `p_is_public BOOLEAN DEFAULT false` parameter. When the presigned upload URL is generated, conditionally include `public-read` ACL only for public files.

#### 8. Test vector verification function

```sql
CREATE FUNCTION metadata.verify_sigv4_test_vector() RETURNS BOOLEAN
```

Validates the signing implementation against AWS's published test vector (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, `test.txt` in `examplebucket`, `us-east-1`). Used for automated testing and confidence in the signing correctness. See `docs/notes/SIGV4_SIGNING_REFERENCE.md` for the complete test vector.

## Frontend Changes

### `FileReference` interface update (`src/app/interfaces/entity.ts`)

Add new fields:

```typescript
url?: string;                    // Signed URL to original file
thumb_small_url?: string;        // Signed URL to small thumbnail
thumb_medium_url?: string;       // Signed URL to medium thumbnail
thumb_large_url?: string;        // Signed URL to large thumbnail
download_url?: string;           // Signed URL with Content-Disposition
is_public?: boolean;
```

### Component updates (~12 files, mechanical)

The change pattern is the same everywhere: replace `getS3Url(file.s3_original_key)` with `file.url`.

| File | Change |
|------|--------|
| `components/file-thumbnail/file-thumbnail.component.ts` | Replace `thumbnailUrl` computed to use `file.thumb_small_url` / `file.thumb_medium_url` / `file.url` cascade |
| `components/display-property/display-property.component.ts` | Remove `getS3Url()` method. Use `file.url`, `file.thumb_medium_url` |
| `components/image-viewer/image-viewer.component.ts` | Replace `getS3Url()`. Display: `file.thumb_large_url ?? file.url`. Download: `file.download_url` |
| `components/pdf-viewer/pdf-viewer.component.ts` | Replace `getS3Url()`. Embed: `file.url`. Download: `file.download_url` |
| `components/gallery-lightbox/gallery-lightbox.component.ts` | Replace URL helpers. Full: `file.url`. Thumb: `file.thumb_small_url` |
| `components/photo-gallery-editor/photo-gallery-editor.component.ts` | Replace `getS3Url()`. Display: `file.thumb_medium_url` |
| `components/edit-property/edit-property.component.ts` | Replace `getS3Url()`. Preview: `file.thumb_small_url ?? file.url` |
| `components/widgets/image-widget/image-widget.component.ts` | Replace `getS3Url()`. Srcset entries use `file.url`, `file.thumb_medium_url` etc. |
| `pages/admin-files/admin-files.page.ts` | Replace `getS3Url()`, `getThumbnailUrl()`. Download: `file.download_url` |
| `pages/static-assets/static-assets.page.ts` | Replace `getS3Url()`. Image display uses `file.url`, `file.thumb_*_url` |
| `services/file-upload.service.ts` | Conditionally include `x-amz-acl: public-read` only for public files |
| `config/runtime.ts` | `getS3Config()` can eventually be deprecated (frontend no longer constructs S3 URLs) |

### Download flow

Current: `fetch(getS3Url(file.s3_original_key))` → blob → download
New: `fetch(file.download_url)` → blob → download

The presigned URL includes `response-content-disposition=attachment;filename="name.jpg"`, so S3 returns the file with the correct download header. **Requires S3/MinIO CORS config** to allow GET from the app origin.

## Worker Changes (Phase 1 — Minimal)

### `thumbnail_worker.go`

Conditionally set `public-read` ACL only for thumbnails of public files. The worker queries `is_public` from the file record before uploading thumbnails.

### `s3_presign_worker.go`

In Phase 1, conditionally set `public-read` ACL based on a new `is_public` field in the job args. In Phase 2, this entire worker is removed.

### Email renderer (`renderer.go`)

Static assets in emails are uploaded with `is_public = true` (via the `p_is_public` parameter). The `staticAsset()` template function continues to work — it queries `public.files`, which now returns `url` (a direct S3 URL for public files). No change needed.

---

## Phase 2: In-Database Upload Signing (eliminates polling)

The same SigV4 algorithm that signs GET URLs can sign PUT URLs — just `PUT` instead of `GET` in the canonical request. This means `request_upload_url` can return a presigned PUT URL **synchronously**, eliminating:

- `metadata.file_upload_requests` table
- `s3_presign` River worker (`s3_presign_worker.go`)
- `s3_signer` queue (20 workers)
- `pg_notify('upload_url_request', ...)` trigger
- Frontend polling loop (500ms × 20 attempts)

### New synchronous upload RPC

```sql
CREATE OR REPLACE FUNCTION request_upload_url(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_file_name TEXT,
  p_file_type TEXT,
  p_is_public BOOLEAN DEFAULT false
) RETURNS JSONB  -- was UUID (request_id for polling); now returns {url, file_id}
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_file_id UUID;
  v_file_ext TEXT;
  v_s3_key TEXT;
  v_presigned_url TEXT;
BEGIN
  -- Generate file ID (UUIDv7)
  v_file_id := uuid_generate_v7();

  -- Build S3 key
  v_file_ext := COALESCE(
    '.' || regexp_replace(p_file_name, '^.*\.', ''),
    '.bin'
  );
  v_s3_key := format('%s/%s/%s/original%s', p_entity_type, p_entity_id, v_file_id, v_file_ext);

  -- Generate presigned PUT URL (reuses same SigV4 engine)
  v_presigned_url := metadata.generate_presigned_put_url(
    get_config('s3_bucket'),
    v_s3_key,
    p_file_type,
    p_is_public,  -- includes x-amz-acl:public-read in signature if true
    900           -- 15-minute expiry
  );

  RETURN jsonb_build_object(
    'url', v_presigned_url,
    'file_id', v_file_id
  );
END;
$$;
```

### New signing function for PUT

```sql
CREATE FUNCTION metadata.generate_presigned_put_url(
  p_bucket TEXT, p_key TEXT, p_content_type TEXT,
  p_is_public BOOLEAN DEFAULT false,
  p_expires_in INTEGER DEFAULT 900
) RETURNS TEXT
```

Same SigV4 algorithm as `generate_presigned_get_url`, but:
- HTTP method: `PUT` instead of `GET`
- Signed headers include `host` (and `x-amz-acl` if public)
- Content-Type is part of the signed request if included

### Frontend upload simplification (`file-upload.service.ts`)

```typescript
// Before (5 steps, async polling):
// 1. requestUploadUrl() → returns request_id
// 2. pollForUrl() → polls every 500ms for presigned URL
// 3. uploadToS3() → PUT to presigned URL
// 4. createFileRecord() → POST to RPC
// 5. waitForThumbnails() → polls for thumbnail

// After (3 steps, synchronous):
// 1. requestUploadUrl() → returns {url, file_id, is_public} immediately
// 2. uploadToS3() → PUT to presigned URL (conditional x-amz-acl header)
// 3. createFileRecord() → POST to RPC (passes is_public)
// (waitForThumbnails stays the same — thumbnails still async via River)
```

The `file_upload_requests` table, `get_upload_url` RPC, and polling logic are all removed.

### Worker cleanup

- Delete `s3_presign_worker.go` entirely
- Remove `s3_signer` queue from River config in `main.go`
- Remove LISTEN/NOTIFY handler for `upload_url_request`
- The worker still handles thumbnails, notifications, etc. — just not upload signing

---

## Security Model

### Access control layers

1. **RLS on `metadata.files`**: The existing tiered policy (`is_admin() OR created_by = current_user_id() OR has_permission(entity_type, 'read') OR metadata.can_view_entity_record(entity_type, entity_id)`) filters rows before any signing occurs.

2. **`security_invoker = true` VIEW**: The `public.files` VIEW evaluates RLS as the calling user. The signing functions in computed columns only run for rows the user can already see.

3. **`SECURITY DEFINER` signing functions**: Read S3 credentials from `instance_config` using the function owner's privileges. No credential data is ever returned — only the computed presigned URL.

4. **URL expiry**: Presigned URLs expire after 15 minutes. If a user's access is revoked, they cannot obtain new URLs (RLS blocks them), and existing URLs expire within 15 minutes.

5. **S3 ACL**: Private files have no public ACL on S3 — direct URL access returns 403. Only presigned URLs (with valid, non-expired signatures) work.

### Threat model

| Threat | Mitigation |
|--------|------------|
| User saves a signed URL and shares it | URL expires in 15 minutes |
| User loses role access | RLS prevents new URL generation; existing URLs expire |
| Attacker guesses S3 key paths | S3 returns 403 (no `public-read` ACL) |
| SQL injection in signing function | Function uses parameterized queries; `search_path = ''` prevents hijacking |
| Credential leak via function output | Function returns only the signed URL, never raw credentials |
| Clock skew causes invalid signatures | Use `now() AT TIME ZONE 'utc'` in PostgreSQL; keep NTP in sync |

## Migration Path

### Phase 1: Signed read URLs (4 steps, each independently deployable)

**Step 1: Deploy signing infrastructure (non-breaking)**
- Migration: `is_public` file column, signing functions, updated VIEW
- Seed S3 credentials into instance_config (or GUCs as bridge)
- Data migration: set `is_public = true` for existing `static_assets` files
- **All files remain `public-read` on S3** — signed URLs work but old direct URLs also work
- Frontend unchanged

**Step 2: Frontend switchover**
- Update `FileReference` interface with new URL fields
- Replace `getS3Url()` with VIEW-provided URL fields in all components
- Deploy frontend
- **Verify**: All images load via presigned URLs (Network tab shows `X-Amz-Signature` in URLs)

**Step 3: Private-by-default for new uploads**
- Worker: conditionally set `public-read` ACL only for files where `is_public = true`
- Frontend: conditionally send `x-amz-acl` header only for public files
- New uploads to non-public entities are private; existing files still `public-read`

**Step 4: Bulk migrate existing S3 objects to private**
- One-time script: list all S3 objects, set ACL to `private` (skip `is_public = true` files)
- Idempotent and resumable
- After this, leaked URLs from before the migration stop working

**Rollback at any step:**
- Step 2: Frontend can read both old and new fields — revert is a frontend deploy
- Step 3: Re-add unconditional `public-read` ACL
- Step 4: Re-run ACL script setting objects back to `public-read`

### Phase 2: In-database upload signing (separate release)

**Step 5: Migrate upload signing to PostgreSQL**
- New migration: `generate_presigned_put_url()` function, updated `request_upload_url()` RPC
- Frontend: simplify `FileUploadService` (remove polling, use synchronous response)
- Worker: delete `s3_presign_worker.go`, remove `s3_signer` queue
- Drop `metadata.file_upload_requests` table (cleanup migration)
- **Verify**: Upload flow works end-to-end without worker involvement for signing

## Verification Checklist

### Phase 1 (Signed read URLs)
1. **SigV4 correctness**: Run `metadata.verify_sigv4_test_vector()` against AWS's published test vector
2. **Live signing**: Compare output of `generate_presigned_get_url()` with `aws s3 presign` CLI for the same object
3. **Unit tests**: Frontend component tests with mock file records containing `url`, `thumb_*_url` fields
4. **RLS enforcement**: Query `/files` as different roles — verify only authorized files return signed URLs
5. **Revocation test**: Access file → remove role → re-query `/files` → verify file no longer returned
6. **Public files**: Upload with `is_public = true` → verify direct (unsigned) URL returned
7. **Download**: Click download → verify blob download works via `download_url` with Content-Disposition
8. **MinIO + AWS**: Test signing with both path-style and virtual-hosted URL formats
9. **Clock sanity**: Verify signed URL works within TTL, fails after expiry

### Phase 2 (In-database upload signing)
10. **Upload flow**: Upload file → verify no polling occurs, presigned URL returned synchronously
11. **Public upload**: Upload with `is_public = true` → verify S3 object has `public-read` ACL
12. **Private upload**: Upload to standard entity → verify S3 object is private (403 on direct URL)
13. **Worker cleanup**: Verify `s3_signer` queue no longer exists, no presign jobs enqueued

## Known Gaps / Implementation Notes

These issues were identified during design review and must be addressed during implementation.

### 1. Browser image caching (most significant)

Current `getS3Url()` produces deterministic URLs — same S3 key = same URL = browser cache hit. Presigned URLs include `X-Amz-Date` and `X-Amz-Signature` in the query string, so every VIEW query produces a *different* URL for the same object. This means:

- Angular sees a new `[src]` string → updates the DOM
- Browser treats it as a new resource → cache miss → re-downloads

On a list page with 25 thumbnails, this causes 25 unnecessary re-fetches on every navigation or re-render.

**Mitigation options** (decide during implementation):
- **Frontend URL cache**: Cache file records (including signed URLs) in a service-level `Map<fileId, {record, expiresAt}>` keyed by file ID, with TTL slightly less than the presigned URL expiry (e.g., 12 minutes). Return cached records on re-query until TTL expires.
- **`computed()` memoization**: Ensure all components use `computed()` for URL derivation (currently only `FileThumbnailComponent` does — `DisplayPropertyComponent`, `ImageViewerComponent`, `PdfViewerComponent`, and `GalleryLightboxComponent` use direct method calls in templates).
- **Accept the tradeoff for private files**: Document that private files trade caching for security. Public files (`is_public = true`) return deterministic direct URLs and remain cacheable.

### 2. PostgREST select strings need updating

`SchemaService.propertyToSelectString()` explicitly lists file columns in its PostgREST select string:

```typescript
// Current (line ~723):
`${prop.column_name}:files!${prop.column_name}(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,thumbnail_error,created_at)`
```

The new VIEW columns (`url`, `thumb_small_url`, `thumb_medium_url`, `thumb_large_url`, `download_url`, `is_public`) are **not** in this select string. They must be added, or PostgREST won't return them. This is the critical path for the frontend switchover (Step 2).

### 3. `instance_config` / `get_config()` doesn't exist yet

The signing functions depend on `get_config()` to read S3 credentials. Neither `metadata.instance_config` nor `get_config()` exist in the codebase yet (see `docs/notes/INSTANCE_SETUP_DESIGN.md`).

**GUC bridge specifics**: Until `instance_config` is implemented, seed credentials via:

```sql
ALTER DATABASE civic_os SET app.s3_access_key_id = 'AKIA...';
ALTER DATABASE civic_os SET app.s3_secret_access_key = 'wJalr...';
ALTER DATABASE civic_os SET app.s3_region = 'us-east-1';
ALTER DATABASE civic_os SET app.s3_public_endpoint = 'http://localhost:9000';
ALTER DATABASE civic_os SET app.s3_path_style = 'true';
ALTER DATABASE civic_os SET app.s3_bucket = 'civic-os-files';
```

The bridge `get_config()` reads these via `current_setting('app.' || p_key, true)`. These values mirror the existing environment variables the Go worker already consumes (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, etc.).

### 4. CORS for presigned GET downloads

`<img>` and `<video>` tags are CORS-exempt — presigned URLs work without CORS headers. However, the **download flow** uses `fetch(file.download_url)` to create a blob, which is a cross-origin JavaScript request and **requires CORS**.

Current S3/MinIO CORS configuration (documented in `infrastructure/vps/README.md`) only lists `PUT` as an allowed method. `GET` must be added:

```
Allowed Methods: GET, PUT
Allowed Headers: *
Allowed Origin: https://{APP_DOMAIN}
```

For development, MinIO's default permissive CORS should work. For production (AWS S3, DigitalOcean Spaces), the CORS configuration must be updated before Step 2 of the migration.

### 5. `download_url` for public files

The VIEW always generates a signed `download_url` (with `Content-Disposition`) even for public files. This is intentional — `Content-Disposition` requires the `response-content-disposition` query parameter, which must be signed. Public files' display URLs (`url`, `thumb_*_url`) remain unsigned direct URLs.

## Critical Files

| File | Role |
|------|------|
| `postgres/migrations/deploy/v0-5-0-add-file-storage.sql` | Original file storage migration (VIEW, RLS, RPCs, `request_upload_url`) |
| `postgres/migrations/deploy/v0-39-0-add-file-admin.sql` | File admin migration (tiered RLS policy, `can_view_entity_record`) |
| `postgres/migrations/deploy/v0-38-0-add-static-assets.sql` | Static assets schema (files with `entity_type = 'static_assets'`) |
| `services/consolidated-worker-go/s3_presign_worker.go` | Upload presigning (Phase 1: conditional ACL; Phase 2: delete entirely) |
| `services/consolidated-worker-go/thumbnail_worker.go` | Thumbnail upload (conditional `public-read` ACL) |
| `services/consolidated-worker-go/s3_client.go` | S3 client config (endpoint/region/path-style handling) |
| `services/consolidated-worker-go/main.go` | River queue config (Phase 2: remove `s3_signer` queue) |
| `src/app/interfaces/entity.ts` | `FileReference` interface |
| `src/app/components/file-thumbnail/file-thumbnail.component.ts` | Primary thumbnail display component |
| `src/app/components/display-property/display-property.component.ts` | Property display (file types) |
| `src/app/config/runtime.ts` | `getS3Config()` (to deprecate after frontend switchover) |
| `src/app/services/file-upload.service.ts` | Upload service (Phase 1: conditional ACL; Phase 2: remove polling) |
| `docs/notes/INSTANCE_SETUP_DESIGN.md` | Instance config design (dependency for credential storage) |
| `docs/notes/SIGV4_SIGNING_REFERENCE.md` | SigV4 algorithm reference (extracted from research) |
