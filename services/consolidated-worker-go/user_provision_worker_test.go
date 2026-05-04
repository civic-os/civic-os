package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ============================================================================
// Helper: mock Keycloak server for CreateUser tests
// ============================================================================

// newCreateUserServer creates a mock Keycloak server that:
// - Responds to token requests
// - Captures the POST /users body for assertions
// - Returns the configured status code and Location header
func newCreateUserServer(statusCode int, locationHeader string, capturedPOST *map[string]interface{}) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Token endpoint
		if r.URL.Path == "/realms/test-realm/protocol/openid-connect/token" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "test-token",
				"expires_in":   300,
				"token_type":   "Bearer",
			})
			return
		}

		// POST /users — capture body and return configured response
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/users") {
			body, _ := io.ReadAll(r.Body)
			var parsed map[string]interface{}
			json.Unmarshal(body, &parsed)
			*capturedPOST = parsed

			if locationHeader != "" {
				w.Header().Set("Location", locationHeader)
			}
			w.WriteHeader(statusCode)
			if statusCode == http.StatusConflict {
				w.Write([]byte(`{"errorMessage":"User exists with same email"}`))
			}
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
}

// ============================================================================
// CreateUser Keycloak API Tests
// ============================================================================

// TestCreateUserPayload verifies the POST /users JSON payload includes
// firstName and lastName as separate fields alongside email and username.
func TestCreateUserPayload(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newCreateUserServer(
		http.StatusCreated,
		"http://localhost/admin/realms/test-realm/users/abc-uuid-123",
		&capturedBody,
	)
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	userID, err := kc.CreateUser(context.Background(), "jane@test.com", "Jane", "Doe", "5551234567")

	if err != nil {
		t.Fatalf("CreateUser returned error: %v", err)
	}
	if userID != "abc-uuid-123" {
		t.Errorf("expected userID=abc-uuid-123, got %s", userID)
	}

	// Verify name fields
	if capturedBody["firstName"] != "Jane" {
		t.Errorf("expected firstName=Jane, got %v", capturedBody["firstName"])
	}
	if capturedBody["lastName"] != "Doe" {
		t.Errorf("expected lastName=Doe, got %v", capturedBody["lastName"])
	}
	if capturedBody["email"] != "jane@test.com" {
		t.Errorf("expected email=jane@test.com, got %v", capturedBody["email"])
	}
	if capturedBody["username"] != "jane@test.com" {
		t.Errorf("expected username=jane@test.com, got %v", capturedBody["username"])
	}
	if capturedBody["enabled"] != true {
		t.Errorf("expected enabled=true, got %v", capturedBody["enabled"])
	}
	if capturedBody["emailVerified"] != true {
		t.Errorf("expected emailVerified=true, got %v", capturedBody["emailVerified"])
	}

	// Verify phone attribute is set
	attrs, ok := capturedBody["attributes"].(map[string]interface{})
	if !ok {
		t.Fatal("expected attributes map in payload when phone is provided")
	}
	phoneArr, ok := attrs["phoneNumber"].([]interface{})
	if !ok {
		t.Fatal("expected phoneNumber array in attributes")
	}
	if len(phoneArr) != 1 || phoneArr[0] != "5551234567" {
		t.Errorf("expected phoneNumber=[5551234567], got %v", phoneArr)
	}
}

// TestCreateUserPayloadWithoutPhone verifies that an empty phone string
// does not include an attributes key in the payload.
func TestCreateUserPayloadWithoutPhone(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newCreateUserServer(
		http.StatusCreated,
		"http://localhost/admin/realms/test-realm/users/def-uuid-456",
		&capturedBody,
	)
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	_, err := kc.CreateUser(context.Background(), "bob@test.com", "Bob", "Smith", "")

	if err != nil {
		t.Fatalf("CreateUser returned error: %v", err)
	}

	// Verify name fields still present
	if capturedBody["firstName"] != "Bob" {
		t.Errorf("expected firstName=Bob, got %v", capturedBody["firstName"])
	}
	if capturedBody["lastName"] != "Smith" {
		t.Errorf("expected lastName=Smith, got %v", capturedBody["lastName"])
	}

	// Verify no attributes key when phone is empty
	if _, ok := capturedBody["attributes"]; ok {
		t.Error("expected no attributes key when phone is empty")
	}
}

// TestCreateUserConflict verifies that a 409 Conflict response is handled
// correctly with an appropriate error message.
func TestCreateUserConflict(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newCreateUserServer(http.StatusConflict, "", &capturedBody)
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	_, err := kc.CreateUser(context.Background(), "existing@test.com", "Existing", "User", "")

	if err == nil {
		t.Fatal("expected error for 409 Conflict, got nil")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("expected error to mention 'already exists', got: %v", err)
	}
}

// TestCreateUserExtractsUUID verifies UUID extraction from the Location header.
func TestCreateUserExtractsUUID(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newCreateUserServer(
		http.StatusCreated,
		"http://keycloak:8080/admin/realms/my-realm/users/550e8400-e29b-41d4-a716-446655440000",
		&capturedBody,
	)
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	userID, err := kc.CreateUser(context.Background(), "uuid@test.com", "UUID", "Test", "")

	if err != nil {
		t.Fatalf("CreateUser returned error: %v", err)
	}
	if userID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("expected extracted UUID, got %s", userID)
	}
}

// ============================================================================
// formatPublicDisplayName Tests
// ============================================================================

// TestFormatPublicDisplayName uses table-driven tests to verify the Go mirror
// of the SQL format_public_display_name() function.
func TestFormatPublicDisplayName(t *testing.T) {
	tests := []struct {
		firstName string
		lastName  string
		expected  string
	}{
		{"Jane", "Doe", "Jane D."},
		{"Jane", "", "Jane"},
		{"", "Doe", "D."},
		{"", "", "User"},
		{"María", "García", "María G."},
		{"  Jane  ", "  Doe  ", "Jane D."}, // whitespace trimmed
		{"Alice", "O'Brien", "Alice O."},   // special chars
		{"Li", "Wei", "Li W."},             // short names
	}

	for _, tc := range tests {
		t.Run(tc.firstName+"_"+tc.lastName, func(t *testing.T) {
			got := formatPublicDisplayName(tc.firstName, tc.lastName)
			if got != tc.expected {
				t.Errorf("formatPublicDisplayName(%q, %q) = %q, want %q",
					tc.firstName, tc.lastName, got, tc.expected)
			}
		})
	}
}

// ============================================================================
// ProvisionUserArgs Tests
// ============================================================================

// TestProvisionUserArgsKind verifies the River job kind string.
func TestProvisionUserArgsKind(t *testing.T) {
	args := ProvisionUserArgs{}
	if args.Kind() != "provision_keycloak_user" {
		t.Errorf("expected kind=provision_keycloak_user, got %s", args.Kind())
	}
}

// TestProvisionUserArgsInsertOpts verifies queue, max attempts, and priority.
func TestProvisionUserArgsInsertOpts(t *testing.T) {
	args := ProvisionUserArgs{}
	opts := args.InsertOpts()

	if opts.Queue != "user_provisioning" {
		t.Errorf("expected queue=user_provisioning, got %s", opts.Queue)
	}
	if opts.MaxAttempts != 5 {
		t.Errorf("expected maxAttempts=5, got %d", opts.MaxAttempts)
	}
	if opts.Priority != 1 {
		t.Errorf("expected priority=1, got %d", opts.Priority)
	}
}
