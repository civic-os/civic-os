package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const telnyxAPIURL = "https://api.telnyx.com/v2/messages"

// TelnyxClient sends transactional SMS via the Telnyx REST API.
// Uses stdlib net/http — no external dependencies.
type TelnyxClient struct {
	apiKey     string
	fromNumber string
	httpClient *http.Client
}

// NewTelnyxClient creates a TelnyxClient with a 10s timeout.
func NewTelnyxClient(apiKey, fromNumber string) *TelnyxClient {
	return &TelnyxClient{
		apiKey:     apiKey,
		fromNumber: fromNumber,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// TelnyxError classifies a Telnyx API error as opted-out, permanent, or transient.
type TelnyxError struct {
	// IsOptedOut is true when the recipient texted STOP (carrier-level opt-out).
	// The caller should update notification_preferences.sms_opted_out = true.
	IsOptedOut bool

	// IsPermanent is true for non-retryable errors (invalid number, auth failure, etc.).
	// Transient errors (rate limit, 5xx, network) leave IsPermanent = false.
	IsPermanent bool

	Message string
}

func (e *TelnyxError) Error() string {
	return e.Message
}

// telnyxRequest is the JSON body sent to POST /v2/messages
type telnyxRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
	Text string `json:"text"`
}

// telnyxErrorDetail is one item in the Telnyx error array
type telnyxErrorDetail struct {
	Code   string `json:"code"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

// telnyxErrorResponse is the top-level Telnyx error body
type telnyxErrorResponse struct {
	Errors []telnyxErrorDetail `json:"errors"`
}

// Send delivers an SMS to `to` (E.164 format) with the given message text.
// Returns nil on success, *TelnyxError on failure.
func (c *TelnyxClient) Send(to, message string) *TelnyxError {
	body, err := json.Marshal(telnyxRequest{
		From: c.fromNumber,
		To:   to,
		Text: message,
	})
	if err != nil {
		return &TelnyxError{IsPermanent: true, Message: fmt.Sprintf("failed to marshal request: %v", err)}
	}

	req, err := http.NewRequest(http.MethodPost, telnyxAPIURL, bytes.NewReader(body))
	if err != nil {
		return &TelnyxError{IsPermanent: true, Message: fmt.Sprintf("failed to create request: %v", err)}
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Network error, timeout — transient
		return &TelnyxError{IsPermanent: false, Message: fmt.Sprintf("HTTP request failed: %v", err)}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil // success
	}

	// Parse error response for classification
	respBody, _ := io.ReadAll(resp.Body)
	var telnyxErr telnyxErrorResponse
	_ = json.Unmarshal(respBody, &telnyxErr)

	return classifyTelnyxError(resp.StatusCode, telnyxErr, string(respBody))
}

// classifyTelnyxError maps Telnyx HTTP status codes and error codes to TelnyxError.
//
// Telnyx error code reference:
//   - opted_out / 90126: recipient texted STOP
//   - 40002 (invalid_phone_number), 40007 (invalid_parameter): bad request, permanent
//   - 401: auth failure, permanent (misconfiguration)
//   - 429 (rate_limit_exceeded): transient, retry
//   - 5xx: transient, retry
func classifyTelnyxError(statusCode int, body telnyxErrorResponse, rawBody string) *TelnyxError {
	// Check error codes first (more specific than HTTP status)
	for _, e := range body.Errors {
		switch e.Code {
		case "opted_out", "90126":
			return &TelnyxError{
				IsOptedOut:  true,
				IsPermanent: true,
				Message:     fmt.Sprintf("recipient has opted out (STOP): %s", e.Detail),
			}
		case "40002", "invalid_phone_number":
			return &TelnyxError{
				IsPermanent: true,
				Message:     fmt.Sprintf("invalid phone number: %s", e.Detail),
			}
		case "40007", "invalid_parameter":
			return &TelnyxError{
				IsPermanent: true,
				Message:     fmt.Sprintf("invalid parameter: %s", e.Detail),
			}
		}
	}

	// Fall back to HTTP status code classification
	switch {
	case statusCode == 401:
		return &TelnyxError{
			IsPermanent: true,
			Message:     "Telnyx authentication failed (check TELNYX_API_KEY)",
		}
	case statusCode == 422:
		// Unprocessable Entity — typically a permanent validation error
		return &TelnyxError{
			IsPermanent: true,
			Message:     fmt.Sprintf("Telnyx rejected request (422): %s", rawBody),
		}
	case statusCode == 429:
		return &TelnyxError{
			IsPermanent: false,
			Message:     "Telnyx rate limit exceeded",
		}
	case statusCode >= 500:
		return &TelnyxError{
			IsPermanent: false,
			Message:     fmt.Sprintf("Telnyx server error (%d): %s", statusCode, rawBody),
		}
	default:
		return &TelnyxError{
			IsPermanent: true,
			Message:     fmt.Sprintf("Telnyx error (%d): %s", statusCode, rawBody),
		}
	}
}
