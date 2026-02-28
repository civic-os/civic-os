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
// Role CRUD Sync Worker (sync_keycloak_role)
// ============================================================================

// SyncKeycloakRoleArgs defines the job arguments for role CRUD sync
type SyncKeycloakRoleArgs struct {
	RoleName    string `json:"role_name"`
	Description string `json:"description"`
	Action      string `json:"action"` // "create" or "delete"
}

func (SyncKeycloakRoleArgs) Kind() string { return "sync_keycloak_role" }

func (SyncKeycloakRoleArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "user_provisioning",
		MaxAttempts: 5,
		Priority:    1,
	}
}

// SyncKeycloakRoleWorker syncs role CRUD operations to Keycloak
type SyncKeycloakRoleWorker struct {
	river.WorkerDefaults[SyncKeycloakRoleArgs]
	dbPool         *pgxpool.Pool
	keycloakClient *KeycloakClient
}

func (w *SyncKeycloakRoleWorker) Work(ctx context.Context, job *river.Job[SyncKeycloakRoleArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting role sync (attempt %d/%d): role=%s action=%s",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.RoleName, job.Args.Action)

	var err error
	switch job.Args.Action {
	case "create":
		err = w.keycloakClient.CreateRealmRole(ctx, job.Args.RoleName, job.Args.Description)
	case "delete":
		err = w.keycloakClient.DeleteRealmRole(ctx, job.Args.RoleName)
	default:
		log.Printf("[Job %d] Unknown action '%s', skipping", job.ID, job.Args.Action)
		return nil
	}

	if err != nil {
		return fmt.Errorf("role sync failed: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] Role '%s' %sd in Keycloak in %v", job.ID, job.Args.RoleName, job.Args.Action, duration)
	return nil
}

// ============================================================================
// Role Assignment Worker (assign_keycloak_role)
// ============================================================================

// AssignKeycloakRoleArgs defines the job arguments for role assignment
type AssignKeycloakRoleArgs struct {
	UserID   string `json:"user_id"`
	RoleName string `json:"role_name"`
}

func (AssignKeycloakRoleArgs) Kind() string { return "assign_keycloak_role" }

func (AssignKeycloakRoleArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "user_provisioning",
		MaxAttempts: 5,
		Priority:    1,
	}
}

// AssignKeycloakRoleWorker assigns realm roles to users in Keycloak
type AssignKeycloakRoleWorker struct {
	river.WorkerDefaults[AssignKeycloakRoleArgs]
	dbPool         *pgxpool.Pool
	keycloakClient *KeycloakClient
}

func (w *AssignKeycloakRoleWorker) Work(ctx context.Context, job *river.Job[AssignKeycloakRoleArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting role assignment (attempt %d/%d): user=%s role=%s",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.UserID, job.Args.RoleName)

	err := w.keycloakClient.AssignRealmRoles(ctx, job.Args.UserID, []string{job.Args.RoleName})
	if err != nil {
		return fmt.Errorf("assign role failed: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] Assigned role '%s' to user %s in Keycloak in %v",
		job.ID, job.Args.RoleName, job.Args.UserID, duration)
	return nil
}

// ============================================================================
// Role Revocation Worker (revoke_keycloak_role)
// ============================================================================

// RevokeKeycloakRoleArgs defines the job arguments for role revocation
type RevokeKeycloakRoleArgs struct {
	UserID   string `json:"user_id"`
	RoleName string `json:"role_name"`
}

func (RevokeKeycloakRoleArgs) Kind() string { return "revoke_keycloak_role" }

func (RevokeKeycloakRoleArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "user_provisioning",
		MaxAttempts: 5,
		Priority:    1,
	}
}

// RevokeKeycloakRoleWorker revokes realm roles from users in Keycloak
type RevokeKeycloakRoleWorker struct {
	river.WorkerDefaults[RevokeKeycloakRoleArgs]
	dbPool         *pgxpool.Pool
	keycloakClient *KeycloakClient
}

func (w *RevokeKeycloakRoleWorker) Work(ctx context.Context, job *river.Job[RevokeKeycloakRoleArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting role revocation (attempt %d/%d): user=%s role=%s",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.UserID, job.Args.RoleName)

	err := w.keycloakClient.RemoveRealmRoles(ctx, job.Args.UserID, []string{job.Args.RoleName})
	if err != nil {
		return fmt.Errorf("revoke role failed: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] Revoked role '%s' from user %s in Keycloak in %v",
		job.ID, job.Args.RoleName, job.Args.UserID, duration)
	return nil
}
