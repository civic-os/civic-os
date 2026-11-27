package main

// Publishes the S3 values this worker signs with into the deployment-managed secret keys of
// metadata.instance_config (v0.88.0), so the database's URL signer and the worker always use the
// same key pair. See docs/notes/INSTANCE_SETUP_DESIGN.md (Secret Keys, How Values Arrive).
//
//   - Startup only: a periodic re-publish would let an old pod in a rolling update put the old key
//     back after the new pod published the new one.
//   - The values travel as one bind parameter; logs and errors carry key names, never values.
//   - While the function or table does not exist yet (the migrations have not run), retry every 30s.
//     Any other error logs a WARNING and publishing stops until the next start.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const s3PublishRetryInterval = 30 * time.Second

// s3SigningValues returns the five values the worker presigns with, keyed by their instance_config
// key, or the missing environment variables when the key pair is incomplete.
func s3SigningValues() (map[string]string, []string) {
	accessKey := getS3Env("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "")
	secretKey := getS3Env("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", "")
	region := getS3Env("S3_REGION", "AWS_REGION", "us-east-1")
	endpoint := getEnv("S3_PUBLIC_ENDPOINT", "")
	if endpoint == "" {
		endpoint = getS3Env("S3_ENDPOINT", "AWS_ENDPOINT_URL", "")
	}
	if endpoint == "" {
		// The endpoint the SDK presigns with when none is configured (path-style, as the client is set up).
		endpoint = "https://s3." + region + ".amazonaws.com"
	}
	bucket := getEnv("S3_BUCKET", "civic-os-files")

	var missing []string
	if accessKey == "" {
		missing = append(missing, "S3_ACCESS_KEY_ID")
	}
	if secretKey == "" {
		missing = append(missing, "S3_SECRET_ACCESS_KEY")
	}
	if len(missing) > 0 {
		return nil, missing
	}
	return map[string]string{
		"s3_access_key_id":     accessKey,
		"s3_secret_access_key": secretKey,
		"s3_region":            strings.TrimSpace(region),
		// normalized the way the database stores it, so an unchanged value compares equal
		"s3_public_endpoint": strings.TrimRight(strings.TrimSpace(endpoint), "/"),
		"s3_bucket":          strings.TrimSpace(bucket),
	}, nil
}

// configPublisher is the database call, swappable in tests.
type configPublisher func(ctx context.Context, values []byte) ([]string, error)

func poolConfigPublisher(pool *pgxpool.Pool) configPublisher {
	return func(ctx context.Context, values []byte) ([]string, error) {
		var result []byte
		if err := pool.QueryRow(ctx, `SELECT metadata.publish_deployment_config($1::jsonb)::text`, string(values)).Scan(&result); err != nil {
			return nil, err
		}
		var parsed struct {
			Changed []string `json:"changed"`
		}
		if err := json.Unmarshal(result, &parsed); err != nil {
			return nil, fmt.Errorf("unexpected publish_deployment_config result")
		}
		return parsed.Changed, nil
	}
}

// notYetMigrated is true for the errors of a database the v0.88.0 migrations have not reached.
func notYetMigrated(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "42883" || pgErr.Code == "42P01")
}

// publishErrorText describes a failed publish by its SQLSTATE and message only. The function's
// errors never carry values, and pgx's error string adds nothing beyond them.
func publishErrorText(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return fmt.Sprintf("%s (SQLSTATE %s)", pgErr.Message, pgErr.Code)
	}
	return err.Error()
}

// publishS3SigningConfig publishes once the database is ready; it blocks until it succeeds, fails
// with an error other than "not migrated yet", or ctx ends. Run it in a goroutine.
func publishS3SigningConfig(ctx context.Context, publish configPublisher, retry time.Duration) {
	values, missing := s3SigningValues()
	if values == nil {
		log.Printf("[S3Config] WARNING: not publishing S3 signing config: %s not set; file links stay unavailable until it is", strings.Join(missing, ", "))
		return
	}
	payload, err := json.Marshal(values)
	if err != nil {
		log.Printf("[S3Config] WARNING: could not encode S3 signing config")
		return
	}

	waitingLogged := false
	for {
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		changed, err := publish(callCtx, payload)
		cancel()
		switch {
		case err == nil:
			if len(changed) == 0 {
				log.Printf("[S3Config] published s3 config: unchanged")
			} else {
				sort.Strings(changed)
				log.Printf("[S3Config] published s3 config: changed %v", changed)
			}
			return
		case notYetMigrated(err):
			if !waitingLogged {
				log.Printf("[S3Config] database not migrated to v0.88.0 yet; retrying every %s", retry)
				waitingLogged = true
			}
		default:
			log.Printf("[S3Config] WARNING: publishing S3 signing config failed: %s; not retrying until the next start", publishErrorText(err))
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retry):
		}
	}
}
