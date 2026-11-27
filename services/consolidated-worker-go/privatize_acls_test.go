package main

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type fakeACLSource struct {
	files []aclFile // sorted by ID
	calls []string
	err   error
}

func (f *fakeACLSource) PrivateFilesAfter(_ context.Context, after string, limit int) ([]aclFile, error) {
	f.calls = append(f.calls, after)
	if f.err != nil {
		return nil, f.err
	}
	var out []aclFile
	for _, file := range f.files {
		if file.ID > after && len(out) < limit {
			out = append(out, file)
		}
	}
	return out, nil
}

type fakeACLStore struct {
	set     map[string]types.ObjectCannedACL
	missing map[string]bool
	fail    map[string]bool
}

func (f *fakeACLStore) PutACL(_ context.Context, bucket, key string, acl types.ObjectCannedACL) error {
	if f.missing[key] {
		return errNoSuchKey
	}
	if f.fail[key] {
		return errors.New("boom")
	}
	f.set[bucket+"/"+key] = acl
	return nil
}

func aclFixture() *fakeACLSource {
	return &fakeACLSource{files: []aclFile{
		{ID: "a1", Bucket: "b", Keys: []string{"Issue/1/a1/original.png", "Issue/1/a1/thumb-small.jpg"}},
		{ID: "a2", Bucket: "b", Keys: []string{"Issue/2/a2/original.pdf"}},
		{ID: "a3", Bucket: "b", Keys: []string{"Issue/3/a3/original.bin"}},
	}}
}

func TestPrivatizeACLs_SetsEveryObjectInBatches(t *testing.T) {
	src := aclFixture()
	store := &fakeACLStore{set: map[string]types.ObjectCannedACL{}}
	var out bytes.Buffer
	res, err := privatizeACLs(context.Background(), src, store, privatizeOptions{ACL: types.ObjectCannedACLPrivate, Batch: 2}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 3 || res.Objects != 4 || res.LastID != "a3" {
		t.Errorf("result = %+v", res)
	}
	keys := make([]string, 0, len(store.set))
	for k, v := range store.set {
		if v != types.ObjectCannedACLPrivate {
			t.Errorf("%s = %s", k, v)
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) != 4 {
		t.Errorf("keys = %v", keys)
	}
	// batches resume after the last id of the previous one
	if strings.Join(src.calls, ",") != ",a2,a3" {
		t.Errorf("calls = %v", src.calls)
	}
	if !strings.Contains(out.String(), "resume with --after a3") {
		t.Errorf("out = %q", out.String())
	}
}

func TestPrivatizeACLs_DryRunChangesNothing(t *testing.T) {
	store := &fakeACLStore{set: map[string]types.ObjectCannedACL{}}
	res, err := privatizeACLs(context.Background(), aclFixture(), store, privatizeOptions{DryRun: true, ACL: types.ObjectCannedACLPrivate, Batch: 10}, &bytes.Buffer{})
	if err != nil || res.Objects != 4 || len(store.set) != 0 {
		t.Errorf("res = %+v, err = %v, set = %v", res, err, store.set)
	}
}

func TestPrivatizeACLs_ResumesAfterID(t *testing.T) {
	src := aclFixture()
	store := &fakeACLStore{set: map[string]types.ObjectCannedACL{}}
	res, _ := privatizeACLs(context.Background(), src, store, privatizeOptions{ACL: types.ObjectCannedACLPublicRead, After: "a1", Batch: 10}, &bytes.Buffer{})
	if res.Files != 2 || store.set["b/Issue/1/a1/original.png"] != "" || store.set["b/Issue/2/a2/original.pdf"] != types.ObjectCannedACLPublicRead {
		t.Errorf("res = %+v set = %v", res, store.set)
	}
}

func TestPrivatizeACLs_CountsMissingAndFailedAndContinues(t *testing.T) {
	store := &fakeACLStore{
		set:     map[string]types.ObjectCannedACL{},
		missing: map[string]bool{"Issue/1/a1/thumb-small.jpg": true},
		fail:    map[string]bool{"Issue/2/a2/original.pdf": true},
	}
	var out bytes.Buffer
	res, err := privatizeACLs(context.Background(), aclFixture(), store, privatizeOptions{ACL: types.ObjectCannedACLPrivate, Batch: 10}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if res.Missing != 1 || res.Failed != 1 || res.Objects != 2 || res.Files != 3 {
		t.Errorf("res = %+v", res)
	}
	if !strings.Contains(out.String(), "failed: file a2 object Issue/2/a2/original.pdf") {
		t.Errorf("out = %q", out.String())
	}
}

func TestPrivatizeACLs_StopsOnReadError(t *testing.T) {
	src := &fakeACLSource{err: errors.New("db down")}
	_, err := privatizeACLs(context.Background(), src, &fakeACLStore{set: map[string]types.ObjectCannedACL{}}, privatizeOptions{ACL: types.ObjectCannedACLPrivate, Batch: 10}, &bytes.Buffer{})
	if err == nil {
		t.Fatal("want an error")
	}
}

func TestThumbnailPutInput_ACLFollowsIsPublic(t *testing.T) {
	if in := thumbnailPutInput("b", "k/thumb-small.jpg", []byte("x"), false); in.ACL != "" || *in.ContentType != "image/jpeg" {
		t.Errorf("private thumbnail: ACL %q, type %q", in.ACL, *in.ContentType)
	}
	if in := thumbnailPutInput("b", "k/thumb-small.png", []byte("x"), true); in.ACL != types.ObjectCannedACLPublicRead || *in.ContentType != "image/png" {
		t.Errorf("public thumbnail: ACL %q, type %q", in.ACL, *in.ContentType)
	}
}

func TestReconcileCopyInput_IsPrivate(t *testing.T) {
	in := reconcileCopyInput("b", "Issue/_new/x/original.png", "Issue/1/x/original.png")
	if in.ACL != "" || *in.Key != "Issue/1/x/original.png" {
		t.Errorf("copy input = %+v", in)
	}
}
