# Civic OS - Docker Containers

This directory contains Docker configurations for building and deploying Civic OS containers.

## Container Images

Civic OS provides two production-ready container images:

1. **Frontend Container** (`ghcr.io/civic-os/frontend`)
   - Angular SPA with nginx
   - Runtime configuration via environment variables
   - Multi-architecture support (amd64, arm64)

2. **PostgREST Container** (`ghcr.io/civic-os/postgrest`)
   - PostgREST API with automatic Keycloak JWKS fetching
   - Built on official PostgREST image
   - Multi-architecture support (amd64, arm64)

## Quick Start

### Pull Pre-Built Images

```bash
# Pull images from GitHub Container Registry
docker pull ghcr.io/civic-os/frontend:latest
docker pull ghcr.io/civic-os/postgrest:latest
docker pull ghcr.io/civic-os/consolidated-worker:latest

# For production, pin to specific version tags (e.g., v0.19.0)
# See releases: https://github.com/civic-os/civic-os-frontend/releases
```

### Deploy with Docker Compose

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your configuration
nano .env

# Start services
docker-compose -f docker-compose.prod.yml up -d
```

## Building Locally

### Prerequisites

**Docker BuildKit** is required for optimized builds with cache mounts. BuildKit is enabled by default in Docker 23.0+.

To verify BuildKit is available:
```bash
docker buildx version
```

For older Docker versions, enable BuildKit:
```bash
export DOCKER_BUILDKIT=1
```

### Build Frontend

The frontend Dockerfile uses **BuildKit cache mounts** to significantly speed up rebuilds:
- **npm cache** - Reuses downloaded packages between builds
- **Angular cache** - Reuses Angular's incremental build cache

```bash
# Standard build (cache mounts automatically used)
docker build -t civic-os-frontend:local -f docker/frontend/Dockerfile .

# View detailed build output
docker build --progress=plain -t civic-os-frontend:local -f docker/frontend/Dockerfile .
```

**Performance Impact**: Cache mounts reduce rebuild time from ~5 minutes to ~30 seconds when only source code changes.

### Build PostgREST

```bash
docker build -t civic-os-postgrest:local -f docker/postgrest/Dockerfile .
```

## Environment Variables

### Frontend Container

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGREST_URL` | Yes | `http://localhost:3000/` | PostgREST API endpoint |
| `KEYCLOAK_URL` | Yes | `https://auth.civic-os.org` | Keycloak server URL |
| `KEYCLOAK_REALM` | Yes | `civic-os-dev` | Keycloak realm name |
| `KEYCLOAK_CLIENT_ID` | Yes | `myclient` | Keycloak client ID |
| `MAP_TILE_URL` | No | OpenStreetMap | Map tile server URL |
| `MAP_ATTRIBUTION` | No | OSM attribution | Map attribution text |
| `MAP_DEFAULT_LAT` | No | `43.0125` | Default map latitude |
| `MAP_DEFAULT_LNG` | No | `-83.6875` | Default map longitude |
| `MAP_DEFAULT_ZOOM` | No | `13` | Default map zoom level |
| `S3_ENDPOINT` | Yes* | `http://localhost:9000` | S3-compatible storage endpoint (browser-accessible URL) |
| `S3_BUCKET` | Yes* | `civic-os-files` | S3 bucket name for file storage |

*Required if using file upload features (v0.5.0+)

### PostgREST Container

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PGRST_DB_URI` | Yes | - | PostgreSQL connection string |
| `KEYCLOAK_URL` | Yes | - | Keycloak server URL |
| `KEYCLOAK_REALM` | Yes | - | Keycloak realm name |
| `PGRST_DB_SCHEMA` | No | `public,metadata` | Exposed schemas |
| `PGRST_DB_ANON_ROLE` | No | `web_anon` | Anonymous role |
| `PGRST_DB_PRE_REQUEST` | No | `public.check_jwt` | Pre-request function |
| `PGRST_JWT_AUD` | No | `account` | JWT audience claim |
| `PGRST_LOG_LEVEL` | No | `info` | Log level |

## Health Checks

### Frontend

```bash
curl http://localhost:80/health
# Expected: "healthy"
```

### PostgREST

```bash
curl http://localhost:3000/
# Expected: OpenAPI JSON schema
```

## Container Architecture

### Frontend Container

```
┌─────────────────────────────────────┐
│  nginx:alpine                       │
├─────────────────────────────────────┤
│  1. docker-entrypoint.sh            │
│     - Reads ENV variables           │
│     - Generates config.js via       │
│       envsubst                      │
│  2. Nginx serves:                   │
│     - Angular static files          │
│     - Runtime config.js             │
│     - SPA routing (all → index.html)│
└─────────────────────────────────────┘
```

### PostgREST Container

```
┌─────────────────────────────────────┐
│  postgrest/postgrest:latest         │
├─────────────────────────────────────┤
│  1. docker-entrypoint.sh            │
│     - Fetches JWKS from Keycloak    │
│     - Saves to jwt-secret.jwks      │
│  2. PostgREST starts with JWKS      │
└─────────────────────────────────────┘
```

## GitHub Actions CI/CD

On every push to `main`, GitHub Actions automatically:
1. Extracts version from `package.json` (e.g., `0.3.0`)
2. Builds both containers for amd64 and arm64
3. Publishes to GitHub Container Registry with tags:
   - `latest`
   - `v0.3.0`
   - `0.3.0`
   - `sha-<git-sha>`

### Version Bumps

To release a new version:

```bash
# Bump version in package.json
npm version patch   # 0.3.0 → 0.3.1
npm version minor   # 0.3.0 → 0.4.0
npm version major   # 0.3.0 → 1.0.0

# Commit and push
git add package.json
git commit -m "Bump version to 0.4.0"
git push

# GitHub Actions will automatically build and tag v0.4.0
```

## Troubleshooting

### Frontend config.js not updating

The frontend generates `config.js` at container startup. If changes aren't reflected:

```bash
# Restart container to regenerate config
docker-compose restart frontend

# Or check logs
docker logs civic_os_frontend
```

### PostgREST JWKS fetch fails

Check Keycloak connectivity:

```bash
# Exec into container
docker exec -it civic_os_postgrest sh

# Test JWKS URL
curl -s https://auth.civic-os.org/realms/civic-os-dev/protocol/openid-connect/certs | jq .
```

### Permission denied errors

Ensure PostgreSQL roles and RLS policies are configured:

```bash
# Check PostgREST logs
docker logs civic_os_postgrest

# Verify database connection
docker exec -it civic_os_postgres psql -U postgres -d civic_os_db
```

## Production Deployment

See `docs/deployment/PRODUCTION.md` for complete production deployment guide including:
- Kubernetes manifests
- SSL/TLS configuration
- High availability setup
- Monitoring and logging
- Backup strategies

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
Copyright (C) 2023-2025 Civic OS, L3C. See the LICENSE file for full terms.
