package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// ProvisionUserArgs defines the job arguments
type ProvisionUserArgs struct {
	ProvisionID int64 `json:"provision_id"`
}

func (ProvisionUserArgs) Kind() string { return "provision_keycloak_user" }

func (ProvisionUserArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "user_provisioning",
		MaxAttempts: 5,
		Priority:    1,
	}
}

// UserProvisionWorker provisions users in Keycloak
type UserProvisionWorker struct {
	river.WorkerDefaults[ProvisionUserArgs]
	dbPool           *pgxpool.Pool
	keycloakClient   *KeycloakClient
	siteURL          string
	keycloakClientID string // Keycloak client ID for redirect URI
}

// provisionRequest holds data from metadata.user_provisioning
type provisionRequest struct {
	ID               int64
	Email            string
	FirstName        string
	LastName         string
	Phone            *string
	InitialRoles     []string
	SendWelcomeEmail bool
	Status           string
	KeycloakUserID   *string
}

func (w *UserProvisionWorker) Work(ctx context.Context, job *river.Job[ProvisionUserArgs]) error {
	startTime := time.Now()
	provisionID := job.Args.ProvisionID
	log.Printf("[Job %d] Starting user provisioning (attempt %d/%d): provision_id=%d",
		job.ID, job.Attempt, job.MaxAttempts, provisionID)

	// 1. Fetch provision request
	req, err := w.fetchProvisionRequest(ctx, provisionID)
	if err != nil {
		return w.handleError(ctx, provisionID, job.ID, "fetch request", err)
	}

	// Skip if already completed
	if req.Status == "completed" {
		log.Printf("[Job %d] Provision request %d already completed, skipping", job.ID, provisionID)
		return nil
	}

	// 2. Update status to processing
	if err := w.updateStatus(ctx, provisionID, "processing", nil); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	// 3. Check Keycloak for existing user (idempotency for retries)
	var keycloakUserID string
	existingUser, err := w.keycloakClient.GetUserByEmail(ctx, req.Email)
	if err != nil {
		return w.handleError(ctx, provisionID, job.ID, "search user", err)
	}

	if existingUser != nil {
		keycloakUserID = existingUser.ID
		log.Printf("[Job %d] User %s already exists in Keycloak (ID: %s), using existing",
			job.ID, req.Email, keycloakUserID)
	} else {
		// 4. Create user in Keycloak
		phone := ""
		if req.Phone != nil {
			phone = *req.Phone
		}
		keycloakUserID, err = w.keycloakClient.CreateUser(ctx, req.Email, req.FirstName, req.LastName, phone)
		if err != nil {
			return w.handleError(ctx, provisionID, job.ID, "create user", err)
		}
		log.Printf("[Job %d] Created user %s in Keycloak (ID: %s)", job.ID, req.Email, keycloakUserID)
	}

	// 5. Assign realm roles
	if len(req.InitialRoles) > 0 {
		if err := w.keycloakClient.AssignRealmRoles(ctx, keycloakUserID, req.InitialRoles); err != nil {
			return w.handleError(ctx, provisionID, job.ID, "assign roles", err)
		}
		log.Printf("[Job %d] Assigned roles %v to user %s", job.ID, req.InitialRoles, keycloakUserID)
	}

	// 6. Insert into civic_os_users and civic_os_users_private
	if err := w.insertUserRecords(ctx, keycloakUserID, req); err != nil {
		return w.handleError(ctx, provisionID, job.ID, "insert user records", err)
	}

	// 7. Insert user roles
	if err := w.insertUserRoles(ctx, keycloakUserID, req.InitialRoles); err != nil {
		return w.handleError(ctx, provisionID, job.ID, "insert user roles", err)
	}

	// 8. Send welcome email if requested
	if req.SendWelcomeEmail {
		redirectURI := w.siteURL
		if err := w.keycloakClient.SendWelcomeEmail(ctx, keycloakUserID, w.keycloakClientID, redirectURI); err != nil {
			// Don't fail the whole job for welcome email - log and continue
			log.Printf("[Job %d] Warning: failed to send welcome email: %v", job.ID, err)
		} else {
			log.Printf("[Job %d] Sent welcome email to %s", job.ID, req.Email)
		}
	}

	// 9. Mark as completed
	if err := w.markCompleted(ctx, provisionID, keycloakUserID); err != nil {
		return fmt.Errorf("failed to mark completed: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] User %s provisioned successfully in %v (Keycloak ID: %s)",
		job.ID, req.Email, duration, keycloakUserID)

	return nil
}

func (w *UserProvisionWorker) fetchProvisionRequest(ctx context.Context, id int64) (*provisionRequest, error) {
	var req provisionRequest
	var rolesJSON json.RawMessage

	err := w.dbPool.QueryRow(ctx, `
		SELECT id, email::TEXT, first_name, last_name, phone::TEXT,
		       to_json(initial_roles) AS initial_roles,
		       send_welcome_email, status, keycloak_user_id::TEXT
		FROM metadata.user_provisioning
		WHERE id = $1
	`, id).Scan(
		&req.ID, &req.Email, &req.FirstName, &req.LastName, &req.Phone,
		&rolesJSON, &req.SendWelcomeEmail, &req.Status, &req.KeycloakUserID,
	)
	if err != nil {
		return nil, fmt.Errorf("provision request %d not found: %w", id, err)
	}

	if err := json.Unmarshal(rolesJSON, &req.InitialRoles); err != nil {
		return nil, fmt.Errorf("failed to parse initial_roles: %w", err)
	}

	return &req, nil
}

func (w *UserProvisionWorker) updateStatus(ctx context.Context, id int64, status string, errMsg *string) error {
	if errMsg != nil {
		_, err := w.dbPool.Exec(ctx, `
			UPDATE metadata.user_provisioning
			SET status = $2, error_message = $3
			WHERE id = $1
		`, id, status, *errMsg)
		return err
	}

	_, err := w.dbPool.Exec(ctx, `
		UPDATE metadata.user_provisioning
		SET status = $2
		WHERE id = $1
	`, id, status)
	return err
}

func (w *UserProvisionWorker) insertUserRecords(ctx context.Context, keycloakUserID string, req *provisionRequest) error {
	// Format display name using the same logic as format_public_display_name()
	displayName := formatPublicDisplayName(req.FirstName, req.LastName)
	fullName := req.FirstName + " " + req.LastName

	// Insert into civic_os_users (ON CONFLICT for idempotency)
	_, err := w.dbPool.Exec(ctx, `
		INSERT INTO metadata.civic_os_users (id, display_name)
		VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET
		    display_name = EXCLUDED.display_name,
		    updated_at = NOW()
	`, keycloakUserID, displayName)
	if err != nil {
		return fmt.Errorf("insert civic_os_users failed: %w", err)
	}

	// Insert into civic_os_users_private
	// This triggers auto-creation of notification_preferences
	phone := ""
	if req.Phone != nil {
		phone = *req.Phone
	}

	if phone != "" {
		_, err = w.dbPool.Exec(ctx, `
			INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone)
			VALUES ($1, $2, $3::email_address, $4::phone_number)
			ON CONFLICT (id) DO UPDATE SET
			    display_name = EXCLUDED.display_name,
			    email = EXCLUDED.email,
			    phone = EXCLUDED.phone,
			    updated_at = NOW()
		`, keycloakUserID, fullName, req.Email, phone)
	} else {
		_, err = w.dbPool.Exec(ctx, `
			INSERT INTO metadata.civic_os_users_private (id, display_name, email)
			VALUES ($1, $2, $3::email_address)
			ON CONFLICT (id) DO UPDATE SET
			    display_name = EXCLUDED.display_name,
			    email = EXCLUDED.email,
			    updated_at = NOW()
		`, keycloakUserID, fullName, req.Email)
	}
	if err != nil {
		return fmt.Errorf("insert civic_os_users_private failed: %w", err)
	}

	return nil
}

func (w *UserProvisionWorker) insertUserRoles(ctx context.Context, keycloakUserID string, roleNames []string) error {
	for _, roleName := range roleNames {
		_, err := w.dbPool.Exec(ctx, `
			INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
			SELECT $1, r.id, NOW()
			FROM metadata.roles r
			WHERE r.display_name = $2
			ON CONFLICT (user_id, role_id) DO UPDATE SET synced_at = NOW()
		`, keycloakUserID, roleName)
		if err != nil {
			return fmt.Errorf("insert user_role '%s' failed: %w", roleName, err)
		}
	}
	return nil
}

func (w *UserProvisionWorker) markCompleted(ctx context.Context, id int64, keycloakUserID string) error {
	_, err := w.dbPool.Exec(ctx, `
		UPDATE metadata.user_provisioning
		SET status = 'completed',
		    keycloak_user_id = $2,
		    completed_at = NOW()
		WHERE id = $1
	`, id, keycloakUserID)
	return err
}

func (w *UserProvisionWorker) handleError(ctx context.Context, provisionID int64, jobID int64, step string, err error) error {
	errMsg := fmt.Sprintf("%s: %v", step, err)
	log.Printf("[Job %d] Error in step '%s' for provision %d: %v", jobID, step, provisionID, err)
	_ = w.updateStatus(ctx, provisionID, "failed", &errMsg)
	return fmt.Errorf("%s: %w", step, err) // Return error for retry
}

// formatPublicDisplayName formats "First Last" -> "First L."
// Mirrors the PostgreSQL format_public_display_name() function
func formatPublicDisplayName(firstName, lastName string) string {
	firstName = strings.TrimSpace(firstName)
	lastName = strings.TrimSpace(lastName)

	if firstName == "" && lastName == "" {
		return "User"
	}
	if lastName == "" {
		return firstName
	}
	if firstName == "" {
		return string([]rune(strings.ToUpper(lastName))[0:1]) + "."
	}

	// Take first character of last name
	lastInitial := string([]rune(strings.ToUpper(lastName))[0:1])
	return firstName + " " + lastInitial + "."
}
