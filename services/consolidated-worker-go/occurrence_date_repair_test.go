package main

import (
	"testing"
	"time"
)

// ----------------------------------------------------------------------------
// resolveGroup: UTC-keyed occurrence_date -> local date (v0.76.9 repair)
// ----------------------------------------------------------------------------

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func wall(y int, m time.Month, d, h, mi int) time.Time {
	return time.Date(y, m, d, h, mi, 0, 0, time.UTC)
}

func utcAt(t *testing.T, s string) *time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return &ts
}

var horizon = time.Date(2027, 12, 31, 0, 0, 0, 0, time.UTC)

func decisionFor(t *testing.T, ds []repairDecision, id int64) repairDecision {
	t.Helper()
	for _, d := range ds {
		if d.InstanceID == id {
			return d
		}
	}
	t.Fatalf("no decision for instance %d", id)
	return repairDecision{}
}

func expect(t *testing.T, ds []repairDecision, id int64, date string, status repairStatus) {
	t.Helper()
	d := decisionFor(t, ds, id)
	if d.NewDate != date || d.Status != status {
		t.Errorf("instance %d: got %s (%s, %q), want %s (%s)", id, d.NewDate, d.Status, d.Note, date, status)
	}
}

// Review finding 1: a "this only" move must not beat a schedule match with a single
// candidate. Mon Nov 9 19:30 NY (stored under UTC Nov 10) was moved to Tue Nov 10
// 12:00; it is still the Monday occurrence.
func TestResolveGroup_ScheduleBeatsMovedBooking(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	v := repairVersion{ID: 1, VersionNumber: 1, RRULE: "FREQ=WEEKLY;BYDAY=MO;COUNT=3", Dtstart: wall(2026, 11, 2, 19, 30), Duration: time.Hour, Loc: ny}
	moved := utcAt(t, "2026-11-10T17:00:00Z") // Tue Nov 10 12:00 EST
	ds, _, err := resolveGroup([]repairVersion{v}, []repairInstance{
		{ID: 10, SeriesID: 1, StoredDate: "2026-11-03"},
		{ID: 11, SeriesID: 1, StoredDate: "2026-11-10", Evidence: moved},
		{ID: 12, SeriesID: 1, StoredDate: "2026-11-17"},
	}, horizon)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, ds, 10, "2026-11-02", repairRepaired)
	expect(t, ds, 11, "2026-11-09", repairRepaired)
	expect(t, ds, 12, "2026-11-16", repairRepaired)
}

// Review finding 2: BYSETPOS must be honored. The 4th weekend day of March 2027 is
// Sun Mar 14 (6, 7, 13, 14); the cancelled occurrence (no booking) is that Sunday,
// not Sat Mar 13, which shares its UTC date.
func TestResolveGroup_BySetPosCancelledOccurrence(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	v := repairVersion{ID: 1, VersionNumber: 1, RRULE: "FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=4;COUNT=3", Dtstart: wall(2027, 1, 1, 19, 30), Duration: time.Hour, Loc: ny}
	ds, _, err := resolveGroup([]repairVersion{v}, []repairInstance{
		{ID: 20, SeriesID: 1, StoredDate: "2027-03-14"}, // cancelled: entity_id NULL, no evidence
	}, horizon)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, ds, 20, "2027-03-14", repairUnchanged)
}

// Review finding 3: a pre-v0.76.5 split of Mon 19:00 NY to 09:00 re-linked the old
// 19:00 booking (stored under UTC Tue) and the new version then booked the same
// Monday at 09:00. Both are the Monday occurrence: the new version's own booking
// keeps it, the re-linked one is detached instead of aborting the upgrade.
func TestResolveGroup_PreSplitDoubleBookingDetachesTheRelinkedRow(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	v1 := repairVersion{ID: 1, VersionNumber: 1, RRULE: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T235959Z", Dtstart: wall(2026, 11, 2, 19, 0), Duration: time.Hour, Loc: ny}
	v2 := repairVersion{ID: 2, VersionNumber: 2, RRULE: "FREQ=WEEKLY;BYDAY=MO;COUNT=4", Dtstart: wall(2026, 11, 16, 9, 0), Duration: time.Hour, Loc: ny}
	ds, _, err := resolveGroup([]repairVersion{v1, v2}, []repairInstance{
		{ID: 30, SeriesID: 1, StoredDate: "2026-11-03"},
		{ID: 31, SeriesID: 1, StoredDate: "2026-11-10"},
		{ID: 32, SeriesID: 2, StoredDate: "2026-11-17"}, // re-linked 19:00 booking of Mon Nov 16
		{ID: 33, SeriesID: 2, StoredDate: "2026-11-24"}, // re-linked 19:00 booking of Mon Nov 23
		{ID: 34, SeriesID: 2, StoredDate: "2026-11-16"}, // new version's 09:00 booking of Mon Nov 16
	}, horizon)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, ds, 30, "2026-11-02", repairRepaired)
	expect(t, ds, 31, "2026-11-09", repairRepaired)
	expect(t, ds, 34, "2026-11-16", repairUnchanged)
	expect(t, ds, 32, "2026-11-16", repairDetached)
	expect(t, ds, 33, "2026-11-23", repairRepaired)
}

// Ties (two occurrences share a UTC date around a DST change) are broken by the
// booking; without a booking they are reported, not guessed.
func TestResolveGroup_DailyEveningAcrossSpringForward(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	v := repairVersion{ID: 1, VersionNumber: 1, RRULE: "FREQ=DAILY;COUNT=4", Dtstart: wall(2027, 3, 12, 19, 30), Duration: time.Hour, Loc: ny}
	ds, orphans, err := resolveGroup([]repairVersion{v}, []repairInstance{
		{ID: 40, SeriesID: 1, StoredDate: "2027-03-13", Evidence: utcAt(t, "2027-03-13T00:30:00Z")},
		{ID: 41, SeriesID: 1, StoredDate: "2027-03-14", Evidence: utcAt(t, "2027-03-14T00:30:00Z")}, // Sat Mar 13 19:30 EST
		{ID: 42, SeriesID: 1, StoredDate: "2027-03-15", Evidence: utcAt(t, "2027-03-15T23:30:00Z")},
	}, horizon)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, ds, 40, "2027-03-12", repairRepaired)
	expect(t, ds, 41, "2027-03-13", repairRepaired)
	expect(t, ds, 42, "2027-03-15", repairUnchanged)
	if len(orphans) != 1 || orphans[0].LocalDate != "2027-03-14" || !orphans[0].Start.Equal(*utcAt(t, "2027-03-14T23:30:00Z")) {
		t.Errorf("orphans = %+v, want the Sun Mar 14 19:30 occurrence", orphans)
	}

	// Same tie, but the row is a cancellation without a booking
	ds, _, _ = resolveGroup([]repairVersion{v}, []repairInstance{{ID: 43, SeriesID: 1, StoredDate: "2027-03-14"}}, horizon)
	expect(t, ds, 43, "2027-03-14", repairUnresolved)
	// An operator's hint resolves it, but only to one of the candidates
	ds, _, _ = resolveGroup([]repairVersion{v}, []repairInstance{{ID: 44, SeriesID: 1, StoredDate: "2027-03-14", Hint: "2027-03-13"}}, horizon)
	expect(t, ds, 44, "2027-03-13", repairRepaired)
	ds, _, _ = resolveGroup([]repairVersion{v}, []repairInstance{{ID: 45, SeriesID: 1, StoredDate: "2027-03-14", Hint: "2027-03-20"}}, horizon)
	expect(t, ds, 45, "2027-03-14", repairUnresolved)

	// Re-run after the remedy: rows repaired earlier keep their dates and win collisions
	ds, _, _ = resolveGroup([]repairVersion{v}, []repairInstance{
		{ID: 46, SeriesID: 1, StoredDate: "2027-03-13", Fixed: true},
		{ID: 47, SeriesID: 1, StoredDate: "2027-03-14", Hint: "2027-03-13"},
	}, horizon)
	expect(t, ds, 46, "2027-03-13", repairUnchanged)
	if d := decisionFor(t, ds, 47); d.Status == repairRepaired {
		t.Errorf("hinted row moved onto a date a repaired row holds: %+v", d)
	}
}

func TestResolveGroup_SydneyAcrossDSTStart(t *testing.T) {
	syd := mustLoc(t, "Australia/Sydney")
	v := repairVersion{ID: 1, VersionNumber: 1, RRULE: "FREQ=DAILY;COUNT=3", Dtstart: wall(2026, 10, 3, 10, 30), Duration: time.Hour, Loc: syd}
	ds, orphans, err := resolveGroup([]repairVersion{v}, []repairInstance{
		{ID: 50, SeriesID: 1, StoredDate: "2026-10-03", Evidence: utcAt(t, "2026-10-03T00:30:00Z")}, // Sat Oct 3 10:30 AEST
		{ID: 51, SeriesID: 1, StoredDate: "2026-10-04", Evidence: utcAt(t, "2026-10-04T23:30:00Z")}, // Mon Oct 5 10:30 AEDT
	}, horizon)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, ds, 50, "2026-10-03", repairUnchanged)
	expect(t, ds, 51, "2026-10-05", repairRepaired)
	if len(orphans) != 1 || orphans[0].LocalDate != "2026-10-04" {
		t.Errorf("orphans = %+v, want Sun Oct 4", orphans)
	}
}

// Rows re-linked to a later version by a pre-v0.76.5 split are matched against the
// earlier version's schedule when their own has no occurrence on that UTC date.
func TestResolveGroup_RelinkedCancelledRowUsesEarlierVersion(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	v1 := repairVersion{ID: 1, VersionNumber: 1, RRULE: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T235959Z", Dtstart: wall(2026, 11, 2, 19, 0), Duration: time.Hour, Loc: ny}
	v2 := repairVersion{ID: 2, VersionNumber: 2, RRULE: "FREQ=WEEKLY;BYDAY=MO;COUNT=4", Dtstart: wall(2026, 11, 16, 8, 0), Duration: time.Hour, Loc: ny}
	ds, _, err := resolveGroup([]repairVersion{v1, v2}, []repairInstance{
		{ID: 60, SeriesID: 2, StoredDate: "2026-11-24"}, // cancelled, re-linked from v1 (Mon Nov 23 19:00)
	}, horizon)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, ds, 60, "2026-11-23", repairRepaired)
}

func TestVersionOccurrences_DropsUntilKeepsCount(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	v := repairVersion{ID: 1, RRULE: "FREQ=WEEKLY;BYDAY=MO;COUNT=3;UNTIL=20261109T235959Z", Dtstart: wall(2026, 11, 2, 19, 0), Loc: ny}
	occs, err := versionOccurrences(v, horizon)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, len(occs))
	for i, o := range occs {
		got[i] = o.LocalDate + "/" + o.UTCDate
	}
	assertDates(t, got, []string{"2026-11-02/2026-11-03", "2026-11-09/2026-11-10", "2026-11-16/2026-11-17"})
}
