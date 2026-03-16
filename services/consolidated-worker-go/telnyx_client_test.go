package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ============================================================================
// classifyTelnyxError Tests
// ============================================================================

func TestClassifyTelnyxError_OptedOut(t *testing.T) {
	tests := []struct {
		name string
		code string
	}{
		{"opted_out string code", "opted_out"},
		{"90126 numeric code", "90126"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := telnyxErrorResponse{
				Errors: []telnyxErrorDetail{
					{Code: tt.code, Title: "Opted Out", Detail: "recipient has opted out"},
				},
			}

			err := classifyTelnyxError(422, body, "")
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !err.IsOptedOut {
				t.Error("expected IsOptedOut=true")
			}
			if !err.IsPermanent {
				t.Error("expected IsPermanent=true for opted-out")
			}
		})
	}
}

func TestClassifyTelnyxError_InvalidPhone(t *testing.T) {
	tests := []struct {
		name string
		code string
	}{
		{"40002 code", "40002"},
		{"invalid_phone_number string code", "invalid_phone_number"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := telnyxErrorResponse{
				Errors: []telnyxErrorDetail{
					{Code: tt.code, Detail: "bad number"},
				},
			}

			err := classifyTelnyxError(422, body, "")
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if err.IsOptedOut {
				t.Error("expected IsOptedOut=false")
			}
			if !err.IsPermanent {
				t.Error("expected IsPermanent=true for invalid phone")
			}
		})
	}
}

func TestClassifyTelnyxError_InvalidParameter(t *testing.T) {
	tests := []struct {
		name string
		code string
	}{
		{"40007 code", "40007"},
		{"invalid_parameter string code", "invalid_parameter"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := telnyxErrorResponse{
				Errors: []telnyxErrorDetail{
					{Code: tt.code, Detail: "bad param"},
				},
			}

			err := classifyTelnyxError(422, body, "")
			if !err.IsPermanent {
				t.Error("expected IsPermanent=true for invalid parameter")
			}
		})
	}
}

func TestClassifyTelnyxError_HTTPStatusFallback(t *testing.T) {
	emptyBody := telnyxErrorResponse{}

	tests := []struct {
		name        string
		statusCode  int
		isPermanent bool
	}{
		{"401 auth failure is permanent", 401, true},
		{"422 unprocessable is permanent", 422, true},
		{"429 rate limit is transient", 429, false},
		{"500 server error is transient", 500, false},
		{"503 unavailable is transient", 503, false},
		{"400 unknown is permanent", 400, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := classifyTelnyxError(tt.statusCode, emptyBody, "raw body")
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if err.IsPermanent != tt.isPermanent {
				t.Errorf("expected IsPermanent=%v, got %v", tt.isPermanent, err.IsPermanent)
			}
			if err.IsOptedOut {
				t.Error("expected IsOptedOut=false for HTTP status fallback")
			}
		})
	}
}

func TestClassifyTelnyxError_ErrorCodeTakesPrecedence(t *testing.T) {
	// When both error code and HTTP status are present, error code wins
	body := telnyxErrorResponse{
		Errors: []telnyxErrorDetail{
			{Code: "opted_out", Detail: "user opted out"},
		},
	}

	// 500 would normally be transient, but opted_out code should make it permanent
	err := classifyTelnyxError(500, body, "")
	if !err.IsOptedOut {
		t.Error("error code should take precedence over HTTP status")
	}
	if !err.IsPermanent {
		t.Error("opted_out should be permanent regardless of HTTP status")
	}
}

// ============================================================================
// TelnyxClient.Send Integration Tests (with httptest mock server)
// ============================================================================

func TestTelnyxClientSend_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify request structure
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-api-key" {
			t.Errorf("expected Bearer test-api-key, got %s", auth)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("expected application/json, got %s", ct)
		}

		// Verify body
		var req telnyxRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.From != "+15551234567" {
			t.Errorf("expected from +15551234567, got %s", req.From)
		}
		if req.To != "+15559876543" {
			t.Errorf("expected to +15559876543, got %s", req.To)
		}
		if req.Text != "Hello world" {
			t.Errorf("expected text 'Hello world', got %s", req.Text)
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"data":{"id":"msg-123"}}`))
	}))
	defer server.Close()

	// Override the API URL for testing
	originalURL := telnyxAPIURL
	defer func() { setTelnyxAPIURL(originalURL) }()
	setTelnyxAPIURL(server.URL)

	client := NewTelnyxClient("test-api-key", "+15551234567")
	err := client.Send("+15559876543", "Hello world")
	if err != nil {
		t.Fatalf("expected nil error, got: %v", err)
	}
}

func TestTelnyxClientSend_OptedOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(telnyxErrorResponse{
			Errors: []telnyxErrorDetail{
				{Code: "opted_out", Title: "Opted Out", Detail: "recipient has opted out"},
			},
		})
	}))
	defer server.Close()

	originalURL := telnyxAPIURL
	defer func() { setTelnyxAPIURL(originalURL) }()
	setTelnyxAPIURL(server.URL)

	client := NewTelnyxClient("test-key", "+15551234567")
	err := client.Send("+15559876543", "test")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !err.IsOptedOut {
		t.Error("expected IsOptedOut=true")
	}
	if !err.IsPermanent {
		t.Error("expected IsPermanent=true")
	}
}

func TestTelnyxClientSend_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"errors":[{"code":"server_error","detail":"internal error"}]}`))
	}))
	defer server.Close()

	originalURL := telnyxAPIURL
	defer func() { setTelnyxAPIURL(originalURL) }()
	setTelnyxAPIURL(server.URL)

	client := NewTelnyxClient("test-key", "+15551234567")
	err := client.Send("+15559876543", "test")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.IsPermanent {
		t.Error("expected IsPermanent=false for 500 server error")
	}
}

func TestTelnyxClientSend_RateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"errors":[]}`))
	}))
	defer server.Close()

	originalURL := telnyxAPIURL
	defer func() { setTelnyxAPIURL(originalURL) }()
	setTelnyxAPIURL(server.URL)

	client := NewTelnyxClient("test-key", "+15551234567")
	err := client.Send("+15559876543", "test")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.IsPermanent {
		t.Error("expected IsPermanent=false for rate limit")
	}
}

// ============================================================================
// formatE164 Tests
// ============================================================================

func TestFormatE164_TenDigit(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"bare 10 digits", "5551234567", "+15551234567"},
		{"formatted with parens and dash", "(555) 123-4567", "+15551234567"},
		{"formatted with dots", "555.123.4567", "+15551234567"},
		{"formatted with dashes", "555-123-4567", "+15551234567"},
		{"with spaces", "555 123 4567", "+15551234567"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := formatE164(tt.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("formatE164(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestFormatE164_ElevenDigitWithCountryCode(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"bare 11 digits starting with 1", "15551234567", "+15551234567"},
		{"with dashes", "1-555-123-4567", "+15551234567"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := formatE164(tt.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("formatE164(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestFormatE164_InternationalPassthrough(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"UK number", "+447911123456", "+447911123456"},
		{"with spaces stripped", "+44 7911 123 456", "+447911123456"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := formatE164(tt.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("formatE164(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestFormatE164_Invalid(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"too few digits", "12345"},
		{"too many digits without +", "123456789012345"},
		{"empty string", ""},
		{"letters only", "abcdefghij"},
		{"nine digits", "555123456"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := formatE164(tt.input)
			if err == nil {
				t.Errorf("formatE164(%q) expected error, got nil", tt.input)
			}
		})
	}
}
