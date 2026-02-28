package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// ============================================================================
// User Update Worker (update_keycloak_user)
// ============================================================================

// UpdateKeycloakUserArgs defines the job arguments for updating user info in Keycloak
type UpdateKeycloakUserArgs struct {
	UserID    string `json:"user_id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Phone     string `json:"phone"`
}

func (UpdateKeycloakUserArgs) Kind() string { return "update_keycloak_user" }

func (UpdateKeycloakUserArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "user_provisioning",
		MaxAttempts: 5,
		Priority:    1,
	}
}

// UpdateKeycloakUserWorker syncs user profile changes to Keycloak
type UpdateKeycloakUserWorker struct {
	river.WorkerDefaults[UpdateKeycloakUserArgs]
	dbPool         *pgxpool.Pool
	keycloakClient *KeycloakClient
}

func (w *UpdateKeycloakUserWorker) Work(ctx context.Context, job *river.Job[UpdateKeycloakUserArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting user update (attempt %d/%d): user=%s name=%s %s",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.UserID, job.Args.FirstName, job.Args.LastName)

	err := w.keycloakClient.UpdateUser(ctx, job.Args.UserID, job.Args.FirstName, job.Args.LastName, job.Args.Phone)
	if err != nil {
		return fmt.Errorf("update user failed: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] Updated user %s in Keycloak in %v", job.ID, job.Args.UserID, duration)
	return nil
}
