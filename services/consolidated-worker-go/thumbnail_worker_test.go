package main

import (
	"testing"
)

// ============================================================================
// isPDFType Tests
// ============================================================================

// TestIsPDFType verifies that isPDFType correctly identifies PDF MIME types.
// Bug fix: the worker previously compared fileType == "pdf" but the database
// stores full MIME types from the browser (e.g., "application/pdf"), causing
// PDFs to be processed as images and fail with "Unsupported image format".
func TestIsPDFType(t *testing.T) {
	tests := []struct {
		name     string
		fileType string
		want     bool
	}{
		// PDF types — should all return true
		{"full MIME type", "application/pdf", true},
		{"legacy MIME type", "application/x-pdf", true},
		{"short name", "pdf", true},
		{"uppercase MIME", "APPLICATION/PDF", true},
		{"mixed case", "Application/Pdf", true},
		{"with whitespace", " application/pdf ", true},

		// Non-PDF types — should all return false
		{"jpeg image", "image/jpeg", false},
		{"png image", "image/png", false},
		{"generic image", "image/*", false},
		{"empty string", "", false},
		{"plain text", "text/plain", false},
		{"word doc", "application/msword", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isPDFType(tt.fileType)
			if got != tt.want {
				t.Errorf("isPDFType(%q) = %v, want %v", tt.fileType, got, tt.want)
			}
		})
	}
}
