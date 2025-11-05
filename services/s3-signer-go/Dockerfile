# =============================================================================
# Build Stage
# =============================================================================
FROM golang:1.24-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the application
# CGO_ENABLED=0 for static binary (no libc dependency)
# -ldflags="-w -s" strips debug info for smaller binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o s3-signer .

# =============================================================================
# Runtime Stage
# =============================================================================
FROM alpine:3.20

# Install CA certificates for HTTPS requests to AWS
RUN apk --no-cache add ca-certificates

# Create non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/s3-signer .

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port (not used, but good practice for documentation)
# This service doesn't listen on HTTP, it's a worker
EXPOSE 8080

# Health check (optional - check if process is running)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ps aux | grep -v grep | grep -q s3-signer || exit 1

# Run the service
CMD ["./s3-signer"]
