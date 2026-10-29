package main

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	siteNameTTL          = 60 * time.Second
	siteNameQueryTimeout = 2 * time.Second
)

// siteNameResolver returns the application title used as {{.Metadata.site_name}}.
// It reads metadata.instance_config.app_title and caches the outcome for a TTL
// so admin edits reach emails without a restart. When the row is missing, the
// value is NULL or blank, or the query fails (including a missing table), it
// returns the fallback (the APP_TITLE env var).
type siteNameResolver struct {
	fallback string
	ttl      time.Duration
	query    func(ctx context.Context) (*string, error) // nil means never query
	now      func() time.Time

	mu      sync.Mutex
	value   string
	expires time.Time
}

// newSiteNameResolver builds a resolver backed by the given pool. A nil pool
// yields a resolver that always returns the fallback.
func newSiteNameResolver(fallback string, pool *pgxpool.Pool) *siteNameResolver {
	r := &siteNameResolver{
		fallback: fallback,
		ttl:      siteNameTTL,
		now:      time.Now,
	}
	if pool != nil {
		r.query = func(ctx context.Context) (*string, error) {
			var v *string
			err := pool.QueryRow(ctx,
				`SELECT config_value FROM metadata.instance_config WHERE config_key = 'app_title'`,
			).Scan(&v)
			return v, err
		}
	}
	return r
}

// Get returns the current site name, refreshing from the database when the
// cached outcome is older than the TTL.
func (r *siteNameResolver) Get() string {
	if r.query == nil {
		return r.fallback
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	if now.Before(r.expires) {
		return r.value
	}

	// Template code has no context, so use a short standalone timeout.
	ctx, cancel := context.WithTimeout(context.Background(), siteNameQueryTimeout)
	defer cancel()

	value := r.fallback
	v, err := r.query(ctx)
	switch {
	case err == nil:
		if v != nil && strings.TrimSpace(*v) != "" {
			value = *v
		}
	case errors.Is(err, pgx.ErrNoRows):
		// No row: not set, use fallback quietly
	default:
		log.Printf("[Renderer] Failed to read instance_config.app_title, using fallback: %v", err)
	}

	r.value = value
	r.expires = now.Add(r.ttl)
	return value
}
