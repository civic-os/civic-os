package main

// ============================================================================
// Occurrence date repair (v0.76.9): UTC-keyed occurrence_date -> series-local date
// ============================================================================
//
// Before v0.76.9 the expansion worker stored time_slot_instances.occurrence_date
// as the occurrence's UTC date. Migration v0-76-9-occurrence-date-local flags every
// series and instance for repair and enqueues RepairOccurrenceDatesArgs; this
// worker computes the local dates with rrule-go, the same code that expands
// series, so no RRULE semantics are re-implemented in SQL.
//
// This file holds the pure resolution logic (unit-tested); the database work is in
// occurrence_date_repair_worker.go.

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/teambition/rrule-go"
)

// repairVersion is one version (time_slot_series row) of a series group.
type repairVersion struct {
	ID            int64
	VersionNumber int
	RRULE         string
	Dtstart       time.Time // wall clock, tagged UTC (TIMESTAMP)
	Duration      time.Duration
	Loc           *time.Location
}

// repairInstance is one stored time_slot_instances row awaiting repair.
type repairInstance struct {
	ID         int64
	SeriesID   int64
	StoredDate string // occurrence_date as stored (UTC date), YYYY-MM-DD
	EntityID   *int64
	// Evidence is the booking's start (non-exception rows) or original_time_slot
	// start (rescheduled exceptions). It only breaks ties.
	Evidence *time.Time
	// Hint is a local date an operator set to resolve a tie the repair reported;
	// it is used only if it is one of the candidates.
	Hint string
	// Fixed rows were repaired earlier (StoredDate is already local): they keep
	// their date and only occupy it for the collision rules.
	Fixed bool
}

// repairOccurrence is one occurrence a version's RRULE generates.
type repairOccurrence struct {
	VersionID int64
	Start     time.Time // UTC instant
	LocalDate string    // date in the series timezone
	UTCDate   string
}

// repairStatus is the outcome for one instance.
type repairStatus string

const (
	repairRepaired   repairStatus = "repaired"   // moved to its local date
	repairUnchanged  repairStatus = "unchanged"  // its local date equals the stored date
	repairUnresolved repairStatus = "unresolved" // tie without evidence, or no matching occurrence: left as stored, flagged
	repairDetached   repairStatus = "detached"   // a second row for an occurrence that already has one: link removed, booking kept
)

// repairDecision is what the repair does with one instance.
type repairDecision struct {
	InstanceID int64
	SeriesID   int64
	NewDate    string // local date (equals StoredDate when unchanged/unresolved)
	Status     repairStatus
	Note       string
	ownVersion bool // matched an occurrence of its own version (vs. another version of the group)
	fixed      bool // repaired earlier: not written again
}

// orphanCandidate is an occurrence whose booking the UTC-keyed worker may have
// inserted without an instance row: two occurrences of one version shared a UTC
// date, the first got the row and the second's ON CONFLICT DO NOTHING dropped it.
type orphanCandidate struct {
	VersionID int64
	LocalDate string
	Start     time.Time
	Duration  time.Duration
}

var untilPart = regexp.MustCompile(`(?i)(^|;)UNTIL=[^;]*`)

// versionOccurrences expands a version's RRULE up to `until` (UTC). UNTIL is
// dropped: a split later cut the version with UNTIL, but rows it expanded before
// the split (and pre-v0.76.5 rows re-linked to its successor) must still match.
// COUNT is kept: the old worker never generated past it.
func versionOccurrences(v repairVersion, until time.Time) ([]repairOccurrence, error) {
	rule := strings.Trim(untilPart.ReplaceAllString(v.RRULE, "$1"), ";")
	rule = strings.ReplaceAll(rule, ";;", ";")
	set, err := rrule.StrToRRuleSet(fmt.Sprintf("DTSTART:%s\nRRULE:%s", v.Dtstart.Format("20060102T150405"), rule))
	if err != nil {
		return nil, fmt.Errorf("version %d: parse RRULE %q: %w", v.ID, v.RRULE, err)
	}
	walls := set.Between(v.Dtstart, until.In(v.Loc), true)
	occs := make([]repairOccurrence, 0, len(walls))
	for _, w := range walls {
		start := wallClockInstant(w, v.Loc)
		occs = append(occs, repairOccurrence{
			VersionID: v.ID,
			Start:     start,
			LocalDate: occurrenceDate(start, v.Loc),
			UTCDate:   start.UTC().Format("2006-01-02"),
		})
	}
	return occs, nil
}

// resolveGroup decides each instance's local date.
//
// Rules (v0.76.9 review):
//  1. The schedule decides: the occurrences of the row's own version whose UTC
//     date is the stored date (other versions of the group only when its own has
//     none, i.e. rows re-linked by a pre-v0.76.5 split). Exactly one candidate
//     wins even if the booking was moved "this only".
//  2. The booking is evidence only to break a tie between candidates.
//  3. A tie without decisive evidence, or no candidate at all, is not guessed:
//     the row stays as stored and is reported unresolved.
//  4. Two rows resolving to the same occurrence (a split that had booked it twice):
//     the row that matched its own version keeps it, the other is detached.
//
// It also returns the occurrences whose bookings may have been orphaned.
func resolveGroup(versions []repairVersion, instances []repairInstance, until time.Time) ([]repairDecision, []orphanCandidate, error) {
	byID := make(map[int64]repairVersion, len(versions))
	occsByVersion := make(map[int64][]repairOccurrence, len(versions))
	for _, v := range versions {
		byID[v.ID] = v
		occs, err := versionOccurrences(v, until)
		if err != nil {
			return nil, nil, err
		}
		occsByVersion[v.ID] = occs
	}

	// Other versions in the order rows re-linked to v most likely came from:
	// earlier versions first (newest of them first), then later ones.
	otherVersions := func(v repairVersion) []repairVersion {
		var earlier, later []repairVersion
		for _, o := range versions {
			if o.ID == v.ID {
				continue
			}
			if o.VersionNumber < v.VersionNumber {
				earlier = append(earlier, o)
			} else {
				later = append(later, o)
			}
		}
		sort.Slice(earlier, func(i, j int) bool { return earlier[i].VersionNumber > earlier[j].VersionNumber })
		sort.Slice(later, func(i, j int) bool { return later[i].VersionNumber < later[j].VersionNumber })
		return append(earlier, later...)
	}

	candidatesIn := func(versionID int64, utcDate string) []string {
		seen := map[string]bool{}
		var dates []string
		for _, o := range occsByVersion[versionID] {
			if o.UTCDate == utcDate && !seen[o.LocalDate] {
				seen[o.LocalDate] = true
				dates = append(dates, o.LocalDate)
			}
		}
		sort.Strings(dates)
		return dates
	}

	decisions := make([]repairDecision, 0, len(instances))
	for _, inst := range instances {
		v, ok := byID[inst.SeriesID]
		if !ok {
			decisions = append(decisions, repairDecision{InstanceID: inst.ID, SeriesID: inst.SeriesID, NewDate: inst.StoredDate,
				Status: repairUnresolved, Note: "series version not found"})
			continue
		}
		cands, own, from := candidatesIn(v.ID, inst.StoredDate), true, v
		if len(cands) == 0 {
			own = false
			for _, o := range otherVersions(v) {
				if c := candidatesIn(o.ID, inst.StoredDate); len(c) > 0 {
					cands, from = c, o
					break
				}
			}
		}

		d := repairDecision{InstanceID: inst.ID, SeriesID: inst.SeriesID, NewDate: inst.StoredDate, ownVersion: own}
		if inst.Fixed {
			d.Status, d.ownVersion, d.fixed = repairUnchanged, true, true
			decisions = append(decisions, d)
			continue
		}
		switch {
		case len(cands) == 0:
			d.Status, d.Note = repairUnresolved, "no occurrence of the series falls on this UTC date"
		case len(cands) == 1:
			d.NewDate = cands[0]
		default:
			evidence := ""
			if inst.Evidence != nil {
				evidence = occurrenceDate(*inst.Evidence, from.Loc)
			}
			if inst.Hint != "" && contains(cands, inst.Hint) {
				evidence = inst.Hint
			}
			for _, c := range cands {
				if c == evidence {
					d.NewDate = c
				}
			}
			if d.NewDate == inst.StoredDate && !contains(cands, evidence) {
				d.Status = repairUnresolved
				d.Note = fmt.Sprintf("two occurrences share this UTC date (%s) and the booking does not say which this is", strings.Join(cands, ", "))
			}
		}
		if d.Status == "" {
			if d.NewDate == inst.StoredDate {
				d.Status = repairUnchanged
			} else {
				d.Status = repairRepaired
			}
		}
		decisions = append(decisions, d)
	}

	// Rule 4: one row per occurrence (series, local date). Own-version matches beat
	// rows that came from another version; then the lower instance id (older row).
	type key struct {
		series int64
		date   string
	}
	holders := map[key][]int{}
	for i, d := range decisions {
		holders[key{d.SeriesID, d.NewDate}] = append(holders[key{d.SeriesID, d.NewDate}], i)
	}
	for _, idx := range holders {
		if len(idx) < 2 {
			continue
		}
		sort.Slice(idx, func(a, b int) bool {
			da, db := decisions[idx[a]], decisions[idx[b]]
			if da.fixed != db.fixed {
				return da.fixed
			}
			ra, rb := da.Status != repairUnresolved && da.ownVersion, db.Status != repairUnresolved && db.ownVersion
			if ra != rb {
				return ra
			}
			return da.InstanceID < db.InstanceID
		})
		for _, i := range idx[1:] {
			decisions[i].Status = repairDetached
			decisions[i].Note = fmt.Sprintf("instance %d already holds the %s occurrence; this booking is kept but no longer linked to the series",
				decisions[idx[0]].InstanceID, decisions[i].NewDate)
		}
	}

	// A row may not move onto a date still held by a row that stays where it is
	// (unchanged or unresolved): it stays too, reported, until nothing collides.
	for changed := true; changed; {
		changed = false
		staying := map[key]int64{}
		for _, d := range decisions {
			if d.Status == repairUnchanged || d.Status == repairUnresolved {
				staying[key{d.SeriesID, d.NewDate}] = d.InstanceID
			}
		}
		for i, d := range decisions {
			if d.Status != repairRepaired {
				continue
			}
			if holder, ok := staying[key{d.SeriesID, d.NewDate}]; ok {
				stored := ""
				for _, inst := range instances {
					if inst.ID == d.InstanceID {
						stored = inst.StoredDate
					}
				}
				decisions[i].Status = repairUnresolved
				decisions[i].Note = fmt.Sprintf("its local date %s is still held by instance %d", d.NewDate, holder)
				decisions[i].NewDate = stored
				changed = true
			}
		}
	}

	// Occurrences sharing a UTC date with another occurrence of the same version,
	// that no row now holds: their bookings may be orphans.
	held := map[key]bool{}
	for _, d := range decisions {
		if d.Status != repairDetached {
			held[key{d.SeriesID, d.NewDate}] = true
		}
	}
	var orphans []orphanCandidate
	for _, v := range versions {
		perUTC := map[string]int{}
		for _, o := range occsByVersion[v.ID] {
			perUTC[o.UTCDate]++
		}
		for _, o := range occsByVersion[v.ID] {
			if perUTC[o.UTCDate] > 1 && !held[key{v.ID, o.LocalDate}] {
				orphans = append(orphans, orphanCandidate{VersionID: v.ID, LocalDate: o.LocalDate, Start: o.Start, Duration: v.Duration})
			}
		}
	}
	return decisions, orphans, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
