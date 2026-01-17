# Civic OS VPS Deployment

Deploy Civic OS to a single VPS (DigitalOcean Droplet) with:
- **Caddy** reverse proxy with automatic HTTPS
- **docker-rollout** for zero-downtime deployments
- **Managed PostgreSQL** for database (external)

## Architecture

```
Internet → Caddy (:80/:443)
              ├── {APP_DOMAIN}       → Frontend
              ├── api.{APP_DOMAIN}   → PostgREST API
              │   └── /webhooks/stripe → Payment Worker (optional)
              └── docs.{APP_DOMAIN}  → Swagger UI

Managed PostgreSQL (external) ← All services
```

## Prerequisites

1. **DigitalOcean Account** with:
   - API token (for doctl)
   - Managed PostgreSQL database
   - Spaces bucket (for file storage)

2. **Local Tools**:
   - [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) - DigitalOcean CLI
   - SSH key pair

3. **DNS Access** to create A records

4. **Keycloak** realm configured (use shared instance at auth.civic-os.org or your own)

## Quick Start

### 1. Configure SSH Key

Edit `cloud-init.yaml` and replace the SSH key placeholder:

```yaml
ssh_authorized_keys:
  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... your-actual-key
```

### 2. Provision Droplet

```bash
# Authenticate doctl (one-time)
doctl auth init

# Create droplet
./provision.sh demo
```

This creates a `civic-os-demo` droplet with Docker and docker-rollout pre-installed.

### 3. Copy Files & Configure

```bash
# Get the droplet IP from provision.sh output
DROPLET_IP=xxx.xxx.xxx.xxx

# Copy deployment files
scp docker-compose.vps.yml Caddyfile deploy.sh .env.example \
    deploy@${DROPLET_IP}:/opt/civic-os/

# SSH in and configure
ssh deploy@${DROPLET_IP}
cd /opt/civic-os
cp .env.example .env
nano .env  # Fill in your configuration
```

### 4. Deploy

```bash
# On the droplet
./deploy.sh

# Or with payment processing enabled
./deploy.sh --payments
```

### 5. Configure DNS

Create three A records pointing to your droplet IP:
- `{instance}` → `{DROPLET_IP}`
- `api.{instance}` → `{DROPLET_IP}`
- `docs.{instance}` → `{DROPLET_IP}`

For example, if your domain is `demo.civic-os.org` and instance is `pothole`:
- `pothole.demo.civic-os.org` → `165.227.80.192`
- `api.pothole.demo.civic-os.org` → `165.227.80.192`
- `docs.pothole.demo.civic-os.org` → `165.227.80.192`

**Using doctl** (if DNS is managed by DigitalOcean):

```bash
# List available domains
doctl compute domain list

# Create A records (TTL 300 = 5 minutes)
doctl compute domain records create {domain} --record-type A --record-name {instance} --record-data {DROPLET_IP} --record-ttl 300
doctl compute domain records create {domain} --record-type A --record-name api.{instance} --record-data {DROPLET_IP} --record-ttl 300
doctl compute domain records create {domain} --record-type A --record-name docs.{instance} --record-data {DROPLET_IP} --record-ttl 300
```

> **Note**: If you have a wildcard DNS record (`*.domain`), Let's Encrypt may have issues with multi-perspective validation until the specific records propagate. Wait 5-10 minutes for DNS caches to update.

Caddy will automatically obtain SSL certificates via Let's Encrypt.

### 6. Configure Database Firewall

DigitalOcean Managed PostgreSQL blocks all connections by default. You must add the VPS IP to the trusted sources:

```bash
# Find your database cluster ID
doctl databases list

# Add VPS IP to firewall (replace {DB_ID} and {DROPLET_IP})
doctl databases firewalls append {DB_ID} --rule ip_addr:{DROPLET_IP}

# Verify the rule was added
doctl databases firewalls list {DB_ID}
```

**Example**:
```bash
doctl databases firewalls append 00888968-a952-430c-9895-1d263de733c2 --rule ip_addr:165.227.80.192
```

## Files

| File | Purpose |
|------|---------|
| `docker-compose.vps.yml` | Service definitions (docker-rollout compatible) |
| `Caddyfile` | Reverse proxy with subdomain routing |
| `deploy.sh` | Zero-downtime deployment script |
| `provision.sh` | Droplet creation via doctl |
| `cloud-init.yaml` | Droplet provisioning (Docker, firewall, etc.) |
| `.env.example` | Environment variable template |

## Updating

To deploy a new version:

```bash
ssh deploy@${DROPLET_IP}
cd /opt/civic-os

# Update VERSION in .env if needed
nano .env

# Deploy with zero-downtime rollout
./deploy.sh
```

## Costs

| Component | Monthly Cost |
|-----------|-------------|
| Droplet (s-1vcpu-2gb) | $12 |
| Managed PostgreSQL (basic) | $15 |
| Spaces (first 250GB) | $5 |
| **Total** | **~$32/mo** |

Note: Droplet backups are optional since services are stateless. All data lives in managed PostgreSQL and Spaces.

## Troubleshooting

### Check Service Health

```bash
docker compose -f docker-compose.vps.yml ps
```

### View Logs

```bash
# All services
docker compose -f docker-compose.vps.yml logs -f

# Specific service
docker compose -f docker-compose.vps.yml logs -f frontend
```

### SSL Certificate Issues

Caddy automatically handles SSL. If certificates aren't working:

1. Verify DNS records are pointing to the droplet
2. Check Caddy logs: `docker compose -f docker-compose.vps.yml logs caddy`
3. Ensure ports 80 and 443 are open: `sudo ufw status`

### Database Connection Issues

1. Verify managed PostgreSQL allows connections from droplet IP
2. Check connection string in `.env`
3. Test with: `docker compose -f docker-compose.vps.yml run --rm migrations`

### docker-rollout Not Working

```bash
# Verify docker-rollout plugin is installed
docker rollout --help

# If missing, install it as a Docker CLI plugin
mkdir -p ~/.docker/cli-plugins
curl -sL https://raw.githubusercontent.com/wowu/docker-rollout/main/docker-rollout \
    -o ~/.docker/cli-plugins/docker-rollout
chmod +x ~/.docker/cli-plugins/docker-rollout
```

## Security Notes

- **Firewall**: UFW is configured to allow only ports 22, 80, 443
- **fail2ban**: Enabled for SSH protection
- **SSL**: Automatic via Caddy/Let's Encrypt
- **Secrets**: Stored in `.env` file (not in git)
- **Database**: Uses SSL (`sslmode=require`) for managed PostgreSQL

## Scaling

This setup is designed for single-instance deployments. For scaling:

- **Vertical**: Upgrade droplet size (e.g., s-2vcpu-4gb)
- **Database**: Upgrade managed PostgreSQL tier
- **Multiple instances**: Deploy separate droplets per customer (not multi-tenant)

For true horizontal scaling, consider migrating to Kubernetes.
