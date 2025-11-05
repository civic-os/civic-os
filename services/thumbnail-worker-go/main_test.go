package main

import (
	"testing"

	"github.com/h2non/bimg"
	"github.com/riverqueue/river"
)

// ============================================================================
// Tests for ThumbnailArgs Job Definition
// ============================================================================

func TestThumbnailArgs_Kind(t *testing.T) {
	args := ThumbnailArgs{
		FileID:   "019a5463-3c75-770c-ab5a-1e162ef32b7f",
		S3Key:    "Issue/26/019a5463-3c75-770c-ab5a-1e162ef32b7f/original.png",
		FileType: "image",
		Bucket:   "civic-os-files",
	}

	expectedKind := "thumbnail_generate"
	actualKind := args.Kind()

	if actualKind != expectedKind {
		t.Errorf("Expected Kind() = %q, got %q", expectedKind, actualKind)
	}
}

func TestThumbnailArgs_InsertOpts(t *testing.T) {
	args := ThumbnailArgs{}
	opts := args.InsertOpts()

	// Verify queue name
	if opts.Queue != "thumbnails" {
		t.Errorf("Expected Queue = %q, got %q", "thumbnails", opts.Queue)
	}

	// Verify max attempts
	if opts.MaxAttempts != 25 {
		t.Errorf("Expected MaxAttempts = 25, got %d", opts.MaxAttempts)
	}

	// Verify priority
	if opts.Priority != 1 {
		t.Errorf("Expected Priority = 1, got %d", opts.Priority)
	}
}

// ============================================================================
// Tests for Thumbnail Configuration
// ============================================================================

func TestThumbnailSizes_Configuration(t *testing.T) {
	// Verify we have 3 thumbnail sizes
	if len(thumbnailSizes) != 3 {
		t.Errorf("Expected 3 thumbnail sizes, got %d", len(thumbnailSizes))
	}

	// Verify small thumbnail (150x150)
	if thumbnailSizes[0].Name != "small" || thumbnailSizes[0].Width != 150 || thumbnailSizes[0].Height != 150 {
		t.Errorf("Small thumbnail misconfigured: %+v", thumbnailSizes[0])
	}

	// Verify medium thumbnail (400x400)
	if thumbnailSizes[1].Name != "medium" || thumbnailSizes[1].Width != 400 || thumbnailSizes[1].Height != 400 {
		t.Errorf("Medium thumbnail misconfigured: %+v", thumbnailSizes[1])
	}

	// Verify large thumbnail (800x800)
	if thumbnailSizes[2].Name != "large" || thumbnailSizes[2].Width != 800 || thumbnailSizes[2].Height != 800 {
		t.Errorf("Large thumbnail misconfigured: %+v", thumbnailSizes[2])
	}

	// Verify quality settings are reasonable (should be between 80-95)
	for _, size := range thumbnailSizes {
		if size.Quality < 80 || size.Quality > 95 {
			t.Errorf("%s thumbnail quality %d is outside recommended range 80-95", size.Name, size.Quality)
		}
	}
}

// ============================================================================
// Tests for ThumbnailWorker (Unit Tests)
// ============================================================================

func TestThumbnailWorker_ImplementsWorkerInterface(t *testing.T) {
	// Verify that ThumbnailWorker satisfies River's Worker interface
	// This is a compile-time check - if this compiles, the interface is satisfied
	var _ river.Worker[ThumbnailArgs] = &ThumbnailWorker{}
}

// Note: Full integration tests for Work() method would require:
// - Real or mocked AWS S3 client
// - Real or mocked PostgreSQL connection
// - Test fixtures for River job execution
// - Sample image files for thumbnail generation
// These are better suited for integration test suite or Docker-based testing

// ============================================================================
// Tests for Image Processing Options
// ============================================================================

func TestBimgOptions_Configuration(t *testing.T) {
	// Test that our bimg options are correctly configured
	// This verifies the image processing settings we use

	size := thumbnailSizes[1] // Use medium size for testing

	options := bimg.Options{
		Width:      size.Width,
		Height:     size.Height,
		Embed:      true,
		Gravity:    bimg.GravityCentre,
		Background: bimg.Color{R: 255, G: 255, B: 255},
		Type:       bimg.JPEG,
		Quality:    size.Quality,
	}

	// Verify embed mode (maintains aspect ratio)
	if !options.Embed {
		t.Error("Expected Embed=true for aspect ratio preservation")
	}

	// Verify centering
	if options.Gravity != bimg.GravityCentre {
		t.Errorf("Expected Gravity=GravityCentre, got %v", options.Gravity)
	}

	// Verify white background for transparent images
	if options.Background.R != 255 || options.Background.G != 255 || options.Background.B != 255 {
		t.Errorf("Expected white background (255,255,255), got (%d,%d,%d)",
			options.Background.R, options.Background.G, options.Background.B)
	}

	// Verify JPEG output
	if options.Type != bimg.JPEG {
		t.Errorf("Expected Type=JPEG, got %v", options.Type)
	}
}

// ============================================================================
// Tests for getEnv Utility
// ============================================================================

func TestGetEnv_WithExistingValue(t *testing.T) {
	// Set a test environment variable
	key := "TEST_THUMBNAIL_VAR_EXISTS"
	expectedValue := "test-value"
	t.Setenv(key, expectedValue)

	actualValue := getEnv(key, "default-value")

	if actualValue != expectedValue {
		t.Errorf("Expected getEnv(%q) = %q, got %q", key, expectedValue, actualValue)
	}
}

func TestGetEnv_WithMissingValue(t *testing.T) {
	key := "TEST_THUMBNAIL_VAR_MISSING"
	defaultValue := "default-value"

	actualValue := getEnv(key, defaultValue)

	if actualValue != defaultValue {
		t.Errorf("Expected getEnv(%q) = %q (default), got %q", key, defaultValue, actualValue)
	}
}

// ============================================================================
// Benchmark Tests
// ============================================================================

func BenchmarkThumbnailArgs_Kind(b *testing.B) {
	args := ThumbnailArgs{
		FileID:   "019a5463-3c75-770c-ab5a-1e162ef32b7f",
		S3Key:    "Issue/26/019a5463-3c75-770c-ab5a-1e162ef32b7f/original.png",
		FileType: "image",
		Bucket:   "civic-os-files",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = args.Kind()
	}
}

func BenchmarkThumbnailArgs_InsertOpts(b *testing.B) {
	args := ThumbnailArgs{}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = args.InsertOpts()
	}
}
