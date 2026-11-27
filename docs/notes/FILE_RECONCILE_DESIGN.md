# File Reconcile: Staged Uploads, Claiming and Orphan Cleanup

**Status**: built (issue #141). Steps 0 to 4 in v0.87.0 (step 0, Create pages save the staged file's id; step 1, the `_new` staging key; steps 2 to 4, the reconcile job), with the changes recorded in Amendments after build.
**Decided with the maintainer (2026-11-24)**: stage uploads made before a record exists under `_new`, then move them to the record's folder from a periodic reconcile job, which also deletes files nothing references. Per-table triggers were the rejected alternative (see Alternatives). The open questions were settled the same day (see Decisions).

## Problem

A file attached on a Create page is uploaded before its record exists, so `EditPropertyComponent.entityId()` is `''` (`src/app/components/edit-property/edit-property.component.ts`). That empty id flows through `file-upload.service.ts` and `request_upload_url` to the presign worker, which built `{entity_type}//{file_id}/original.ext` (`services/consolidated-worker-go/s3_presign_worker.go`).

- **Local S3 (RustFS)** rejects the `//` key, so the upload fails. The upload request is still marked `completed`, with a `file_id` that never gets a `metadata.files` row.
- **AWS S3** accepts `//`, so production stores the file under an id-less prefix.
- **The row never learns its record.** `metadata.files.entity_id` stays `''` after the record is saved. The File Admin page links such a file to `/view/{entity_type}/` instead of its record (`admin-files.page.ts`), and `s3_key_prefix` (generated from `entity_id`) reads `{type}//{file_id}`.
- **Nothing is ever deleted from S3.** Neither worker calls `DeleteObject`. A file attached on a Create page that is never saved, or replaced before saving, leaves its row and objects forever. `delete_file_record()` removes only the row.

## Facts the design rests on

- Entity tables reference files through single-column foreign keys: `<column> UUID REFERENCES metadata.files(id)`. `pg_constraint` lists them (`confrelid = 'metadata.files'::regclass`), the way `register_dimension()` finds a dimension's referencing columns.
- Thumbnails are written beside the original: the thumbnail worker takes `filepath.Dir(s3_original_key)` as its base path. A thumbnail job that runs after a move must therefore read the moved key, and a move must not race a thumbnail job that is still writing.
- `thumbnail_status` records that state: `pending` and `processing` mean a job may still write, while `completed`, `failed` and `not_applicable` are final.
- Photo galleries (`entity_type = 'photo_gallery'`) have their own draft lifecycle (`cleanup_draft_galleries()`) and always know their gallery id. They are out of scope.
- S3 has no atomic move: a move is copy, then delete.

## Design

### Step 0: Create pages save the file's id (built, v0.87.0)

Every later step finds a staged file through the foreign key of the record that saved it, so that key must be set. Before v0.87.0 it never was: the Create page showed File, FileImage and FilePDF inputs (its renderables come from `propsForCreate`, which keeps them, since v0.17.0), but `recordEditor` left those properties out of the create form, so the upload's id had no form field to land in (`EditPropertyComponent` writes it with `form.get(column)?.setValue`, a no-op without a control). The user saw "Uploaded", the save succeeded, and the record's file column stayed NULL.

`recordEditor` now keeps file properties in the create form, as edit always has, and `transformValuesForApi` maps a file object to its id in both modes. A required file column is now required on Create too. An untouched file field is sent as `null`, like any other empty field.

### Step 1: staging key (built, v0.87.0)

When `entity_id` is empty, the presign worker writes `{entity_type}/_new/{file_id}/original.{ext}` (since v0.88.0 the database issues uploads and `request_file_upload()` computes the same key in SQL; there is no presign worker). `entity_id` stays `''` in `metadata.files`: the empty id remains the "unclaimed" marker, so no migration is needed and existing rows keep their meaning. Uploads on Create pages work against RustFS, and production stops creating id-less prefixes.

### Step 2: discover references (SQL, migration; built, v0.87.0)

`metadata.unclaimed_file_references(p_limit int)`, SECURITY DEFINER, with EXECUTE revoked from PUBLIC (worker only), returns `(file_id, entity_type, entity_id)` rows:

1. Unclaimed files are those with `entity_id = ''` and `entity_type <> 'photo_gallery'`, served by a partial index `WHERE entity_id = ''`.
2. Every FK column in `public` that references `metadata.files(id)` is read from `pg_constraint`. For each, the function selects the referencing table's single-column primary key from rows whose column holds an unclaimed id. This is a dynamic `UNION ALL` built with `format('%I')`, skipping tables without a single-column primary key.
3. A file referenced by more than one row (for example a record copied with its file id before the first was claimed) is claimed for the first owner: the referencing table that sorts first by name, then its lowest primary key. The other references keep pointing at the same file, which is no longer an orphan. The job logs the shared file once.

`entity_type` is taken from the referencing table, not from the file row, so a file uploaded for one entity and attached to another moves to its real owner.

Legacy rows (`entity_id = ''` with a `{type}//{file_id}` key, uploaded on AWS before step 1) are claimed the same way, which repairs them.

### Step 3: claim and move (Go, consolidated worker; built, v0.87.0)

`FileReconcileCron` follows `GalleryCleanupCron`: a Go ticker in the consolidated worker only, every `FILE_RECONCILE_INTERVAL` (default 5 min), not River periodic jobs (see `docs/notes/SCHEDULED_JOBS_DESIGN.md` for why). Each tick:

1. Reads a batch from `unclaimed_file_references()`, skipping files whose `thumbnail_status` is `pending` or `processing` (they are retried next tick, so the move never races a thumbnail write).
2. For each file, `CopyObject`s the original and every non-null thumbnail key to `{entity_type}/{entity_id}/{file_id}/<same file name>`.
3. Calls `metadata.claim_file(p_file_id, p_entity_type, p_entity_id, p_keys jsonb)`, which updates `entity_id`, `entity_type` and the key columns in one statement, guarded by `WHERE id = p_file_id AND entity_id = ''`. Zero rows changed means another worker claimed the file first: delete the copies just made and move on.
4. `DeleteObject`s the old keys.

Failure leaves nothing broken. A crash after step 2 leaves unreferenced copies under the new prefix. A crash after step 3 leaves the old objects under `_new/`. The sweep in step 4 removes both. Readers build URLs from the row's keys at read time, so the only visible effect is that a page opened before the move can get a 404 on a stale thumbnail URL until it reloads.

### Step 4: orphan cleanup (built, v0.87.0)

The same tick deletes what nothing will claim, oldest first, in batches:

- **Unreferenced staged files.** Rows with `entity_id = ''` that no FK references and are older than `FILE_ORPHAN_TTL` (default 7 days): delete the objects, then the row.
- **Stray objects.** Objects under `{type}/_new/` whose file row is claimed or gone, older than the TTL: delete them. This finishes interrupted moves.
- **Stale upload requests.** `metadata.file_upload_requests` rows older than 24 hours, as the table comment already promises but nothing does.

Deleting objects for rows removed by `delete_file_record()` (claimed files) is a separate change, issue #165: it needs a tombstone, because the row is gone.

### Migration and configuration

- **Migration:** `v0-87-0-file-reconcile` adds the partial index, `unclaimed_file_references()`, `claim_file()` and `orphaned_staged_files(p_ttl interval, p_limit int)`, all worker-only (EXECUTE revoked from PUBLIC, `SET search_path`).
- **Worker environment:** `FILE_RECONCILE_INTERVAL` (default `5m`, `0` disables the job) and `FILE_ORPHAN_TTL` (default `168h`, 7 days).
- **Expired attachment on save.** A Create page left open longer than the TTL references a deleted file, and its save fails with a foreign-key violation (`23503`) on a column that references `metadata.files`. Core's error classification maps that case to a translated message on the field ("This attachment expired. Upload it again."), a new key seeded in the six core locales, instead of the generic constraint error.
- **Logs:** files claimed, moved, skipped (pending thumbnails, multiple references) and deleted per tick.

### Testing

- **Go unit tests:** key mapping (staging, legacy `//`, thumbnails), and claim conflicts (zero rows changed, so the copies are deleted).
- **Functional test** on an example stack with RustFS:
  - a file uploaded on a Create page lands under `_new/`;
  - after the record is saved and one tick runs, the row has the record id, the objects exist under the record's prefix and are gone from `_new/`;
  - an unreferenced staged file older than the TTL is deleted;
  - a referenced file with a pending thumbnail waits.
- **Browser:** attach a file on Create, save, wait one tick; the Detail page and File Admin show and link the file.

## Alternatives

- **Triggers on every file column** that claim and enqueue a move job at save time. Moves would be immediate, but the triggers have to be installed on, and re-installed for, every table that gains a file column (the dimension registry's burden), and orphan cleanup would still need a periodic job. Rejected in favor of one job that finds references itself.
- **Drop the entity id from the key** (`{type}/{file_id}/…`). Simpler, but two key layouts would coexist, and the bucket would no longer group a record's files. Not chosen.
- **Placeholder only** (step 1 alone). It fixes the upload failure but never links staged files to their records or cleans up. Not chosen as the end state, though step 1 ships first.

## Decisions (2026-11-24)

1. **TTL versus long-open forms.** `FILE_ORPHAN_TTL` defaults to 7 days, long enough for a tab left open over a weekend; orphans cost little storage. A save that still hits a deleted staged file gets a clear, translated "upload it again" message (see Migration and configuration). No re-check before save. Rejected: a 24 h TTL with the Create page re-checking its staged files before every save (an extra request and client logic on every save with files).
2. **Multiple references.** Claim for the first owner (step 2), not skip-and-log (the file would never get a real key, and cleanup could never remove it because it is referenced) and not copy-per-owner (the worker would write to instance tables with superuser rights).
3. **Deleting claimed files' objects** after `delete_file_record()` or a record delete is a follow-up, issue #165, not part of #141: it needs a tombstone, since the row is gone by the time a job could act, and a decision about record deletes, which today keep their file rows.

## Amendments after build (v0.87.0, 2026-11-24)

Building steps 2 to 4 changed these points. Each closes a gap found while building, and the rest of the design stands.

1. **A live thumbnail job holds a file back, not `thumbnail_status`.** The thumbnail worker never writes `processing`, and on failure it wrote `'error'`, which the CHECK constraint rejects. So a file whose thumbnail fails stayed `pending` through 25 retries and then forever, and the status rule would never claim it. The worker reads `s3_original_key` each time it runs, so the real hazard is a job that may still run. `metadata._file_thumbnail_job_live()` looks for a `thumbnail_generate` River job for the file in `available`, `pending`, `retryable`, `running` or `scheduled` (through the existing GIN index on `args`). The thumbnail worker now writes `failed` on its last attempt.
2. **`claim_file()` returns an outcome, not a boolean, and checks more.** Its parameters are the file, the owner's table and column, the record id, the `updated_at` that `unclaimed_file_references()` read, and the four new keys; the `p_keys jsonb` of the design became typed parameters. It returns:
   - `claimed`;
   - `claimed_elsewhere`: already claimed with the same keys. Two workers copy to the same keys, so the loser must keep, not delete, the copies;
   - `stale`: the row changed or went away since it was read;
   - `unreferenced`: the record no longer references the file. It is re-checked under `FOR KEY SHARE`, so a record deleted between discovery and claim does not get the file.

   It refuses (22023) a column that is not a single-column foreign key from a public table with a single-column primary key. The worker deletes its copies only on `stale` and `unreferenced`.
3. **Orphans: row first, then objects, and references in every schema.** The design deleted objects, then the row. If the row delete then failed (the file was referenced in the meantime), the record would point at a file with no objects. `metadata.delete_orphaned_staged_files(p_ttl, p_limit)` (the design's `orphaned_staged_files`) deletes each row under `FOR UPDATE SKIP LOCKED`, skips one that turns out to be referenced (`foreign_key_violation`), and returns the keys for the worker to delete. An object left behind is swept later. The reference check covers foreign keys in every schema, not only `public`, because a `CASCADE` or `SET NULL` reference (for example from a `metadata` table) would otherwise be hit silently. The TTL must be at least 1 hour.
4. **The limit applies to references, not to staged rows.** Limiting staged rows first would let a backlog of unreferenced uploads, all waiting for the TTL, hide every referenced one.
5. **Stray objects.** `metadata.staged_file_states(ids)` tells the sweep which ids under `{type}/_new/` still have a row and whether it is claimed. Objects of a claimed row are deleted at once (an interrupted move). Objects without a row are deleted once older than the TTL, since an upload may still be creating its row. The sweep lists `{type}/` prefixes with a delimiter, then each `{type}/_new/`, up to 1,000 objects a tick.
6. **One case is not swept: a crash after copying but before claiming, when the record is then deleted.** A later tick normally re-copies and claims (the copy is idempotent). If the reference disappears first, the copies under `{type}/{id}/{file}/` stay, because only `_new/` prefixes are listed. Listing every record prefix would cost a full bucket scan per tick, so this rare leak is accepted.
7. **The expired-attachment message is shown in the Create page's error modal, naming the field**, not on the field itself. Core's classifier now returns the referenced table for a 23503 (`params.referencedTable`, an additive `ErrorParams` field), and the column when the detail names it. PostgreSQL leaves the key out for a caller without SELECT on the referencing columns, which includes every API role (`Key is not present in table "files".`), so the column is usually absent. The Create page finds the field from the constraint name (`<table>_<column>_fkey` by default), else from the file fields that hold a value, and shows `error.attachment_expired` (six locales) with the field's label. Core's English default (MCP) names the attachment. Error text is otherwise not translated yet (`ErrorService`), so the page maps this one case.
8. **Configuration.** `FILE_RECONCILE_INTERVAL` (`0` disables) and `FILE_ORPHAN_TTL` (at least `1h`); an unreadable value falls back to its default with a log line. The first tick runs when the worker starts. The worker needs `s3:DeleteObject`, which the documented IAM policy lacked.
9. **Tests.**
   - `tests/functional/v0-87-0-file-reconcile-sql-test.sh` checks the functions on throwaway tables in one rolled-back transaction: a mixed-case table name, a text primary key, a table without a key, a `CASCADE` reference from another schema, live jobs and every claim outcome. It runs in PR CI on the bare database.
   - `tests/functional/v0-87-0-file-reconcile-test.sh` drives the real worker on pothole (nightly, `FILE_RECONCILE_INTERVAL=5s` from `tests/e2e/env/pothole.compose-env`).
   - Go unit tests cover the key mapping, the configuration and the copy, claim and delete sequence over fakes.
   - The legacy `{type}//{file}` repair is covered by the Go and SQL tests only, because RustFS refuses such keys.

