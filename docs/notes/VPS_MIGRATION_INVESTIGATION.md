# VPS Migration Investigation: From DOKS to Per-Instance Droplets

**Date:** 2026-01-16
**Status:** Research Complete - Awaiting Decision
**Related Task:** `~/.claude/tasks/2026-01-13-k8s-to-vps-investigation.md`

---

## Executive Summary

This document evaluates migrating Civic OS deployments from DigitalOcean Managed Kubernetes (DOKS) to single VPS (Droplet) instances per pilot. The goal is achieving **predictable per-instance costs** while maintaining operational reliability.

**Recommendation:** Proceed with VPS migration using **Managed PostgreSQL + Caddy + docker-rollout** architecture. Estimated cost per instance: **~$27/month** with zero-downtime deployments and simplified operations.

**Key Insight:** Civic OS services are stateless—all persistent data lives in PostgreSQL (backed up by Managed DB) and S3 (inherently durable). Droplet backups are unnecessary, reducing costs significantly.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [VPS Architecture Options](#vps-architecture-options)
3. [Component-by-Component Recommendations](#component-by-component-recommendations)
4. [Cost Comparison](#cost-comparison)
5. [Migration Path](#migration-path)
6. [Risk Assessment](#risk-assessment)
7. [Decision Matrix](#decision-matrix)
8. [Next Steps](#next-steps)

---

## Current State Analysis

### Existing DOKS Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DOKS Cluster                         │
├─────────────────────────────────────────────────────────┤
│  Ingress Controller (shared)                            │
│     ├── pilot-a.civic-os.app → pilot-a namespace        │
│     ├── pilot-b.civic-os.app → pilot-b namespace        │
│     └── demo.civic-os.app    → demo namespace           │
│                                                         │
│  Each namespace contains:                               │
│     - frontend (Deployment, 1-3 replicas)               │
│     - postgrest (Deployment, 1-3 replicas)              │
│     - consolidated-worker (Deployment, 1 replica)       │
│     - postgres (StatefulSet with PVC)                   │
│     - migrations (Job, runs on deploy)                  │
│                                                         │
│  Shared Keycloak (external: auth.civic-os.org)          │
└─────────────────────────────────────────────────────────┘
```

### DOKS Strengths

- Automatic scaling
- Built-in high availability
- Ingress handles SSL/routing
- Familiar k8s patterns for future team members

### DOKS Pain Points

1. **Cost unpredictability** - Node pool scaling creates variable monthly bills
2. **Operational complexity** - k8s concepts (CRDs, operators, etc.) for simple workloads
3. **Resource overhead** - System components consume significant cluster resources
4. **Per-pilot isolation** - Namespaces provide soft isolation only

---

## VPS Architecture Options

### Option A: Containerized PostgreSQL + Whole-Droplet Backups

```
┌────────────────────────────────────────────────────┐
│  Droplet (4GB RAM / 2 vCPU)           ~$24/month   │
├────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────┐    │
│  │ Docker Compose Stack                       │    │
│  │   - caddy (reverse proxy)                  │    │
│  │   - frontend (nginx + Angular)             │    │
│  │   - postgrest (API)                        │    │
│  │   - postgres (database)                    │    │
│  │   - consolidated-worker                    │    │
│  │   - migrations (init container)            │    │
│  └────────────────────────────────────────────┘    │
│                                                    │
│  Daily Backups (30% of droplet cost)  ~$7/month   │
│  OR Snapshots ($0.06/GB)              ~$1/month   │
└────────────────────────────────────────────────────┘
Total: ~$25-31/month
```

**Pros:**
- Lowest cost
- Entire stack restored from single snapshot
- Aligns with existing docker-compose.prod.yml

**Cons:**
- You manage PostgreSQL updates/security
- No automatic failover
- Backup/restore is manual process

### Option B: Managed PostgreSQL + Lightweight Droplet (Recommended)

```
┌────────────────────────────────────────────────────┐
│  Droplet (2GB RAM / 1 vCPU)           ~$12/month   │
├────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────┐    │
│  │ Docker Compose Stack                       │    │
│  │   - caddy (reverse proxy)                  │    │
│  │   - frontend (nginx + Angular)             │    │
│  │   - postgrest (API)                        │    │
│  │   - consolidated-worker                    │    │
│  │   - migrations (init container)            │    │
│  └────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────┐
│  Managed PostgreSQL (1GB/10GB)        ~$15/month   │
│  - Automatic daily backups + PITR                  │
│  - Automatic security patches                      │
│  - SSL encryption included                         │
└────────────────────────────────────────────────────┘
Total: ~$27/month
```

**Why no droplet backups needed:** Civic OS services are stateless:
- **Frontend** = static files rebuilt from Docker image
- **PostgREST** = stateless API, no local state
- **Workers** = stateless processors, no local state
- **Config files** = stored in git or provisioning scripts

All persistent data lives in Managed PostgreSQL (automatic backups) or S3 (11 9's durability).

**Pros:**
- Database operations offloaded to DigitalOcean
- Automatic backups with point-in-time recovery
- Security patches handled automatically
- Can scale database independently
- No droplet backup costs (stateless architecture)

**Cons:**
- Higher cost than self-managed DB
- Slight network latency (database external to droplet)
- Two things to manage instead of one

### Option C: Hybrid with Optional Upgrades

Start with Option B (recommended), with clear upgrade paths:

| Stage | Configuration | Monthly Cost |
|-------|---------------|--------------|
| Prototype | Managed PostgreSQL + 2GB droplet | ~$27 |
| Production | Same (stateless = no change needed) | ~$27 |
| High-traffic | Managed DB + larger droplet (4GB) | ~$39 |
| Enterprise | Managed DB HA + larger droplet | ~$69+ |

### Disaster Recovery (Stateless Architecture)

If a droplet dies completely, recovery is straightforward:

```bash
# 1. Create new droplet (~2 minutes)
doctl compute droplet create civicos-pilot-new \
  --image docker-20-04 \
  --size s-1vcpu-2gb \
  --user-data-file cloud-init.yaml

# 2. SSH in and deploy (~5 minutes)
ssh deploy@new-droplet
cd /opt/civic-os
docker compose pull
docker compose up -d

# 3. Update DNS (instant with low TTL)
# Point pilot.civic-os.app → new droplet IP
```

**Total recovery time: ~10-15 minutes**
**Data loss: Zero** (database in Managed PostgreSQL, files in S3)

---

## Component-by-Component Recommendations

### 1. Database Strategy

**Recommendation: Managed PostgreSQL**

| Factor | Containerized | Managed | Verdict |
|--------|---------------|---------|---------|
| Cost | $0 (included in droplet) | $15/month | Managed costs more |
| Backups | Manual scripting | Automatic + PITR | **Managed wins** |
| Security patches | Your responsibility | Automatic | **Managed wins** |
| PostGIS support | Full control | Supported | Tie |
| Restore complexity | Snapshot-based | 1-click | **Managed wins** |
| Ops burden | High | Low | **Managed wins** |

The $15/month premium for managed PostgreSQL buys significant peace of mind. For pilots handling real user data, automatic backups and security patches are worth the cost.

**Source:** [DigitalOcean Managed Database Pricing](https://www.digitalocean.com/pricing/managed-databases)

### 2. Provisioning/Templating

**Recommendation: doctl + Shell Scripts (Phase 1), Terraform (Phase 2)**

| Approach | Learning Curve | Best For | State Management |
|----------|----------------|----------|------------------|
| doctl + bash | Low | <5 instances, prototyping | None |
| Terraform + cloud-init | Medium | 5+ instances, teams | Drift detection |
| Ansible | Medium-High | Server config management | Idempotent playbooks |
| App Platform | Lowest | Single-container apps | N/A (PaaS) |

**Phase 1 (Prototype):** Use doctl scripts to quickly spin up demo instance.
```bash
doctl compute droplet create civicos-demo \
  --image docker-20-04 \
  --size s-2vcpu-2gb \
  --region nyc1 \
  --user-data-file cloud-init.yaml
```

**Phase 2 (5+ pilots):** Migrate to Terraform for reproducibility.

**Source:** [DigitalOcean Terraform Tutorial](https://www.digitalocean.com/community/tutorials/how-to-use-terraform-with-digitalocean)

### 3. Network Design (Routing/Subdomains)

**Recommendation: Caddy Reverse Proxy**

| Option | SSL Handling | Config Complexity | Dynamic Discovery |
|--------|--------------|-------------------|-------------------|
| **Caddy** | Automatic (built-in) | Low (Caddyfile) | Via reload |
| Traefik | Via companion | Medium (labels) | Automatic |
| nginx-proxy | Via companion | Medium | Automatic |
| DO Load Balancer | Automatic | Lowest | N/A |

**Why Caddy:**
- Automatic HTTPS with zero configuration
- Simple Caddyfile syntax
- [Supports multiple domains](https://caddyserver.com/docs/caddyfile/patterns) for custom customer domains
- [Zero-downtime config reloads](https://caddy.community/t/zero-downtime-deployments/19122)
- Wildcard certificates via DNS-01 challenge (requires DNS provider module)

**Multi-Domain Configuration:**
```caddyfile
# Explicit domains (automatic SSL via HTTP-01)
mypilot.civic-os.app, civicos.customerdomain.org {
    reverse_proxy frontend:80
}

api.mypilot.civic-os.app, api.civicos.customerdomain.org {
    reverse_proxy postgrest:3000
}

# Wildcard (requires DNS module, e.g., Cloudflare)
*.civic-os.app {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
    }
    reverse_proxy frontend:80
}
```

**Sources:**
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Reverse Proxy Comparison 2025](https://www.programonaut.com/reverse-proxies-compared-traefik-vs-caddy-vs-nginx-docker/)

### 4. App Management (Updates/Migrations)

**Recommendation: docker-rollout + GitHub Actions**

| Approach | Zero-Downtime | Automation | Complexity |
|----------|---------------|------------|------------|
| Manual `docker compose up` | No | None | Low |
| **docker-rollout** | Yes | CLI tool | Low |
| Blue-green scripting | Yes | Custom | Medium |
| Watchtower | No (restarts) | Automatic | Low |
| Self-hosted runner | Yes | Full CI/CD | High |

**Why docker-rollout:**
- [Zero-downtime for Docker Compose](https://github.com/wowu/docker-rollout) without k8s complexity
- Works with Caddy/Traefik reverse proxies
- Simple CLI: `docker rollout frontend`
- Healthcheck-based promotion

**Deployment Flow:**
```bash
#!/bin/bash
# deploy.sh - Zero-downtime deployment

# 1. Pull new images
docker compose pull

# 2. Run migrations FIRST (before rolling services)
docker compose run --rm migrations

# 3. Roll services with zero downtime
docker rollout postgrest
docker rollout frontend
docker rollout consolidated-worker
```

**Key Requirements for Zero-Downtime:**
1. Services must NOT have `container_name` in docker-compose.yml
2. Services must NOT have `ports:` - only Caddy exposes ports
3. Services MUST have healthchecks defined
4. Migrations must be backward-compatible

**GitHub Actions Integration:**
```yaml
name: Deploy to VPS
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [demo, pilot-a, pilot-b]
      version:
        required: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets[format('{0}_HOST', inputs.environment)] }}
          username: deploy
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd /opt/civic-os
            ./deploy.sh ${{ inputs.version }}
```

**Sources:**
- [Docker Rollout GitHub](https://github.com/wowu/docker-rollout)
- [Zero Downtime Docker Compose Tutorial](https://www.virtualizationhowto.com/2025/06/docker-rollout-zero-downtime-deployments-for-docker-compose-made-simple/)

---

## Cost Comparison

### Current DOKS Estimate (2-4 instances)

| Component | Monthly Cost |
|-----------|--------------|
| DOKS control plane | ~$12 |
| Node pool (2x 4GB nodes) | ~$48 |
| Load balancer | ~$12 |
| Block storage (50GB × 3) | ~$15 |
| **Total** | **~$87/month** |

*Note: Actual DOKS costs vary based on scaling. Request actual billing data for accurate comparison.*

### VPS Architecture Estimate (per instance)

| Component | Option A (Self-Managed DB) | Option B (Managed DB) |
|-----------|---------------------------|----------------------|
| Droplet | $24 (4GB/2vCPU) | $12 (2GB/1vCPU) |
| Managed PostgreSQL | - | $15 |
| Droplet backups | $7.20 (if needed) | **$0** (stateless) |
| DNS (shared) | ~$0 | ~$0 |
| **Per Instance** | **~$24-31/month** | **~$27/month** |

**Why Option B has no droplet backup costs:** Civic OS services are stateless. All persistent data is in:
- **Managed PostgreSQL** → automatic daily backups + PITR included
- **S3** → inherently durable (11 9's)
- **Config files** → stored in git/provisioning scripts

If a droplet dies, re-provision from scratch in ~10 minutes. No data loss.

### Comparison at Scale

| # Instances | DOKS (est.) | VPS Option A | VPS Option B (Recommended) |
|-------------|-------------|--------------|---------------------------|
| 1 | ~$72 | ~$31 | **~$27** |
| 2 | ~$87 | ~$62 | **~$54** |
| 3 | ~$102 | ~$93 | **~$81** |
| 4 | ~$120 | ~$124 | **~$108** |
| 5 | ~$135 | ~$155 | **~$135** |

**Insight:** With stateless architecture (Option B), VPS is cost-competitive with DOKS up to ~5 instances. Beyond that, consider whether predictability and isolation outweigh pure cost savings.

**VPS advantages regardless of scale:**
- **Predictable** monthly costs (no autoscaling surprises)
- **Complete isolation** between pilots (no shared infrastructure)
- **Simpler operations** (no k8s expertise required)

---

## Migration Path

### Phase 1: Prototype (Week 1-2)

**Goal:** Validate VPS architecture with demo instance

1. **Create demo droplet** using doctl + cloud-init
2. **Deploy existing docker-compose.prod.yml** with modifications:
   - Add Caddy service
   - Remove `container_name` from services
   - Add healthchecks to all services
3. **Configure Managed PostgreSQL** and point docker-compose to it
4. **Install docker-rollout** and verify zero-downtime deploys
5. **Document learnings** and adjust architecture

**Success Criteria:**
- [ ] Demo accessible at demo.civic-os.app
- [ ] Zero-downtime deploy verified
- [ ] Droplet rebuild tested (stateless recovery)
- [ ] SSL working for custom domain

### Phase 2: Production Template (Week 3-4)

**Goal:** Create reproducible deployment template

1. **Create provisioning scripts** (doctl/cloud-init)
2. **Create GitHub Actions workflow** for deployment
3. **Document operational runbook**:
   - How to create new instance
   - How to deploy updates
   - How to rebuild droplet (stateless recovery)
   - How to add custom domain
4. **Set up monitoring** (existing uptime monitoring + new healthchecks)

### Phase 3: Pilot Migration (Week 5+)

**Goal:** Migrate one pilot from DOKS to VPS

1. **Create VPS instance** for pilot
2. **Export data** from DOKS postgres
3. **Import data** to Managed PostgreSQL
4. **Update DNS** to point to new VPS
5. **Verify functionality** with pilot stakeholder
6. **Decommission DOKS namespace**

**Repeat for remaining pilots.**

---

## Risk Assessment

### High Risk

| Risk | Mitigation |
|------|------------|
| Data loss during migration | Full pg_dump before migration; keep DOKS running until verified |
| Downtime during DNS cutover | Use low TTL (300s) before migration; have rollback plan |
| Managed DB connection issues | Test connection from droplet before migration |

### Medium Risk

| Risk | Mitigation |
|------|------------|
| Docker-rollout doesn't work as expected | Test thoroughly on demo; have manual fallback |
| Caddy configuration complexity | Start with explicit domains; add wildcards later |
| Higher-than-expected costs | Monitor billing weekly during pilot phase |

### Low Risk

| Risk | Mitigation |
|------|------------|
| Team unfamiliar with VPS ops | Document everything; VPS is simpler than k8s |
| Scaling limitations | Can always move high-traffic pilots back to k8s |

---

## Decision Matrix

### Go/No-Go Criteria

| Criterion | Weight | DOKS | VPS | Notes |
|-----------|--------|------|-----|-------|
| Cost predictability | High | 2/5 | 5/5 | Primary driver for investigation |
| Cost efficiency | High | 3/5 | 4/5 | ~$27/instance vs ~$29/instance equivalent |
| Operational simplicity | High | 2/5 | 4/5 | No k8s expertise needed |
| Per-instance isolation | Medium | 3/5 | 5/5 | Full isolation vs namespace |
| Scaling flexibility | Medium | 5/5 | 3/5 | k8s scales more easily |
| HA/redundancy | Low | 4/5 | 2/5 | Single VPS is SPOF |
| Team familiarity | Medium | 3/5 | 4/5 | Docker Compose well understood |
| Disaster recovery | Medium | 3/5 | 4/5 | Stateless = 10-min rebuild, zero data loss |
| **Weighted Score** | | **2.7** | **4.2** | |

### Recommendation

**Proceed with VPS migration** using:
- **Managed PostgreSQL** for database (~$15/mo - automatic backups, security patches)
- **Caddy** for reverse proxy (automatic SSL, simple config)
- **docker-rollout** for zero-downtime deployments
- **GitHub Actions** for deployment automation
- **doctl scripts** for provisioning (migrate to Terraform at 5+ instances)
- **No droplet backups** - stateless architecture means fast rebuild with zero data loss

**Estimated cost: ~$27/month per instance** (Droplet $12 + Managed PostgreSQL $15)

---

## Next Steps

1. **[ ] Get actual DOKS billing data** for accurate cost comparison
2. **[ ] Create prototype on demo instance**
3. **[ ] Develop provisioning scripts** and document
4. **[ ] Test full migration workflow** (export/import/cutover)
5. **[ ] Get stakeholder approval** to proceed with first pilot migration

---

## References

- [DigitalOcean Managed Database Pricing](https://www.digitalocean.com/pricing/managed-databases)
- [DigitalOcean Droplet Pricing](https://www.digitalocean.com/pricing/droplets)
- [Docker Rollout GitHub](https://github.com/wowu/docker-rollout)
- [Caddy Server Documentation](https://caddyserver.com/docs/)
- [Terraform DigitalOcean Provider](https://www.digitalocean.com/community/tutorials/how-to-use-terraform-with-digitalocean)
- [Zero-Downtime Docker Compose](https://www.virtualizationhowto.com/2025/06/docker-rollout-zero-downtime-deployments-for-docker-compose-made-simple/)
