package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pgquery "github.com/pganalyze/pg_query_go/v6"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

// ============================================================================
// River Job: ParseAllSourceCode
// ============================================================================

// ParseAllSourceCodeArgs triggers a full re-parse of all public functions and views.
type ParseAllSourceCodeArgs struct{}

func (ParseAllSourceCodeArgs) Kind() string { return "parse_all_source_code" }

func (ParseAllSourceCodeArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "source_parsing",
		MaxAttempts: 3,
		Priority:    3,
		UniqueOpts: river.UniqueOpts{
			ByState: []rivertype.JobState{
				rivertype.JobStatePending,
				rivertype.JobStateAvailable,
				rivertype.JobStateRunning,
				rivertype.JobStateScheduled,
			},
		},
	}
}

// ParseAllSourceCodeWorker parses all public functions and views into AST JSON.
type ParseAllSourceCodeWorker struct {
	river.WorkerDefaults[ParseAllSourceCodeArgs]
	dbPool *pgxpool.Pool
}

func (w *ParseAllSourceCodeWorker) Work(ctx context.Context, job *river.Job[ParseAllSourceCodeArgs]) error {
	log.Printf("[Job %d] Starting source code parsing...", job.ID)

	// 1. Query all public functions
	functions, err := w.queryFunctions(ctx)
	if err != nil {
		return fmt.Errorf("query functions: %w", err)
	}

	// 2. Query all public views
	views, err := w.queryViews(ctx)
	if err != nil {
		return fmt.Errorf("query views: %w", err)
	}

	// 3. Get existing hashes to skip unchanged objects
	existingHashes, err := w.getExistingHashes(ctx)
	if err != nil {
		return fmt.Errorf("get existing hashes: %w", err)
	}

	// 4. Parse and upsert each object
	var parsed, skipped, failed int
	currentObjects := make(map[string]bool)

	for _, fn := range functions {
		key := fmt.Sprintf("public:%s:function", fn.name)
		currentObjects[key] = true

		hash := computeHash(fn.sourceCode)
		if existingHashes[key] == hash {
			skipped++
			continue
		}

		astJSON, parseErr := parsePLpgSQL(fn.sourceCode, fn.language)
		if err := w.upsertParsed(ctx, "public", fn.name, "function", fn.language, hash, astJSON, parseErr); err != nil {
			log.Printf("[Job %d] Failed to upsert %s: %v", job.ID, fn.name, err)
			failed++
			continue
		}
		parsed++
	}

	for _, v := range views {
		key := fmt.Sprintf("public:%s:view", v.name)
		currentObjects[key] = true

		hash := computeHash(v.sourceCode)
		if existingHashes[key] == hash {
			skipped++
			continue
		}

		astJSON, parseErr := parseSQL(v.sourceCode)
		if err := w.upsertParsed(ctx, "public", v.name, "view", "sql", hash, astJSON, parseErr); err != nil {
			log.Printf("[Job %d] Failed to upsert view %s: %v", job.ID, v.name, err)
			failed++
			continue
		}
		parsed++
	}

	// 5. Delete stale entries (objects that no longer exist)
	deleted, err := w.deleteStale(ctx, currentObjects)
	if err != nil {
		log.Printf("[Job %d] Failed to clean stale entries: %v", job.ID, err)
	}

	log.Printf("[Job %d] Source code parsing complete: %d parsed, %d skipped, %d failed, %d stale removed",
		job.ID, parsed, skipped, failed, deleted)

	return nil
}

// ============================================================================
// Database Queries
// ============================================================================

type sourceObject struct {
	name       string
	language   string
	sourceCode string
}

func (w *ParseAllSourceCodeWorker) queryFunctions(ctx context.Context) ([]sourceObject, error) {
	rows, err := w.dbPool.Query(ctx, `
		SELECT p.proname::TEXT, l.lanname::TEXT, pg_get_functiondef(p.oid) AS source_code
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
		JOIN pg_language l ON l.oid = p.prolang
		WHERE p.prokind = 'f' AND l.lanname IN ('plpgsql', 'sql')
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []sourceObject
	for rows.Next() {
		var obj sourceObject
		if err := rows.Scan(&obj.name, &obj.language, &obj.sourceCode); err != nil {
			return nil, err
		}
		result = append(result, obj)
	}
	return result, rows.Err()
}

func (w *ParseAllSourceCodeWorker) queryViews(ctx context.Context) ([]sourceObject, error) {
	rows, err := w.dbPool.Query(ctx, `
		SELECT v.viewname::TEXT, pg_get_viewdef(v.viewname, true) AS source_code
		FROM pg_views v WHERE v.schemaname = 'public'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []sourceObject
	for rows.Next() {
		var obj sourceObject
		if err := rows.Scan(&obj.name, &obj.sourceCode); err != nil {
			return nil, err
		}
		obj.language = "sql"
		result = append(result, obj)
	}
	return result, rows.Err()
}

func (w *ParseAllSourceCodeWorker) getExistingHashes(ctx context.Context) (map[string]string, error) {
	rows, err := w.dbPool.Query(ctx, `
		SELECT schema_name, object_name, object_type, source_hash
		FROM metadata.parsed_source_code
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	hashes := make(map[string]string)
	for rows.Next() {
		var schema, name, objType, hash string
		if err := rows.Scan(&schema, &name, &objType, &hash); err != nil {
			return nil, err
		}
		hashes[fmt.Sprintf("%s:%s:%s", schema, name, objType)] = hash
	}
	return hashes, rows.Err()
}

func (w *ParseAllSourceCodeWorker) upsertParsed(ctx context.Context, schema, name, objType, language, hash string, astJSON *string, parseError *string) error {
	_, err := w.dbPool.Exec(ctx, `
		INSERT INTO metadata.parsed_source_code
			(schema_name, object_name, object_type, language, source_hash, ast_json, parse_error, parsed_at)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
		ON CONFLICT (schema_name, object_name, object_type) DO UPDATE SET
			language = EXCLUDED.language,
			source_hash = EXCLUDED.source_hash,
			ast_json = EXCLUDED.ast_json,
			parse_error = EXCLUDED.parse_error,
			parsed_at = EXCLUDED.parsed_at
	`, schema, name, objType, language, hash, astJSON, parseError)
	return err
}

func (w *ParseAllSourceCodeWorker) deleteStale(ctx context.Context, currentObjects map[string]bool) (int, error) {
	rows, err := w.dbPool.Query(ctx, `
		SELECT schema_name, object_name, object_type
		FROM metadata.parsed_source_code
	`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var toDelete [][]string
	for rows.Next() {
		var schema, name, objType string
		if err := rows.Scan(&schema, &name, &objType); err != nil {
			return 0, err
		}
		key := fmt.Sprintf("%s:%s:%s", schema, name, objType)
		if !currentObjects[key] {
			toDelete = append(toDelete, []string{schema, name, objType})
		}
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	for _, item := range toDelete {
		_, err := w.dbPool.Exec(ctx, `
			DELETE FROM metadata.parsed_source_code
			WHERE schema_name = $1 AND object_name = $2 AND object_type = $3
		`, item[0], item[1], item[2])
		if err != nil {
			return 0, err
		}
	}

	return len(toDelete), nil
}

// ============================================================================
// Parsing Helpers
// ============================================================================

// computeHash returns a hex-encoded SHA-256 hash of the source code.
func computeHash(source string) string {
	h := sha256.Sum256([]byte(source))
	return fmt.Sprintf("%x", h)
}

// parsePLpgSQL parses a PL/pgSQL or SQL function definition into AST JSON.
// For plpgsql functions, uses ParsePlPgSqlToJSON which understands DECLARE/BEGIN/END.
// For sql functions, extracts the body and parses with ParseToJSON.
func parsePLpgSQL(sourceCode string, language string) (astJSON *string, parseError *string) {
	if language == "plpgsql" {
		result, err := pgquery.ParsePlPgSqlToJSON(sourceCode)
		if err != nil {
			errStr := err.Error()
			return nil, &errStr
		}
		return &result, nil
	}

	// SQL language function: extract body and parse
	body := extractFunctionBody(sourceCode)
	if body == "" {
		errStr := "could not extract function body"
		return nil, &errStr
	}

	result, err := pgquery.ParseToJSON(body)
	if err != nil {
		errStr := err.Error()
		return nil, &errStr
	}
	return &result, nil
}

// parseSQL parses a SQL view definition into AST JSON.
func parseSQL(viewDef string) (astJSON *string, parseError *string) {
	// pg_get_viewdef returns just the SELECT body, wrap it for parsing
	query := viewDef
	if !strings.HasPrefix(strings.TrimSpace(strings.ToUpper(viewDef)), "SELECT") {
		query = "SELECT " + viewDef
	}

	result, err := pgquery.ParseToJSON(query)
	if err != nil {
		errStr := err.Error()
		return nil, &errStr
	}
	return &result, nil
}

// extractFunctionBody extracts the body from a CREATE FUNCTION statement.
// Finds the dollar-quoted string (AS $tag$...body...$tag$) and returns the inner content.
func extractFunctionBody(source string) string {
	upper := strings.ToUpper(source)

	// Find dollar-quoted body: AS $tag$...body...$tag$
	asIdx := strings.Index(upper, "\nAS ")
	if asIdx == -1 {
		asIdx = strings.Index(upper, " AS ")
	}
	if asIdx == -1 {
		return ""
	}

	rest := source[asIdx+4:]
	// Find dollar-quote delimiter
	if len(rest) > 0 && rest[0] == '$' {
		endTag := ""
		for i := 1; i < len(rest); i++ {
			if rest[i] == '$' {
				endTag = rest[0 : i+1]
				break
			}
		}
		if endTag != "" {
			bodyStart := len(endTag)
			bodyEnd := strings.Index(rest[bodyStart:], endTag)
			if bodyEnd != -1 {
				return strings.TrimSpace(rest[bodyStart : bodyStart+bodyEnd])
			}
		}
	}

	return ""
}

// ============================================================================
// LISTEN Goroutine
// ============================================================================

// StartSourceCodeListener starts a goroutine that LISTENs on the pgrst channel
// and enqueues parse jobs when schema changes are detected.
// The insertJob callback is called to enqueue the parse job, decoupling the
// listener from the River client type.
func StartSourceCodeListener(ctx context.Context, databaseURL string, insertJob func(ctx context.Context) error) {
	go func() {
		for {
			err := listenAndDispatch(ctx, databaseURL, insertJob)
			if ctx.Err() != nil {
				return
			}
			log.Printf("[Listener] Reconnecting in 5s: %v", err)
			time.Sleep(5 * time.Second)
		}
	}()
}

// lastParseInsert tracks debounce timing for parse job insertion.
var (
	lastParseInsert   time.Time
	lastParseInsertMu sync.Mutex
)

func listenAndDispatch(ctx context.Context, databaseURL string, insertJob func(ctx context.Context) error) error {
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)

	_, err = conn.Exec(ctx, "LISTEN pgrst")
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	log.Println("[Listener] Listening on channel: pgrst")

	for {
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait: %w", err)
		}

		payload := strings.TrimSpace(notification.Payload)
		if payload != "" && payload != "reload schema" && payload != "reload config" {
			continue
		}

		// Debounce: skip if last parse job was inserted < 5 seconds ago
		lastParseInsertMu.Lock()
		if time.Since(lastParseInsert) < 5*time.Second {
			lastParseInsertMu.Unlock()
			log.Println("[Listener] Debounced pgrst notification (< 5s since last parse)")
			continue
		}
		lastParseInsert = time.Now()
		lastParseInsertMu.Unlock()

		log.Printf("[Listener] Received pgrst notification (payload: %q), enqueuing parse job", payload)

		if err := insertJob(ctx); err != nil {
			log.Printf("[Listener] Failed to insert parse job: %v", err)
			continue
		}
	}
}
