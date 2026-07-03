package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ============================================================================
// Helper: mock Keycloak server for fetch-then-merge tests
// ============================================================================

// mockKeycloakUser returns a baseline Keycloak user for GET responses.
func mockKeycloakUser() map[string]interface{} {
	return map[string]interface{}{
		"id":            "user-uuid-123",
		"username":      "jdoe@example.com",
		"email":         "jdoe@example.com",
		"firstName":     "OldFirst",
		"lastName":      "OldLast",
		"enabled":       true,
		"emailVerified": true,
		"attributes": map[string][]string{
			"phoneNumber": {"1112223333"},
			"customAttr":  {"preserve-me"},
		},
	}
}

// newTestServer creates a mock Keycloak server that:
// - Responds to token requests
// - Returns the given user on GET /users/{id}
// - Captures the PUT body for assertions
func newTestServer(getUser map[string]interface{}, capturedPUT *map[string]interface{}) *httptest.Server {
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

		// GET /users/{id} — return mock user
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(getUser)
			return
		}

		// PUT /users/{id} — capture body
		if r.Method == "PUT" {
			body, _ := io.ReadAll(r.Body)
			var parsed map[string]interface{}
			json.Unmarshal(body, &parsed)
			*capturedPUT = parsed
			w.WriteHeader(http.StatusNoContent)
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
}

// ============================================================================
// UpdateUser Keycloak API Tests
// ============================================================================

// TestUpdateUserPayloadWithPhone verifies the PUT payload includes all preserved
// fields plus the updated firstName, lastName, email, and phoneNumber attribute.
func TestUpdateUserPayloadWithPhone(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newTestServer(mockKeycloakUser(), &capturedBody)
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.UpdateUser(context.Background(), "user-uuid-123", "newemail@example.com", "John", "Doe", "5551234567")

	if err != nil {
		t.Fatalf("UpdateUser returned error: %v", err)
	}

	// Verify updated fields
	if capturedBody["firstName"] != "John" {
		t.Errorf("expected firstName=John, got %v", capturedBody["firstName"])
	}
	if capturedBody["lastName"] != "Doe" {
		t.Errorf("expected lastName=Doe, got %v", capturedBody["lastName"])
	}
	if capturedBody["email"] != "newemail@example.com" {
		t.Errorf("expected email=newemail@example.com, got %v", capturedBody["email"])
	}

	// Verify preserved fields from GET response
	if capturedBody["enabled"] != true {
		t.Errorf("expected enabled=true (preserved), got %v", capturedBody["enabled"])
	}
	if capturedBody["emailVerified"] != true {
		t.Errorf("expected emailVerified=true (preserved), got %v", capturedBody["emailVerified"])
	}
	if capturedBody["username"] != "jdoe@example.com" {
		t.Errorf("expected username=jdoe@example.com (preserved), got %v", capturedBody["username"])
	}

	// Check phoneNumber attribute updated
	attrs, ok := capturedBody["attributes"].(map[string]interface{})
	if !ok {
		t.Fatal("expected attributes map in payload")
	}
	phoneArr, ok := attrs["phoneNumber"].([]interface{})
	if !ok {
		t.Fatal("expected phoneNumber array in attributes")
	}
	if len(phoneArr) != 1 || phoneArr[0] != "5551234567" {
		t.Errorf("expected phoneNumber=[5551234567], got %v", phoneArr)
	}

	// Check custom attribute preserved
	customArr, ok := attrs["customAttr"].([]interface{})
	if !ok {
		t.Fatal("expected customAttr array preserved in attributes")
	}
	if len(customArr) != 1 || customArr[0] != "preserve-me" {
		t.Errorf("expected customAttr=[preserve-me] (preserved), got %v", customArr)
	}
}

// TestUpdateUserPayloadWithoutPhone verifies that an empty phone string sends
// an empty phoneNumber array to clear the attribute while preserving other attributes.
func TestUpdateUserPayloadWithoutPhone(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newTestServer(mockKeycloakUser(), &capturedBody)
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.UpdateUser(context.Background(), "user-uuid-123", "jane@example.com", "Jane", "Smith", "")

	if err != nil {
		t.Fatalf("UpdateUser returned error: %v", err)
	}

	attrs, ok := capturedBody["attributes"].(map[string]interface{})
	if !ok {
		t.Fatal("expected attributes map in payload")
	}
	phoneArr, ok := attrs["phoneNumber"].([]interface{})
	if !ok {
		t.Fatal("expected phoneNumber array in attributes")
	}
	if len(phoneArr) != 0 {
		t.Errorf("expected empty phoneNumber array to clear attribute, got %v", phoneArr)
	}

	// Verify other attrs preserved
	customArr, ok := attrs["customAttr"].([]interface{})
	if !ok {
		t.Fatal("expected customAttr preserved")
	}
	if len(customArr) != 1 || customArr[0] != "preserve-me" {
		t.Errorf("expected customAttr=[preserve-me], got %v", customArr)
	}
}

// TestUpdateUserKeycloakError verifies that a non-204 response from the PUT
// is surfaced as an error from UpdateUser.
func TestUpdateUserKeycloakError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/test-realm/protocol/openid-connect/token" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "test-token",
				"expires_in":   300,
				"token_type":   "Bearer",
			})
			return
		}

		// GET returns a user, PUT returns error
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockKeycloakUser())
			return
		}

		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"User not found"}`))
	}))
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.UpdateUser(context.Background(), "nonexistent-user", "ghost@example.com", "Ghost", "User", "")

	if err == nil {
		t.Fatal("expected error for 404 response, got nil")
	}
	if got := err.Error(); got == "" {
		t.Error("expected non-empty error message")
	}
}

// TestUpdateUserGetFails verifies that a failed GET (fetch) surfaces an error.
func TestUpdateUserGetFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/test-realm/protocol/openid-connect/token" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "test-token",
				"expires_in":   300,
				"token_type":   "Bearer",
			})
			return
		}

		// GET returns 404
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"User not found"}`))
	}))
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.UpdateUser(context.Background(), "missing-user", "x@example.com", "X", "Y", "")

	if err == nil {
		t.Fatal("expected error when GET user fails, got nil")
	}
}

// ============================================================================
// DisableUser Tests
// ============================================================================

// TestDisableUserPreservesFields verifies that DisableUser sends the full user
// payload with only enabled=false changed. All other fields (name, email,
// emailVerified, attributes) must be preserved.
func TestDisableUserPreservesFields(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newTestServer(mockKeycloakUser(), &capturedBody)
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.DisableUser(context.Background(), "user-uuid-123")

	if err != nil {
		t.Fatalf("DisableUser returned error: %v", err)
	}

	// enabled must be false
	if capturedBody["enabled"] != false {
		t.Errorf("expected enabled=false, got %v", capturedBody["enabled"])
	}

	// All other fields preserved from the mock user
	if capturedBody["username"] != "jdoe@example.com" {
		t.Errorf("expected username preserved, got %v", capturedBody["username"])
	}
	if capturedBody["email"] != "jdoe@example.com" {
		t.Errorf("expected email preserved, got %v", capturedBody["email"])
	}
	if capturedBody["firstName"] != "OldFirst" {
		t.Errorf("expected firstName preserved, got %v", capturedBody["firstName"])
	}
	if capturedBody["lastName"] != "OldLast" {
		t.Errorf("expected lastName preserved, got %v", capturedBody["lastName"])
	}
	if capturedBody["emailVerified"] != true {
		t.Errorf("expected emailVerified preserved, got %v", capturedBody["emailVerified"])
	}

	// Attributes preserved
	attrs, ok := capturedBody["attributes"].(map[string]interface{})
	if !ok {
		t.Fatal("expected attributes map preserved in disable payload")
	}
	phoneArr, ok := attrs["phoneNumber"].([]interface{})
	if !ok {
		t.Fatal("expected phoneNumber attribute preserved")
	}
	if len(phoneArr) != 1 || phoneArr[0] != "1112223333" {
		t.Errorf("expected phoneNumber=[1112223333] preserved, got %v", phoneArr)
	}
}

// ============================================================================
// GetUserByID Tests
// ============================================================================

// TestGetUserByID verifies the GET /users/{id} call returns a decoded user.
func TestGetUserByID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/test-realm/protocol/openid-connect/token" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "test-token",
				"expires_in":   300,
				"token_type":   "Bearer",
			})
			return
		}

		if r.Method == "GET" && r.URL.Path == "/admin/realms/test-realm/users/test-uuid" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":            "test-uuid",
				"username":      "testuser@example.com",
				"email":         "testuser@example.com",
				"firstName":     "Test",
				"lastName":      "User",
				"enabled":       true,
				"emailVerified": true,
				"attributes": map[string][]string{
					"phoneNumber": {"9998887777"},
				},
			})
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	user, err := kc.GetUserByID(context.Background(), "test-uuid")

	if err != nil {
		t.Fatalf("GetUserByID returned error: %v", err)
	}
	if user.ID != "test-uuid" {
		t.Errorf("expected ID=test-uuid, got %s", user.ID)
	}
	if user.Email != "testuser@example.com" {
		t.Errorf("expected email=testuser@example.com, got %s", user.Email)
	}
	if !user.Enabled {
		t.Error("expected enabled=true")
	}
	if !user.EmailVerified {
		t.Error("expected emailVerified=true")
	}
	if user.Attributes == nil {
		t.Fatal("expected attributes to be populated")
	}
	if phones := user.Attributes["phoneNumber"]; len(phones) != 1 || phones[0] != "9998887777" {
		t.Errorf("expected phoneNumber=[9998887777], got %v", phones)
	}
}

// TestGetUserByIDNotFound verifies a 404 returns an error.
func TestGetUserByIDNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/test-realm/protocol/openid-connect/token" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "test-token",
				"expires_in":   300,
				"token_type":   "Bearer",
			})
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	_, err := kc.GetUserByID(context.Background(), "nonexistent")

	if err == nil {
		t.Fatal("expected error for 404, got nil")
	}
}

// ============================================================================
// UpdateKeycloakUserArgs Tests
// ============================================================================

// TestUpdateKeycloakUserArgsKind verifies the River job kind string.
func TestUpdateKeycloakUserArgsKind(t *testing.T) {
	args := UpdateKeycloakUserArgs{}
	if args.Kind() != "update_keycloak_user" {
		t.Errorf("expected kind=update_keycloak_user, got %s", args.Kind())
	}
}

// TestUpdateKeycloakUserArgsInsertOpts verifies queue, max attempts, and priority.
func TestUpdateKeycloakUserArgsInsertOpts(t *testing.T) {
	args := UpdateKeycloakUserArgs{}
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

// TestUpdateKeycloakUserArgsJSON verifies JSON serialization matches
// the field names expected by the SQL RPC's json_build_object.
// Phone is intentionally excluded — database is the authority for phone.
func TestUpdateKeycloakUserArgsJSON(t *testing.T) {
	args := UpdateKeycloakUserArgs{
		UserID:    "abc-123",
		Email:     "jane@example.com",
		FirstName: "Jane",
		LastName:  "Doe",
	}

	data, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var parsed map[string]string
	json.Unmarshal(data, &parsed)

	expected := map[string]string{
		"user_id":    "abc-123",
		"email":      "jane@example.com",
		"first_name": "Jane",
		"last_name":  "Doe",
	}

	for key, want := range expected {
		if got := parsed[key]; got != want {
			t.Errorf("JSON key %q: expected %q, got %q", key, want, got)
		}
	}

	// Verify phone is NOT in the JSON output
	if _, hasPhone := parsed["phone"]; hasPhone {
		t.Error("expected no 'phone' key in JSON output — phone is managed by database, not Keycloak sync")
	}
}
