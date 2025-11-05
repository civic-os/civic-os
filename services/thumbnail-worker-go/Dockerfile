# =============================================================================
# Build Stage
# =============================================================================
FROM golang:1.24-alpine AS builder

# Install build dependencies
# - vips-dev: libvips headers and development files for bimg
# - build-base: gcc, g++, make for CGO compilation
# - git: for go mod download
RUN apk add --no-cache \
    vips-dev \
    build-base \
    git

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the application with CGO enabled (required for bimg/libvips)
# -ldflags="-w -s" strips debug info for smaller binary
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-w -s" -o thumbnail-worker .

# =============================================================================
# Runtime Stage
# =============================================================================
FROM alpine:3.20

# Install runtime dependencies
# - ca-certificates: for HTTPS requests to AWS
# - vips: libvips runtime library (no dev files)
# - poppler-utils: pdftoppm for PDF to image conversion
RUN apk --no-cache add \
    ca-certificates \
    vips \
    poppler-utils

# Create non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/thumbnail-worker .

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port (not used, but good practice for documentation)
# This service doesn't listen on HTTP, it's a worker
EXPOSE 8080

# Health check (check if process is running)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ps aux | grep -v grep | grep -q thumbnail-worker || exit 1

# Run the service
CMD ["./thumbnail-worker"]
