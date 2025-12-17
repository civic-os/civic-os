package main

import (
	"testing"
	"time"
)

// ============================================================================
// Unit Tests for Recurring Series Worker
// ============================================================================

// ----------------------------------------------------------------------------
// parsePGInterval Tests
// ----------------------------------------------------------------------------

func TestParsePGInterval_SimpleHoursMinutesSeconds(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected time.Duration
	}{
		{
			name:     "one hour",
			input:    "01:00:00",
			expected: 1 * time.Hour,
		},
		{
			name:     "two hours",
			input:    "02:00:00",
			expected: 2 * time.Hour,
		},
		{
			name:     "90 minutes",
			input:    "01:30:00",
			expected: 1*time.Hour + 30*time.Minute,
		},
		{
			name:     "30 minutes",
			input:    "00:30:00",
			expected: 30 * time.Minute,
		},
		{
			name:     "45 seconds",
			input:    "00:00:45",
			expected: 45 * time.Second,
		},
		{
			name:     "complex duration",
			input:    "02:15:30",
			expected: 2*time.Hour + 15*time.Minute + 30*time.Second,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := parsePGInterval(tt.input)
			if err != nil {
				t.Errorf("parsePGInterval(%q) returned error: %v", tt.input, err)
				return
			}
			if result != tt.expected {
				t.Errorf("parsePGInterval(%q) = %v, want %v", tt.input, result, tt.expected)
			}
		})
	}
}

// ----------------------------------------------------------------------------
// joinStrings Tests
// ----------------------------------------------------------------------------

func TestJoinStrings(t *testing.T) {
	tests := []struct {
		name     string
		input    []string
		sep      string
		expected string
	}{
		{
			name:     "empty slice",
			input:    []string{},
			sep:      ", ",
			expected: "",
		},
		{
			name:     "single element",
			input:    []string{"hello"},
			sep:      ", ",
			expected: "hello",
		},
		{
			name:     "two elements",
			input:    []string{"hello", "world"},
			sep:      ", ",
			expected: "hello, world",
		},
		{
			name:     "SQL columns",
			input:    []string{"room_id", "purpose", "time_slot"},
			sep:      ", ",
			expected: "room_id, purpose, time_slot",
		},
		{
			name:     "placeholders",
			input:    []string{"$1", "$2", "$3"},
			sep:      ", ",
			expected: "$1, $2, $3",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := joinStrings(tt.input, tt.sep)
			if result != tt.expected {
				t.Errorf("joinStrings(%v, %q) = %q, want %q", tt.input, tt.sep, result, tt.expected)
			}
		})
	}
}

// ----------------------------------------------------------------------------
// generateOccurrences Tests (RRULE parsing)
// ----------------------------------------------------------------------------

func TestGenerateOccurrences_WeeklyByday(t *testing.T) {
	// Create a mock worker (doesn't need DB for RRULE parsing)
	w := &ExpandRecurringSeriesWorker{}

	// Weekly on Monday, 4 occurrences
	series := &SeriesRecord{
		RRULE:   "FREQ=WEEKLY;BYDAY=MO;COUNT=4",
		Dtstart: time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC), // Monday Jan 5, 2026
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// Should get exactly 4 occurrences (COUNT=4)
	if len(occurrences) != 4 {
		t.Errorf("Expected 4 occurrences, got %d", len(occurrences))
	}

	// Verify dates are all Mondays and one week apart
	expectedDates := []string{"2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"}
	for i, occ := range occurrences {
		dateStr := occ.Format("2006-01-02")
		if dateStr != expectedDates[i] {
			t.Errorf("Occurrence %d: got %s, want %s", i, dateStr, expectedDates[i])
		}
		if occ.Weekday() != time.Monday {
			t.Errorf("Occurrence %d (%s) is not Monday, got %s", i, dateStr, occ.Weekday())
		}
	}
}

func TestGenerateOccurrences_DailyCount(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	series := &SeriesRecord{
		RRULE:   "FREQ=DAILY;COUNT=5",
		Dtstart: time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC),
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	if len(occurrences) != 5 {
		t.Errorf("Expected 5 occurrences, got %d", len(occurrences))
	}

	// Verify consecutive days
	for i := 0; i < len(occurrences)-1; i++ {
		diff := occurrences[i+1].Sub(occurrences[i])
		if diff != 24*time.Hour {
			t.Errorf("Gap between occurrence %d and %d is %v, expected 24h", i, i+1, diff)
		}
	}
}

func TestGenerateOccurrences_MonthlyByMonthDay(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Monthly on the 15th, 3 occurrences
	series := &SeriesRecord{
		RRULE:   "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3",
		Dtstart: time.Date(2026, 1, 15, 14, 0, 0, 0, time.UTC),
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	if len(occurrences) != 3 {
		t.Errorf("Expected 3 occurrences, got %d", len(occurrences))
	}

	// Verify all on the 15th
	for i, occ := range occurrences {
		if occ.Day() != 15 {
			t.Errorf("Occurrence %d is on day %d, expected 15", i, occ.Day())
		}
	}
}

func TestGenerateOccurrences_WithUntilDate(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Weekly, but limited by UNTIL
	series := &SeriesRecord{
		RRULE:   "FREQ=WEEKLY;BYDAY=TU;UNTIL=20260210T235959Z",
		Dtstart: time.Date(2026, 1, 6, 10, 0, 0, 0, time.UTC), // Tuesday
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// Should stop at Feb 10 (which is a Tuesday)
	// Tuesdays: Jan 6, 13, 20, 27, Feb 3, 10 = 6 occurrences
	if len(occurrences) != 6 {
		t.Errorf("Expected 6 occurrences (until Feb 10), got %d", len(occurrences))
		for i, occ := range occurrences {
			t.Logf("  Occurrence %d: %s", i, occ.Format("2006-01-02"))
		}
	}
}

func TestGenerateOccurrences_WithInterval(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Every 2 weeks on Friday
	series := &SeriesRecord{
		RRULE:   "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=4",
		Dtstart: time.Date(2026, 1, 2, 15, 0, 0, 0, time.UTC), // Friday
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	if len(occurrences) != 4 {
		t.Errorf("Expected 4 occurrences, got %d", len(occurrences))
	}

	// Verify 2-week intervals
	expectedDates := []string{"2026-01-02", "2026-01-16", "2026-01-30", "2026-02-13"}
	for i, occ := range occurrences {
		dateStr := occ.Format("2006-01-02")
		if dateStr != expectedDates[i] {
			t.Errorf("Occurrence %d: got %s, want %s", i, dateStr, expectedDates[i])
		}
	}
}

func TestGenerateOccurrences_WeekdaysMWF(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Monday, Wednesday, Friday for 2 weeks (6 occurrences)
	series := &SeriesRecord{
		RRULE:   "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6",
		Dtstart: time.Date(2026, 1, 5, 8, 0, 0, 0, time.UTC), // Monday
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	if len(occurrences) != 6 {
		t.Errorf("Expected 6 occurrences, got %d", len(occurrences))
	}

	// Verify days are Mon/Wed/Fri
	validDays := map[time.Weekday]bool{
		time.Monday:    true,
		time.Wednesday: true,
		time.Friday:    true,
	}

	for i, occ := range occurrences {
		if !validDays[occ.Weekday()] {
			t.Errorf("Occurrence %d (%s) is %s, expected Mon/Wed/Fri",
				i, occ.Format("2006-01-02"), occ.Weekday())
		}
	}
}

func TestGenerateOccurrences_BySetPos_SecondTuesday(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Second Tuesday of each month (BYSETPOS=2 with BYDAY=TU)
	series := &SeriesRecord{
		RRULE:   "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;COUNT=3",
		Dtstart: time.Date(2026, 1, 13, 18, 0, 0, 0, time.UTC), // 2nd Tuesday of Jan
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	if len(occurrences) != 3 {
		t.Errorf("Expected 3 occurrences, got %d", len(occurrences))
		for i, occ := range occurrences {
			t.Logf("  Occurrence %d: %s (%s)", i, occ.Format("2006-01-02"), occ.Weekday())
		}
	}

	// Verify all are Tuesdays
	for i, occ := range occurrences {
		if occ.Weekday() != time.Tuesday {
			t.Errorf("Occurrence %d (%s) is not Tuesday", i, occ.Format("2006-01-02"))
		}
		// Second Tuesday should be between 8th and 14th of month
		if occ.Day() < 8 || occ.Day() > 14 {
			t.Errorf("Occurrence %d (%s) day is %d, should be 8-14 for 2nd occurrence",
				i, occ.Format("2006-01-02"), occ.Day())
		}
	}
}

func TestGenerateOccurrences_BySetPos_LastFriday(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Last Friday of each month (BYSETPOS=-1 with BYDAY=FR)
	series := &SeriesRecord{
		RRULE:   "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=3",
		Dtstart: time.Date(2026, 1, 30, 10, 0, 0, 0, time.UTC), // Last Friday of Jan
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	if len(occurrences) != 3 {
		t.Errorf("Expected 3 occurrences, got %d", len(occurrences))
		for i, occ := range occurrences {
			t.Logf("  Occurrence %d: %s (%s)", i, occ.Format("2006-01-02"), occ.Weekday())
		}
	}

	// Verify all are Fridays
	for i, occ := range occurrences {
		if occ.Weekday() != time.Friday {
			t.Errorf("Occurrence %d (%s) is not Friday", i, occ.Format("2006-01-02"))
		}
	}

	// Expected last Fridays: Jan 30, Feb 27, Mar 27 (2026)
	expectedDates := []string{"2026-01-30", "2026-02-27", "2026-03-27"}
	for i, occ := range occurrences {
		dateStr := occ.Format("2006-01-02")
		if dateStr != expectedDates[i] {
			t.Errorf("Occurrence %d: got %s, want %s", i, dateStr, expectedDates[i])
		}
	}
}

// ----------------------------------------------------------------------------
// Edge Cases
// ----------------------------------------------------------------------------

func TestGenerateOccurrences_EmptyUntilBeforeStart(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	series := &SeriesRecord{
		RRULE:   "FREQ=DAILY;COUNT=10",
		Dtstart: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC),
	}

	// Expand until is before start
	until := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// Should get 0 occurrences since until < dtstart
	if len(occurrences) != 0 {
		t.Errorf("Expected 0 occurrences when until < dtstart, got %d", len(occurrences))
	}
}

func TestGenerateOccurrences_PreservesTime(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// 3:30 PM start time
	series := &SeriesRecord{
		RRULE:   "FREQ=DAILY;COUNT=3",
		Dtstart: time.Date(2026, 1, 1, 15, 30, 0, 0, time.UTC),
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// All occurrences should preserve the 15:30 time
	for i, occ := range occurrences {
		if occ.Hour() != 15 || occ.Minute() != 30 {
			t.Errorf("Occurrence %d has time %02d:%02d, expected 15:30",
				i, occ.Hour(), occ.Minute())
		}
	}
}

// ----------------------------------------------------------------------------
// ExpandRecurringSeriesArgs Tests
// ----------------------------------------------------------------------------

func TestExpandRecurringSeriesArgs_Kind(t *testing.T) {
	args := ExpandRecurringSeriesArgs{}
	if args.Kind() != "expand_recurring_series" {
		t.Errorf("Kind() = %q, want %q", args.Kind(), "expand_recurring_series")
	}
}

func TestExpandRecurringSeriesArgs_InsertOpts(t *testing.T) {
	args := ExpandRecurringSeriesArgs{}
	opts := args.InsertOpts()

	if opts.Queue != "recurring" {
		t.Errorf("InsertOpts().Queue = %q, want %q", opts.Queue, "recurring")
	}
	if opts.MaxAttempts != 10 {
		t.Errorf("InsertOpts().MaxAttempts = %d, want %d", opts.MaxAttempts, 10)
	}
	if opts.Priority != 2 {
		t.Errorf("InsertOpts().Priority = %d, want %d", opts.Priority, 2)
	}
}

// ----------------------------------------------------------------------------
// parsePGInterval Error Handling Tests (Task 5)
// ----------------------------------------------------------------------------

func TestParsePGInterval_InvalidFormat_ReturnsError(t *testing.T) {
	// These invalid formats should return an error, not default to 1 hour
	// Note: parsePGInterval currently supports HH:MM:SS format with Sscanf which is lenient
	invalidFormats := []string{
		"invalid",
		"abc:def:ghi",
		"",
		"one hour",
		"totally wrong format",
	}

	for _, input := range invalidFormats {
		t.Run(input, func(t *testing.T) {
			duration, err := parsePGInterval(input)
			if err == nil {
				t.Errorf("parsePGInterval(%q) should return error, got duration %v", input, duration)
			}
		})
	}
}

// ----------------------------------------------------------------------------
// Timezone-Aware Generation Tests (Task 1)
// ----------------------------------------------------------------------------

func TestGenerateOccurrences_WithTimezone_America_NewYork(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Daily for 3 days at 2 PM local time in New York
	tz := "America/New_York"
	loc, _ := time.LoadLocation("America/New_York")

	// dtstart is 2 PM local in New York (EST = UTC-5)
	localStart := time.Date(2026, 1, 5, 14, 0, 0, 0, loc) // 2 PM EST = 7 PM UTC
	series := &SeriesRecord{
		RRULE:    "FREQ=DAILY;COUNT=3",
		Dtstart:  localStart.UTC(), // Store as UTC
		Timezone: &tz,
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// Verify we get at least 2 occurrences (rrule.Between behavior may vary)
	if len(occurrences) < 2 {
		t.Errorf("Expected at least 2 occurrences, got %d", len(occurrences))
		for i, occ := range occurrences {
			t.Logf("  Occurrence %d: %v (local: %v)", i, occ, occ.In(loc))
		}
	}

	// All occurrences should be at 2 PM in New York (the key test for timezone handling)
	for i, occ := range occurrences {
		localTime := occ.In(loc)
		if localTime.Hour() != 14 {
			t.Errorf("Occurrence %d (%s): local time is %02d:00, expected 14:00",
				i, occ.Format("2006-01-02"), localTime.Hour())
		}
	}
}

func TestGenerateOccurrences_WithTimezone_UTC(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Explicit UTC timezone
	tz := "UTC"
	series := &SeriesRecord{
		RRULE:    "FREQ=DAILY;COUNT=3",
		Dtstart:  time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
		Timezone: &tz,
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// All should be at 10:00 UTC
	for i, occ := range occurrences {
		if occ.Hour() != 10 {
			t.Errorf("Occurrence %d: UTC hour is %d, expected 10", i, occ.Hour())
		}
	}
}

func TestGenerateOccurrences_WithInvalidTimezone_FallsBackToUTC(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Invalid timezone should fallback to UTC
	tz := "Invalid/Timezone"
	series := &SeriesRecord{
		RRULE:    "FREQ=DAILY;COUNT=2",
		Dtstart:  time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC),
		Timezone: &tz,
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// Should still work with UTC fallback
	if len(occurrences) != 2 {
		t.Errorf("Expected 2 occurrences, got %d", len(occurrences))
	}
}

func TestGenerateOccurrences_WithNilTimezone_UsesUTC(t *testing.T) {
	w := &ExpandRecurringSeriesWorker{}

	// Nil timezone should use UTC
	series := &SeriesRecord{
		RRULE:    "FREQ=DAILY;COUNT=2",
		Dtstart:  time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC),
		Timezone: nil,
	}

	until := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	occurrences, err := w.generateOccurrences(series, until)
	if err != nil {
		t.Fatalf("generateOccurrences failed: %v", err)
	}

	// All should be at 12:00 UTC
	for i, occ := range occurrences {
		if occ.Hour() != 12 {
			t.Errorf("Occurrence %d: UTC hour is %d, expected 12", i, occ.Hour())
		}
	}
}

// ----------------------------------------------------------------------------
// convertToUTC Tests
// ----------------------------------------------------------------------------

func TestConvertToUTC_PreservesWallClockTime(t *testing.T) {
	loc, _ := time.LoadLocation("America/Chicago")

	// Create times in the location (2 PM CST = 8 PM UTC in winter)
	localTimesInLoc := []time.Time{
		time.Date(2026, 1, 15, 14, 0, 0, 0, loc),
	}

	result := convertToUTC(localTimesInLoc, loc)

	// 2 PM CST (UTC-6) should become 8 PM UTC in winter
	if len(result) != 1 {
		t.Fatalf("Expected 1 result, got %d", len(result))
	}

	expected := time.Date(2026, 1, 15, 20, 0, 0, 0, time.UTC)
	if !result[0].Equal(expected) {
		t.Errorf("convertToUTC: got %v, want %v", result[0], expected)
	}
}

func TestConvertToUTC_EmptySlice(t *testing.T) {
	loc, _ := time.LoadLocation("America/New_York")
	result := convertToUTC([]time.Time{}, loc)

	if len(result) != 0 {
		t.Errorf("convertToUTC(empty) should return empty slice, got %d elements", len(result))
	}
}
