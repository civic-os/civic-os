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
// UpdateUser Keycloak API Tests
// ============================================================================

// TestUpdateUserPayloadWithPhone verifies the PUT /users/{id} payload includes
// firstName, lastName, and phoneNumber attribute when phone is provided.
func TestUpdateUserPayloadWithPhone(t *testing.T) {
	var capturedMethod string
	var capturedPath string
	var capturedBody map[string]interface{}

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

		capturedMethod = r.Method
		capturedPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &capturedBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.UpdateUser(context.Background(), "user-uuid-123", "John", "Doe", "5551234567")

	if err != nil {
		t.Fatalf("UpdateUser returned error: %v", err)
	}
	if capturedMethod != "PUT" {
		t.Errorf("expected PUT, got %s", capturedMethod)
	}
	if capturedPath != "/admin/realms/test-realm/users/user-uuid-123" {
		t.Errorf("unexpected path: %s", capturedPath)
	}
	if capturedBody["firstName"] != "John" {
		t.Errorf("expected firstName=John, got %v", capturedBody["firstName"])
	}
	if capturedBody["lastName"] != "Doe" {
		t.Errorf("expected lastName=Doe, got %v", capturedBody["lastName"])
	}

	// Check phoneNumber attribute
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
}

// TestUpdateUserPayloadWithoutPhone verifies that an empty phone string sends
// an empty phoneNumber array to clear the attribute in Keycloak.
func TestUpdateUserPayloadWithoutPhone(t *testing.T) {
	var capturedBody map[string]interface{}

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

		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &capturedBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.UpdateUser(context.Background(), "user-uuid-123", "Jane", "Smith", "")

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
}

// TestUpdateUserKeycloakError verifies that a non-204 response from Keycloak
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

		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"User not found"}`))
	}))
	defer server.Close()

	kc := NewKeycloakClient(server.URL, "test-realm", "test-client", "test-secret")
	err := kc.UpdateUser(context.Background(), "nonexistent-user", "Ghost", "User", "")

	if err == nil {
		t.Fatal("expected error for 404 response, got nil")
	}
	if got := err.Error(); got == "" {
		t.Error("expected non-empty error message")
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
func TestUpdateKeycloakUserArgsJSON(t *testing.T) {
	args := UpdateKeycloakUserArgs{
		UserID:    "abc-123",
		FirstName: "Jane",
		LastName:  "Doe",
		Phone:     "5559876543",
	}

	data, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var parsed map[string]string
	json.Unmarshal(data, &parsed)

	expected := map[string]string{
		"user_id":    "abc-123",
		"first_name": "Jane",
		"last_name":  "Doe",
		"phone":      "5559876543",
	}

	for key, want := range expected {
		if got := parsed[key]; got != want {
			t.Errorf("JSON key %q: expected %q, got %q", key, want, got)
		}
	}
}
