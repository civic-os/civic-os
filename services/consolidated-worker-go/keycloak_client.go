package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// KeycloakClient wraps the Keycloak Admin REST API
type KeycloakClient struct {
	baseURL      string
	realm        string
	clientID     string
	clientSecret string
	httpClient   *http.Client

	mu          sync.RWMutex
	token       *tokenResponse
	tokenExpiry time.Time
	roles       map[string]string // role name -> role ID cache
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

// KeycloakUser represents a user in Keycloak
type KeycloakUser struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Email     string `json:"email"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	Enabled   bool   `json:"enabled"`
}

type keycloakRole struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// NewKeycloakClient creates a new Keycloak Admin API client
func NewKeycloakClient(baseURL, realm, clientID, clientSecret string) *KeycloakClient {
	return &KeycloakClient{
		baseURL:      strings.TrimRight(baseURL, "/"),
		realm:        realm,
		clientID:     clientID,
		clientSecret: clientSecret,
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		roles:        make(map[string]string),
	}
}

// authenticate obtains a token via client_credentials grant
func (kc *KeycloakClient) authenticate(ctx context.Context) error {
	tokenURL := fmt.Sprintf("%s/realms/%s/protocol/openid-connect/token", kc.baseURL, kc.realm)

	data := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {kc.clientID},
		"client_secret": {kc.clientSecret},
	}

	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return fmt.Errorf("failed to create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := kc.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("token request returned %d: %s", resp.StatusCode, string(body))
	}

	var token tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return fmt.Errorf("failed to decode token response: %w", err)
	}

	kc.mu.Lock()
	kc.token = &token
	// Refresh 30 seconds before expiry
	kc.tokenExpiry = time.Now().Add(time.Duration(token.ExpiresIn-30) * time.Second)
	kc.mu.Unlock()

	return nil
}

// ensureValidToken refreshes the token if expired
func (kc *KeycloakClient) ensureValidToken(ctx context.Context) error {
	kc.mu.RLock()
	valid := kc.token != nil && time.Now().Before(kc.tokenExpiry)
	kc.mu.RUnlock()

	if valid {
		return nil
	}

	return kc.authenticate(ctx)
}

// doRequest performs an authenticated HTTP request
func (kc *KeycloakClient) doRequest(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	if err := kc.ensureValidToken(ctx); err != nil {
		return nil, fmt.Errorf("authentication failed: %w", err)
	}

	reqURL := fmt.Sprintf("%s/admin/realms/%s%s", kc.baseURL, kc.realm, path)
	req, err := http.NewRequestWithContext(ctx, method, reqURL, body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	kc.mu.RLock()
	req.Header.Set("Authorization", "Bearer "+kc.token.AccessToken)
	kc.mu.RUnlock()
	req.Header.Set("Content-Type", "application/json")

	return kc.httpClient.Do(req)
}

// CreateUser creates a user in Keycloak and returns the UUID
func (kc *KeycloakClient) CreateUser(ctx context.Context, email, firstName, lastName, phone string) (string, error) {
	userPayload := map[string]interface{}{
		"username":      email,
		"email":         email,
		"firstName":     firstName,
		"lastName":      lastName,
		"enabled":       true,
		"emailVerified": true,
	}

	if phone != "" {
		userPayload["attributes"] = map[string][]string{
			"phoneNumber": {phone},
		}
	}

	payloadBytes, err := json.Marshal(userPayload)
	if err != nil {
		return "", fmt.Errorf("failed to marshal user payload: %w", err)
	}

	resp, err := kc.doRequest(ctx, "POST", "/users", strings.NewReader(string(payloadBytes)))
	if err != nil {
		return "", fmt.Errorf("create user request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		return "", fmt.Errorf("user with email %s already exists in Keycloak", email)
	}

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("create user returned %d: %s", resp.StatusCode, string(body))
	}

	// Extract UUID from Location header: .../users/{uuid}
	location := resp.Header.Get("Location")
	parts := strings.Split(location, "/")
	if len(parts) == 0 {
		return "", fmt.Errorf("no UUID in Location header: %s", location)
	}

	return parts[len(parts)-1], nil
}

// GetUserByEmail finds a user by email (for idempotency checks)
func (kc *KeycloakClient) GetUserByEmail(ctx context.Context, email string) (*KeycloakUser, error) {
	path := fmt.Sprintf("/users?email=%s&exact=true", url.QueryEscape(email))
	resp, err := kc.doRequest(ctx, "GET", path, nil)
	if err != nil {
		return nil, fmt.Errorf("search user request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("search user returned %d: %s", resp.StatusCode, string(body))
	}

	var users []KeycloakUser
	if err := json.NewDecoder(resp.Body).Decode(&users); err != nil {
		return nil, fmt.Errorf("failed to decode user search: %w", err)
	}

	if len(users) == 0 {
		return nil, nil // Not found
	}

	return &users[0], nil
}

// loadRoles fetches all realm roles and caches name->ID mapping
func (kc *KeycloakClient) loadRoles(ctx context.Context) error {
	resp, err := kc.doRequest(ctx, "GET", "/roles", nil)
	if err != nil {
		return fmt.Errorf("fetch roles request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("fetch roles returned %d: %s", resp.StatusCode, string(body))
	}

	var roles []keycloakRole
	if err := json.NewDecoder(resp.Body).Decode(&roles); err != nil {
		return fmt.Errorf("failed to decode roles: %w", err)
	}

	kc.mu.Lock()
	for _, r := range roles {
		kc.roles[r.Name] = r.ID
	}
	kc.mu.Unlock()

	return nil
}

// getRoleID returns the Keycloak role ID for a role name, loading cache if needed
func (kc *KeycloakClient) getRoleID(ctx context.Context, roleName string) (string, error) {
	kc.mu.RLock()
	id, ok := kc.roles[roleName]
	kc.mu.RUnlock()

	if ok {
		return id, nil
	}

	// Cache miss - reload roles
	if err := kc.loadRoles(ctx); err != nil {
		return "", err
	}

	kc.mu.RLock()
	id, ok = kc.roles[roleName]
	kc.mu.RUnlock()

	if !ok {
		return "", fmt.Errorf("role '%s' not found in Keycloak", roleName)
	}

	return id, nil
}

// AssignRealmRoles assigns realm roles to a user
func (kc *KeycloakClient) AssignRealmRoles(ctx context.Context, userID string, roleNames []string) error {
	var roles []keycloakRole
	for _, name := range roleNames {
		id, err := kc.getRoleID(ctx, name)
		if err != nil {
			return fmt.Errorf("role lookup failed for '%s': %w", name, err)
		}
		roles = append(roles, keycloakRole{ID: id, Name: name})
	}

	payloadBytes, err := json.Marshal(roles)
	if err != nil {
		return fmt.Errorf("failed to marshal roles: %w", err)
	}

	path := fmt.Sprintf("/users/%s/role-mappings/realm", userID)
	resp, err := kc.doRequest(ctx, "POST", path, strings.NewReader(string(payloadBytes)))
	if err != nil {
		return fmt.Errorf("assign roles request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("assign roles returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// RemoveRealmRoles removes realm roles from a user
func (kc *KeycloakClient) RemoveRealmRoles(ctx context.Context, userID string, roleNames []string) error {
	var roles []keycloakRole
	for _, name := range roleNames {
		id, err := kc.getRoleID(ctx, name)
		if err != nil {
			return fmt.Errorf("role lookup failed for '%s': %w", name, err)
		}
		roles = append(roles, keycloakRole{ID: id, Name: name})
	}

	payloadBytes, err := json.Marshal(roles)
	if err != nil {
		return fmt.Errorf("failed to marshal roles: %w", err)
	}

	path := fmt.Sprintf("/users/%s/role-mappings/realm", userID)
	resp, err := kc.doRequest(ctx, "DELETE", path, strings.NewReader(string(payloadBytes)))
	if err != nil {
		return fmt.Errorf("remove roles request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("remove roles returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// SendWelcomeEmail triggers the "set password" email action in Keycloak
func (kc *KeycloakClient) SendWelcomeEmail(ctx context.Context, userID, clientID, redirectURI string) error {
	path := fmt.Sprintf("/users/%s/execute-actions-email?client_id=%s&redirect_uri=%s",
		userID, url.QueryEscape(clientID), url.QueryEscape(redirectURI))

	actions := []string{"UPDATE_PASSWORD"}
	payloadBytes, err := json.Marshal(actions)
	if err != nil {
		return fmt.Errorf("failed to marshal actions: %w", err)
	}

	resp, err := kc.doRequest(ctx, "PUT", path, strings.NewReader(string(payloadBytes)))
	if err != nil {
		return fmt.Errorf("execute-actions-email request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("execute-actions-email returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// UpdateUser updates a user's profile in Keycloak (firstName, lastName, phone)
func (kc *KeycloakClient) UpdateUser(ctx context.Context, userID, firstName, lastName, phone string) error {
	payload := map[string]interface{}{
		"firstName": firstName,
		"lastName":  lastName,
	}

	if phone != "" {
		payload["attributes"] = map[string][]string{
			"phoneNumber": {phone},
		}
	} else {
		payload["attributes"] = map[string][]string{
			"phoneNumber": {},
		}
	}

	payloadBytes, _ := json.Marshal(payload)

	path := fmt.Sprintf("/users/%s", userID)
	resp, err := kc.doRequest(ctx, "PUT", path, strings.NewReader(string(payloadBytes)))
	if err != nil {
		return fmt.Errorf("update user request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("update user returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// DisableUser sets enabled=false on a Keycloak user
func (kc *KeycloakClient) DisableUser(ctx context.Context, userID string) error {
	payload := map[string]interface{}{"enabled": false}
	payloadBytes, _ := json.Marshal(payload)

	path := fmt.Sprintf("/users/%s", userID)
	resp, err := kc.doRequest(ctx, "PUT", path, strings.NewReader(string(payloadBytes)))
	if err != nil {
		return fmt.Errorf("disable user request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("disable user returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// CreateRealmRole creates a new realm role in Keycloak
func (kc *KeycloakClient) CreateRealmRole(ctx context.Context, name, description string) error {
	payload := map[string]string{
		"name":        name,
		"description": description,
	}
	payloadBytes, _ := json.Marshal(payload)

	resp, err := kc.doRequest(ctx, "POST", "/roles", strings.NewReader(string(payloadBytes)))
	if err != nil {
		return fmt.Errorf("create role request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		log.Printf("[Keycloak] Role '%s' already exists (idempotent)", name)
		return nil // Idempotent
	}

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("create role returned %d: %s", resp.StatusCode, string(body))
	}

	// Invalidate role cache
	kc.mu.Lock()
	delete(kc.roles, name)
	kc.mu.Unlock()

	return nil
}

// DeleteRealmRole deletes a realm role from Keycloak
func (kc *KeycloakClient) DeleteRealmRole(ctx context.Context, name string) error {
	path := fmt.Sprintf("/roles/%s", url.PathEscape(name))
	resp, err := kc.doRequest(ctx, "DELETE", path, nil)
	if err != nil {
		return fmt.Errorf("delete role request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		log.Printf("[Keycloak] Role '%s' not found (already deleted)", name)
		return nil // Idempotent
	}

	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("delete role returned %d: %s", resp.StatusCode, string(body))
	}

	// Invalidate role cache
	kc.mu.Lock()
	delete(kc.roles, name)
	kc.mu.Unlock()

	return nil
}
