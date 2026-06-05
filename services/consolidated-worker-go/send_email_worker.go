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

// SendEmailArgs defines the job arguments for multi-recipient email
type SendEmailArgs struct {
	To           []string        `json:"to"`
	CC           []string        `json:"cc"`
	TemplateName string          `json:"template_name"`
	EntityType   string          `json:"entity_type"`
	EntityID     string          `json:"entity_id"`
	EntityData   json.RawMessage `json:"entity_data"`
	ReplyTo      string          `json:"reply_to"`
}

// Kind returns the job type identifier
func (SendEmailArgs) Kind() string { return "send_email" }

// InsertOpts returns job insertion options
func (SendEmailArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "notifications",
		MaxAttempts: 5,
		Priority:    2, // Slightly lower than system notifications (priority 1)
	}
}

// SendEmailWorker implements the River Worker interface for multi-recipient email
type SendEmailWorker struct {
	river.WorkerDefaults[SendEmailArgs]
	dbPool     *pgxpool.Pool
	renderer   *Renderer
	smtpConfig *SMTPConfig
}

// Work executes the send_email job
func (w *SendEmailWorker) Work(ctx context.Context, job *river.Job[SendEmailArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting send_email job (attempt %d/%d): template=%s, to=%v, cc=%v",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.TemplateName,
		job.Args.To, job.Args.CC)

	// 1. Load template from database
	template, err := loadTemplateFromDB(ctx, w.dbPool, job.Args.TemplateName)
	if err != nil {
		// Template error is permanent — don't retry
		log.Printf("[Job %d] Template error: %v", job.ID, err)
		return nil
	}

	// 2. Build entity data (default to empty object if not provided)
	entityData := job.Args.EntityData
	if len(entityData) == 0 {
		entityData = json.RawMessage(`{}`)
	}

	// 3. Render template with entity data
	rendered, err := w.renderer.RenderTemplate(template, entityData)
	if err != nil {
		// Rendering error is permanent — don't retry
		log.Printf("[Job %d] Rendering error: %v", job.ID, err)
		return nil
	}

	// 4. Send email via SMTP with multi-recipient support
	err = sendEmailSMTP(w.smtpConfig, job.Args.To, job.Args.CC, rendered, job.Args.ReplyTo)
	if err != nil {
		if isTransientError(err) {
			log.Printf("[Job %d] Transient error, will retry: %v", job.ID, err)
			return err // River will retry
		}
		log.Printf("[Job %d] Permanent error, not retrying: %v", job.ID, err)
		return nil
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] ✓ Email sent successfully to=%v cc=%v in %v",
		job.ID, job.Args.To, job.Args.CC, duration)
	return nil
}

// ============================================================================
// Shared template loading (used by NotificationWorker and SendEmailWorker)
// ============================================================================

// loadTemplateFromDB fetches a notification template from the database.
// This is the shared implementation used by both NotificationWorker and SendEmailWorker.
func loadTemplateFromDB(ctx context.Context, dbPool *pgxpool.Pool, templateName string) (*NotificationTemplate, error) {
	var tmpl NotificationTemplate
	err := dbPool.QueryRow(ctx, `
		SELECT subject_template, html_template, text_template, COALESCE(sms_template, '')
		FROM metadata.notification_templates
		WHERE name = $1
	`, templateName).Scan(&tmpl.Subject, &tmpl.HTML, &tmpl.Text, &tmpl.SMS)

	if err != nil {
		return nil, fmt.Errorf("template '%s' not found: %w", templateName, err)
	}

	return &tmpl, nil
}

// ============================================================================
// Multi-recipient SMTP sending
// ============================================================================

// sendEmailSMTP sends an email via SMTP with support for multiple TO and CC recipients.
// This is a standalone function (not a method) so it can be used by SendEmailWorker
// without coupling to NotificationWorker.
func sendEmailSMTP(smtpConfig *SMTPConfig, to []string, cc []string, rendered *RenderedNotification, replyToOverride string) error {
	// Filter out test emails if configured
	var realTo []string
	for _, addr := range to {
		if smtpConfig.SkipTestEmails && isTestEmail(addr) {
			log.Printf("⚠️  Skipping test email in TO: %s (SkipTestEmails=true)", addr)
			continue
		}
		realTo = append(realTo, addr)
	}

	var realCC []string
	for _, addr := range cc {
		if smtpConfig.SkipTestEmails && isTestEmail(addr) {
			log.Printf("⚠️  Skipping test email in CC: %s (SkipTestEmails=true)", addr)
			continue
		}
		realCC = append(realCC, addr)
	}

	// If all TO addresses were filtered out, nothing to send
	if len(realTo) == 0 {
		log.Printf("⚠️  All TO addresses were test emails — skipping send")
		return nil
	}

	// Parse RFC 5322 format for From header vs SMTP envelope
	headerFrom, envelopeFrom := parseEmailAddress(smtpConfig.From)

	// Extract domain for Message-ID
	domain := "localhost"
	if atIdx := strings.LastIndex(envelopeFrom, "@"); atIdx != -1 {
		domain = envelopeFrom[atIdx+1:]
	}

	// Generate unique values per message
	boundary := generateBoundary()
	messageID := generateMessageID(domain)

	// Build MIME email headers
	headers := make(map[string]string)
	headers["From"] = headerFrom
	headers["To"] = strings.Join(realTo, ", ")
	if len(realCC) > 0 {
		headers["Cc"] = strings.Join(realCC, ", ")
	}
	headers["Subject"] = rendered.Subject
	headers["Message-ID"] = messageID
	headers["MIME-Version"] = "1.0"
	headers["Content-Type"] = fmt.Sprintf("multipart/alternative; boundary=\"%s\"", boundary)
	headers["Date"] = time.Now().Format(time.RFC1123Z)

	// Add Reply-To header: per-call override takes precedence, then global config
	replyTo := replyToOverride
	if replyTo == "" {
		replyTo = smtpConfig.ReplyTo
	}
	if replyTo != "" {
		headers["Reply-To"] = replyTo
	}

	// Build email body
	var emailBody strings.Builder
	for key, value := range headers {
		emailBody.WriteString(fmt.Sprintf("%s: %s\r\n", key, value))
	}
	emailBody.WriteString("\r\n")

	// Plain text part
	emailBody.WriteString("--" + boundary + "\r\n")
	emailBody.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	emailBody.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	emailBody.WriteString(rendered.Text)
	emailBody.WriteString("\r\n\r\n")

	// HTML part
	emailBody.WriteString("--" + boundary + "\r\n")
	emailBody.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	emailBody.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	emailBody.WriteString(rendered.HTML)
	emailBody.WriteString("\r\n\r\n")

	emailBody.WriteString("--" + boundary + "--")

	// Connect to SMTP server
	serverAddr := net.JoinHostPort(smtpConfig.Host, smtpConfig.Port)
	conn, err := net.DialTimeout("tcp", serverAddr, 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect to SMTP server: %w", err)
	}

	client, err := smtp.NewClient(conn, smtpConfig.Host)
	if err != nil {
		return fmt.Errorf("failed to create SMTP client: %w", err)
	}
	defer client.Close()

	// Start TLS if supported (STARTTLS)
	if ok, _ := client.Extension("STARTTLS"); ok {
		tlsConfig := &tls.Config{
			ServerName: smtpConfig.Host,
			MinVersion: tls.VersionTLS12,
		}
		if err = client.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("STARTTLS failed: %w", err)
		}
	}

	// Authenticate if credentials provided
	if smtpConfig.Username != "" && smtpConfig.Password != "" {
		auth := smtp.PlainAuth("", smtpConfig.Username, smtpConfig.Password, smtpConfig.Host)
		if err = client.Auth(auth); err != nil {
			return fmt.Errorf("SMTP authentication failed: %w", err)
		}
	}

	// SMTP envelope: MAIL FROM
	if err = client.Mail(envelopeFrom); err != nil {
		return fmt.Errorf("MAIL FROM failed: %w", err)
	}

	// SMTP envelope: RCPT TO for all recipients (TO + CC)
	allRecipients := append(realTo, realCC...)
	for _, rcpt := range allRecipients {
		if err = client.Rcpt(rcpt); err != nil {
			return fmt.Errorf("RCPT TO failed for %s: %w", rcpt, err)
		}
	}

	// Send DATA
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
