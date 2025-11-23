# =============================================================================
# Build Stage
# =============================================================================
FROM golang:1.24-alpine AS builder

# Install build dependencies for CGO (required by pgx)
RUN apk add --no-cache \
    build-base \
    git

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod go.sum* ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Accept version as build argument
ARG VERSION=dev

# Build the application
# -ldflags="-w -s" strips debug info for smaller binary
# -X 'main.version' injects version at compile time
RUN CGO_ENABLED=1 GOOS=linux go build \
    -ldflags="-w -s -X 'main.version=${VERSION}'" \
    -o payment-worker .

# =============================================================================
# Runtime Stage
# =============================================================================
FROM alpine:3.20

# Install runtime dependencies
# - ca-certificates: for HTTPS requests to Stripe API
# - tzdata: for timezone support
RUN apk --no-cache add \
    ca-certificates \
    tzdata

# Create non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/payment-worker .

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Health check (check if process is running)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ps aux | grep -v grep | grep -q payment-worker || exit 1

# Run the service
CMD ["./payment-worker"]
