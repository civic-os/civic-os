package main

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	instanceConfigTTL          = 60 * time.Second
	instanceConfigQueryTimeout = 2 * time.Second
)

// configRow is one metadata.instance_config row as the worker reads it.
type configRow struct {
	key   string
	typ   string
	value *string
}

// instanceConfigSnapshot is what templates see: {{.Config.<key>}} and
// {{.Metadata.site_name}}. Both maps are replaced, never mutated, so a
// snapshot can be shared by concurrent renders.
type instanceConfigSnapshot struct {
	config   map[string]interface{}
	siteName string
}

// instanceConfigResolver reads metadata.instance_config and caches the result
// for a TTL, so admin edits reach notifications without a restart. Values
// resolve DB -> ENV -> default, like ConfigService in the frontend:
//
//   - site_name (and .Config.app_title) is the DB app_title, else the APP_TITLE
//     env var, else "Civic OS" (applied by the caller through fallbackSiteName).
//   - Every other key is its DB value, else its default_value (as get_config()
//     returns). With neither it is an empty string, so {{if .Config.key}} is
//     false. Integrator keys have no ENV counterpart.
//
// boolean values become bools and json values are parsed, so {{if}} and field
// access behave as written; every other type stays the text stored in the row.
// When the query fails (including a missing table on an older database), the
// snapshot holds no keys and the fallback site name.
type instanceConfigResolver struct {
	fallbackSiteName string
	ttl              time.Duration
	query            func(ctx context.Context) ([]configRow, error) // nil means never query
	now              func() time.Time

	mu       sync.Mutex
	snapshot instanceConfigSnapshot
	expires  time.Time
}

// newInstanceConfigResolver builds a resolver backed by the given pool. A nil
// pool yields a resolver that always returns the fallback site name and no keys.
// The worker connects as postgres, so RLS does not apply: templates see every
// key, private ones included, as every signed-in user can.
func newInstanceConfigResolver(fallbackSiteName string, pool *pgxpool.Pool) *instanceConfigResolver {
	r := &instanceConfigResolver{
		fallbackSiteName: fallbackSiteName,
		ttl:              instanceConfigTTL,
		now:              time.Now,
	}
	if pool != nil {
		r.query = func(ctx context.Context) ([]configRow, error) {
			rows, err := pool.Query(ctx,
				`SELECT config_key, config_type, COALESCE(config_value, default_value) FROM metadata.instance_config`,
			)
			if err != nil {
				return nil, err
			}
			defer rows.Close()

			var out []configRow
			for rows.Next() {
				var row configRow
				if err := rows.Scan(&row.key, &row.typ, &row.value); err != nil {
					return nil, err
				}
				out = append(out, row)
			}
			return out, rows.Err()
		}
	}
	return r
}

// Get returns the current snapshot, refreshing from the database when the
// cached one is older than the TTL.
func (r *instanceConfigResolver) Get() instanceConfigSnapshot {
	if r.query == nil {
		return r.build(nil)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	if now.Before(r.expires) {
		return r.snapshot
	}

	// Template code has no context, so use a short standalone timeout.
	ctx, cancel := context.WithTimeout(context.Background(), instanceConfigQueryTimeout)
	defer cancel()

	rows, err := r.query(ctx)
	if err != nil {
		log.Printf("[Renderer] Failed to read instance_config, using APP_TITLE and no config keys: %v", err)
		rows = nil
	}

	r.snapshot = r.build(rows)
	r.expires = now.Add(r.ttl)
	return r.snapshot
}

// SiteName returns the resolved application title for {{.Metadata.site_name}}.
func (r *instanceConfigResolver) SiteName() string {
	return r.Get().siteName
}

func (r *instanceConfigResolver) build(rows []configRow) instanceConfigSnapshot {
	config := make(map[string]interface{}, len(rows)+1)
	for _, row := range rows {
		config[row.key] = typedConfigValue(row)
	}

	siteName := r.fallbackSiteName
	if title, ok := config["app_title"].(string); ok && title != "" {
		siteName = title
	}
	config["app_title"] = siteName

	return instanceConfigSnapshot{config: config, siteName: siteName}
}

// typedConfigValue converts a stored value for templates. A value that does not
// parse as its type (possible only for a row INSERTed with a value, since the
// type check runs on UPDATE) is kept as text.
func typedConfigValue(row configRow) interface{} {
	if row.value == nil || strings.TrimSpace(*row.value) == "" {
		return ""
	}
	v := *row.value
	switch row.typ {
	case "boolean":
		switch v {
		case "true":
			return true
		case "false":
			return false
		}
	case "json":
		var parsed interface{}
		if err := json.Unmarshal([]byte(v), &parsed); err == nil {
			return parsed
		}
	}
	return v
}
