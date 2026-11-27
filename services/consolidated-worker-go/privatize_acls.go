package main

// privatize-acls: an operator command that makes the S3 objects of this instance's private files private
// (v0.88.0). Before v0.88.0 every object was uploaded public-read; after the upgrade new uploads are
// private, and this command fixes the old ones. It walks metadata.files (never the bucket), so on a bucket
// several instances share it touches only this instance's objects. Static assets (is_public) are skipped.
//
//   /app/consolidated-worker privatize-acls [--dry-run] [--acl private|public-read] [--after <file id>] [--batch 500]
//
// In Docker Compose: docker compose run --rm --no-deps consolidated-worker /app/consolidated-worker privatize-acls
// (the image has no ENTRYPOINT, so the binary must be named; --no-deps leaves running services alone).
//
// --acl public-read puts the old ACL back (rollback). Setting an ACL twice is harmless, so the command can
// simply be run again; --after resumes after the last file id it printed.

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/jackc/pgx/v5/pgxpool"
)

// aclFile is one private file's objects.
type aclFile struct {
	ID, Bucket string
	Keys       []string
}

type aclFileSource interface {
	// PrivateFilesAfter returns up to limit files with is_public = false, ordered by id, after the given id.
	PrivateFilesAfter(ctx context.Context, after string, limit int) ([]aclFile, error)
}

type aclObjectStore interface {
	PutACL(ctx context.Context, bucket, key string, acl types.ObjectCannedACL) error
}

type privatizeOptions struct {
	DryRun bool
	ACL    types.ObjectCannedACL
	After  string
	Batch  int
}

type privatizeResult struct {
	Files, Objects, Missing, Failed int
	LastID                          string
}

var errNoSuchKey = errors.New("no such key")

// privatizeACLs applies opts.ACL to every object of every private file, logging progress to out.
func privatizeACLs(ctx context.Context, src aclFileSource, store aclObjectStore, opts privatizeOptions, out io.Writer) (privatizeResult, error) {
	res := privatizeResult{LastID: opts.After}
	for {
		files, err := src.PrivateFilesAfter(ctx, res.LastID, opts.Batch)
		if err != nil {
			return res, fmt.Errorf("reading files after %q: %w", res.LastID, err)
		}
		if len(files) == 0 {
			return res, nil
		}
		for _, f := range files {
			for _, key := range f.Keys {
				if opts.DryRun {
					res.Objects++
					continue
				}
				switch err := store.PutACL(ctx, f.Bucket, key, opts.ACL); {
				case err == nil:
					res.Objects++
				case errors.Is(err, errNoSuchKey):
					res.Missing++
				default:
					res.Failed++
					fmt.Fprintf(out, "failed: file %s object %s: %v\n", f.ID, key, err)
				}
			}
			res.Files++
			res.LastID = f.ID
		}
		fmt.Fprintf(out, "progress: %d files, %d objects set to %s, %d missing, %d failed; resume with --after %s\n",
			res.Files, res.Objects, opts.ACL, res.Missing, res.Failed, res.LastID)
	}
}

// ---------------------------------------------------------------------------
// Database and S3 sides
// ---------------------------------------------------------------------------

type pgACLFileSource struct{ pool *pgxpool.Pool }

func (p pgACLFileSource) PrivateFilesAfter(ctx context.Context, after string, limit int) ([]aclFile, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id::text, s3_bucket,
		       array_remove(ARRAY[s3_original_key, s3_thumbnail_small_key, s3_thumbnail_medium_key, s3_thumbnail_large_key], NULL)
		FROM metadata.files
		WHERE NOT is_public AND ($1 = '' OR id > $1::uuid)
		ORDER BY id
		LIMIT $2`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []aclFile
	for rows.Next() {
		var f aclFile
		if err := rows.Scan(&f.ID, &f.Bucket, &f.Keys); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

type s3ACLStore struct{ client *s3.Client }

func (s s3ACLStore) PutACL(ctx context.Context, bucket, key string, acl types.ObjectCannedACL) error {
	_, err := s.client.PutObjectAcl(ctx, &s3.PutObjectAclInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		ACL:    acl,
	})
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) && (apiErr.ErrorCode() == "NoSuchKey" || apiErr.ErrorCode() == "NotFound") {
		return errNoSuchKey
	}
	return err
}

// runPrivatizeACLs is the command's entry point; it returns the process exit code.
func runPrivatizeACLs(args []string) int {
	fs := flag.NewFlagSet("privatize-acls", flag.ContinueOnError)
	dryRun := fs.Bool("dry-run", false, "count the objects without changing them")
	acl := fs.String("acl", "private", "ACL to set: private, or public-read to roll back")
	after := fs.String("after", "", "resume after this file id")
	batch := fs.Int("batch", 500, "files per database read")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *acl != "private" && *acl != "public-read" {
		fmt.Fprintln(os.Stderr, "--acl must be private or public-read")
		return 2
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, getEnv("DATABASE_URL", ""))
	if err != nil {
		log.Printf("[privatize-acls] database: %v", err)
		return 1
	}
	defer pool.Close()

	opts := privatizeOptions{DryRun: *dryRun, ACL: types.ObjectCannedACL(*acl), After: *after, Batch: *batch}
	log.Printf("[privatize-acls] setting %s on the objects of this instance's private files (dry run: %v)", opts.ACL, opts.DryRun)
	res, err := privatizeACLs(ctx, pgACLFileSource{pool}, s3ACLStore{initializeS3Client(ctx).S3Client}, opts, os.Stdout)
	log.Printf("[privatize-acls] done: %d files, %d objects, %d missing, %d failed", res.Files, res.Objects, res.Missing, res.Failed)
	if err != nil {
		log.Printf("[privatize-acls] stopped: %v (resume with --after %s)", err, res.LastID)
		return 1
	}
	if res.Failed > 0 {
		return 1
	}
	return 0
}
