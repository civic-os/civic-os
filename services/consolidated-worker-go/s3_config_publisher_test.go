package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const publisherSentinel = "LEAKCHECK-publisher-secret"

func setS3Env(t *testing.T, env map[string]string) {
	t.Helper()
	for _, k := range []string{"S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY",
		"S3_REGION", "AWS_REGION", "S3_ENDPOINT", "AWS_ENDPOINT_URL", "S3_PUBLIC_ENDPOINT", "S3_BUCKET"} {
		t.Setenv(k, env[k])
	}
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

func TestS3SigningValues_Defaults(t *testing.T) {
	setS3Env(t, map[string]string{"S3_ACCESS_KEY_ID": "AKID", "S3_SECRET_ACCESS_KEY": "secret"})
	values, missing := s3SigningValues()
	if missing != nil {
		t.Fatalf("missing = %v", missing)
	}
	want := map[string]string{
		"s3_access_key_id": "AKID", "s3_secret_access_key": "secret", "s3_region": "us-east-1",
		"s3_public_endpoint": "https://s3.us-east-1.amazonaws.com", "s3_bucket": "civic-os-files",
	}
	for k, v := range want {
		if values[k] != v {
			t.Errorf("%s = %q, want %q", k, values[k], v)
		}
	}
}

func TestS3SigningValues_EndpointFallbackAndNormalization(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"public wins", map[string]string{"S3_PUBLIC_ENDPOINT": "http://localhost:9000/", "S3_ENDPOINT": "http://s3:9000"}, "http://localhost:9000"},
		{"internal when no public", map[string]string{"S3_ENDPOINT": "https://nyc3.digitaloceanspaces.com"}, "https://nyc3.digitaloceanspaces.com"},
		{"aws by region", map[string]string{"S3_REGION": "eu-west-1"}, "https://s3.eu-west-1.amazonaws.com"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := map[string]string{"S3_ACCESS_KEY_ID": "AKID", "S3_SECRET_ACCESS_KEY": "secret"}
			for k, v := range c.env {
				env[k] = v
			}
			setS3Env(t, env)
			values, _ := s3SigningValues()
			if values["s3_public_endpoint"] != c.want {
				t.Errorf("endpoint = %q, want %q", values["s3_public_endpoint"], c.want)
			}
		})
	}
}

func TestPublishS3SigningConfig_IncompleteEnvPublishesNothing(t *testing.T) {
	setS3Env(t, map[string]string{"S3_ACCESS_KEY_ID": "AKID"})
	logs := captureLog(t)
	called := false
	publishS3SigningConfig(context.Background(), func(context.Context, []byte) ([]string, error) {
		called = true
		return nil, nil
	}, time.Millisecond)
	if called {
		t.Fatal("published with an incomplete key pair")
	}
	if strings.Count(logs.String(), "WARNING") != 1 || !strings.Contains(logs.String(), "S3_SECRET_ACCESS_KEY") {
		t.Errorf("want one WARNING naming the missing variable, got %q", logs.String())
	}
}

func TestPublishS3SigningConfig_SendsValuesAndLogsKeyNamesOnly(t *testing.T) {
	setS3Env(t, map[string]string{"S3_ACCESS_KEY_ID": "AKID-" + publisherSentinel, "S3_SECRET_ACCESS_KEY": publisherSentinel})
	logs := captureLog(t)
	var sent map[string]string
	publishS3SigningConfig(context.Background(), func(_ context.Context, values []byte) ([]string, error) {
		if err := json.Unmarshal(values, &sent); err != nil {
			t.Fatal(err)
		}
		return []string{"s3_secret_access_key", "s3_access_key_id"}, nil
	}, time.Millisecond)
	if sent["s3_secret_access_key"] != publisherSentinel {
		t.Errorf("sent = %v", sent)
	}
	if strings.Contains(logs.String(), publisherSentinel) {
		t.Fatalf("a value reached the log: %q", logs.String())
	}
	if !strings.Contains(logs.String(), "changed [s3_access_key_id s3_secret_access_key]") {
		t.Errorf("log = %q", logs.String())
	}
}

func TestPublishS3SigningConfig_RetriesUntilMigrated(t *testing.T) {
	setS3Env(t, map[string]string{"S3_ACCESS_KEY_ID": "AKID", "S3_SECRET_ACCESS_KEY": "secret"})
	logs := captureLog(t)
	var mu sync.Mutex
	calls := 0
	publishS3SigningConfig(context.Background(), func(context.Context, []byte) ([]string, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		switch calls {
		case 1:
			return nil, &pgconn.PgError{Code: "42883", Message: "function metadata.publish_deployment_config(jsonb) does not exist"}
		case 2:
			return nil, &pgconn.PgError{Code: "42P01", Message: "relation does not exist"}
		}
		return nil, nil
	}, time.Millisecond)
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
	if strings.Count(logs.String(), "not migrated") != 1 || !strings.Contains(logs.String(), "unchanged") {
		t.Errorf("log = %q", logs.String())
	}
}

func TestPublishS3SigningConfig_OtherErrorStops(t *testing.T) {
	setS3Env(t, map[string]string{"S3_ACCESS_KEY_ID": "AKID", "S3_SECRET_ACCESS_KEY": publisherSentinel})
	logs := captureLog(t)
	calls := 0
	publishS3SigningConfig(context.Background(), func(context.Context, []byte) ([]string, error) {
		calls++
		return nil, &pgconn.PgError{Code: "42501", Message: "publish_deployment_config is for the deployment role only"}
	}, time.Millisecond)
	if calls != 1 {
		t.Errorf("calls = %d, want 1", calls)
	}
	if !strings.Contains(logs.String(), "WARNING") || !strings.Contains(logs.String(), "42501") || strings.Contains(logs.String(), publisherSentinel) {
		t.Errorf("log = %q", logs.String())
	}
}

func TestPublishS3SigningConfig_StopsWithContext(t *testing.T) {
	setS3Env(t, map[string]string{"S3_ACCESS_KEY_ID": "AKID", "S3_SECRET_ACCESS_KEY": "secret"})
	captureLog(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		publishS3SigningConfig(ctx, func(context.Context, []byte) ([]string, error) {
			return nil, &pgconn.PgError{Code: "42883"}
		}, time.Hour)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("publisher did not stop when the context ended")
	}
}

func TestNotYetMigrated(t *testing.T) {
	if notYetMigrated(errors.New("plain")) || !notYetMigrated(&pgconn.PgError{Code: "42P01"}) {
		t.Error("notYetMigrated misclassifies")
	}
}
