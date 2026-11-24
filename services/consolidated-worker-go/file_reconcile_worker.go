// Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.

package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ============================================================================
// File Reconcile Cron (issue #141, v0.87.0)
//
// A file attached on a Create page is uploaded before its record exists, so it is
// staged as {entity_type}/_new/{file_id}/... with metadata.files.entity_id = ''. Each
// tick this job:
//   1. claims staged files that a record references: copies the original and its
//      thumbnails to {entity_type}/{entity_id}/{file_id}/, claims the row in one guarded
//      statement (metadata.claim_file), then deletes the old objects;
//   2. deletes staged files nothing has referenced for FILE_ORPHAN_TTL (row first, then
//      objects);
//   3. sweeps objects left under {type}/_new/ by interrupted moves or failed uploads;
//   4. deletes metadata.file_upload_requests rows older than 24 hours.
//
// Like GalleryCleanupCron, a Go ticker in the consolidated worker only, not a River
// periodic job. Design: docs/notes/FILE_RECONCILE_DESIGN.md.
// ============================================================================

const (
	defaultFileReconcileInterval = 5 * time.Minute
	defaultFileOrphanTTL         = 7 * 24 * time.Hour
	minFileOrphanTTL             = time.Hour
	fileReconcileBatch           = 100
	strayObjectScanLimit         = 1000
	staleUploadRequestAge        = 24 * time.Hour
)

// fileReconcileConfig reads FILE_RECONCILE_INTERVAL (Go duration, "0" disables) and FILE_ORPHAN_TTL
// (Go duration, at least 1h). An unreadable value falls back to its default and is logged.
func fileReconcileConfig(getenv func(string) string) (interval, ttl time.Duration) {
	interval = defaultFileReconcileInterval
	if v := strings.TrimSpace(getenv("FILE_RECONCILE_INTERVAL")); v != "" {
		if v == "0" {
			interval = 0
		} else if d, err := time.ParseDuration(v); err != nil || d < 0 {
			log.Printf("[FileReconcile] Invalid FILE_RECONCILE_INTERVAL %q, using %s", v, defaultFileReconcileInterval)
		} else {
			interval = d
		}
	}
	ttl = defaultFileOrphanTTL
	if v := strings.TrimSpace(getenv("FILE_ORPHAN_TTL")); v != "" {
		if d, err := time.ParseDuration(v); err != nil || d < minFileOrphanTTL {
			log.Printf("[FileReconcile] Invalid FILE_ORPHAN_TTL %q (a duration of at least %s), using %s", v, minFileOrphanTTL, defaultFileOrphanTTL)
		} else {
			ttl = d
		}
	}
	return interval, ttl
}

// fileKeys are a file's object keys: the original and up to three thumbnails ("" when absent).
type fileKeys struct {
	Original, Small, Medium, Large string
}

func (k fileKeys) list() []string {
	out := []string{}
	for _, key := range []string{k.Original, k.Small, k.Medium, k.Large} {
		if key != "" {
			out = append(out, key)
		}
	}
	return out
}

// claimedKeys maps a staged file's keys to its record's folder, keeping each object's
// name: Issue/_new/f1/original.png -> Issue/42/f1/original.png, and the legacy id-less
// Issue//f1/thumb-small.jpg -> Issue/42/f1/thumb-small.jpg.
func claimedKeys(entityType, entityID, fileID string, keys fileKeys) fileKeys {
	move := func(key string) string {
		if key == "" {
			return ""
		}
		return fmt.Sprintf("%s/%s/%s/%s", entityType, entityID, fileID, path.Base(key))
	}
	return fileKeys{move(keys.Original), move(keys.Small), move(keys.Medium), move(keys.Large)}
}

// stagedFileID returns the file id of an object under {type}/_new/{file_id}/...
func stagedFileID(key string) (string, bool) {
	parts := strings.Split(key, "/")
	if len(parts) < 4 || parts[1] != stagedEntityID || parts[2] == "" || parts[0] == "" {
		return "", false
	}
	return parts[2], true
}

// copySource is the x-amz-copy-source value: bucket/key with each segment URL-escaped.
func copySource(bucket, key string) string {
	segments := strings.Split(key, "/")
	for i, s := range segments {
		segments[i] = url.PathEscape(s)
	}
	return url.PathEscape(bucket) + "/" + strings.Join(segments, "/")
}

// unclaimedReference is one row of metadata.unclaimed_file_references().
type unclaimedReference struct {
	FileID, Table, Column, EntityID, Bucket string
	Keys                                    fileKeys
	SeenUpdatedAt                           time.Time
}

// orphanedFile is one row deleted by metadata.delete_orphaned_staged_files().
type orphanedFile struct {
	FileID, Bucket string
	Keys           fileKeys
}

// stagedObject is an object found under {type}/_new/.
type stagedObject struct {
	Key          string
	LastModified time.Time
}

// fileReconcileDB is the job's database side (metadata.* functions of v0-87-0-file-reconcile).
type fileReconcileDB interface {
	UnclaimedReferences(ctx context.Context, limit int) ([]unclaimedReference, error)
	ClaimFile(ctx context.Context, ref unclaimedReference, keys fileKeys) (string, error)
	DeleteOrphanedStagedFiles(ctx context.Context, ttl time.Duration, limit int) ([]orphanedFile, error)
	StagedFileStates(ctx context.Context, ids []string) (map[string]bool, error)
	DeleteStaleUploadRequests(ctx context.Context, age time.Duration) (int, error)
}

// fileObjectStore is the job's S3 side.
type fileObjectStore interface {
	Copy(ctx context.Context, bucket, from, to string) error
	Delete(ctx context.Context, bucket, key string) error
	ListStaged(ctx context.Context, bucket string, limit int) ([]stagedObject, error)
}

// FileReconcileCron claims staged files for their records and cleans up orphans.
type FileReconcileCron struct {
	db       fileReconcileDB
	store    fileObjectStore
	bucket   string
	interval time.Duration
	ttl      time.Duration
	now      func() time.Time
	done     chan bool
}

// NewFileReconcileCron builds the job over the worker's pool and S3 client.
func NewFileReconcileCron(dbPool *pgxpool.Pool, s3Client *s3.Client, bucket string, interval, ttl time.Duration) *FileReconcileCron {
	return &FileReconcileCron{
		db:       &pgFileReconcileDB{pool: dbPool},
		store:    &s3FileObjectStore{client: s3Client},
		bucket:   bucket,
		interval: interval,
		ttl:      ttl,
		now:      time.Now,
	}
}

// Start runs one tick at once, then one every interval. An interval of 0 disables the job.
func (c *FileReconcileCron) Start(ctx context.Context) {
	if c.interval <= 0 {
		log.Println("[FileReconcile] Disabled (FILE_RECONCILE_INTERVAL=0)")
		return
	}
	c.done = make(chan bool)
	go func() {
		c.RunTick(ctx)
		ticker := time.NewTicker(c.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				c.RunTick(ctx)
			case <-c.done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	log.Printf("[FileReconcile] Started - every %s, orphan TTL %s", c.interval, c.ttl)
}

// Stop ends the ticker goroutine.
func (c *FileReconcileCron) Stop() {
	if c.done != nil {
		close(c.done)
		c.done = nil
	}
	log.Println("[FileReconcile] Stopped")
}

// tickStats counts what one tick did, for its log line.
type tickStats struct {
	Claimed, ClaimedElsewhere, Stale, Unreferenced, CopyFailed int
	OrphansDeleted, StrayObjectsDeleted, UploadRequestsDeleted int
	Errors                                                     int
}

// RunTick runs the four steps once. Each step logs and skips its own failures, so one
// bad file or an S3 outage never stops the others.
func (c *FileReconcileCron) RunTick(ctx context.Context) tickStats {
	var st tickStats

	refs, err := c.db.UnclaimedReferences(ctx, fileReconcileBatch)
	if err != nil {
		log.Printf("[FileReconcile] Error reading unclaimed file references: %v", err)
		st.Errors++
	}
	for _, ref := range refs {
		switch outcome := c.claimOne(ctx, ref); outcome {
		case "claimed":
			st.Claimed++
		case "claimed_elsewhere":
			st.ClaimedElsewhere++
		case "stale":
			st.Stale++
		case "unreferenced":
			st.Unreferenced++
		case "copy_failed":
			st.CopyFailed++
		default:
			st.Errors++
		}
	}

	orphans, err := c.db.DeleteOrphanedStagedFiles(ctx, c.ttl, fileReconcileBatch)
	if err != nil {
		log.Printf("[FileReconcile] Error deleting orphaned staged files: %v", err)
		st.Errors++
	}
	for _, o := range orphans {
		c.deleteKeys(ctx, o.Bucket, o.Keys.list())
		st.OrphansDeleted++
	}

	st.StrayObjectsDeleted, err = c.sweepStrayObjects(ctx)
	if err != nil {
		log.Printf("[FileReconcile] Error sweeping staged objects: %v", err)
		st.Errors++
	}

	st.UploadRequestsDeleted, err = c.db.DeleteStaleUploadRequests(ctx, staleUploadRequestAge)
	if err != nil {
		log.Printf("[FileReconcile] Error deleting stale upload requests: %v", err)
		st.Errors++
	}

	if st != (tickStats{}) {
		log.Printf("[FileReconcile] Tick: claimed %d, claimed elsewhere %d, stale %d, unreferenced %d, copy failed %d; orphans deleted %d, stray objects deleted %d, upload requests deleted %d; errors %d",
			st.Claimed, st.ClaimedElsewhere, st.Stale, st.Unreferenced, st.CopyFailed,
			st.OrphansDeleted, st.StrayObjectsDeleted, st.UploadRequestsDeleted, st.Errors)
	}
	return st
}

// claimOne moves one staged file to its record: copy, claim, then delete the old objects.
// It returns claim_file's outcome, "copy_failed", or "error".
func (c *FileReconcileCron) claimOne(ctx context.Context, ref unclaimedReference) string {
	target := claimedKeys(ref.Table, ref.EntityID, ref.FileID, ref.Keys)
	from, to := ref.Keys.list(), target.list()

	copied := []string{}
	for i := range from {
		if err := c.store.Copy(ctx, ref.Bucket, from[i], to[i]); err != nil {
			log.Printf("[FileReconcile] File %s: copy %s -> %s failed: %v", ref.FileID, from[i], to[i], err)
			c.deleteKeys(ctx, ref.Bucket, copied)
			return "copy_failed"
		}
		copied = append(copied, to[i])
	}

	outcome, err := c.db.ClaimFile(ctx, ref, target)
	if err != nil {
		log.Printf("[FileReconcile] File %s: claim failed: %v", ref.FileID, err)
		c.deleteKeys(ctx, ref.Bucket, copied)
		return "error"
	}
	switch outcome {
	case "claimed":
		c.deleteKeys(ctx, ref.Bucket, from)
		log.Printf("[FileReconcile] File %s claimed for %s %s (%s)", ref.FileID, ref.Table, ref.EntityID, ref.Column)
	case "claimed_elsewhere":
		// Another worker moved it to the same keys: the copies are the live objects.
	default: // stale, unreferenced
		c.deleteKeys(ctx, ref.Bucket, copied)
	}
	return outcome
}

// sweepStrayObjects deletes objects under {type}/_new/ that no staged row owns: those of
// claimed rows at once (an interrupted move), and those without a row once older than the
// TTL (an upload whose row was never created, or an orphan whose objects failed to delete).
func (c *FileReconcileCron) sweepStrayObjects(ctx context.Context) (int, error) {
	objects, err := c.store.ListStaged(ctx, c.bucket, strayObjectScanLimit)
	if err != nil || len(objects) == 0 {
		return 0, err
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, o := range objects {
		if id, ok := stagedFileID(o.Key); ok && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	states, err := c.db.StagedFileStates(ctx, ids)
	if err != nil {
		return 0, err
	}
	cutoff := c.now().Add(-c.ttl)
	deleted := 0
	for _, o := range objects {
		id, ok := stagedFileID(o.Key)
		if !ok {
			continue
		}
		claimed, hasRow := states[id]
		if hasRow && !claimed {
			continue // still staged: its row owns it
		}
		if !hasRow && !o.LastModified.Before(cutoff) {
			continue // an upload may still be creating its row
		}
		if err := c.store.Delete(ctx, c.bucket, o.Key); err != nil {
			log.Printf("[FileReconcile] Delete %s failed: %v", o.Key, err)
			continue
		}
		deleted++
	}
	return deleted, nil
}

func (c *FileReconcileCron) deleteKeys(ctx context.Context, bucket string, keys []string) {
	for _, key := range keys {
		if err := c.store.Delete(ctx, bucket, key); err != nil {
			log.Printf("[FileReconcile] Delete %s failed: %v", key, err)
		}
	}
}

// ============================================================================
// PostgreSQL side
// ============================================================================

type pgFileReconcileDB struct {
	pool *pgxpool.Pool
}

func (p *pgFileReconcileDB) UnclaimedReferences(ctx context.Context, limit int) ([]unclaimedReference, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT file_id::text, table_name::text, column_name::text, entity_id, s3_bucket, s3_original_key,
		       COALESCE(s3_thumbnail_small_key, ''), COALESCE(s3_thumbnail_medium_key, ''),
		       COALESCE(s3_thumbnail_large_key, ''), seen_updated_at
		FROM metadata.unclaimed_file_references($1)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []unclaimedReference{}
	for rows.Next() {
		var r unclaimedReference
		if err := rows.Scan(&r.FileID, &r.Table, &r.Column, &r.EntityID, &r.Bucket, &r.Keys.Original,
			&r.Keys.Small, &r.Keys.Medium, &r.Keys.Large, &r.SeenUpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (p *pgFileReconcileDB) ClaimFile(ctx context.Context, ref unclaimedReference, keys fileKeys) (string, error) {
	var outcome string
	err := p.pool.QueryRow(ctx,
		`SELECT metadata.claim_file($1::uuid, $2::name, $3::name, $4, $5, $6, $7, $8, $9)`,
		ref.FileID, ref.Table, ref.Column, ref.EntityID, ref.SeenUpdatedAt,
		keys.Original, nullIfEmpty(keys.Small), nullIfEmpty(keys.Medium), nullIfEmpty(keys.Large),
	).Scan(&outcome)
	return outcome, err
}

func (p *pgFileReconcileDB) DeleteOrphanedStagedFiles(ctx context.Context, ttl time.Duration, limit int) ([]orphanedFile, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT file_id::text, s3_bucket, s3_original_key, COALESCE(s3_thumbnail_small_key, ''),
		       COALESCE(s3_thumbnail_medium_key, ''), COALESCE(s3_thumbnail_large_key, '')
		FROM metadata.delete_orphaned_staged_files(make_interval(secs => $1), $2)`, ttl.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []orphanedFile{}
	for rows.Next() {
		var o orphanedFile
		if err := rows.Scan(&o.FileID, &o.Bucket, &o.Keys.Original, &o.Keys.Small, &o.Keys.Medium, &o.Keys.Large); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (p *pgFileReconcileDB) StagedFileStates(ctx context.Context, ids []string) (map[string]bool, error) {
	states := map[string]bool{}
	valid := []string{}
	for _, id := range ids {
		if isUUID(id) {
			valid = append(valid, id)
		}
	}
	if len(valid) == 0 {
		return states, nil
	}
	rows, err := p.pool.Query(ctx, `SELECT file_id::text, claimed FROM metadata.staged_file_states($1::uuid[])`, valid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var claimed bool
		if err := rows.Scan(&id, &claimed); err != nil {
			return nil, err
		}
		states[id] = claimed
	}
	return states, rows.Err()
}

func (p *pgFileReconcileDB) DeleteStaleUploadRequests(ctx context.Context, age time.Duration) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx, `SELECT metadata.delete_stale_upload_requests(make_interval(secs => $1))`, age.Seconds()).Scan(&n)
	return n, err
}

// isUUID accepts the canonical 8-4-4-4-12 hex form, so a stray object name never reaches a uuid cast.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
				return false
			}
		}
	}
	return true
}

// ============================================================================
// S3 side
// ============================================================================

type s3FileObjectStore struct {
	client *s3.Client
}

// Copy copies an object, keeping its content type, with the public-read ACL every upload has
// (a copy does not keep the source's ACL).
func (s *s3FileObjectStore) Copy(ctx context.Context, bucket, from, to string) error {
	_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(bucket),
		CopySource: aws.String(copySource(bucket, from)),
		Key:        aws.String(to),
		ACL:        types.ObjectCannedACLPublicRead,
	})
	return err
}

func (s *s3FileObjectStore) Delete(ctx context.Context, bucket, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	return err
}

// ListStaged lists objects under every {type}/_new/ prefix, up to limit objects.
func (s *s3FileObjectStore) ListStaged(ctx context.Context, bucket string, limit int) ([]stagedObject, error) {
	out := []stagedObject{}
	top := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: aws.String(bucket), Delimiter: aws.String("/")})
	for top.HasMorePages() && len(out) < limit {
		page, err := top.NextPage(ctx)
		if err != nil {
			return out, err
		}
		for _, p := range page.CommonPrefixes {
			if p.Prefix == nil {
				continue
			}
			staged := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
				Bucket: aws.String(bucket),
				Prefix: aws.String(*p.Prefix + stagedEntityID + "/"),
			})
			for staged.HasMorePages() && len(out) < limit {
				sp, err := staged.NextPage(ctx)
				if err != nil {
					return out, err
				}
				for _, o := range sp.Contents {
					if o.Key == nil || len(out) >= limit {
						continue
					}
					var modified time.Time
					if o.LastModified != nil {
						modified = *o.LastModified
					}
					out = append(out, stagedObject{Key: *o.Key, LastModified: modified})
				}
			}
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}
