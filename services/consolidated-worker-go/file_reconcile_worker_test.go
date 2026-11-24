// Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.

package main

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"
	"time"
)

// Issue #141: staged Create-page uploads are claimed for their record by FileReconcileCron
// (docs/notes/FILE_RECONCILE_DESIGN.md). These tests cover the key mapping, the config and
// the copy -> claim -> delete sequence over fakes of the database and S3.

func TestClaimedKeys(t *testing.T) {
	cases := []struct {
		name string
		in   fileKeys
		want fileKeys
	}{
		{
			"staged image with three JPEG thumbnails",
			fileKeys{"Issue/_new/f1/original.png", "Issue/_new/f1/thumb-small.jpg", "Issue/_new/f1/thumb-medium.jpg", "Issue/_new/f1/thumb-large.jpg"},
			fileKeys{"Issue/42/f1/original.png", "Issue/42/f1/thumb-small.jpg", "Issue/42/f1/thumb-medium.jpg", "Issue/42/f1/thumb-large.jpg"},
		},
		{
			"staged PDF with a PNG medium thumbnail only",
			fileKeys{Original: "Issue/_new/f1/original.pdf", Medium: "Issue/_new/f1/thumb-medium.png"},
			fileKeys{Original: "Issue/42/f1/original.pdf", Medium: "Issue/42/f1/thumb-medium.png"},
		},
		{
			"legacy id-less key from before v0.86.5",
			fileKeys{Original: "Issue//f1/original.jpg", Small: "Issue//f1/thumb-small.jpg"},
			fileKeys{Original: "Issue/42/f1/original.jpg", Small: "Issue/42/f1/thumb-small.jpg"},
		},
		{
			"file without extension",
			fileKeys{Original: "Issue/_new/f1/original.bin"},
			fileKeys{Original: "Issue/42/f1/original.bin"},
		},
	}
	for _, c := range cases {
		if got := claimedKeys("Issue", "42", "f1", c.in); got != c.want {
			t.Errorf("%s: claimedKeys = %+v, want %+v", c.name, got, c.want)
		}
	}
	// The owner's table decides the folder, not the type the file was uploaded for.
	got := claimedKeys("WorkPackage", "7", "f1", fileKeys{Original: "Issue/_new/f1/original.png"})
	if got.Original != "WorkPackage/7/f1/original.png" {
		t.Errorf("claimedKeys for another table = %q", got.Original)
	}
}

func TestStagedFileID(t *testing.T) {
	ok := map[string]string{
		"Issue/_new/0190a1b2-0000-7000-8000-000000000001/original.png":    "0190a1b2-0000-7000-8000-000000000001",
		"WorkPackage/_new/0190a1b2-0000-7000-8000-000000000002/thumb.jpg": "0190a1b2-0000-7000-8000-000000000002",
	}
	for key, want := range ok {
		if got, found := stagedFileID(key); !found || got != want {
			t.Errorf("stagedFileID(%q) = %q, %v", key, got, found)
		}
	}
	for _, key := range []string{"Issue/42/f1/original.png", "Issue/_new/f1", "_new/f1/original.png", "/_new/f1/x", "Issue/_new//x"} {
		if _, found := stagedFileID(key); found {
			t.Errorf("stagedFileID(%q) matched", key)
		}
	}
}

func TestCopySource(t *testing.T) {
	if got := copySource("civic-os-files", "Work Package/_new/f1/original.png"); got != "civic-os-files/Work%20Package/_new/f1/original.png" {
		t.Errorf("copySource = %q", got)
	}
}

func TestIsUUID(t *testing.T) {
	if !isUUID("0190a1b2-0000-7000-8000-00000000000A") {
		t.Error("uuid rejected")
	}
	for _, s := range []string{"", "f1", "0190a1b2-0000-7000-8000-00000000000", "0190a1b2x0000-7000-8000-000000000001", "0190a1b2-0000-7000-8000-00000000000g"} {
		if isUUID(s) {
			t.Errorf("isUUID(%q) = true", s)
		}
	}
}

func TestFileReconcileConfig(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cases := []struct {
		vars          map[string]string
		interval, ttl time.Duration
	}{
		{map[string]string{}, 5 * time.Minute, 168 * time.Hour},
		{map[string]string{"FILE_RECONCILE_INTERVAL": "30s", "FILE_ORPHAN_TTL": "48h"}, 30 * time.Second, 48 * time.Hour},
		{map[string]string{"FILE_RECONCILE_INTERVAL": "0"}, 0, 168 * time.Hour},
		{map[string]string{"FILE_RECONCILE_INTERVAL": "0s"}, 0, 168 * time.Hour},
		{map[string]string{"FILE_RECONCILE_INTERVAL": "soon", "FILE_ORPHAN_TTL": "weekly"}, 5 * time.Minute, 168 * time.Hour},
		{map[string]string{"FILE_RECONCILE_INTERVAL": "-1m", "FILE_ORPHAN_TTL": "10m"}, 5 * time.Minute, 168 * time.Hour},
	}
	for _, c := range cases {
		interval, ttl := fileReconcileConfig(env(c.vars))
		if interval != c.interval || ttl != c.ttl {
			t.Errorf("fileReconcileConfig(%v) = %s, %s; want %s, %s", c.vars, interval, ttl, c.interval, c.ttl)
		}
	}
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type fakeReconcileDB struct {
	refs          []unclaimedReference
	claimOutcome  string
	claimErr      error
	claims        []fileKeys
	orphans       []orphanedFile
	orphanTTL     time.Duration
	states        map[string]bool
	stateIDs      []string
	uploadsPurged int
}

func (f *fakeReconcileDB) UnclaimedReferences(context.Context, int) ([]unclaimedReference, error) {
	return f.refs, nil
}
func (f *fakeReconcileDB) ClaimFile(_ context.Context, _ unclaimedReference, keys fileKeys) (string, error) {
	f.claims = append(f.claims, keys)
	return f.claimOutcome, f.claimErr
}
func (f *fakeReconcileDB) DeleteOrphanedStagedFiles(_ context.Context, ttl time.Duration, _ int) ([]orphanedFile, error) {
	f.orphanTTL = ttl
	return f.orphans, nil
}
func (f *fakeReconcileDB) StagedFileStates(_ context.Context, ids []string) (map[string]bool, error) {
	f.stateIDs = ids
	return f.states, nil
}
func (f *fakeReconcileDB) DeleteStaleUploadRequests(context.Context, time.Duration) (int, error) {
	return f.uploadsPurged, nil
}

type fakeObjectStore struct {
	objects map[string]time.Time
	failOn  map[string]bool
	ops     []string
}

func newFakeStore(keys ...string) *fakeObjectStore {
	s := &fakeObjectStore{objects: map[string]time.Time{}, failOn: map[string]bool{}}
	for _, k := range keys {
		s.objects[k] = time.Time{}
	}
	return s
}
func (s *fakeObjectStore) Copy(_ context.Context, _ string, from, to string) error {
	s.ops = append(s.ops, "copy "+from+" -> "+to)
	if s.failOn[from] {
		return errors.New("copy failed")
	}
	if _, ok := s.objects[from]; !ok {
		return errors.New("no such key")
	}
	s.objects[to] = s.objects[from]
	return nil
}
func (s *fakeObjectStore) Delete(_ context.Context, _ string, key string) error {
	s.ops = append(s.ops, "delete "+key)
	delete(s.objects, key)
	return nil
}
func (s *fakeObjectStore) ListStaged(context.Context, string, int) ([]stagedObject, error) {
	out := []stagedObject{}
	for k, m := range s.objects {
		if _, ok := stagedFileID(k); ok {
			out = append(out, stagedObject{Key: k, LastModified: m})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}
func (s *fakeObjectStore) keys() []string {
	out := []string{}
	for k := range s.objects {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

const fid = "0190a1b2-0000-7000-8000-000000000001"

func stagedRef() unclaimedReference {
	return unclaimedReference{
		FileID: fid, Table: "Issue", Column: "photo", EntityID: "42", Bucket: "b",
		Keys: fileKeys{Original: "Issue/_new/" + fid + "/original.png", Small: "Issue/_new/" + fid + "/thumb-small.jpg"},
	}
}

// stagedRow is the state of the file's row while it is still staged: the stray sweep leaves its objects alone.
func stagedRow() map[string]bool { return map[string]bool{fid: false} }

func newCron(db *fakeReconcileDB, store *fakeObjectStore) *FileReconcileCron {
	return &FileReconcileCron{db: db, store: store, bucket: "b", interval: time.Minute, ttl: 168 * time.Hour,
		now: func() time.Time { return time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC) }}
}

// ---------------------------------------------------------------------------
// Claim sequence
// ---------------------------------------------------------------------------

func TestClaimMovesObjectsToTheRecordFolder(t *testing.T) {
	ref := stagedRef()
	store := newFakeStore(ref.Keys.Original, ref.Keys.Small)
	db := &fakeReconcileDB{refs: []unclaimedReference{ref}, claimOutcome: "claimed"}
	st := newCron(db, store).RunTick(context.Background())

	if st.Claimed != 1 || st.Errors != 0 {
		t.Fatalf("stats = %+v", st)
	}
	want := []string{"Issue/42/" + fid + "/original.png", "Issue/42/" + fid + "/thumb-small.jpg"}
	if got := store.keys(); !reflect.DeepEqual(got, want) {
		t.Errorf("objects after claim = %v, want %v", got, want)
	}
	if len(db.claims) != 1 || db.claims[0].Original != want[0] || db.claims[0].Small != want[1] || db.claims[0].Medium != "" {
		t.Errorf("claim keys = %+v", db.claims)
	}
	// copy, copy, then the old objects are deleted only after the claim
	if store.ops[0][:4] != "copy" || store.ops[1][:4] != "copy" || store.ops[2][:6] != "delete" {
		t.Errorf("ops = %v", store.ops)
	}
}

func TestClaimConflictsDeleteTheCopiesAndNeverTheOriginals(t *testing.T) {
	for _, outcome := range []string{"stale", "unreferenced"} {
		ref := stagedRef()
		store := newFakeStore(ref.Keys.Original, ref.Keys.Small)
		db := &fakeReconcileDB{refs: []unclaimedReference{ref}, claimOutcome: outcome, states: stagedRow()}
		newCron(db, store).RunTick(context.Background())
		if got, want := store.keys(), []string{ref.Keys.Original, ref.Keys.Small}; !reflect.DeepEqual(got, want) {
			t.Errorf("%s: objects = %v, want the originals only %v", outcome, got, want)
		}
	}
}

func TestClaimedElsewhereKeepsTheCopies(t *testing.T) {
	// Another worker claimed the file to the same keys: those copies are its live objects.
	ref := stagedRef()
	store := newFakeStore(ref.Keys.Original, ref.Keys.Small)
	db := &fakeReconcileDB{refs: []unclaimedReference{ref}, claimOutcome: "claimed_elsewhere", states: stagedRow()}
	st := newCron(db, store).RunTick(context.Background())
	if st.ClaimedElsewhere != 1 {
		t.Fatalf("stats = %+v", st)
	}
	for _, k := range []string{"Issue/42/" + fid + "/original.png", "Issue/42/" + fid + "/thumb-small.jpg"} {
		if _, ok := store.objects[k]; !ok {
			t.Errorf("copy %s was deleted", k)
		}
	}
}

func TestClaimErrorDeletesTheCopies(t *testing.T) {
	ref := stagedRef()
	store := newFakeStore(ref.Keys.Original, ref.Keys.Small)
	db := &fakeReconcileDB{refs: []unclaimedReference{ref}, claimErr: errors.New("db down"), states: stagedRow()}
	st := newCron(db, store).RunTick(context.Background())
	if st.Errors != 1 {
		t.Fatalf("stats = %+v", st)
	}
	if got, want := store.keys(), []string{ref.Keys.Original, ref.Keys.Small}; !reflect.DeepEqual(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
}

func TestCopyFailureStopsBeforeTheClaim(t *testing.T) {
	ref := stagedRef()
	store := newFakeStore(ref.Keys.Original, ref.Keys.Small)
	store.failOn[ref.Keys.Small] = true
	db := &fakeReconcileDB{refs: []unclaimedReference{ref}, claimOutcome: "claimed", states: stagedRow()}
	st := newCron(db, store).RunTick(context.Background())
	if st.CopyFailed != 1 || len(db.claims) != 0 {
		t.Fatalf("stats = %+v, claims = %v", st, db.claims)
	}
	if got, want := store.keys(), []string{ref.Keys.Original, ref.Keys.Small}; !reflect.DeepEqual(got, want) {
		t.Errorf("objects = %v, want the originals only %v", got, want)
	}
}

// ---------------------------------------------------------------------------
// Orphans, stray objects, upload requests
// ---------------------------------------------------------------------------

func TestOrphansAreDeletedWithTheirObjects(t *testing.T) {
	orphan := orphanedFile{FileID: fid, Bucket: "b", Keys: fileKeys{Original: "Issue/_new/" + fid + "/original.pdf", Medium: "Issue/_new/" + fid + "/thumb-medium.png"}}
	store := newFakeStore(orphan.Keys.Original, orphan.Keys.Medium, "Issue/42/other/original.png")
	db := &fakeReconcileDB{orphans: []orphanedFile{orphan}, states: map[string]bool{}}
	c := newCron(db, store)
	st := c.RunTick(context.Background())
	if st.OrphansDeleted != 1 {
		t.Fatalf("stats = %+v", st)
	}
	if db.orphanTTL != c.ttl {
		t.Errorf("orphan TTL passed = %s", db.orphanTTL)
	}
	if got := store.keys(); !reflect.DeepEqual(got, []string{"Issue/42/other/original.png"}) {
		t.Errorf("objects = %v", got)
	}
}

func TestStrayObjectSweep(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	staged := "0190a1b2-0000-7000-8000-00000000000a"
	claimed := "0190a1b2-0000-7000-8000-00000000000b"
	goneOld := "0190a1b2-0000-7000-8000-00000000000c"
	goneNew := "0190a1b2-0000-7000-8000-00000000000d"
	store := newFakeStore()
	store.objects["Issue/_new/"+staged+"/original.png"] = now.Add(-30 * 24 * time.Hour)
	store.objects["Issue/_new/"+claimed+"/original.png"] = now.Add(-time.Minute)
	store.objects["Issue/_new/"+goneOld+"/original.png"] = now.Add(-8 * 24 * time.Hour)
	store.objects["Issue/_new/"+goneNew+"/original.png"] = now.Add(-time.Hour)
	store.objects["Issue/42/"+claimed+"/original.png"] = now
	db := &fakeReconcileDB{states: map[string]bool{staged: false, claimed: true}}
	st := newCron(db, store).RunTick(context.Background())

	if st.StrayObjectsDeleted != 2 {
		t.Fatalf("stats = %+v", st)
	}
	want := []string{
		"Issue/42/" + claimed + "/original.png",   // the claimed file's live object
		"Issue/_new/" + staged + "/original.png",  // still staged: owned by its row, however old
		"Issue/_new/" + goneNew + "/original.png", // no row yet, younger than the TTL: an upload may be finishing
	}
	sort.Strings(want)
	if got := store.keys(); !reflect.DeepEqual(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
	if len(db.stateIDs) != 4 {
		t.Errorf("states asked for %v", db.stateIDs)
	}
}

func TestQuietTickAndUploadRequests(t *testing.T) {
	db := &fakeReconcileDB{states: map[string]bool{}, uploadsPurged: 3}
	st := newCron(db, newFakeStore()).RunTick(context.Background())
	if st != (tickStats{UploadRequestsDeleted: 3}) {
		t.Errorf("stats = %+v", st)
	}
	if st := newCron(&fakeReconcileDB{}, newFakeStore()).RunTick(context.Background()); st != (tickStats{}) {
		t.Errorf("quiet tick stats = %+v", st)
	}
}

func TestDisabledCronNeverStarts(t *testing.T) {
	c := &FileReconcileCron{interval: 0}
	c.Start(context.Background())
	if c.done != nil {
		t.Error("a disabled cron started its goroutine")
	}
	c.Stop()
}
