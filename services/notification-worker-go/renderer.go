package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"regexp"
	textTemplate "text/template"
	"time"
)

// Renderer handles template parsing and rendering
type Renderer struct {
	siteURL  string
	timezone *time.Location
}

// NewRenderer creates a new Renderer instance
func NewRenderer(siteURL string, timezone *time.Location) *Renderer {
	return &Renderer{
		siteURL:  siteURL,
		timezone: timezone,
	}
}

// RenderedNotification holds rendered template parts
type RenderedNotification struct {
	Subject string
	HTML    string
	Text    string
	SMS     string
}

// RenderTemplate renders all parts of a notification template
func (r *Renderer) RenderTemplate(tmpl *NotificationTemplate, entityData json.RawMessage) (*RenderedNotification, error) {
	// Parse entity data
	var entity map[string]interface{}
	if err := json.Unmarshal(entityData, &entity); err != nil {
		return nil, fmt.Errorf("invalid entity data: %w", err)
	}

	// Build template context
	context := r.buildContext(entity)

	// Render subject
	subject, err := r.renderText(tmpl.Subject, context)
	if err != nil {
		return nil, fmt.Errorf("subject rendering failed: %w", err)
	}

	// Render HTML
	html, err := r.renderHTML(tmpl.HTML, context)
	if err != nil {
		return nil, fmt.Errorf("HTML rendering failed: %w", err)
	}

	// Render text
	text, err := r.renderText(tmpl.Text, context)
	if err != nil {
		return nil, fmt.Errorf("text rendering failed: %w", err)
	}

	// Render SMS (if present)
	sms := ""
	if tmpl.SMS != "" {
		sms, err = r.renderText(tmpl.SMS, context)
		if err != nil {
			return nil, fmt.Errorf("SMS rendering failed: %w", err)
		}
	}

	return &RenderedNotification{
		Subject: subject,
		HTML:    html,
		Text:    text,
		SMS:     sms,
	}, nil
}

// RenderTemplatePart renders a single template part with sample data
func (r *Renderer) RenderTemplatePart(templateStr string, isHTML bool, sampleEntityData json.RawMessage) (string, error) {
	// Parse entity data
	var entity map[string]interface{}
	if err := json.Unmarshal(sampleEntityData, &entity); err != nil {
		return "", fmt.Errorf("invalid sample entity data: %w", err)
	}

	// Build template context
	context := r.buildContext(entity)

	// Render based on type
	if isHTML {
		return r.renderHTML(templateStr, context)
	}
	return r.renderText(templateStr, context)
}

// ValidateTemplate validates template syntax without rendering
func (r *Renderer) ValidateTemplate(templateStr string, isHTML bool) error {
	if isHTML {
		// Parse as HTML template
		_, err := template.New("validation").
			Option("missingkey=zero").
			Funcs(template.FuncMap(r.getTemplateFuncs())).
			Parse(templateStr)
		if err != nil {
			return fmt.Errorf("invalid template syntax: %w", err)
		}
	} else {
		// Parse as text template
		_, err := textTemplate.New("validation").
			Option("missingkey=zero").
			Funcs(textTemplate.FuncMap(r.getTemplateFuncs())).
			Parse(templateStr)
		if err != nil {
			return fmt.Errorf("invalid template syntax: %w", err)
		}
	}
	return nil
}

// getTemplateFuncs returns custom functions available in templates
func (r *Renderer) getTemplateFuncs() template.FuncMap {
	return template.FuncMap{
		"formatTimeSlot": r.formatTimeSlot,
		"formatDateTime": r.formatDateTime,
		"formatDate":     r.formatDate,
		"formatMoney":    r.formatMoney,
		"formatPhone":    r.formatPhone,
	}
}

// formatTimeSlot formats tstzrange to human-readable date range
// Input: ["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")
// Output: "Mar 15, 2025 2:00 PM EST - 4:00 PM EST" (in configured timezone)
func (r *Renderer) formatTimeSlot(tstzrange string) string {
	// Parse the tstzrange format
	re := regexp.MustCompile(`\["?([^",]+)"?,\s*"?([^")]+)"?\)`)
	matches := re.FindStringSubmatch(tstzrange)
	if len(matches) < 3 {
		return tstzrange // Return raw if parse fails
	}

	// Parse timestamps (PostgreSQL returns timestamps with timezone offset)
	start, err1 := time.Parse("2006-01-02 15:04:05-07", matches[1])
	end, err2 := time.Parse("2006-01-02 15:04:05-07", matches[2])
	if err1 != nil || err2 != nil {
		return tstzrange
	}

	// Convert to configured timezone
	start = start.In(r.timezone)
	end = end.In(r.timezone)

	// Format based on same-day or multi-day
	sameDay := start.Format("2006-01-02") == end.Format("2006-01-02")

	if sameDay {
		// "Mar 15, 2025 2:00 PM EST - 4:00 PM EST"
		return fmt.Sprintf("%s %s - %s",
			start.Format("Jan 2, 2006"),
			start.Format("3:04 PM MST"),
			end.Format("3:04 PM MST"),
		)
	} else {
		// "Mar 15, 2025 2:00 PM EST - Mar 17, 2025 11:00 AM EST"
		return fmt.Sprintf("%s - %s",
			start.Format("Jan 2, 2006 3:04 PM MST"),
			end.Format("Jan 2, 2006 3:04 PM MST"),
		)
	}
}

// formatDateTime formats ISO timestamp to localized datetime
// Input: "2025-03-15T19:00:00Z"
// Output: "Mar 15, 2025 2:00 PM EST" (in configured timezone)
func (r *Renderer) formatDateTime(isoString string) string {
	t, err := time.Parse(time.RFC3339, isoString)
	if err != nil {
		return isoString
	}
	t = t.In(r.timezone)
	return t.Format("Jan 2, 2006 3:04 PM MST")
}

// formatDate formats ISO date to localized date
// Input: "2025-03-15"
// Output: "Mar 15, 2025"
func (r *Renderer) formatDate(dateString string) string {
	t, err := time.Parse("2006-01-02", dateString)
	if err != nil {
		return dateString
	}
	return t.Format("Jan 2, 2006")
}

// formatMoney formats money value
// Input: "$1,234.56" or 1234.56
// Output: "$1,234.56"
func (r *Renderer) formatMoney(value interface{}) string {
	// PostgreSQL money type comes as string "$1,234.56"
	if str, ok := value.(string); ok {
		return str // Already formatted by PostgreSQL
	}
	// Fallback for numeric values
	if num, ok := value.(float64); ok {
		return fmt.Sprintf("$%.2f", num)
	}
	return fmt.Sprintf("%v", value)
}

// formatPhone formats 10-digit phone to (XXX) XXX-XXXX
// Input: "5551234567"
// Output: "(555) 123-4567"
func (r *Renderer) formatPhone(phone string) string {
	// Remove any non-digit characters
	digits := regexp.MustCompile(`\D`).ReplaceAllString(phone, "")

	if len(digits) != 10 {
		return phone // Return original if not 10 digits
	}
	return fmt.Sprintf("(%s) %s-%s", digits[0:3], digits[3:6], digits[6:10])
}

// buildContext creates the template context with Entity and Metadata
func (r *Renderer) buildContext(entity map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"Entity": entity,
		"Metadata": map[string]string{
			"site_url": r.siteURL,
		},
	}
}

// renderText renders a text template (for subject, text body, SMS)
func (r *Renderer) renderText(templateStr string, context map[string]interface{}) (string, error) {
	tmpl, err := textTemplate.New("text").
		Option("missingkey=zero").
		Funcs(textTemplate.FuncMap(r.getTemplateFuncs())).
		Parse(templateStr)
	if err != nil {
		return "", fmt.Errorf("template parse error: %w", err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, context); err != nil {
		return "", fmt.Errorf("template execution error: %w", err)
	}

	return buf.String(), nil
}

// renderHTML renders an HTML template with XSS protection
func (r *Renderer) renderHTML(templateStr string, context map[string]interface{}) (string, error) {
	tmpl, err := template.New("html").
		Option("missingkey=zero").
		Funcs(template.FuncMap(r.getTemplateFuncs())).
		Parse(templateStr)
	if err != nil {
		return "", fmt.Errorf("template parse error: %w", err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, context); err != nil {
		return "", fmt.Errorf("template execution error: %w", err)
	}

	return buf.String(), nil
}
