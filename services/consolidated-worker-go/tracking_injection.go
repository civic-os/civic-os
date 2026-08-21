package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrRecipientSuppressed is returned when a recipient has unsubscribed from a bulk template
var ErrRecipientSuppressed = fmt.Errorf("recipient is suppressed (unsubscribed)")

// TrackingInjector handles tracking pixel/footer injection for bulk emails
type TrackingInjector struct {
	dbPool      *pgxpool.Pool
	trackingURL string

	// Cached notification_settings (TTL: 5 minutes)
	settingsMu     sync.Mutex
	cachedSettings *notificationSettings
	settingsTTL    time.Time
}

type notificationSettings struct {
	OrganizationAddress  string
	UnsubscribeReasonTxt string
	TrackingEnabled      bool
}

// NewTrackingInjector creates a new tracking injector
func NewTrackingInjector(dbPool *pgxpool.Pool, trackingURL string) *TrackingInjector {
	return &TrackingInjector{
		dbPool:      dbPool,
		trackingURL: strings.TrimRight(trackingURL, "/"),
	}
}

// getSettings loads notification_settings with 5-minute cache
func (ti *TrackingInjector) getSettings(ctx context.Context) (*notificationSettings, error) {
	ti.settingsMu.Lock()
	defer ti.settingsMu.Unlock()

	if ti.cachedSettings != nil && time.Now().Before(ti.settingsTTL) {
		return ti.cachedSettings, nil
	}

	var settings notificationSettings
	err := ti.dbPool.QueryRow(ctx, `
		SELECT
			COALESCE(organization_address, ''),
			COALESCE(unsubscribe_reason_text, 'You received this email based on your registration.'),
			tracking_enabled
		FROM metadata.notification_settings
		WHERE id = 1
	`).Scan(&settings.OrganizationAddress, &settings.UnsubscribeReasonTxt, &settings.TrackingEnabled)
	if err != nil {
		// Default to tracking enabled if no settings row
		settings.TrackingEnabled = true
		settings.UnsubscribeReasonTxt = "You received this email based on your registration."
	}

	ti.cachedSettings = &settings
	ti.settingsTTL = time.Now().Add(5 * time.Minute)
	return ti.cachedSettings, nil
}

// InjectTracking adds tracking pixel, CAN-SPAM footer, and generates a tracking token.
// Returns the tracking token UUID for use in List-Unsubscribe headers.
// Returns ErrRecipientSuppressed if the recipient has unsubscribed from this template.
func (ti *TrackingInjector) InjectTracking(
	ctx context.Context,
	recipientEmail string,
	templateName string,
	entityType string,
	entityID string,
	entityData json.RawMessage,
	rendered *RenderedNotification,
) (string, error) {
	settings, err := ti.getSettings(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to load tracking settings: %w", err)
	}

	// Master switch: skip all tracking if disabled
	if !settings.TrackingEnabled {
		return "", nil
	}

	// Check suppression: has recipient unsubscribed from this template?
	var suppressed bool
	err = ti.dbPool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM metadata.notification_tracking_tokens
			WHERE recipient_email = $1
			  AND template_name = $2
			  AND unsubscribed = TRUE
		)
	`, recipientEmail, templateName).Scan(&suppressed)
	if err == nil && suppressed {
		return "", ErrRecipientSuppressed
	}

	// Create tracking token
	var tokenID string
	err = ti.dbPool.QueryRow(ctx, `
		INSERT INTO metadata.notification_tracking_tokens
			(recipient_email, template_name, entity_type, entity_id, entity_data_snapshot)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id::text
	`, recipientEmail, templateName, entityType, entityID, entityData).Scan(&tokenID)
	if err != nil {
		return "", fmt.Errorf("failed to create tracking token: %w", err)
	}

	// Inject CAN-SPAM footer before </body>
	footer := ti.buildCANSPAMFooter(tokenID, settings)

	// Inject tracking pixel
	pixel := fmt.Sprintf(
		`<img src="%s/t/o?t=%s" width="1" height="1" alt="" style="display:block;height:1px;width:1px;overflow:hidden;" />`,
		ti.trackingURL, tokenID,
	)

	// Insert footer + pixel before </body> (case-insensitive)
	injection := footer + "\n" + pixel
	bodyIdx := strings.LastIndex(strings.ToLower(rendered.HTML), "</body>")
	if bodyIdx != -1 {
		rendered.HTML = rendered.HTML[:bodyIdx] + injection + "\n" + rendered.HTML[bodyIdx:]
	} else {
		// No </body> tag — append at end
		rendered.HTML += injection
	}

	// Warn if org address not configured
	if settings.OrganizationAddress == "" {
		log.Printf("[TrackingInjector] WARNING: organization_address not configured in notification_settings. CAN-SPAM requires a physical address in bulk emails.")
	}

	return tokenID, nil
}

// buildCANSPAMFooter generates the compliance footer HTML
func (ti *TrackingInjector) buildCANSPAMFooter(tokenID string, settings *notificationSettings) string {
	unsubLink := fmt.Sprintf("%s/t/u?t=%s", ti.trackingURL, tokenID)

	var addressLine string
	if settings.OrganizationAddress != "" {
		addressLine = fmt.Sprintf(`<p style="margin:0; color:#a1a1aa;">%s</p>`, settings.OrganizationAddress)
	}

	return fmt.Sprintf(`<div style="margin-top:32px; padding-top:16px; border-top:1px solid #e4e4e7; text-align:center; font-size:12px; color:#a1a1aa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <p style="margin:0 0 8px;">%s</p>
  <p style="margin:0 0 8px;">
    <a href="%s" style="color:#71717a; text-decoration:underline;">Unsubscribe</a>
  </p>
  %s
</div>`, settings.UnsubscribeReasonTxt, unsubLink, addressLine)
}

// BuildListUnsubscribeHeaders returns the RFC 8058 headers for a bulk email
func (ti *TrackingInjector) BuildListUnsubscribeHeaders(tokenID string) map[string]string {
	if tokenID == "" {
		return nil
	}
	return map[string]string{
		"List-Unsubscribe":      fmt.Sprintf("<%s/t/u?t=%s>", ti.trackingURL, tokenID),
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	}
}
