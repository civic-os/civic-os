package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type fakeSiteNameDB struct {
	mu    sync.Mutex
	calls int
	val   *string
	err   error
}

func (f *fakeSiteNameDB) query(ctx context.Context) (*string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.val, f.err
}

func (f *fakeSiteNameDB) set(v *string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.val, f.err = v, err
}

func strPtr(s string) *string { return &s }

func newTestResolver(db *fakeSiteNameDB, clock *time.Time) *siteNameResolver {
	return &siteNameResolver{
		fallback: "Civic OS",
		ttl:      siteNameTTL,
		query:    db.query,
		now:      func() time.Time { return *clock },
	}
}

func TestSiteNameResolver_NilPoolReturnsFallback(t *testing.T) {
	r := newSiteNameResolver("Fallback", nil)
	if r.query != nil {
		t.Fatal("expected nil query for nil pool")
	}
	if got := r.Get(); got != "Fallback" {
		t.Errorf("Get() = %q, want Fallback", got)
	}
}

func TestSiteNameResolver_NilQueryNeverQueries(t *testing.T) {
	r := &siteNameResolver{fallback: "Fallback", ttl: siteNameTTL, now: time.Now}
	if got := r.Get(); got != "Fallback" {
		t.Errorf("Get() = %q, want Fallback", got)
	}
}

func TestSiteNameResolver_ReturnsDBValueAndCaches(t *testing.T) {
	db := &fakeSiteNameDB{val: strPtr("Acme Portal")}
	clock := time.Unix(1000, 0)
	r := newTestResolver(db, &clock)

	for i := 0; i < 5; i++ {
		if got := r.Get(); got != "Acme Portal" {
			t.Fatalf("Get() = %q, want Acme Portal", got)
		}
		clock = clock.Add(5 * time.Second)
	}
	if db.calls != 1 {
		t.Errorf("query called %d times within TTL, want 1", db.calls)
	}
}

func TestSiteNameResolver_RefreshesAfterTTL(t *testing.T) {
	db := &fakeSiteNameDB{val: strPtr("Old Name")}
	clock := time.Unix(1000, 0)
	r := newTestResolver(db, &clock)

	if got := r.Get(); got != "Old Name" {
		t.Fatalf("Get() = %q, want Old Name", got)
	}

	db.set(strPtr("New Name"), nil)
	clock = clock.Add(siteNameTTL - time.Second)
	if got := r.Get(); got != "Old Name" {
		t.Errorf("Get() before TTL = %q, want Old Name", got)
	}

	clock = clock.Add(2 * time.Second)
	if got := r.Get(); got != "New Name" {
		t.Errorf("Get() after TTL = %q, want New Name", got)
	}
	if db.calls != 2 {
		t.Errorf("query called %d times, want 2", db.calls)
	}
}

func TestSiteNameResolver_FallbackOutcomes(t *testing.T) {
	tests := []struct {
		name string
		val  *string
		err  error
	}{
		{"NULL value", nil, nil},
		{"blank value", strPtr("  "), nil},
		{"no row", nil, pgx.ErrNoRows},
		{"generic error", nil, errors.New("relation \"metadata.instance_config\" does not exist (42P01)")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := &fakeSiteNameDB{val: tt.val, err: tt.err}
			clock := time.Unix(1000, 0)
			r := newTestResolver(db, &clock)

			for i := 0; i < 3; i++ {
				if got := r.Get(); got != "Civic OS" {
					t.Fatalf("Get() = %q, want fallback", got)
				}
			}
			if db.calls != 1 {
				t.Errorf("fallback outcome not cached: %d queries within TTL, want 1", db.calls)
			}

			clock = clock.Add(siteNameTTL + time.Second)
			r.Get()
			if db.calls != 2 {
				t.Errorf("expected one more query after TTL, got %d total", db.calls)
			}
		})
	}
}

func TestSiteNameResolver_RecoversWhenTableAppears(t *testing.T) {
	db := &fakeSiteNameDB{err: errors.New("undefined_table")}
	clock := time.Unix(1000, 0)
	r := newTestResolver(db, &clock)

	if got := r.Get(); got != "Civic OS" {
		t.Fatalf("Get() = %q, want fallback", got)
	}
	db.set(strPtr("Now Set"), nil)
	clock = clock.Add(siteNameTTL + time.Second)
	if got := r.Get(); got != "Now Set" {
		t.Errorf("Get() = %q, want Now Set", got)
	}
}

func TestSiteNameResolver_ConcurrentGet(t *testing.T) {
	db := &fakeSiteNameDB{val: strPtr("Concurrent")}
	var clockMu sync.Mutex
	clock := time.Unix(1000, 0)
	r := &siteNameResolver{
		fallback: "Civic OS",
		ttl:      siteNameTTL,
		query:    db.query,
		now: func() time.Time {
			clockMu.Lock()
			defer clockMu.Unlock()
			clock = clock.Add(time.Second)
			return clock
		},
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if got := r.Get(); got != "Concurrent" {
					t.Errorf("Get() = %q, want Concurrent", got)
				}
			}
		}()
	}
	wg.Wait()
}

func TestRenderer_BuildContextUsesResolvedSiteName(t *testing.T) {
	db := &fakeSiteNameDB{val: strPtr("Resolved Name")}
	clock := time.Unix(1000, 0)
	renderer := &Renderer{
		siteURL:  "http://localhost:4200",
		siteName: newTestResolver(db, &clock),
		apiURL:   "http://localhost:3000",
	}

	ctx := renderer.buildContext(map[string]interface{}{})
	meta, ok := ctx["Metadata"].(map[string]string)
	if !ok {
		t.Fatalf("Metadata has unexpected type %T", ctx["Metadata"])
	}
	if meta["site_name"] != "Resolved Name" {
		t.Errorf("site_name = %q, want Resolved Name", meta["site_name"])
	}
}
