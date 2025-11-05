package main

import (
	"testing"

	"github.com/riverqueue/river"
)

// ============================================================================
// Tests for S3PresignArgs Job Definition
// ============================================================================

func TestS3PresignArgs_Kind(t *testing.T) {
	args := S3PresignArgs{
		RequestID:  "test-request-123",
		FileName:   "test-image.jpg",
		FileType:   "image/jpeg",
		EntityType: "Issue",
		EntityID:   "42",
	}

	expectedKind := "s3_presign"
	actualKind := args.Kind()

	if actualKind != expectedKind {
		t.Errorf("Expected Kind() = %q, got %q", expectedKind, actualKind)
	}
}

func TestS3PresignArgs_InsertOpts(t *testing.T) {
	args := S3PresignArgs{}
	opts := args.InsertOpts()

	// Verify queue name
	if opts.Queue != "s3_signer" {
		t.Errorf("Expected Queue = %q, got %q", "s3_signer", opts.Queue)
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
// Tests for getEnv Utility
// ============================================================================

func TestGetEnv_WithExistingValue(t *testing.T) {
	// Set a test environment variable
	key := "TEST_VAR_EXISTS"
	expectedValue := "test-value"
	t.Setenv(key, expectedValue)

	actualValue := getEnv(key, "default-value")

	if actualValue != expectedValue {
		t.Errorf("Expected getEnv(%q) = %q, got %q", key, expectedValue, actualValue)
	}
}

func TestGetEnv_WithMissingValue(t *testing.T) {
	key := "TEST_VAR_MISSING"
	defaultValue := "default-value"

	actualValue := getEnv(key, defaultValue)

	if actualValue != defaultValue {
		t.Errorf("Expected getEnv(%q) = %q (default), got %q", key, defaultValue, actualValue)
	}
}

// ============================================================================
// Tests for S3PresignWorker (Unit Tests with Mocks)
// ============================================================================

// Note: Full integration tests would require AWS credentials and PostgreSQL.
// These are basic structural tests to ensure the worker implements River's interface correctly.

func TestS3PresignWorker_ImplementsWorkerInterface(t *testing.T) {
	// Verify that S3PresignWorker satisfies River's Worker interface
	// This is a compile-time check - if this compiles, the interface is satisfied
	var _ river.Worker[S3PresignArgs] = &S3PresignWorker{}
}

// Note: Full integration tests for Work() method would require:
// - Real or mocked AWS S3 client
// - Real or mocked PostgreSQL connection
// - Test fixtures for River job execution
// These are better suited for integration test suite or Docker-based testing

// ============================================================================
// Helper Functions for Tests
// ============================================================================

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) && containsAt(s, substr, 0))
}

func containsAt(s, substr string, offset int) bool {
	for i := offset; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// ============================================================================
// Benchmark Tests
// ============================================================================

func BenchmarkS3PresignArgs_Kind(b *testing.B) {
	args := S3PresignArgs{
		RequestID:  "test-request-123",
		FileName:   "test-image.jpg",
		FileType:   "image/jpeg",
		EntityType: "Issue",
		EntityID:   "42",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = args.Kind()
	}
}

func BenchmarkS3PresignArgs_InsertOpts(b *testing.B) {
	args := S3PresignArgs{}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = args.InsertOpts()
	}
}
