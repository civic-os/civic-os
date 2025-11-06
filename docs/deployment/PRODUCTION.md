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
│  Internet                           │
└──────────────┬──────────────────────┘
               │
         ┌─────▼─────┐
         │  nginx    │  (Reverse Proxy + SSL)
         │  Port 443 │
         └─────┬─────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐    ┌─────▼─────┐
│ Frontend  │    │ PostgREST │
│ Port 80   │    │ Port 3000 │
└───────────┘    └─────┬─────┘
                       │
                ┌──────▼──────┐
                │ PostgreSQL  │
                │ Port 5432   │
                └─────────────┘
```

### High-Availability Architecture (Kubernetes)

```
┌────────────────────────────────────────┐
│  Load Balancer (Ingress)              │
│  SSL Termination                       │
└────────────┬───────────────────────────┘
             │
    ┌────────┴─────────┐
    │                  │
┌───▼────┐       ┌────▼────┐
│Frontend│       │PostgREST│
│ (3x)   │       │  (3x)   │
└────────┘       └────┬────┘
                      │
               ┌──────▼──────┐
               │ PostgreSQL  │
               │ (StatefulSet│
               │  + PVC)     │
               └─────────────┘
```

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

# AWS SDK configuration (for s3-signer and thumbnail-worker microservices)
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_REGION=us-east-1
S3_ENDPOINT=  # Leave empty for real AWS S3, set for MinIO/S3-compatible storage

# Thumbnail Worker Configuration
THUMBNAIL_MAX_WORKERS=5  # Concurrent workers (tune based on CPU/memory)
# Tuning: Low memory (512Mi)=2-3, Medium (1Gi)=5-7, High (2Gi)=10-12

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
docker pull ghcr.io/civic-os/frontend:v0.3.0
docker pull ghcr.io/civic-os/postgrest:v0.3.0

# Or build locally
docker build -t civic-os-frontend:v0.3.0 -f docker/frontend/Dockerfile .
docker build -t civic-os-postgrest:v0.3.0 -f docker/postgrest/Dockerfile .
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
        image: ghcr.io/civic-os/postgrest:v0.3.0
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
        image: ghcr.io/civic-os/frontend:v0.3.0
        envFrom:
        - configMapRef:
            name: civic-os-config
        ports:
        - containerPort: 80
```

### Step 7: Create Ingress

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
      - path: /
        pathType: Prefix
        backend:
          service:
            name: postgrest
            port:
              number: 3000
```

### Apply Manifests

```bash
kubectl apply -f configmap.yaml
kubectl apply -f postgres-statefulset.yaml
kubectl apply -f postgrest-deployment.yaml
kubectl apply -f frontend-deployment.yaml
kubectl apply -f ingress.yaml
```

---

## Database Migrations

Civic OS uses **Sqitch** for database schema migrations. The migration system ensures safe, versioned schema upgrades across environments.

### Migration Container

The migrations container (`ghcr.io/civic-os/migrations`) is automatically run as an init container before PostgREST starts. It applies all pending migrations and verifies the schema.

**Critical**: Migration container version MUST match frontend/postgrest versions:
```yaml
services:
  migrations:
    image: ghcr.io/civic-os/migrations:v0.4.0
  postgrest:
    image: ghcr.io/civic-os/postgrest:v0.4.0
  frontend:
    image: ghcr.io/civic-os/frontend:v0.4.0
```

### Initial Deployment

For first-time deployments, the migration container will set up the complete schema:

```bash
# Pull versioned images
docker pull ghcr.io/civic-os/migrations:v0.4.0
docker pull ghcr.io/civic-os/postgrest:v0.4.0
docker pull ghcr.io/civic-os/frontend:v0.4.0

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
# Change VERSION=v0.4.0 to VERSION=v0.5.0 in .env

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
# Deploy migrations
./scripts/migrate-production.sh v0.5.0 postgres://user:pass@host:5432/civic_os

# Check migration status
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  ghcr.io/civic-os/migrations:v0.5.0 \
  status

# Run with full verification (recommended for production)
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  -e CIVIC_OS_VERIFY_FULL="true" \
  ghcr.io/civic-os/migrations:v0.5.0
```

### Rollback Procedure

If issues arise after upgrading:

```bash
# 1. Stop application services
docker-compose -f docker-compose.prod.yml stop postgrest frontend

# 2. Revert database migrations
docker run --rm \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/civic_os" \
  ghcr.io/civic-os/migrations:v0.5.0 \
  revert --to @HEAD^

# 3. Downgrade container versions in docker-compose.prod.yml
# Change VERSION=v0.5.0 back to VERSION=v0.4.0

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

**Thumbnail worker high memory usage:**

If the thumbnail worker is consuming too much memory, reduce `THUMBNAIL_MAX_WORKERS`:
```bash
# Edit .env file
THUMBNAIL_MAX_WORKERS=3  # Reduce from default 5

# Restart service
docker-compose restart thumbnail-worker
```

Memory usage scales with worker count (~100MB per worker). Match worker count to available memory:
- 512Mi container: 2-3 workers
- 1Gi container: 5-7 workers
- 2Gi container: 10-12 workers

**Analyze slow queries:**
```sql
-- Enable query logging
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- Log queries > 1s
SELECT pg_reload_conf();
```

---

## Support & Resources

- **Main Documentation**: [README.md](../../README.md)
- **Docker Documentation**: [docker/README.md](../../docker/README.md)
- **Authentication Guide**: [AUTHENTICATION.md](../AUTHENTICATION.md)
- **Troubleshooting Guide**: [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

---

**License**: This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (C) 2023-2025 Civic OS, L3C.
