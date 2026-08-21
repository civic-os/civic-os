package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// 1x1 transparent GIF (43 bytes — smallest valid GIF89a)
var transparentGIF = []byte{
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
	0x01, 0x00, 0x01, 0x00, // 1x1
	0x80, 0x00, 0x00, // GCT flag, 1 color
	0xff, 0xff, 0xff, // white
	0x00, 0x00, 0x00, // black (transparent)
	0x21, 0xf9, 0x04, // GCE
	0x01, 0x00, 0x00, 0x00, 0x00, // transparent index 0
	0x2c, 0x00, 0x00, 0x00, 0x00, // image descriptor
	0x01, 0x00, 0x01, 0x00, 0x00, // 1x1
	0x02, 0x02, 0x44, 0x01, 0x00, // LZW min code size, data
	0x3b, // trailer
}

// Known bot user-agent substrings for open tracking
var knownBotUAs = []string{
	"GoogleImageProxy",
	"YahooMailProxy",
	"ms-office",
	"Barracuda",
	"ZmImgProxy",        // Zimbra
	"Outlook-iOS",       // Outlook prefetch
	"Microsoft Outlook", // Desktop Outlook link preview
}

// TrackingServer handles inbound tracking callbacks (open, click, unsubscribe)
type TrackingServer struct {
	dbPool      *pgxpool.Pool
	trackingURL string // public-facing base URL for tracking links
	port        string // bind port
	server      *http.Server
}

// NewTrackingServer creates a new tracking HTTP server
func NewTrackingServer(dbPool *pgxpool.Pool, trackingURL, port string) *TrackingServer {
	return &TrackingServer{
		dbPool:      dbPool,
		trackingURL: strings.TrimRight(trackingURL, "/"),
		port:        port,
	}
}

// Start begins serving tracking endpoints. Blocks until server stops.
func (ts *TrackingServer) Start() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", ts.handleHealth)
	mux.HandleFunc("GET /t/o", ts.handleOpen)
	mux.HandleFunc("GET /t/c", ts.handleClick)
	mux.HandleFunc("POST /t/u", ts.handleUnsubscribeRFC8058)
	mux.HandleFunc("GET /t/u", ts.handleUnsubscribePage)

	ts.server = &http.Server{
		Addr:         net.JoinHostPort("", ts.port),
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  30 * time.Second,
	}

	log.Printf("[TrackingServer] Listening on :%s (public URL: %s)", ts.port, ts.trackingURL)
	if err := ts.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("[TrackingServer] Error: %v", err)
	}
}

// Shutdown gracefully stops the server
func (ts *TrackingServer) Shutdown(ctx context.Context) {
	if ts.server != nil {
		if err := ts.server.Shutdown(ctx); err != nil {
			log.Printf("[TrackingServer] Shutdown error: %v", err)
		}
		log.Println("[TrackingServer] Stopped")
	}
}

// handleHealth returns 200 OK for health checks
func (ts *TrackingServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

// handleOpen processes open tracking pixels (GET /t/o?t={token})
func (ts *TrackingServer) handleOpen(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")

	// Always return GIF regardless of token validity (don't leak existence)
	defer func() {
		w.Header().Set("Content-Type", "image/gif")
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		w.WriteHeader(http.StatusOK)
		w.Write(transparentGIF)
	}()

	if token == "" {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	// Validate token exists and get created_at for bot detection
	var createdAt time.Time
	err := ts.dbPool.QueryRow(ctx, `
		SELECT created_at FROM metadata.notification_tracking_tokens WHERE id = $1
	`, token).Scan(&createdAt)
	if err != nil {
		return // Invalid token — still return GIF
	}

	// Rate limit: deduplicate opens within 1-minute window
	var recentOpen bool
	err = ts.dbPool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM metadata.notification_events
			WHERE tracking_token = $1
			  AND event_type = 'open'
			  AND created_at > NOW() - INTERVAL '1 minute'
		)
	`, token).Scan(&recentOpen)
	if err == nil && recentOpen {
		return // Duplicate within window
	}

	// Bot detection
	suspectedBot := ts.detectBot(createdAt, r.UserAgent())

	// Record event
	ipAddr := extractIP(r)
	_, _ = ts.dbPool.Exec(ctx, `
		INSERT INTO metadata.notification_events
			(tracking_token, event_type, ip_address, user_agent, suspected_bot)
		VALUES ($1, 'open', $2, $3, $4)
	`, token, ipAddr, r.UserAgent(), suspectedBot)
}

// handleClick processes click tracking (GET /t/c?t={token}&u={base64url})
func (ts *TrackingServer) handleClick(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	encodedURL := r.URL.Query().Get("u")

	if token == "" || encodedURL == "" {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	// Decode target URL
	targetBytes, err := base64.URLEncoding.DecodeString(encodedURL)
	if err != nil {
		// Try without padding
		targetBytes, err = base64.RawURLEncoding.DecodeString(encodedURL)
		if err != nil {
			http.Error(w, "Invalid URL encoding", http.StatusBadRequest)
			return
		}
	}
	targetURL := string(targetBytes)

	// Validate URL scheme (prevent open redirect attacks)
	if !isAllowedScheme(targetURL) {
		http.Error(w, "Invalid URL scheme", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	// Validate token
	var exists bool
	err = ts.dbPool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM metadata.notification_tracking_tokens WHERE id = $1)
	`, token).Scan(&exists)
	if err != nil || !exists {
		// Redirect anyway (don't block user navigation)
		http.Redirect(w, r, targetURL, http.StatusFound)
		return
	}

	// Record click event
	ipAddr := extractIP(r)
	_, _ = ts.dbPool.Exec(ctx, `
		INSERT INTO metadata.notification_events
			(tracking_token, event_type, event_data, ip_address, user_agent, suspected_bot)
		VALUES ($1, 'click', $2, $3, $4, FALSE)
	`, token, fmt.Sprintf(`{"url":"%s"}`, strings.ReplaceAll(targetURL, `"`, `\"`)), ipAddr, r.UserAgent())

	http.Redirect(w, r, targetURL, http.StatusFound)
}

// handleUnsubscribeRFC8058 handles POST /t/u?t={token} per RFC 8058
func (ts *TrackingServer) handleUnsubscribeRFC8058(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	if token == "" {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	// RFC 8058 requires List-Unsubscribe=One-Click in POST body
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if r.PostFormValue("List-Unsubscribe") != "One-Click" {
		http.Error(w, "Missing List-Unsubscribe=One-Click", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if ts.processUnsubscribe(ctx, token, extractIP(r), r.UserAgent()) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	} else {
		http.Error(w, "Invalid or expired token", http.StatusNotFound)
	}
}

// handleUnsubscribePage renders a visible unsubscribe page (GET /t/u?t={token})
func (ts *TrackingServer) handleUnsubscribePage(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	if token == "" {
		ts.renderUnsubscribePage(w, "Invalid request", false)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	// Get template description for the confirmation message
	var templateDesc string
	err := ts.dbPool.QueryRow(ctx, `
		SELECT COALESCE(nt.description, ntt.template_name)
		FROM metadata.notification_tracking_tokens ntt
		LEFT JOIN metadata.notification_templates nt ON nt.name = ntt.template_name
		WHERE ntt.id = $1
	`, token).Scan(&templateDesc)
	if err != nil {
		ts.renderUnsubscribePage(w, "This unsubscribe link is invalid or has expired.", false)
		return
	}

	if ts.processUnsubscribe(ctx, token, extractIP(r), r.UserAgent()) {
		msg := fmt.Sprintf("You have been unsubscribed from \"%s\" emails.", templateDesc)
		ts.renderUnsubscribePage(w, msg, true)
	} else {
		ts.renderUnsubscribePage(w, "This unsubscribe link is invalid or has expired.", false)
	}
}

// processUnsubscribe marks a token as unsubscribed and records the event.
// Returns true if the token was found and processed.
func (ts *TrackingServer) processUnsubscribe(ctx context.Context, token, ipAddr, userAgent string) bool {
	// Set unsubscribed = TRUE
	tag, err := ts.dbPool.Exec(ctx, `
		UPDATE metadata.notification_tracking_tokens
		SET unsubscribed = TRUE
		WHERE id = $1
	`, token)
	if err != nil || tag.RowsAffected() == 0 {
		return false
	}

	// Record unsubscribe event
	_, _ = ts.dbPool.Exec(ctx, `
		INSERT INTO metadata.notification_events
			(tracking_token, event_type, ip_address, user_agent, suspected_bot)
		VALUES ($1, 'unsubscribe', $2, $3, FALSE)
	`, token, ipAddr, userAgent)

	return true
}

// renderUnsubscribePage renders a simple HTML confirmation/error page
func (ts *TrackingServer) renderUnsubscribePage(w http.ResponseWriter, message string, success bool) {
	statusColor := "#dc2626" // red
	statusIcon := "&#10007;" // ✗
	if success {
		statusColor = "#16a34a" // green
		statusIcon = "&#10003;" // ✓
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Preferences</title>
  <style>
    body { margin:0; padding:40px 16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f4f4f5; color:#27272a; }
    .card { max-width:480px; margin:0 auto; background:#fff; border-radius:12px; padding:40px 32px; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
    .icon { font-size:48px; color:%s; margin-bottom:16px; }
    h1 { font-size:20px; font-weight:600; margin:0 0 12px; }
    p { font-size:15px; color:#71717a; line-height:1.5; margin:0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">%s</div>
    <h1>Email Preferences</h1>
    <p>%s</p>
  </div>
</body>
</html>`, statusColor, statusIcon, message)
}

// detectBot applies heuristics to determine if a request is from an automated system
func (ts *TrackingServer) detectBot(tokenCreatedAt time.Time, userAgent string) bool {
	// Heuristic 1: Timing — opens within 5 seconds of send are likely prefetch bots
	if time.Since(tokenCreatedAt) < 5*time.Second {
		return true
	}

	// Heuristic 2: Known bot user-agents
	uaLower := strings.ToLower(userAgent)
	for _, botUA := range knownBotUAs {
		if strings.Contains(uaLower, strings.ToLower(botUA)) {
			return true
		}
	}

	return false
}

// isAllowedScheme validates URL scheme for click tracking redirects
func isAllowedScheme(rawURL string) bool {
	lower := strings.ToLower(strings.TrimSpace(rawURL))
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// extractIP gets the client IP from X-Forwarded-For or RemoteAddr
func extractIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first (client) IP
		if idx := strings.IndexByte(xff, ','); idx != -1 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	// Strip port from RemoteAddr
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
