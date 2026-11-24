package main

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

// Issue #147: the scheduler inserted executions with hand-written SQL whose
// ON CONFLICT (kind, unique_key) relied on River's legacy unique index, which
// also blocks other unique jobs (schema parsing) while a completed one is kept.
// Executions now go through the River client with River's own unique options.

func TestScheduledJobExecuteArgs_UniqueOpts(t *testing.T) {
	opts := ScheduledJobExecuteArgs{}.InsertOpts()
	if !opts.UniqueOpts.ByArgs {
		t.Fatal("UniqueOpts.ByArgs = false, want true (one execution per job and scheduled time)")
	}
	// Every state, as the legacy index enforced: a run that completed, failed for good
	// or was cancelled must not be queued again for the same scheduled time.
	want := []string{"available", "cancelled", "completed", "discarded", "pending", "retryable", "running", "scheduled"}
	var got []string
	for _, s := range opts.UniqueOpts.ByState {
		got = append(got, string(s))
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("UniqueOpts.ByState = %v, want %v", got, want)
	}
	if opts.Queue != "scheduled_jobs" {
		t.Fatalf("Queue = %q, want scheduled_jobs", opts.Queue)
	}
}

func TestScheduledJobExecuteArgs_UniqueFields(t *testing.T) {
	// Only the job and its scheduled time identify an execution; a catch-up and a
	// regular tick for the same time are duplicates.
	typ := reflect.TypeOf(ScheduledJobExecuteArgs{})
	var unique []string
	for i := 0; i < typ.NumField(); i++ {
		if typ.Field(i).Tag.Get("river") == "unique" {
			unique = append(unique, typ.Field(i).Name)
		}
	}
	if want := []string{"JobID", "ScheduledFor"}; !reflect.DeepEqual(unique, want) {
		t.Fatalf(`fields tagged river:"unique" = %v, want %v`, unique, want)
	}
}

type fakeInserter struct {
	args   []river.JobArgs
	result *rivertype.JobInsertResult
	err    error
}

func (f *fakeInserter) Insert(_ context.Context, args river.JobArgs, _ *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	f.args = append(f.args, args)
	return f.result, f.err
}

func TestQueueExecuteJob_InsertsThroughRiver(t *testing.T) {
	due := time.Date(2026, 11, 24, 3, 0, 0, 0, time.UTC)
	sj := ScheduledJobRow{ID: 7, Name: "nightly", FunctionName: "do_nightly"}

	ins := &fakeInserter{result: &rivertype.JobInsertResult{Job: &rivertype.JobRow{ID: 1}}}
	s := &ScheduledJobScheduler{inserter: ins}
	queued, err := s.queueExecuteJob(context.Background(), sj, due, "scheduler")
	if err != nil || !queued {
		t.Fatalf("queueExecuteJob = (%v, %v), want (true, nil)", queued, err)
	}
	want := ScheduledJobExecuteArgs{JobID: 7, JobName: "nightly", FunctionName: "do_nightly", ScheduledFor: due, TriggeredBy: "scheduler"}
	if len(ins.args) != 1 || ins.args[0] != want {
		t.Fatalf("inserted %v, want [%v]", ins.args, want)
	}

	dup := &fakeInserter{result: &rivertype.JobInsertResult{Job: &rivertype.JobRow{ID: 1}, UniqueSkippedAsDuplicate: true}}
	s = &ScheduledJobScheduler{inserter: dup}
	if queued, err = s.queueExecuteJob(context.Background(), sj, due, "catchup"); err != nil || queued {
		t.Fatalf("duplicate: queueExecuteJob = (%v, %v), want (false, nil)", queued, err)
	}

	failing := &fakeInserter{err: errors.New("boom")}
	s = &ScheduledJobScheduler{inserter: failing}
	if _, err = s.queueExecuteJob(context.Background(), sj, due, "scheduler"); err == nil {
		t.Fatal("queueExecuteJob returned no error when the insert failed")
	}
}
