# Civic OS - Kubernetes Deployment Examples

This directory contains example Kubernetes manifests for deploying Civic OS. These examples reflect real-world deployment learnings and best practices.

**License**: This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (C) 2023-2025 Civic OS, L3C.

---

## Architecture Overview

Civic OS uses a three-subdomain architecture with six containerized components:

### Public-Facing Services (via Ingress)
- **app.yourdomain.com** - Frontend (Angular SPA)
- **api.yourdomain.com** - PostgREST API (public REST API)
- **docs.yourdomain.com** - Swagger UI (auto-generated API documentation)

### Backend Services (internal)
- **PostgREST** - REST API layer with JWT authentication
- **S3 Signer** - Go microservice that generates presigned upload URLs via River job queue
- **Thumbnail Worker** - Go microservice that generates image/PDF thumbnails via River job queue
- **PostgreSQL** - Managed database (recommended) or in-cluster StatefulSet

The frontend is a Single Page Application (SPA) that makes API calls from the browser to the public API endpoint. This means configuration must use **public HTTPS URLs**, not internal Kubernetes service URLs.

---

## Prerequisites

Before deploying Civic OS, ensure you have:

### Required
- **Kubernetes cluster** (1.25+)
- **kubectl** CLI configured
- **nginx-ingress controller** installed
- **cert-manager** installed (for SSL certificates)
- **Managed PostgreSQL database** (Digital Ocean, AWS RDS, etc.) OR in-cluster PostgreSQL

### Optional
- **kubeseal** CLI (for Sealed Secrets in production)
- **DNS provider API access** (for wildcard SSL with DNS-01 challenge)

---

## Quick Start

### 1. Create Namespace

```bash
kubectl create namespace civic-os
```

### 2. Configure Your Domain

Edit all YAML files and replace `yourdomain.com` with your actual domain:
- `configmap.yaml` - Update POSTGREST_URL and SWAGGER_API_URL
- `ingress.yaml` - Update all three hosts

### 3. Configure DNS

Point your subdomains to the ingress controller load balancer:

```bash
# Get your load balancer IP
kubectl get svc -n ingress-nginx ingress-nginx-controller

# Create DNS A records:
# app.yourdomain.com    → <load-balancer-ip>
# api.yourdomain.com    → <load-balancer-ip>
# docs.yourdomain.com   → <load-balancer-ip>

# Or use a wildcard (*.yourdomain.com → <load-balancer-ip>)
```

### 4. Create Secrets

**For managed external database and S3 storage (recommended):**

```bash
kubectl create secret generic civic-os-secrets \
  --from-literal=DATABASE_URL='postgresql://user:pass@host:port/dbname?sslmode=require' \
  --from-literal=AWS_ACCESS_KEY_ID='your-access-key-id' \
  --from-literal=AWS_SECRET_ACCESS_KEY='your-secret-access-key' \
  --namespace civic-os
```

**Example for Digital Ocean managed PostgreSQL + AWS S3:**
```bash
DATABASE_URL='postgresql://doadmin:password@db-postgresql-nyc3-12345.ondigitalocean.com:25060/defaultdb?sslmode=require'
AWS_ACCESS_KEY_ID='AKIAIOSFODNN7EXAMPLE'
AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
```

See `secrets.yaml` for production secret management options (Sealed Secrets recommended).

### 5. Deploy Civic OS

```bash
# Apply configuration and secrets
kubectl apply -f configmap.yaml
kubectl apply -f secrets.yaml  # if using template

# Deploy backend services (must come before frontend)
kubectl apply -f postgrest-deployment.yaml
kubectl apply -f postgrest-service.yaml
kubectl apply -f consolidated-worker-deployment.yaml

# Deploy frontend
kubectl apply -f frontend-deployment.yaml
kubectl apply -f frontend-service.yaml

# Deploy optional services
kubectl apply -f swagger-ui.yaml

# Configure ingress (external access)
kubectl apply -f ingress.yaml

# Optional: Enable network policy for security isolation
kubectl apply -f network-policy.yaml
```

**Note**: The `postgrest-deployment.yaml` includes an initContainer that runs database migrations before PostgREST starts, ensuring the schema is up-to-date.

### 6. Verify Deployment

```bash
# Check pods are running
kubectl get pods -n civic-os

# Check certificate is issued
kubectl get certificate -n civic-os

# Check ingress
kubectl get ingress -n civic-os

# View logs
kubectl logs -n civic-os -l app=postgrest
kubectl logs -n civic-os -l app=frontend
```

---

## Resource Tuning

### Consolidated Worker Configuration

The `consolidated-worker` deployment includes tier-based resource configurations in the YAML comments. By default, it's configured for **Small Production** (< 100 uploads/day).

**To customize for your deployment scale:**

1. **Edit the deployment file:**
   ```bash
   kubectl edit deployment consolidated-worker -n civic-os
   ```

2. **Update resources based on your tier** (see comments in `consolidated-worker-deployment.yaml`):

**Development (< 10 uploads/day):**
```yaml
spec:
  template:
    spec:
      containers:
      - name: consolidated-worker
        env:
        - name: THUMBNAIL_MAX_WORKERS
          value: "2"
        resources:
          requests:
            cpu: 200m
            memory: 384Mi
          limits:
            cpu: 1000m
            memory: 768Mi
```

**Medium Production (100-500 uploads/day):**
```yaml
spec:
  template:
    spec:
      containers:
      - name: consolidated-worker
        env:
        - name: THUMBNAIL_MAX_WORKERS
          value: "6"
        - name: DB_MAX_CONNS
          value: "8"
        resources:
          requests:
            cpu: 1000m
            memory: 1536Mi
          limits:
            cpu: 4000m
            memory: 3Gi
```

**High Traffic (>500 uploads/day) - Horizontal Scaling:**
```bash
# Scale out instead of up
kubectl scale deployment consolidated-worker --replicas=3 -n civic-os

# Each replica processes jobs independently via River queue
# Total capacity: 3 replicas × 4 workers = 12 concurrent thumbnail jobs
```

**Update ConfigMap for tuning:**
```bash
kubectl edit configmap civic-os-config -n civic-os

# Add or update:
data:
  THUMBNAIL_MAX_WORKERS: "4"  # Adjust based on your tier
```

**Memory Formula:** `(THUMBNAIL_MAX_WORKERS × 150MB) + 200MB baseline`

For complete tuning guidance, see `docs/deployment/PRODUCTION.md`.

---

## SSL/TLS Certificates

### DNS-01 Challenge (Recommended for Wildcard Domains)

If using wildcard DNS (*.yourdomain.com), you need DNS-01 challenge:

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
      - dns01:
          digitalocean:  # or cloudflare, route53, etc.
            tokenSecretRef:
              name: digitalocean-dns
              key: access-token
```

Create the DNS provider secret:
```bash
kubectl create secret generic digitalocean-dns \
  --from-literal=access-token='your-digitalocean-api-token' \
  --namespace cert-manager
```

### HTTP-01 Challenge (For Specific Subdomains)

For non-wildcard domains, HTTP-01 works but:
- **DO NOT** use `nginx.ingress.kubernetes.io/ssl-redirect: "true"` during initial cert issuance
- It will redirect HTTP to HTTPS, breaking Let's Encrypt validation
- After certificates are issued, you can enable ssl-redirect

---

## Configuration Notes

### Frontend Configuration

The frontend is an Angular SPA that injects configuration at **build time** from environment variables. Version 0.3.1+ uses inline HTML injection instead of a separate config.js file. Version 0.3.2+ includes SSO fixes for authentication.

**Key settings in configmap.yaml:**
- `POSTGREST_URL` - **Must be public HTTPS URL** (e.g., https://api.yourdomain.com/)
- `KEYCLOAK_URL` - Keycloak authentication server
- `KEYCLOAK_REALM` - Your Keycloak realm (e.g., civic-os-dev)
- `KEYCLOAK_CLIENT_ID` - Your Keycloak client ID

### PostgREST Configuration

PostgREST needs to fetch JWKS keys from Keycloak for JWT validation:
- Uses external HTTPS to auth.civic-os.org
- **Network policy must allow external HTTPS** (port 443)
- Without this, you'll see "context deadline exceeded" errors

### Swagger UI Configuration

Swagger UI runs in the browser and fetches the OpenAPI spec from PostgREST:
- `SWAGGER_API_URL` must be the **public API URL** (not internal service)
- PostgREST exposes OpenAPI spec at its root endpoint (/)

---

## Production Recommendations

### 1. Use Sealed Secrets

Store encrypted secrets in git using Sealed Secrets:

```bash
# Install kubeseal
brew install kubeseal

# Create temp secret file
cat > secrets-temp.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: civic-os-secrets
  namespace: civic-os
type: Opaque
stringData:
  DATABASE_URL: "postgresql://user:pass@host:port/db?sslmode=require"
EOF

# Encrypt it (use namespace-wide scope!)
kubeseal --controller-namespace=kube-system \
         --scope namespace-wide \
         --format=yaml < secrets-temp.yaml > sealed-secrets.yaml

# Clean up and commit
rm secrets-temp.yaml
git add sealed-secrets.yaml
```

### 2. Use Managed Database

Use a managed PostgreSQL service (Digital Ocean, AWS RDS, etc.) instead of in-cluster:
- Automatic backups
- High availability
- Better performance
- Easier scaling

### 3. Scale for High Availability

```bash
# Scale deployments
kubectl scale deployment civic-os-frontend --replicas=3 -n civic-os
kubectl scale deployment civic-os-postgrest --replicas=3 -n civic-os
kubectl scale deployment civic-os-swagger-ui --replicas=2 -n civic-os
```

### 4. Resource Limits

Add resource requests/limits based on your workload:

```yaml
resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "512Mi"
    cpu: "500m"
```

### 5. Enable Network Policy

If your cluster supports NetworkPolicy (most do), enable it for security isolation:

```bash
kubectl apply -f network-policy.yaml
```

---

## Troubleshooting

### Pods Not Starting

```bash
# Check pod status
kubectl describe pod -n civic-os <pod-name>

# Check logs
kubectl logs -n civic-os <pod-name>
```

### Certificate Not Issuing

```bash
# Check certificate status
kubectl describe certificate -n civic-os civic-os-tls

# Check cert-manager logs
kubectl logs -n cert-manager -l app=cert-manager

# Common issues:
# - DNS-01: API token invalid or DNS propagation delay
# - HTTP-01: ssl-redirect blocking validation (remove it temporarily)
```

### PostgREST Timeout Errors

If you see "context deadline exceeded":
1. Check network policy allows external HTTPS (port 443)
2. Verify Keycloak URL is accessible
3. Check PostgREST logs for JWKS fetch errors

### Frontend Blank Page

If the page loads but shows blank:
1. Check browser console for JavaScript errors
2. Verify API is accessible from browser (not just in-cluster)
3. Check frontend logs for configuration errors
4. Ensure version 0.3.1+ is deployed (earlier versions had config issues)

---

## Deployment Versions

These examples use **version latest** for development purposes. For production deployments, pin to specific versions:

```yaml
# Development (use latest)
image: ghcr.io/civic-os/frontend:latest
image: ghcr.io/civic-os/postgrest:latest

# Production (pin to specific version)
image: ghcr.io/civic-os/frontend:0.3.2
image: ghcr.io/civic-os/postgrest:0.3.2
```

**Recent versions:**
- **0.3.2** - Fixed SSO blank page issue
- **0.3.1** - Improved config injection (inline HTML vs separate config.js)
- **0.3.0** - Initial stable release

---

## Additional Resources

- [Civic OS Documentation](https://docs.civic-os.org)
- [cert-manager Documentation](https://cert-manager.io/docs/)
- [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets)
- [PostgREST Documentation](https://postgrest.org)

---

**License**: This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (C) 2023-2025 Civic OS, L3C.
