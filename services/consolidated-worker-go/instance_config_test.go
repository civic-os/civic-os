package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeConfigDB struct {
	mu    sync.Mutex
	calls int
	rows  []configRow
	err   error
}

func (f *fakeConfigDB) query(ctx context.Context) ([]configRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.rows, f.err
}

func (f *fakeConfigDB) set(rows []configRow, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows, f.err = rows, err
}

func strPtr(s string) *string { return &s }

func row(key, typ string, value *string) configRow {
	return configRow{key: key, typ: typ, value: value}
}

func titleRows(title *string) []configRow {
	return []configRow{row("app_title", "string", title)}
}

func newTestResolver(db *fakeConfigDB, clock *time.Time) *instanceConfigResolver {
	return &instanceConfigResolver{
		fallbackSiteName: "Civic OS",
		ttl:              instanceConfigTTL,
		query:            db.query,
		now:              func() time.Time { return *clock },
	}
}

func TestInstanceConfigResolver_NilPoolReturnsFallback(t *testing.T) {
	r := newInstanceConfigResolver("Fallback", nil)
	if r.query != nil {
		t.Fatal("expected nil query for nil pool")
	}
	snap := r.Get()
	if snap.siteName != "Fallback" {
		t.Errorf("siteName = %q, want Fallback", snap.siteName)
	}
	if snap.config["app_title"] != "Fallback" || len(snap.config) != 1 {
		t.Errorf("config = %v, want only app_title=Fallback", snap.config)
	}
}

func TestInstanceConfigResolver_ReturnsDBValueAndCaches(t *testing.T) {
	db := &fakeConfigDB{rows: titleRows(strPtr("Acme Portal"))}
	clock := time.Unix(1000, 0)
	r := newTestResolver(db, &clock)

	for i := 0; i < 5; i++ {
		if got := r.SiteName(); got != "Acme Portal" {
			t.Fatalf("SiteName() = %q, want Acme Portal", got)
		}
		clock = clock.Add(5 * time.Second)
	}
	if db.calls != 1 {
		t.Errorf("query called %d times within TTL, want 1", db.calls)
	}
}

func TestInstanceConfigResolver_RefreshesAfterTTL(t *testing.T) {
	db := &fakeConfigDB{rows: titleRows(strPtr("Old Name"))}
	clock := time.Unix(1000, 0)
	r := newTestResolver(db, &clock)

	if got := r.SiteName(); got != "Old Name" {
		t.Fatalf("SiteName() = %q, want Old Name", got)
	}

	db.set(titleRows(strPtr("New Name")), nil)
	clock = clock.Add(instanceConfigTTL - time.Second)
	if got := r.SiteName(); got != "Old Name" {
		t.Errorf("SiteName() before TTL = %q, want Old Name", got)
	}

	clock = clock.Add(2 * time.Second)
	if got := r.SiteName(); got != "New Name" {
		t.Errorf("SiteName() after TTL = %q, want New Name", got)
	}
	if db.calls != 2 {
		t.Errorf("query called %d times, want 2", db.calls)
	}
}

func TestInstanceConfigResolver_SiteNameFallbackOutcomes(t *testing.T) {
	tests := []struct {
		name string
		rows []configRow
		err  error
	}{
		{"NULL value", titleRows(nil), nil},
		{"blank value", titleRows(strPtr("  ")), nil},
		{"no row", nil, nil},
		{"generic error", nil, errors.New("relation \"metadata.instance_config\" does not exist (42P01)")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := &fakeConfigDB{rows: tt.rows, err: tt.err}
			clock := time.Unix(1000, 0)
			r := newTestResolver(db, &clock)

			for i := 0; i < 3; i++ {
				snap := r.Get()
				if snap.siteName != "Civic OS" {
					t.Fatalf("siteName = %q, want fallback", snap.siteName)
				}
				if snap.config["app_title"] != "Civic OS" {
					t.Fatalf("config app_title = %v, want fallback", snap.config["app_title"])
				}
			}
			if db.calls != 1 {
				t.Errorf("fallback outcome not cached: %d queries within TTL, want 1", db.calls)
			}

			clock = clock.Add(instanceConfigTTL + time.Second)
			r.Get()
			if db.calls != 2 {
				t.Errorf("expected one more query after TTL, got %d total", db.calls)
			}
		})
	}
}

func TestInstanceConfigResolver_RecoversWhenTableAppears(t *testing.T) {
	db := &fakeConfigDB{err: errors.New("undefined_table")}
	clock := time.Unix(1000, 0)
	r := newTestResolver(db, &clock)

	if got := r.SiteName(); got != "Civic OS" {
		t.Fatalf("SiteName() = %q, want fallback", got)
	}
	db.set(titleRows(strPtr("Now Set")), nil)
	clock = clock.Add(instanceConfigTTL + time.Second)
	if got := r.SiteName(); got != "Now Set" {
		t.Errorf("SiteName() = %q, want Now Set", got)
	}
}

func TestInstanceConfigResolver_TypedValues(t *testing.T) {
	db := &fakeConfigDB{rows: []configRow{
		row("agency_name", "string", strPtr("City of Springfield")),
		row("agency_phone", "string", nil),
		row("open_saturdays", "boolean", strPtr("false")),
		row("accepts_cash", "boolean", strPtr("true")),
		row("agency_address", "json", strPtr(`{"city": "Flint", "zip": "48502"}`)),
		row("staff_count", "integer", strPtr("12")),
		row("broken_json", "json", strPtr("{not json")),
	}}
	clock := time.Unix(1000, 0)
	cfg := newTestResolver(db, &clock).Get().config

	if cfg["agency_name"] != "City of Springfield" {
		t.Errorf("agency_name = %v", cfg["agency_name"])
	}
	if cfg["agency_phone"] != "" {
		t.Errorf("NULL agency_phone = %#v, want empty string", cfg["agency_phone"])
	}
	if cfg["open_saturdays"] != false || cfg["accepts_cash"] != true {
		t.Errorf("booleans = %#v / %#v, want false / true", cfg["open_saturdays"], cfg["accepts_cash"])
	}
	addr, ok := cfg["agency_address"].(map[string]interface{})
	if !ok || addr["city"] != "Flint" {
		t.Errorf("agency_address = %#v, want parsed object", cfg["agency_address"])
	}
	if cfg["staff_count"] != "12" {
		t.Errorf("staff_count = %#v, want text 12", cfg["staff_count"])
	}
	if cfg["broken_json"] != "{not json" {
		t.Errorf("broken_json = %#v, want raw text", cfg["broken_json"])
	}
}

func TestInstanceConfigResolver_ConcurrentGet(t *testing.T) {
	db := &fakeConfigDB{rows: titleRows(strPtr("Concurrent"))}
	var clockMu sync.Mutex
	clock := time.Unix(1000, 0)
	r := &instanceConfigResolver{
		fallbackSiteName: "Civic OS",
		ttl:              instanceConfigTTL,
		query:            db.query,
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
				if got := r.SiteName(); got != "Concurrent" {
					t.Errorf("SiteName() = %q, want Concurrent", got)
				}
			}
		}()
	}
	wg.Wait()
}

func testRenderer(db *fakeConfigDB) *Renderer {
	clock := time.Unix(1000, 0)
	return &Renderer{
		siteURL: "http://localhost:4200",
		config:  newTestResolver(db, &clock),
		apiURL:  "http://localhost:3000",
	}
}

func TestRenderer_BuildContextUsesResolvedSiteName(t *testing.T) {
	renderer := testRenderer(&fakeConfigDB{rows: titleRows(strPtr("Resolved Name"))})

	ctx := renderer.buildContext(map[string]interface{}{})
	meta, ok := ctx["Metadata"].(map[string]string)
	if !ok {
		t.Fatalf("Metadata has unexpected type %T", ctx["Metadata"])
	}
	if meta["site_name"] != "Resolved Name" {
		t.Errorf("site_name = %q, want Resolved Name", meta["site_name"])
	}
}

func TestRenderer_TemplatesReadConfig(t *testing.T) {
	renderer := testRenderer(&fakeConfigDB{rows: []configRow{
		row("agency_name", "string", strPtr("City of Springfield")),
		row("agency_phone", "string", nil),
		row("open_saturdays", "boolean", strPtr("false")),
		row("agency_address", "json", strPtr(`{"city": "Flint"}`)),
	}})
	tmpl := &NotificationTemplate{
		Subject: "{{.Config.agency_name}} / {{.Config.app_title}}",
		HTML:    `<p>{{.Config.agency_name}}</p>{{if .Config.agency_phone}}<p>call</p>{{end}}`,
		Text:    `{{.Config.agency_address.city}} {{if .Config.open_saturdays}}open{{else}}closed{{end}} Saturdays [{{or .Config.agency_phone "no phone"}}]`,
	}
	entity, _ := json.Marshal(map[string]interface{}{"id": 1})

	out, err := renderer.RenderTemplate(tmpl, entity)
	if err != nil {
		t.Fatalf("RenderTemplate: %v", err)
	}
	if out.Subject != "City of Springfield / Civic OS" {
		t.Errorf("Subject = %q", out.Subject)
	}
	if out.HTML != "<p>City of Springfield</p>" {
		t.Errorf("HTML = %q, want no phone paragraph", out.HTML)
	}
	if out.Text != "Flint closed Saturdays [no phone]" {
		t.Errorf("Text = %q", out.Text)
	}
	if strings.Contains(out.Text+out.HTML+out.Subject, "no value") {
		t.Errorf("rendered output contains <no value>")
	}
}
