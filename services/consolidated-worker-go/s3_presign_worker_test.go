package main

import "testing"

// Issue #141: a file attached on a Create page has no entity id yet, and the key
// used to be "{type}//{file}/original.ext", which RustFS rejects and AWS stores
// under an id-less prefix. It is staged under "_new" until the reconcile job
// (docs/notes/FILE_RECONCILE_DESIGN.md) moves it to its record.
func TestOriginalObjectKey(t *testing.T) {
	cases := []struct {
		entityType, entityID, fileID, ext, want string
	}{
		{"issues", "42", "f1", ".jpg", "issues/42/f1/original.jpg"},
		{"issues", "", "f1", ".pdf", "issues/_new/f1/original.pdf"},
		{"issues", "   ", "f1", ".png", "issues/_new/f1/original.png"},
	}
	for _, c := range cases {
		if got := originalObjectKey(c.entityType, c.entityID, c.fileID, c.ext); got != c.want {
			t.Errorf("originalObjectKey(%q, %q, %q, %q) = %q, want %q", c.entityType, c.entityID, c.fileID, c.ext, got, c.want)
		}
	}
}
