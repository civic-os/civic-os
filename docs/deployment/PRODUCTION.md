# Civic OS - Production Deployment Guide

This guide covers deploying Civic OS to production environments using Docker containers.

**Audience**: DevOps engineers, system administrators, and deployment engineers setting up Civic OS in production.

**Related Documentation**:
- `docs/INTEGRATOR_GUIDE.md` - Metadata configuration, database patterns, and system administration
- `CLAUDE.md` - Developer quick-reference for building applications
- `docs/AUTHENTICATION.md` - Keycloak setup and RBAC configuration

**License**: This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (C) 2023-2025 Civic OS, L3C. See the LICENSE file for full terms.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Deployment Architecture](#deployment-architecture)
4. [Environment Configuration](#environment-configuration)
5. [Docker Compose Deployment](#docker-compose-deployment)
6. [Kubernetes Deployment](#kubernetes-deployment)
7. [Database Migrations](#database-migrations)
8. [SSL/TLS Configuration](#ssltls-configuration)
9. [Database Backups](#database-backups)
10. [Monitoring & Logging](#monitoring--logging)
11. [Security Best Practices](#security-best-practices)
12. [Troubleshooting](#troubleshooting)

---

## Overview

Civic OS uses a containerized architecture with six main components:

1. **Frontend** - Angular SPA served by nginx
2. **PostgREST** - REST API layer with JWT authentication
3. **Migrations** - Sqitch-based database schema migrations (runs before PostgREST)
4. **PostgreSQL** - Database with PostGIS extensions
5. **S3 Signer** - Go microservice that generates presigned upload URLs via River job queue
6. **Thumbnail Worker** - Go microservice that generates image/PDF thumbnails via River job queue

**Optional Components** (feature-specific):
7. **Payment Worker** - Go microservice for Stripe payment processing with HTTP webhook endpoint (port 8080)
   - Only required if using payment processing features
   - Handles payment intent creation via River job queue
   - Exposes HTTP endpoint for Stripe webhook callbacks with signature verification
   - Requires `STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET` environment variables

All components are configured via environment variables, enabling the same container images to run across dev, staging, and production environments.

**Version Compatibility**: The migrations container version MUST match the frontend/postgrest versions to ensure schema compatibility with the application.

---

## Prerequisites

### Required
- **Docker** 20.10+ with Docker Compose
- **PostgreSQL** database (or use provided container)
- **Keycloak** instance for authentication
- **Domain name** with DNS configured
- **SSL/TLS certificates** (Let's Encrypt recommended)

### Recommended
- **Reverse proxy** (nginx, Traefik, or Caddy)
- **Container orchestration** (Kubernetes, Docker Swarm)
- **Monitoring stack** (Prometheus + Grafana)
- **Backup solution** (pg_dump automated backups)

### Database Setup

Before deploying Civic OS, the PostgreSQL database must have the `authenticator` role:

```bash
# Connect to your database
psql postgres://superuser:password@db.example.com:5432/postgres

# Create the authenticator role (required once per cluster)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'your-secure-password';
  END IF;
END $$;

# Grant connection to your application database
GRANT CONNECT ON DATABASE civic_os_prod TO authenticator;
```

**Security Best Practices:**
- Generate strong password: `openssl rand -base64 32`
- Store password in secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)
- Use connection pooling (PgBouncer) in production
- The `web_anon` and `authenticated` roles are created automatically by migrations

**Multi-Tenant Note:** If running multiple Civic OS instances on the same PostgreSQL cluster, the `authenticator`, `web_anon`, and `authenticated` roles are shared. Create the authenticator role once, then run migrations for each database/schema.

---

## Deployment Architecture

### Basic Architecture (Docker Compose)

```
┌─────────────────────────────────────┐
│  Internet / Stripe Webhooks         │
└──────────────┬──────────────────────┘
               │
         ┌─────▼─────┐
         │  nginx    │  (Reverse Proxy + SSL)
         │  Port 443 │
         └─────┬─────┘
               │
      ┌────────┴────────────────┐
      │                 │       │
┌─────▼─────┐    ┌─────▼─────┐ │
│ Frontend  │    │ PostgREST │ │
│ Port 80   │    │ Port 3000 │ │
└───────────┘    └─────┬─────┘ │
                       │       │
                ┌──────▼───────▼──────┐
                │ PostgreSQL          │
                │ Port 5432           │
                └──────┬──────────────┘
                       │
              ┌────────┴────────┐
              │                 │
        ┌─────▼─────┐    ┌─────▼──────────┐
        │Consolidated│   │Payment Worker  │
        │Worker (Go) │   │(Go + HTTP)     │
        │           │    │Port 8080       │
        └───────────┘    │(Optional)      │
                         └────────────────┘
```
**Note**: Payment Worker is optional and only required if using payment processing features.

### High-Availability Architecture (Kubernetes)

```
┌────────────────────────────────────────┐
│  Load Balancer (Ingress)              │
│  SSL Termination                       │
└────────────┬───────────────────────────┘
             │
    ┌────────┴────────────────┐
    │         │                │
┌───▼────┐  ┌▼────────┐  ┌───▼────────┐
│Frontend│  │PostgREST│  │Payment HTTP│
│ (3x)   │  │  (3x)   │  │  (2x)      │
└────────┘  └────┬────┘  └─────┬──────┘
                 │              │
          ┌──────▼──────────────▼──────┐
          │ PostgreSQL                 │
          │ (StatefulSet + PVC)        │
          └──────┬─────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
  ┌─────▼─────┐    ┌─────▼─────┐
  │Consolidated│   │Payment     │
  │Worker (3x) │   │Worker (2x) │
  └────────────┘   └────────────┘
```
**Note**: Payment Worker components are optional and only required if using payment processing features.

---

## Environment Configuration

### Required Environment Variables

Create a `.env` file with the following configuration:

```bash
# ======================================
# Database Configuration
# ======================================
POSTGRES_DB=civic_os_prod
POSTGRES_PASSWORD=CHANGEME_SECURE_PASSWORD_HERE
POSTGRES_PORT=5432

# ======================================
# PostgREST Configuration
# ======================================
POSTGREST_PORT=3000
POSTGREST_PUBLIC_URL=https://api.yourdomain.com
POSTGREST_LOG_LEVEL=warn

# ======================================
# Keycloak Configuration
# ======================================
KEYCLOAK_URL=https://auth.yourdomain.com
KEYCLOAK_REALM=production
KEYCLOAK_CLIENT_ID=civic-os-prod

# ======================================
# Frontend Configuration
# ======================================
FRONTEND_PORT=80
FRONTEND_POSTGREST_URL=https://api.yourdomain.com/
SWAGGER_URL=https://api.yourdomain.com:8080  # Swagger UI for API docs link in About modal

# Map Configuration (Optional)
MAP_DEFAULT_LAT=43.0125
MAP_DEFAULT_LNG=-83.6875
MAP_DEFAULT_ZOOM=13

# ======================================
# S3 / File Storage Configuration
# (Required for v0.10.0+ file upload features)
# ======================================
# Public-facing S3 endpoint (used by frontend for downloads)
S3_PUBLIC_ENDPOINT=https://s3.yourdomain.com
S3_BUCKET=civic-os-files-prod

# AWS SDK configuration (for consolidated-worker microservice)
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_REGION=us-east-1
S3_ENDPOINT=  # Leave empty for real AWS S3, set for MinIO/S3-compatible storage

# Thumbnail Worker Configuration
THUMBNAIL_MAX_WORKERS=5  # Concurrent workers (tune based on CPU/memory)
# Tuning: Low memory (512Mi)=2-3, Medium (1Gi)=5-7, High (2Gi)=10-12

# ======================================
# Payment Worker Configuration (Optional)
# Required only if using payment processing features
# ======================================
# Stripe API credentials (get from https://dashboard.stripe.com/apikeys)
STRIPE_API_KEY=sk_live_your_secret_key  # CRITICAL: Use live keys in production
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret  # From Stripe webhook configuration

# Payment processing configuration
PAYMENT_CURRENCY=USD  # Default: USD
PAYMENT_WORKER_COUNT=1  # River workers for payment intent creation
PAYMENT_WORKER_DB_MAX_CONNS=4  # Database connection pool size

# Webhook HTTP server configuration
WEBHOOK_PORT=8080  # Internal port for Stripe webhook callbacks

# ======================================
# Container Registry
# ======================================
GITHUB_ORG=your-github-org
VERSION=0.3.0  # Pin to specific version for stability
```

### Security Considerations

**CRITICAL**: Change these before production deployment:
- `POSTGRES_PASSWORD` - Use a strong, randomly generated password (32+ characters)
- `KEYCLOAK_CLIENT_ID` - Create a production-specific client
- `KEYCLOAK_REALM` - Use a dedicated production realm

**Generate secure passwords:**
```bash
# Generate 32-character random password
openssl rand -base64 32
```

---

## Docker Compose Deployment

> **Version Note:** Examples in this guide use placeholder versions (e.g., `v0.X.0`). Replace with the [latest release version](https://github.com/civic-os/civic-os-frontend/releases) or use `latest` tag for non-production environments.

### Step 1: Prepare Environment

```bash
# Clone repository
git clone https://github.com/your-org/civic-os-frontend.git
cd civic-os-frontend

# Create production environment file
cp .env.example .env
nano .env  # Edit with production values
```

### Step 2: Initialize Database

```bash
# Create init-scripts directory for your schema
mkdir -p production/init-scripts

# Copy core Civic OS scripts
cp -r postgres production/

# Add your application schema
cp your-schema.sql production/init-scripts/01_schema.sql
cp your-permissions.sql production/init-scripts/02_permissions.sql
```

### Step 3: Pull Container Images

```bash
# Pull specific version (recommended for production)
docker pull ghcr.io/civic-os/frontend:latest
docker pull ghcr.io/civic-os/postgrest:latest

# Or build locally
docker build -t civic-os-frontend:latest -f docker/frontend/Dockerfile .
docker build -t civic-os-postgrest:latest -f docker/postgrest/Dockerfile .
```

### Step 4: Start Services

```bash
# Start all services
docker-compose -f docker-compose.prod.yml up -d

# Check logs
docker-compose -f docker-compose.prod.yml logs -f

# Verify health
curl http://localhost/health  # Frontend
curl http://localhost:3000/   # PostgREST
```

### Step 5: Configure Reverse Proxy

See [SSL/TLS Configuration](#ssltls-configuration) below.

---

## Kubernetes Deployment

### Prerequisites

- Kubernetes cluster (1.25+)
- kubectl configured
- Persistent storage class
- Ingress controller (nginx-ingress recommended)
- cert-manager for SSL certificates

### Step 1: Create Namespace

```bash
kubectl create namespace civic-os-prod
```

### Step 2: Create ConfigMap

**configmap.yaml:**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: civic-os-config
  namespace: civic-os-prod
data:
  POSTGREST_URL: "https://api.yourdomain.com/"
  SWAGGER_URL: "https://api.yourdomain.com:8080"
  KEYCLOAK_URL: "https://auth.yourdomain.com"
  KEYCLOAK_REALM: "production"
  KEYCLOAK_CLIENT_ID: "civic-os-prod"
  MAP_DEFAULT_LAT: "43.0125"
  MAP_DEFAULT_LNG: "-83.6875"
  MAP_DEFAULT_ZOOM: "13"
  S3_ENDPOINT: "https://s3.yourdomain.com"
  S3_BUCKET: "civic-os-files-prod"
```

### Step 3: Create Secrets

```bash
# Create database password secret
kubectl create secret generic postgres-credentials \
  --from-literal=password='YOUR_SECURE_PASSWORD' \
  -n civic-os-prod

# Create Stripe credentials (only if using payment processing)
kubectl create secret generic stripe-credentials \
  --from-literal=api-key='sk_live_YOUR_STRIPE_SECRET_KEY' \
  --from-literal=webhook-secret='whsec_YOUR_WEBHOOK_SECRET' \
  -n civic-os-prod
```

### Step 4: Deploy PostgreSQL

**postgres-statefulset.yaml:**
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: civic-os-prod
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgis/postgis:17-3.5-alpine
        env:
        - name: POSTGRES_DB
          value: civic_os_prod
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        ports:
        - containerPort: 5432
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: postgres-storage
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 50Gi  # Adjust based on needs
```

### Step 5: Deploy PostgREST

**postgrest-deployment.yaml:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgrest
  namespace: civic-os-prod
spec:
  replicas: 3
  selector:
    matchLabels:
      app: postgrest
  template:
    metadata:
      labels:
        app: postgrest
    spec:
      containers:
      - name: postgrest
        image: ghcr.io/civic-os/postgrest:latest  # Pin to specific version for reproducible builds
        env:
        - name: PGRST_DB_URI
          value: postgres://authenticator:$(POSTGRES_PASSWORD)@postgres:5432/civic_os_prod
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        - name: KEYCLOAK_URL
          valueFrom:
            configMapKeyRef:
              name: civic-os-config
              key: KEYCLOAK_URL
        - name: KEYCLOAK_REALM
          valueFrom:
            configMapKeyRef:
              name: civic-os-config
              key: KEYCLOAK_REALM
        ports:
        - containerPort: 3000
```

### Step 6: Deploy Frontend

**frontend-deployment.yaml:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: civic-os-prod
spec:
  replicas: 3
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
      - name: frontend
        image: ghcr.io/civic-os/frontend:latest  # Pin to specific version for reproducible builds
        envFrom:
        - configMapRef:
            name: civic-os-config
        ports:
        - containerPort: 80
```

### Step 7: Deploy Payment Worker (Optional)

**IMPORTANT**: Only deploy if using payment processing features. Requires Stripe credentials.

**payment-worker-deployment.yaml:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-worker
  namespace: civic-os-prod
spec:
  replicas: 2  # For high availability
  selector:
    matchLabels:
      app: payment-worker
      component: payment-worker
  template:
    metadata:
      labels:
        app: payment-worker
        component: payment-worker
    spec:
      containers:
      - name: payment-worker
        image: ghcr.io/civic-os/payment-worker:latest  # Pin to specific version for reproducible builds
        env:
        # Database Configuration
        - name: DATABASE_URL
          value: postgres://postgres:$(POSTGRES_PASSWORD)@postgres:5432/civic_os_prod
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        - name: DB_MAX_CONNS
          value: "4"
        - name: DB_MIN_CONNS
          value: "1"

        # Stripe Configuration (REQUIRED)
        - name: STRIPE_API_KEY
          valueFrom:
            secretKeyRef:
              name: stripe-credentials
              key: api-key
        - name: STRIPE_WEBHOOK_SECRET
          valueFrom:
            secretKeyRef:
              name: stripe-credentials
              key: webhook-secret

        # Payment Configuration
        - name: PAYMENT_CURRENCY
          value: "USD"
        - name: RIVER_WORKER_COUNT
          value: "1"
        - name: WEBHOOK_PORT
          value: "8080"

        ports:
        - name: webhook
          containerPort: 8080
          protocol: TCP

        # Resource limits (tune based on traffic)
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi

        # Health checks
        livenessProbe:
          httpGet:
            path: /health
            port: webhook
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: webhook
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: payment-worker
  namespace: civic-os-prod
spec:
  selector:
    app: payment-worker
  ports:
  - name: webhook
    port: 8080
    targetPort: webhook
    protocol: TCP
  type: ClusterIP
```

**Apply payment worker:**
```bash
kubectl apply -f payment-worker-deployment.yaml
```

### Step 8: Create Ingress

**ingress.yaml:**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: civic-os-ingress
  namespace: civic-os-prod
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    # Increase body size limit for webhook payloads (default 1m)
    nginx.ingress.kubernetes.io/proxy-body-size: "1m"
spec:
  tls:
  - hosts:
    - app.yourdomain.com
    - api.yourdomain.com
    secretName: civic-os-tls
  rules:
  - host: app.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend
            port:
              number: 80
  - host: api.yourdomain.com
    http:
      paths:
      # Stripe webhook endpoint (must be BEFORE /rpc catch-all)
      - path: /webhooks/stripe
        pathType: Exact
        backend:
          service:
            name: payment-worker
            port:
              number: 8080
      # PostgREST API (all other requests)
      - path: /
        pathType: Prefix
        backend:
          service:
            name: postgrest
            port:
              number: 3000
```

**SECURITY NOTE**: The webhook endpoint is publicly accessible (required for Stripe to deliver events). Security is enforced through:
1. **Signature verification** - Only requests with valid HMAC signatures are processed
2. **TLS termination** - Ingress enforces HTTPS (Stripe requires TLS 1.2+)
3. **Request size limits** - 1MB max payload size prevents abuse
4. **Idempotency protection** - Duplicate events are rejected at database level

### Apply Manifests

```bash
kubectl apply -f configmap.yaml
kubectl apply -f postgres-statefulset.yaml
kubectl apply -f postgrest-deployment.yaml
kubectl apply -f frontend-deployment.yaml
kubectl apply -f payment-worker-deployment.yaml  # Optional: Only if using payments
kubectl apply -f ingress.yaml
```

### Stripe Webhook Configuration (Production)

After deploying the payment-worker service, configure Stripe to send webhooks to your production endpoint:

**Step 1: Create Webhook Endpoint in Stripe Dashboard**
1. Go to https://dashboard.stripe.com/webhooks
2. Click "Add endpoint"
3. Enter URL: `https://api.yourdomain.com/webhooks/stripe`
4. Select events to listen for:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
5. Click "Add endpoint"

**Step 2: Update Webhook Secret**

Stripe will generate a webhook signing secret (starts with `whsec_`). Update your Kubernetes secret:

```bash
# Update webhook secret with production value
kubectl create secret generic stripe-credentials \
  --from-literal=api-key='sk_live_YOUR_STRIPE_SECRET_KEY' \
  --from-literal=webhook-secret='whsec_YOUR_PRODUCTION_WEBHOOK_SECRET' \
  --dry-run=client -o yaml | kubectl apply -n civic-os-prod -f -

# Restart payment-worker to pick up new secret
kubectl rollout restart deployment/payment-worker -n civic-os-prod
```

**Step 3: Test Webhook Delivery**

After deployment, use Stripe Dashboard to send a test webhook:
1. Go to your webhook endpoint in Stripe Dashboard
2. Click "Send test webhook"
3. Select `payment_intent.succeeded`
4. Check payment-worker logs: `kubectl logs -l app=payment-worker -n civic-os-prod`
5. Verify 200 OK response in Stripe Dashboard

---

## Database Migrations

Civic OS uses **Sqitch** for database schema migrations. The migration system ensures safe, versioned schema upgrades across environments.

### Migration Container

The migrations container (`ghcr.io/civic-os/migrations`) is automatically run as an init container before PostgREST starts. It applies all pending migrations and verifies the schema.

**Critical**: Migration container version MUST match frontend/postgrest versions:
```yaml
services:
  migrations:
    image: ghcr.io/civic-os/migrations:latest  # or pin to specific version
  postgrest:
    image: ghcr.io/civic-os/postgrest:latest
  frontend:
    image: ghcr.io/civic-os/frontend:latest
```

### Initial Deployment

For first-time deployments, the migration container will set up the complete schema:

```bash
# Pull versioned images (use latest or specific version)
docker pull ghcr.io/civic-os/migrations:latest
docker pull ghcr.io/civic-os/postgrest:latest
docker pull ghcr.io/civic-os/frontend:latest

# Start database
docker-compose -f docker-compose.prod.yml up -d postgres

# Run migrations (automatic with docker-compose)
docker-compose -f docker-compose.prod.yml up migrations

# Start application
docker-compose -f docker-compose.prod.yml up -d postgrest frontend
```

### Upgrading to New Version

When upgrading Civic OS to a new version:

```bash
# 1. Update docker-compose.prod.yml with new version
# Change VERSION=v0.13.0 to VERSION=v0.14.0 in .env (example versions)

# 2. Pull new images
docker-compose -f docker-compose.prod.yml pull

# 3. Run migrations
docker-compose -f docker-compose.prod.yml up migrations

# 4. Restart application services
docker-compose -f docker-compose.prod.yml up -d postgrest frontend
```

### Manual Migration Execution

For manual control or non-Docker Compose deployments:

```bash
# Deploy migrations (replace VERSION with your target version)
./scripts/migrate-production.sh VERSION postgres://user:pass@host:5432/civic_os

# Check migration status
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  ghcr.io/civic-os/migrations:latest \
  status

# Run with full verification (recommended for production)
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  -e CIVIC_OS_VERIFY_FULL="true" \
  ghcr.io/civic-os/migrations:latest
```

### Rollback Procedure

If issues arise after upgrading:

```bash
# 1. Stop application services
docker-compose -f docker-compose.prod.yml stop postgrest frontend

# 2. Revert database migrations (use the NEW version's container for revert)
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  ghcr.io/civic-os/migrations:latest \
  revert --to @HEAD^

# 3. Downgrade container versions in docker-compose.prod.yml
# Change VERSION to previous version (e.g., v0.14.0 back to v0.13.0)

# 4. Restart with old versions
docker-compose -f docker-compose.prod.yml up -d postgrest frontend
```

### Kubernetes Migrations

For Kubernetes deployments, use an init container:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: civic-os-api
spec:
  template:
    spec:
      initContainers:
        - name: migrations
          image: ghcr.io/civic-os/migrations:v0.5.0
          env:
            - name: PGRST_DB_URI
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: uri
            - name: CIVIC_OS_VERIFY_FULL
              value: "true"
      containers:
        - name: postgrest
          image: ghcr.io/civic-os/postgrest:v0.5.0
          # ... postgrest configuration
```

### Migration Monitoring

Monitor migration execution in production:

```bash
# View migration container logs
docker logs civic_os_migrations

# Check migration status after deployment
docker run --rm \
  -e PGRST_DB_URI="..." \
  ghcr.io/civic-os/migrations:v0.5.0 \
  status

# View migration history
docker run --rm \
  -e PGRST_DB_URI="..." \
  ghcr.io/civic-os/migrations:v0.5.0 \
  log
```

### Troubleshooting Migrations

**Migration Fails:**
- Check container logs: `docker logs civic_os_migrations`
- Verify database connectivity and credentials
- Check if manual schema changes conflict with migrations
- Review migration SQL files for errors

**Schema Drift Detected:**
- Compare actual vs expected schema
- Identify source of manual changes
- Create new migration to reconcile differences

**Version Mismatch:**
- Ensure all containers use same version tag
- Check GitHub Container Registry for available versions
- Verify `package.json` version matches deployed containers

For comprehensive migration documentation, see:
- `postgres/migrations/README.md` - Complete migration system guide
- `docker/migrations/README.md` - Container usage documentation

---

## SSL/TLS Configuration

### Option 1: Let's Encrypt with Certbot (Docker Compose)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d app.yourdomain.com -d api.yourdomain.com

# Auto-renewal (crontab)
0 0 * * * /usr/bin/certbot renew --quiet
```

### Option 2: cert-manager (Kubernetes)

**Install cert-manager:**
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
```

**Create ClusterIssuer:**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@yourdomain.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
```

---

## Database Backups

### Automated Backups (Cron + pg_dump)

**backup-script.sh:**
```bash
#!/bin/bash
# Civic OS Database Backup Script

BACKUP_DIR="/backups/civic-os"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/civic_os_backup_$DATE.sql.gz"

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup database
docker exec civic_os_postgres pg_dump -U postgres civic_os_prod | gzip > $BACKUP_FILE

# Delete backups older than 30 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete

echo "Backup completed: $BACKUP_FILE"
```

**Crontab (daily at 2 AM):**
```bash
0 2 * * * /path/to/backup-script.sh >> /var/log/civic-os-backup.log 2>&1
```

### Restore from Backup

```bash
# Stop services
docker-compose down

# Restore database
gunzip -c backup_file.sql.gz | docker exec -i civic_os_postgres psql -U postgres -d civic_os_prod

# Restart services
docker-compose up -d
```

---

## Monitoring & Logging

### Health Check Endpoints

**Frontend:**
```bash
curl http://localhost/health
# Expected: "healthy"
```

**PostgREST:**
```bash
curl http://localhost:3000/
# Expected: OpenAPI JSON schema
```

**PostgreSQL:**
```bash
docker exec civic_os_postgres pg_isready -U postgres
# Expected: "postgres:5432 - accepting connections"
```

### Prometheus Metrics (Kubernetes)

Add ServiceMonitor for PostgREST and nginx metrics.

### Logging Best Practices

**Centralized Logging:**
- Use ELK Stack (Elasticsearch, Logstash, Kibana)
- Or Loki + Grafana
- Configure Docker to use json-file driver with rotation

**Docker logging configuration:**
```yaml
services:
  frontend:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

---

## Security Best Practices

### 1. Network Security

- **Use private networks** for database connections
- **Firewall rules** - Only expose ports 80, 443
- **Rate limiting** on nginx/ingress
- **DDoS protection** via Cloudflare or AWS Shield

### 2. Database Security

- **Strong passwords** (32+ characters, random)
- **SSL/TLS connections** to PostgreSQL
- **Row-Level Security** enabled on all tables
- **Regular security updates** to PostgreSQL

### 3. Application Security

- **CSP headers** configured in nginx
- **CORS** properly configured in PostgREST
- **JWT expiration** enforced in Keycloak
- **Regular security scanning** of container images

### 4. Secret Management

- **Never commit secrets** to version control
- **Use Kubernetes Secrets** or Docker Swarm secrets
- **Rotate credentials** regularly
- **Use managed secret services** (AWS Secrets Manager, HashiCorp Vault)

### 5. Container Security

- **Scan images** with Trivy or Clair
- **Run as non-root** (already configured)
- **Read-only filesystems** where possible
- **Resource limits** on all containers

### 6. Payment Webhook Security (if using payment-worker)

**CRITICAL**: The payment webhook endpoint is publicly accessible by design (Stripe must be able to send events). Security is enforced through multiple layers:

**Signature Verification (Primary Defense):**
- All webhook requests **MUST** have valid HMAC-SHA256 signatures
- Signatures are verified using `STRIPE_WEBHOOK_SECRET` before processing
- Requests with invalid/missing signatures are rejected with 400 Bad Request
- Prevents unauthorized webhook submissions and replay attacks

**TLS/HTTPS Requirements:**
- Stripe requires TLS 1.2 or higher for all webhook deliveries
- Configure TLS termination at ingress/load balancer level
- Never expose HTTP webhook endpoints (port 8080) directly to internet
- Use cert-manager or similar for automatic certificate renewal

**Request Size Limits:**
- Webhook payloads are limited to 64KB (enforced by payment-worker)
- Ingress should enforce 1MB limit to prevent abuse
- Prevents memory exhaustion attacks

**Idempotency Protection:**
- Duplicate webhook events are rejected at database level
- `UNIQUE (provider, provider_event_id)` constraint in `metadata.webhooks` table
- Prevents double-processing of events from Stripe retries

**Network Isolation:**
- Payment-worker should NOT have direct internet access (only database + Stripe API)
- Use egress firewall rules to restrict outbound connections
- Only allow connections to Stripe API endpoints (api.stripe.com)

**Monitoring & Alerting:**
- Monitor failed signature verifications (potential attack indicator)
- Alert on high volume of webhook requests (DDoS/abuse detection)
- Track webhook processing errors in application logs
- Set up alerts for Stripe API errors

**Example nginx configuration for webhook endpoint:**
```nginx
location /webhooks/stripe {
    # Rate limiting (100 requests/minute per IP)
    limit_req zone=webhook_limit burst=10 nodelay;

    # Size limits
    client_max_body_size 1m;

    # Timeouts
    proxy_connect_timeout 5s;
    proxy_send_timeout 5s;
    proxy_read_timeout 10s;

    # Forward to payment-worker
    proxy_pass http://payment-worker:8080;
}
```

**Stripe IP Whitelisting (Optional):**
- Stripe publishes webhook IP ranges: https://stripe.com/files/ips/ips_webhooks.txt
- Can configure ingress to only allow requests from Stripe IPs
- Adds defense-in-depth but signature verification is still required

---

## Troubleshooting

### Frontend not loading

**Check nginx logs:**
```bash
docker logs civic_os_frontend
```

**Verify config.js was generated:**
```bash
docker exec civic_os_frontend cat /usr/share/nginx/html/assets/config.js
```

### PostgREST connection errors

**Check PostgREST logs:**
```bash
docker logs civic_os_postgrest
```

**Verify JWKS fetch:**
```bash
docker exec civic_os_postgrest cat /etc/postgrest/jwt-secret.jwks
```

### Database connection issues

**Check PostgreSQL is healthy:**
```bash
docker exec civic_os_postgres pg_isready -U postgres
```

**Verify permissions:**
```bash
docker exec -it civic_os_postgres psql -U postgres -d civic_os_prod -c "\du"
```

### Performance issues

**Check resource usage:**
```bash
docker stats
```

**Consolidated Worker Resource Tuning:**

The consolidated worker combines S3 presigning, thumbnail generation, and notifications in a single service. Resources scale primarily with `THUMBNAIL_MAX_WORKERS` (image processing is CPU/memory intensive).

**Resource Formula:**
```
Memory needed = (THUMBNAIL_MAX_WORKERS × 150MB) + 200MB baseline
CPU needed (burst) = THUMBNAIL_MAX_WORKERS × 250m
```

**Tier-Based Configuration:**

| Deployment Scale | Upload Volume | CPU Request | Memory Request | CPU Limit | Memory Limit | THUMBNAIL_MAX_WORKERS | DB_MAX_CONNS |
|------------------|---------------|-------------|----------------|-----------|--------------|----------------------|--------------|
| **Development** | <10/day | 200m | 384Mi | 1000m | 768Mi | 2 | 4 |
| **Small Production** | <100/day | 500m | 768Mi | 2000m | 1536Mi | 3-4 | 4 |
| **Medium Production** | 100-500/day | 1000m | 1536Mi | 4000m | 3Gi | 6-8 | 8 |
| **Large (Horizontal)** | >500/day | 500m × N | 768Mi × N | 2000m × N | 1536Mi × N | 4 per replica | 4 |

**Tuning Steps:**

1. **Calculate your needs:**
   ```bash
   # Determine container memory limit (e.g., 1536Mi = 1536MB)
   # Calculate max workers: floor((memory_limit - 200MB) / 150MB)
   # Example: floor((1536 - 200) / 150) = 8 workers
   ```

2. **Update environment variables:**
   ```bash
   # Edit .env or ConfigMap
   THUMBNAIL_MAX_WORKERS=4  # Adjust based on calculation above
   DB_MAX_CONNS=6           # Rule: THUMBNAIL_MAX_WORKERS + 2

   # Restart service
   docker-compose restart consolidated-worker
   # OR for Kubernetes:
   kubectl rollout restart deployment/consolidated-worker -n civic-os
   ```

3. **Monitor performance:**
   ```bash
   # Watch memory usage
   docker stats consolidated-worker
   # OR for Kubernetes:
   kubectl top pod -l component=consolidated-worker -n civic-os

   # Check for memory pressure
   kubectl describe pod <pod-name> -n civic-os | grep -A 5 "Events:"
   ```

**When to Scale Horizontally:**

For high traffic (>500 uploads/day), **prefer multiple replicas** over increasing resources:

```yaml
spec:
  replicas: 3  # Scale out instead of up
  template:
    spec:
      containers:
      - name: consolidated-worker
        env:
        - name: THUMBNAIL_MAX_WORKERS
          value: "4"  # Moderate per-replica
        - name: DB_MAX_CONNS
          value: "4"
        resources:
          requests:
            cpu: 500m
            memory: 768Mi
          limits:
            cpu: 2000m
            memory: 1536Mi
```

**Benefits of horizontal scaling:**
- Better fault tolerance (jobs redistribute if pod fails)
- More consistent performance (avoid CPU throttling)
- River queue handles distribution automatically
- Total capacity: 3 replicas × 4 workers = 12 concurrent jobs

**Troubleshooting:**

**Memory issues (OOMKilled):**
- Reduce `THUMBNAIL_MAX_WORKERS` by 2
- Increase container memory limit
- Check for large file uploads (>10MB images, complex PDFs)

**High CPU usage:**
- Normal during image processing (expect 80-100% CPU during jobs)
- If sustained high CPU with empty queue, check for worker thrashing

**Connection pool exhausted:**
- Increase `DB_MAX_CONNS` (rule: `THUMBNAIL_MAX_WORKERS + 2`)
- Check for connection leaks in logs

**Analyze slow queries:**
```sql
-- Enable query logging
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- Log queries > 1s
SELECT pg_reload_conf();
```

### Payment Worker Issues (if deployed)

**Webhook 400 errors in Stripe Dashboard:**
```bash
# Check payment-worker logs for signature verification failures
docker logs payment-worker
# OR for Kubernetes:
kubectl logs -l app=payment-worker -n civic-os-prod

# Common causes:
# 1. Wrong webhook secret (test vs live mode mismatch)
# 2. API version mismatch (check IgnoreAPIVersionMismatch setting)
# 3. Missing Stripe-Signature header
```

**Webhook 500 errors:**
```bash
# Check for database connection issues
docker exec -it payment-worker /bin/sh -c 'echo "SELECT 1" | psql $DATABASE_URL'

# Check for missing payment records (webhook received for non-existent payment)
docker exec -it postgres_db psql -U postgres -d civic_os_prod -c \
  "SELECT id, stripe_payment_intent_id, status FROM public.payment_transactions ORDER BY created_at DESC LIMIT 10;"
```

**Payment intent creation timing out:**
```bash
# Check River job queue for stalled jobs
docker exec -it postgres_db psql -U postgres -d civic_os_prod -c \
  "SELECT id, kind, state, errors FROM metadata.river_job WHERE kind = 'create_payment_intent' ORDER BY created_at DESC LIMIT 10;"

# Check Stripe API connectivity
docker exec -it payment-worker /bin/sh -c 'curl -s https://api.stripe.com/healthcheck'
```

**Health check failing:**
```bash
# Test health endpoint directly
curl http://localhost:8081/health
# OR for Kubernetes:
kubectl port-forward svc/payment-worker 8080:8080 -n civic-os-prod
curl http://localhost:8080/health

# Expected: {"status":"healthy"}
```

**Monitoring payment processing:**
```sql
-- View recent payment transactions
SELECT id, user_id, amount, currency, status,
       stripe_payment_intent_id, created_at
FROM public.payment_transactions
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;

-- View recent webhook events
SELECT id, provider, event_type, signature_verified,
       processed, created_at, error_message
FROM metadata.webhooks
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;

-- Check for failed webhooks
SELECT event_type, COUNT(*) as failed_count,
       MAX(created_at) as last_failure
FROM metadata.webhooks
WHERE processed = FALSE AND error_message IS NOT NULL
GROUP BY event_type;
```

---

## Support & Resources

- **Main Documentation**: [README.md](../../README.md)
- **Docker Documentation**: [docker/README.md](../../docker/README.md)
- **Authentication Guide**: [AUTHENTICATION.md](../AUTHENTICATION.md)
- **Troubleshooting Guide**: [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

---

**License**: This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (C) 2023-2025 Civic OS, L3C.
