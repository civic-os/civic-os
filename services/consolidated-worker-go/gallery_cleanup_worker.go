// Copyright (C) 2023-2026 Civic OS, L3C. Licensed under AGPL-3.0-or-later.

package main

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ============================================================================
// Gallery Cleanup Cron Job
//
// Runs daily at ~3:00 AM to clean up orphaned draft photo galleries.
// Draft galleries with no associated entity that haven't been updated in
// 12 hours are assumed abandoned and deleted by the metadata.cleanup_draft_galleries()
// PostgreSQL function (in metadata schema, hidden from PostgREST).
//
// ARCHITECTURE: Uses a Go ticker (like ScheduledJobScheduler) rather than
// River periodic jobs. This ensures only consolidated-worker runs the cleanup,
// avoiding leader election issues with payment-worker.
// ============================================================================

// GalleryCleanupCron runs cleanup_draft_galleries() once daily at approximately 3:00 AM.
type GalleryCleanupCron struct {
	dbPool *pgxpool.Pool
	done   chan bool
}

// Start launches the gallery cleanup goroutine. It calculates the duration
// until the next 3:00 AM, sleeps until then, runs cleanup, and repeats every
// 24 hours thereafter.
func (g *GalleryCleanupCron) Start(ctx context.Context) {
	g.done = make(chan bool)

	go func() {
		// Calculate time until next 3:00 AM
		now := time.Now()
		next3AM := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, now.Location())
		if !next3AM.After(now) {
			// Already past 3 AM today, schedule for tomorrow
			next3AM = next3AM.Add(24 * time.Hour)
		}
		initialDelay := time.Until(next3AM)

		log.Printf("[GalleryCleanup] Next run scheduled at %s (in %s)",
			next3AM.Format("2006-01-02 15:04:05"), initialDelay.Round(time.Minute))

		// Wait for initial delay or shutdown
		timer := time.NewTimer(initialDelay)
		defer timer.Stop()

		select {
		case <-timer.C:
			// Initial delay elapsed, run cleanup
			g.runCleanup(ctx)
		case <-g.done:
			return
		case <-ctx.Done():
			return
		}

		// After first run, tick every 24 hours
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				g.runCleanup(ctx)
			case <-g.done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	log.Println("[GalleryCleanup] Started - runs daily at ~3:00 AM")
}

// Stop gracefully shuts down the gallery cleanup goroutine.
func (g *GalleryCleanupCron) Stop() {
	if g.done != nil {
		close(g.done)
	}
	log.Println("[GalleryCleanup] Stopped")
}

// runCleanup calls metadata.cleanup_draft_galleries() and logs the result.
func (g *GalleryCleanupCron) runCleanup(ctx context.Context) {
	log.Println("[GalleryCleanup] Running draft gallery cleanup...")

	var deletedCount int
	err := g.dbPool.QueryRow(ctx, "SELECT metadata.cleanup_draft_galleries()").Scan(&deletedCount)
	if err != nil {
		log.Printf("[GalleryCleanup] Error executing cleanup_draft_galleries(): %v", err)
		return
	}

	if deletedCount > 0 {
		log.Printf("[GalleryCleanup] Cleaned up %d orphaned draft galleries", deletedCount)
	} else {
		log.Println("[GalleryCleanup] No orphaned draft galleries found")
	}
}
