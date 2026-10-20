package main

// ============================================================================
// Job: repair occurrence dates (one-time, v0.76.9)
// ============================================================================
//
// Migration v0-76-9-occurrence-date-local flags every series in
// metadata.time_slot_date_repair (status 'pending') and every instance in
// metadata.time_slot_instance_date_repair (with its original UTC date), then
// enqueues this job. For each flagged group the job resolves every flagged row
// with resolveGroup() (rrule-go), re-links orphaned bookings on an exact unique
// match, moves split boundaries, and records the outcome. Expansion skips a series
// while its group is pending (snooze) or needs attention (unresolved rows).
// Re-running is a no-op: only 'pending' rows are processed.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

// RepairOccurrenceDatesArgs has no arguments: the job repairs every pending group.
type RepairOccurrenceDatesArgs struct{}

func (RepairOccurrenceDatesArgs) Kind() string { return "repair_occurrence_dates" }

func (RepairOccurrenceDatesArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "recurring", MaxAttempts: 5, Priority: 1}
}

type RepairOccurrenceDatesWorker struct {
	river.WorkerDefaults[RepairOccurrenceDatesArgs]
	dbPool pgxDB
}

// pgxDB is the part of *pgxpool.Pool the repair uses.
type pgxDB interface {
	Begin(ctx context.Context) (pgx.Tx, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func (w *RepairOccurrenceDatesWorker) Work(ctx context.Context, job *river.Job[RepairOccurrenceDatesArgs]) error {
	rows, err := w.dbPool.Query(ctx, `
		SELECT DISTINCT COALESCE(s.group_id, -s.id)
		FROM metadata.time_slot_date_repair r
		JOIN metadata.time_slot_series s ON s.id = r.series_id
		WHERE r.status = 'pending'`)
	if err != nil {
		return fmt.Errorf("list pending groups: %w", err)
	}
	groups, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return fmt.Errorf("list pending groups: %w", err)
	}
	log.Printf("[Job %d] Occurrence date repair: %d series group(s) pending", job.ID, len(groups))

	for _, g := range groups {
		if err := w.repairGroup(ctx, g); err != nil {
			return fmt.Errorf("group %d: %w", g, err)
		}
	}
	return nil
}

// repairSummary is stored per series in time_slot_date_repair.detail.
type repairSummary struct {
	Repaired   int               `json:"repaired"`
	Unchanged  int               `json:"unchanged"`
	Unresolved []repairNoteEntry `json:"unresolved,omitempty"`
	Detached   []repairNoteEntry `json:"detached,omitempty"`
	Relinked   []repairNoteEntry `json:"relinked_orphans,omitempty"`
	Boundary   *boundaryChange   `json:"boundary_moved,omitempty"`
}

type repairNoteEntry struct {
	InstanceID int64  `json:"instance_id,omitempty"`
	EntityID   *int64 `json:"entity_id,omitempty"`
	Date       string `json:"date"`
	Note       string `json:"note,omitempty"`
}

// boundaryChange keeps what the repair overwrote, for the migration's revert.
type boundaryChange struct {
	EffectiveUntil         string `json:"effective_until"`
	RRULE                  string `json:"rrule"`
	SuccessorID            int64  `json:"successor_id"`
	SuccessorEffectiveFrom string `json:"successor_effective_from"`
}

type repairSeriesRow struct {
	repairVersion
	EntityTable      string
	TimeSlotProperty string
	Template         map[string]any
	EffectiveUntil   *time.Time
	EffectiveFrom    time.Time
}

func (w *RepairOccurrenceDatesWorker) repairGroup(ctx context.Context, groupKey int64) error {
	tx, err := w.dbPool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	// Versions of the group (a series without a group is its own group: key = -id)
	rows, err := tx.Query(ctx, `
		SELECT id, version_number, rrule, dtstart, duration::text, timezone, entity_table,
		       time_slot_property, entity_template, effective_from, effective_until
		FROM metadata.time_slot_series
		WHERE ($1 > 0 AND group_id = $1) OR ($1 < 0 AND id = -$1)
		ORDER BY version_number, id
		FOR UPDATE`, groupKey)
	if err != nil {
		return err
	}
	var versions []repairSeriesRow
	for rows.Next() {
		var v repairSeriesRow
		var dur string
		var tz *string
		var tmpl []byte
		if err := rows.Scan(&v.ID, &v.VersionNumber, &v.RRULE, &v.Dtstart, &dur, &tz, &v.EntityTable,
			&v.TimeSlotProperty, &tmpl, &v.EffectiveFrom, &v.EffectiveUntil); err != nil {
			rows.Close()
			return err
		}
		if v.Duration, err = parsePGInterval(dur); err != nil {
			rows.Close()
			return fmt.Errorf("series %d duration: %w", v.ID, err)
		}
		v.Loc = seriesLocation(&SeriesRecord{Timezone: tz})
		_ = json.Unmarshal(tmpl, &v.Template)
		versions = append(versions, v)
	}
	rows.Close()
	if len(versions) == 0 {
		return nil
	}
	ids := make([]int64, len(versions))
	pure := make([]repairVersion, len(versions))
	byID := map[int64]repairSeriesRow{}
	for i, v := range versions {
		ids[i], pure[i], byID[v.ID] = v.ID, v.repairVersion, v
	}

	// Flagged instances with their original UTC date and tie-breaking evidence
	rows, err = tx.Query(ctx, `
		SELECT i.id, i.series_id,
		       CASE WHEN r.status = 'pending' THEN r.utc_date ELSE i.occurrence_date END::text,
		       i.entity_id, i.is_exception, lower(i.original_time_slot),
		       COALESCE(r.local_date::text, ''), r.status IS DISTINCT FROM 'pending'
		FROM metadata.time_slot_instances i
		LEFT JOIN metadata.time_slot_instance_date_repair r ON r.instance_id = i.id
		WHERE i.series_id = ANY($1)
		ORDER BY i.id`, ids)
	if err != nil {
		return err
	}
	var instances []repairInstance
	exceptions := map[int64]bool{}
	until := time.Time{}
	for rows.Next() {
		var in repairInstance
		var isExc bool
		var orig *time.Time
		if err := rows.Scan(&in.ID, &in.SeriesID, &in.StoredDate, &in.EntityID, &isExc, &orig, &in.Hint, &in.Fixed); err != nil {
			rows.Close()
			return err
		}
		if isExc {
			exceptions[in.ID] = true
			in.Evidence = orig
		}
		if d, _ := time.Parse("2006-01-02", in.StoredDate); d.After(until) {
			until = d
		}
		instances = append(instances, in)
	}
	rows.Close()

	// Bookings' starts (non-exception rows): evidence only for ties
	for i := range instances {
		in := &instances[i]
		if exceptions[in.ID] || in.EntityID == nil {
			continue
		}
		v := byID[in.SeriesID]
		var start *time.Time
		q := fmt.Sprintf("SELECT lower(%s) FROM %s WHERE id = $1",
			pgx.Identifier{v.TimeSlotProperty}.Sanitize(), pgx.Identifier{"public", v.EntityTable}.Sanitize())
		if err := tx.QueryRow(ctx, q, *in.EntityID).Scan(&start); err == nil {
			in.Evidence = start
		}
	}

	decisions, orphans, err := resolveGroup(pure, instances, until.Add(72*time.Hour))
	if err != nil {
		return err
	}

	summaries := map[int64]*repairSummary{}
	sum := func(id int64) *repairSummary {
		if summaries[id] == nil {
			summaries[id] = &repairSummary{}
		}
		return summaries[id]
	}
	entityOf := map[int64]*int64{}
	for _, in := range instances {
		entityOf[in.ID] = in.EntityID
	}

	// Apply in two phases so rows can trade dates without tripping the unique
	// (series_id, occurrence_date) constraint: park, then set.
	for _, d := range decisions {
		if d.Status == repairRepaired {
			if _, err := tx.Exec(ctx, `UPDATE metadata.time_slot_instances SET occurrence_date = DATE '1000-01-01' - id::int WHERE id = $1`, d.InstanceID); err != nil {
				return err
			}
		}
	}
	for _, d := range decisions {
		if d.fixed {
			continue
		}
		s := sum(d.SeriesID)
		switch d.Status {
		case repairRepaired:
			if _, err := tx.Exec(ctx, `UPDATE metadata.time_slot_instances SET occurrence_date = $2::date WHERE id = $1`, d.InstanceID, d.NewDate); err != nil {
				return err
			}
			s.Repaired++
		case repairUnchanged:
			s.Unchanged++
		case repairUnresolved:
			s.Unresolved = append(s.Unresolved, repairNoteEntry{InstanceID: d.InstanceID, EntityID: entityOf[d.InstanceID], Date: d.NewDate, Note: d.Note})
			log.Printf("[Repair] Series %d instance %d left as %s: %s", d.SeriesID, d.InstanceID, d.NewDate, d.Note)
		case repairDetached:
			// Keep the row for the migration's revert, then remove the link
			if _, err := tx.Exec(ctx, `
				UPDATE metadata.time_slot_instance_date_repair r
				SET detached_row = (SELECT to_jsonb(i) FROM metadata.time_slot_instances i WHERE i.id = r.instance_id)
				WHERE r.instance_id = $1`, d.InstanceID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM metadata.time_slot_instances WHERE id = $1`, d.InstanceID); err != nil {
				return err
			}
			s.Detached = append(s.Detached, repairNoteEntry{InstanceID: d.InstanceID, EntityID: entityOf[d.InstanceID], Date: d.NewDate, Note: d.Note})
			log.Printf("[Repair] Series %d instance %d detached: %s", d.SeriesID, d.InstanceID, d.Note)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE metadata.time_slot_instance_date_repair
			SET status = $2, local_date = $3::date, note = NULLIF($4, ''), repaired_at = NOW()
			WHERE instance_id = $1`, d.InstanceID, string(d.Status), d.NewDate, d.Note); err != nil {
			return err
		}
	}

	// Orphaned bookings: link only an exact, unique match (slot and template;
	// Status columns excluded, they change per booking)
	for _, o := range orphans {
		v := byID[o.VersionID]
		statusCols, err := statusColumns(ctx, tx, v.EntityTable)
		if err != nil {
			return err
		}
		tmpl := map[string]any{}
		for k, val := range v.Template {
			if k != "id" && k != "time_slot" && k != v.TimeSlotProperty && !statusCols[k] {
				tmpl[k] = val
			}
		}
		tmplJSON, _ := json.Marshal(tmpl)
		col := pgx.Identifier{v.TimeSlotProperty}.Sanitize()
		q := fmt.Sprintf(`
			SELECT e.id FROM %s e
			WHERE lower(e.%s) = $1 AND upper(e.%s) = $2
			  AND NOT EXISTS (SELECT 1 FROM jsonb_each_text($3::jsonb) kv
			                  WHERE (to_jsonb(e) ->> kv.key) IS DISTINCT FROM kv.value)
			  AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_instances x
			                  WHERE x.entity_table = $4 AND x.entity_id = e.id)
			LIMIT 2`, pgx.Identifier{"public", v.EntityTable}.Sanitize(), col, col)
		r, err := tx.Query(ctx, q, o.Start, o.Start.Add(o.Duration), string(tmplJSON), v.EntityTable)
		if err != nil {
			return err
		}
		matches, err := pgx.CollectRows(r, pgx.RowTo[int64])
		if err != nil {
			return err
		}
		switch len(matches) {
		case 1:
			if _, err := tx.Exec(ctx, `
				INSERT INTO metadata.time_slot_instances (series_id, occurrence_date, entity_table, entity_id, is_exception)
				VALUES ($1, $2::date, $3, $4, FALSE)
				ON CONFLICT DO NOTHING`, o.VersionID, o.LocalDate, v.EntityTable, matches[0]); err != nil {
				return err
			}
			id := matches[0]
			sum(o.VersionID).Relinked = append(sum(o.VersionID).Relinked, repairNoteEntry{EntityID: &id, Date: o.LocalDate})
			log.Printf("[Repair] Series %d %s: re-linked orphaned booking %d", o.VersionID, o.LocalDate, id)
		case 0:
			// No orphan: the occurrence was never booked (or was deleted)
		default:
			log.Printf("[Repair] Series %d %s: several unlinked bookings match; none linked", o.VersionID, o.LocalDate)
			s := sum(o.VersionID)
			s.Unresolved = append(s.Unresolved, repairNoteEntry{Date: o.LocalDate, Note: "several unlinked bookings match this occurrence; none linked"})
		}
	}

	// Split boundaries: a version split before v0.76.9 ended on (UTC split date - 1),
	// which can include the local split day; end it before its successor's first occurrence.
	for i := 0; i+1 < len(versions); i++ {
		old, next := versions[i], versions[i+1]
		if old.EffectiveUntil == nil || next.VersionNumber != old.VersionNumber+1 {
			continue
		}
		var first *time.Time
		if err := tx.QueryRow(ctx, `SELECT min(occurrence_date) FROM metadata.time_slot_instances WHERE series_id = $1`, next.ID).Scan(&first); err != nil {
			return err
		}
		if first == nil || first.After(*old.EffectiveUntil) {
			continue
		}
		sum(old.ID).Boundary = &boundaryChange{
			EffectiveUntil: old.EffectiveUntil.Format("2006-01-02"), RRULE: old.RRULE,
			SuccessorID: next.ID, SuccessorEffectiveFrom: next.EffectiveFrom.Format("2006-01-02"),
		}
		if _, err := tx.Exec(ctx, `
			UPDATE metadata.time_slot_series
			SET effective_until = $2::date - 1, rrule = metadata.modify_rrule_until(rrule, $2::date - 1)
			WHERE id = $1`, old.ID, first.Format("2006-01-02")); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE metadata.time_slot_series SET effective_from = $2::date WHERE id = $1`, next.ID, first.Format("2006-01-02")); err != nil {
			return err
		}
		log.Printf("[Repair] Series %d now ends %s, before series %d's first occurrence", old.ID, first.AddDate(0, 0, -1).Format("2006-01-02"), next.ID)
	}

	for _, v := range versions {
		s := sum(v.ID)
		status := "repaired"
		if len(s.Unresolved) > 0 {
			status = "needs_attention"
		}
		detail, _ := json.Marshal(s)
		if _, err := tx.Exec(ctx, `
			UPDATE metadata.time_slot_date_repair SET status = $2, detail = $3::jsonb, repaired_at = NOW()
			WHERE series_id = $1 AND status = 'pending'`, v.ID, status, string(detail)); err != nil {
			return err
		}
		log.Printf("[Repair] Series %d: %s (%d repaired, %d unchanged, %d unresolved, %d detached, %d orphans re-linked)",
			v.ID, status, s.Repaired, s.Unchanged, len(s.Unresolved), len(s.Detached), len(s.Relinked))
	}
	return tx.Commit(ctx)
}

// statusColumns returns the columns of an entity table that reference metadata.statuses.
func statusColumns(ctx context.Context, tx pgx.Tx, table string) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.attname::text
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.contype = 'f' AND c.conrelid = to_regclass(format('public.%I', $1::text))
		  AND c.confrelid = 'metadata.statuses'::regclass`, table)
	if err != nil {
		return nil, err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	cols := make(map[string]bool, len(names))
	for _, n := range names {
		cols[n] = true
	}
	return cols, nil
}

// repairGate reports whether expansion of a series must wait for (pending) or is
// blocked by (needs_attention) the occurrence date repair of its group.
func repairGate(ctx context.Context, db interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, seriesID int64) (string, error) {
	var present bool
	if err := db.QueryRow(ctx, `SELECT to_regclass('metadata.time_slot_date_repair') IS NOT NULL`).Scan(&present); err != nil || !present {
		return "", err
	}
	var status *string
	err := db.QueryRow(ctx, `
		SELECT CASE WHEN bool_or(r.status = 'pending') THEN 'pending'
		            WHEN bool_or(r.status = 'needs_attention') THEN 'needs_attention' END
		FROM metadata.time_slot_series s
		JOIN metadata.time_slot_series g ON g.id = s.id OR (s.group_id IS NOT NULL AND g.group_id = s.group_id)
		JOIN metadata.time_slot_date_repair r ON r.series_id = g.id
		WHERE s.id = $1`, seriesID).Scan(&status)
	if err != nil || status == nil {
		return "", err
	}
	return *status, nil
}
