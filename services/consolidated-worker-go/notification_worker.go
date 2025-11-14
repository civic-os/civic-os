package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/smtp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// NotificationArgs defines the job arguments structure
type NotificationArgs struct {
	NotificationID string          `json:"notification_id"`
	UserID         string          `json:"user_id"`
	TemplateName   string          `json:"template_name"`
	EntityType     string          `json:"entity_type"`
	EntityID       string          `json:"entity_id"`
	EntityData     json.RawMessage `json:"entity_data"`
	Channels       []string        `json:"channels"`
}

// Kind returns the job type identifier
func (NotificationArgs) Kind() string { return "send_notification" }

// InsertOpts returns job insertion options
func (NotificationArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "notifications",
		MaxAttempts: 5,
		Priority:    1,
	}
}

// SMTPConfig holds SMTP server configuration
type SMTPConfig struct {
	Host           string
	Port           string
	Username       string
	Password       string
	From           string
	SkipTestEmails bool // Skip sending to test/dummy email addresses (e.g., @example.com)
}

// NotificationWorker implements the River Worker interface
type NotificationWorker struct {
	river.WorkerDefaults[NotificationArgs]
	dbPool     *pgxpool.Pool
	renderer   *Renderer
	smtpConfig *SMTPConfig
}

// Work executes the notification job
func (w *NotificationWorker) Work(ctx context.Context, job *river.Job[NotificationArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting notification job (attempt %d/%d): notification_id=%s, template=%s",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.NotificationID, job.Args.TemplateName)

	// 1. Fetch user preferences and validate channels
	prefs, err := w.getUserPreferences(ctx, job.Args.UserID)
	if err != nil {
		log.Printf("[Job %d] Error fetching user preferences: %v", job.ID, err)
		return fmt.Errorf("failed to fetch user preferences: %w", err)
	}

	// 2. Load template from database
	template, err := w.loadTemplate(ctx, job.Args.TemplateName)
	if err != nil {
		// Template error is permanent - don't retry
		log.Printf("[Job %d] Template error: %v", job.ID, err)
		w.markNotificationFailed(ctx, job.Args.NotificationID, fmt.Sprintf("Template error: %v", err))
		return nil // Don't retry
	}

	// 3. Render template with entity data
	rendered, err := w.renderer.RenderTemplate(template, job.Args.EntityData)
	if err != nil {
		// Rendering error is permanent - don't retry
		log.Printf("[Job %d] Rendering error: %v", job.ID, err)
		w.markNotificationFailed(ctx, job.Args.NotificationID, fmt.Sprintf("Rendering error: %v", err))
		return nil // Don't retry
	}

	// 4. Send via requested channels (respecting preferences)
	var channelsSent []string
	var channelsFailed []string
	var lastError error

	for _, channel := range job.Args.Channels {
		// Check if user has this channel enabled
		if !prefs.IsEnabled(channel) {
			log.Printf("[Job %d] Skipping channel %s (disabled by user)", job.ID, channel)
			continue
		}

		switch channel {
		case "email":
			if err := w.sendEmail(ctx, prefs.Email, rendered); err != nil {
				log.Printf("[Job %d] Failed to send email: %v", job.ID, err)
				channelsFailed = append(channelsFailed, "email")
				lastError = err
			} else {
				channelsSent = append(channelsSent, "email")
			}

		case "sms":
			// Phase 2: SMS implementation
			log.Printf("[Job %d] SMS channel not yet implemented", job.ID)
			channelsFailed = append(channelsFailed, "sms")

		default:
			log.Printf("[Job %d] Unknown channel: %s", job.ID, channel)
		}
	}

	// 5. Update notification status
	if len(channelsSent) > 0 {
		w.markNotificationSent(ctx, job.Args.NotificationID, channelsSent, channelsFailed)
		duration := time.Since(startTime)
		log.Printf("[Job %d] ✓ Notification sent successfully via %v in %v", job.ID, channelsSent, duration)
		return nil
	} else {
		// All channels failed - retry if transient error
		errorMsg := fmt.Sprintf("All channels failed: %v", lastError)
		w.markNotificationFailed(ctx, job.Args.NotificationID, errorMsg)

		if isTransientError(lastError) {
			log.Printf("[Job %d] Transient error detected, will retry: %v", job.ID, lastError)
			return lastError // Retry
		}

		log.Printf("[Job %d] Permanent error detected, not retrying: %v", job.ID, lastError)
		return nil // Don't retry permanent errors
	}
}

// UserPreferences holds user notification preferences
type UserPreferences struct {
	Email        string
	EmailEnabled bool
	Phone        string
	SMSEnabled   bool
}

// IsEnabled checks if a channel is enabled for the user
func (p *UserPreferences) IsEnabled(channel string) bool {
	switch channel {
	case "email":
		return p.EmailEnabled && p.Email != ""
	case "sms":
		return p.SMSEnabled && p.Phone != ""
	default:
		return false
	}
}

// getUserPreferences fetches user notification preferences
func (w *NotificationWorker) getUserPreferences(ctx context.Context, userID string) (*UserPreferences, error) {
	var prefs UserPreferences

	// Get email preference
	err := w.dbPool.QueryRow(ctx, `
		SELECT enabled, email_address
		FROM metadata.notification_preferences
		WHERE user_id = $1 AND channel = 'email'
	`, userID).Scan(&prefs.EmailEnabled, &prefs.Email)

	if err != nil {
		// If no preferences found, fall back to user's primary email
		err = w.dbPool.QueryRow(ctx, `
			SELECT email FROM metadata.civic_os_users WHERE id = $1
		`, userID).Scan(&prefs.Email)

		if err != nil {
			return nil, fmt.Errorf("user not found: %w", err)
		}
		prefs.EmailEnabled = true // Default to enabled
	}

	// Future: Get SMS preference
	// For now, SMS is always disabled
	prefs.SMSEnabled = false

	return &prefs, nil
}

// NotificationTemplate holds template data
type NotificationTemplate struct {
	Subject string
	HTML    string
	Text    string
	SMS     string
}

// loadTemplate fetches template from database
func (w *NotificationWorker) loadTemplate(ctx context.Context, templateName string) (*NotificationTemplate, error) {
	var tmpl NotificationTemplate
	err := w.dbPool.QueryRow(ctx, `
		SELECT subject_template, html_template, text_template, COALESCE(sms_template, '')
		FROM metadata.notification_templates
		WHERE name = $1
	`, templateName).Scan(&tmpl.Subject, &tmpl.HTML, &tmpl.Text, &tmpl.SMS)

	if err != nil {
		return nil, fmt.Errorf("template '%s' not found: %w", templateName, err)
	}

	return &tmpl, nil
}

// sendEmail sends email via SMTP with STARTTLS
func (w *NotificationWorker) sendEmail(ctx context.Context, toEmail string, rendered *RenderedNotification) error {
	// Skip test/dummy email addresses if configured
	if w.smtpConfig.SkipTestEmails && isTestEmail(toEmail) {
		log.Printf("⚠️  Skipping test email: %s (SkipTestEmails=true)", toEmail)
		return nil // Return success to mark notification as sent (prevents retries)
	}

	// Build MIME email with multipart/alternative (HTML + plain text)
	headers := make(map[string]string)
	headers["From"] = w.smtpConfig.From
	headers["To"] = toEmail
	headers["Subject"] = rendered.Subject
	headers["MIME-Version"] = "1.0"
	headers["Content-Type"] = "multipart/alternative; boundary=\"boundary123\""
	headers["Date"] = time.Now().Format(time.RFC1123Z)

	// Build email body
	var emailBody strings.Builder
	for key, value := range headers {
		emailBody.WriteString(fmt.Sprintf("%s: %s\r\n", key, value))
	}
	emailBody.WriteString("\r\n")

	// Plain text part
	emailBody.WriteString("--boundary123\r\n")
	emailBody.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	emailBody.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	emailBody.WriteString(rendered.Text)
	emailBody.WriteString("\r\n\r\n")

	// HTML part
	emailBody.WriteString("--boundary123\r\n")
	emailBody.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	emailBody.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	emailBody.WriteString(rendered.HTML)
	emailBody.WriteString("\r\n\r\n")

	emailBody.WriteString("--boundary123--")

	// Connect to SMTP server
	serverAddr := net.JoinHostPort(w.smtpConfig.Host, w.smtpConfig.Port)
	conn, err := net.DialTimeout("tcp", serverAddr, 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect to SMTP server: %w", err)
	}

	client, err := smtp.NewClient(conn, w.smtpConfig.Host)
	if err != nil {
		return fmt.Errorf("failed to create SMTP client: %w", err)
	}
	defer client.Close()

	// Start TLS if supported (STARTTLS)
	if ok, _ := client.Extension("STARTTLS"); ok {
		tlsConfig := &tls.Config{
			ServerName: w.smtpConfig.Host,
			MinVersion: tls.VersionTLS12,
		}
		if err = client.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("STARTTLS failed: %w", err)
		}
	}

	// Authenticate if credentials provided
	if w.smtpConfig.Username != "" && w.smtpConfig.Password != "" {
		auth := smtp.PlainAuth("", w.smtpConfig.Username, w.smtpConfig.Password, w.smtpConfig.Host)
		if err = client.Auth(auth); err != nil {
			return fmt.Errorf("SMTP authentication failed: %w", err)
		}
	}

	// Send email
	if err = client.Mail(w.smtpConfig.From); err != nil {
		return fmt.Errorf("MAIL FROM failed: %w", err)
	}

	if err = client.Rcpt(toEmail); err != nil {
		return fmt.Errorf("RCPT TO failed: %w", err)
	}

	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("DATA command failed: %w", err)
	}

	_, err = writer.Write([]byte(emailBody.String()))
	if err != nil {
		writer.Close()
		return fmt.Errorf("failed to write email body: %w", err)
	}

	err = writer.Close()
	if err != nil {
		return fmt.Errorf("failed to close DATA writer: %w", err)
	}

	if err = client.Quit(); err != nil {
		log.Printf("Warning: QUIT command failed: %v", err)
	}

	return nil
}

// isTestEmail detects RFC 2606 reserved test/documentation domains
func isTestEmail(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))

	// RFC 2606 reserved documentation domains (should never receive real email)
	testDomains := []string{
		"@example.com",
		"@example.org",
		"@example.net",
	}

	for _, domain := range testDomains {
		if strings.HasSuffix(email, domain) {
			return true
		}
	}

	return false
}

// markNotificationSent updates notification status to 'sent'
func (w *NotificationWorker) markNotificationSent(ctx context.Context, notificationID string, channelsSent, channelsFailed []string) {
	_, err := w.dbPool.Exec(ctx, `
		UPDATE metadata.notifications
		SET status = 'sent',
			sent_at = NOW(),
			channels_sent = $2,
			channels_failed = $3
		WHERE id = $1
	`, notificationID, channelsSent, channelsFailed)

	if err != nil {
		log.Printf("Failed to update notification status: %v", err)
	}
}

// markNotificationFailed updates notification status to 'failed'
func (w *NotificationWorker) markNotificationFailed(ctx context.Context, notificationID string, errorMsg string) {
	_, err := w.dbPool.Exec(ctx, `
		UPDATE metadata.notifications
		SET status = 'failed',
			error_message = $2
		WHERE id = $1
	`, notificationID, errorMsg)

	if err != nil {
		log.Printf("Failed to update notification status: %v", err)
	}
}

// isTransientError determines if error should trigger retry
func isTransientError(err error) bool {
	if err == nil {
		return false
	}

	// Network errors, timeouts, rate limits = retry
	// Invalid email, template errors = don't retry

	errStr := strings.ToLower(err.Error())

	// Transient errors (should retry)
	transientKeywords := []string{
		"timeout",
		"connection",
		"rate limit",
		"throttl",
		"temporary",
		"unavailable",
		"network",
		"dial",
		"refused",
	}

	for _, keyword := range transientKeywords {
		if strings.Contains(errStr, keyword) {
			return true
		}
	}

	// Permanent errors (don't retry)
	permanentKeywords := []string{
		"invalid",
		"not found",
		"template",
		"malformed",
		"bounce",
		"complaint",
		"suppression",
		"authentication failed",
		"bad credentials",
	}

	for _, keyword := range permanentKeywords {
		if strings.Contains(errStr, keyword) {
			return false
		}
	}

	// Default to retry (conservative approach)
	return true
}
