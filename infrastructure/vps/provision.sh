#!/bin/bash
# Copyright (C) 2023-2025 Civic OS, L3C
# AGPL-3.0-or-later

# Civic OS VPS Provisioning Script
# Creates a DigitalOcean droplet with cloud-init configuration
#
# Usage:
#   ./provision.sh <instance-name> [--region <region>] [--size <size>]
#
# Examples:
#   ./provision.sh demo                    # Create 'civic-os-demo' droplet
#   ./provision.sh pilot-1 --region sfo3   # Create in San Francisco
#   ./provision.sh demo --size s-2vcpu-4gb # Use larger droplet
#
# Prerequisites:
#   - doctl installed and authenticated (doctl auth init)
#   - cloud-init.yaml configured with your SSH key

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Default values
REGION="nyc1"
SIZE="s-1vcpu-2gb"  # $12/month: 1 vCPU, 2GB RAM, 50GB SSD
IMAGE="ubuntu-24-04-x64"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

show_usage() {
    echo "Usage: $0 <instance-name> [options]"
    echo ""
    echo "Options:"
    echo "  --region <region>   DigitalOcean region (default: nyc1)"
    echo "  --size <size>       Droplet size (default: s-1vcpu-2gb)"
    echo "  --help              Show this help"
    echo ""
    echo "Common regions: nyc1, nyc3, sfo3, ams3, lon1, fra1, sgp1"
    echo "Common sizes:"
    echo "  s-1vcpu-2gb  - \$12/mo (1 vCPU, 2GB RAM) - recommended"
    echo "  s-2vcpu-4gb  - \$24/mo (2 vCPU, 4GB RAM)"
    echo "  s-4vcpu-8gb  - \$48/mo (4 vCPU, 8GB RAM)"
}

# Parse arguments
if [ $# -lt 1 ]; then
    show_usage
    exit 1
fi

INSTANCE_NAME="$1"
shift

while [[ $# -gt 0 ]]; do
    case $1 in
        --region)
            REGION="$2"
            shift 2
            ;;
        --size)
            SIZE="$2"
            shift 2
            ;;
        --help)
            show_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

DROPLET_NAME="civic-os-${INSTANCE_NAME}"

# Check for doctl
if ! command -v doctl &> /dev/null; then
    log_error "doctl not installed. Install from: https://docs.digitalocean.com/reference/doctl/how-to/install/"
    exit 1
fi

# Check doctl authentication
if ! doctl account get &> /dev/null; then
    log_error "doctl not authenticated. Run: doctl auth init"
    exit 1
fi

# Check for cloud-init.yaml
if [ ! -f "cloud-init.yaml" ]; then
    log_error "cloud-init.yaml not found."
    exit 1
fi

# Check if SSH key is configured in cloud-init.yaml
if grep -q "your-key-here" cloud-init.yaml; then
    log_error "SSH key not configured in cloud-init.yaml"
    log_error "Edit cloud-init.yaml and replace 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... your-key-here' with your actual SSH public key"
    exit 1
fi

# Check if droplet already exists
if doctl compute droplet list --format Name --no-header | grep -q "^${DROPLET_NAME}$"; then
    log_error "Droplet '${DROPLET_NAME}' already exists!"
    log_warn "Use 'doctl compute droplet delete ${DROPLET_NAME}' to remove it first"
    exit 1
fi

log_info "Creating droplet: ${DROPLET_NAME}"
log_info "  Region: ${REGION}"
log_info "  Size: ${SIZE}"
log_info "  Image: ${IMAGE}"
echo ""

# Create droplet
DROPLET_ID=$(doctl compute droplet create "${DROPLET_NAME}" \
    --region "${REGION}" \
    --size "${SIZE}" \
    --image "${IMAGE}" \
    --user-data-file cloud-init.yaml \
    --tag-names "civic-os,${INSTANCE_NAME}" \
    --format ID \
    --no-header \
    --wait)

log_info "Droplet created with ID: ${DROPLET_ID}"

# Get droplet IP
DROPLET_IP=$(doctl compute droplet get "${DROPLET_ID}" --format PublicIPv4 --no-header)

log_info "Droplet IP: ${DROPLET_IP}"
echo ""

# Wait for cloud-init to complete
log_info "Waiting for cloud-init to complete (this may take 2-3 minutes)..."
sleep 30

# Check if SSH is available
MAX_ATTEMPTS=20
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "deploy@${DROPLET_IP}" exit 2>/dev/null; then
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    log_info "Waiting for SSH... (attempt ${ATTEMPT}/${MAX_ATTEMPTS})"
    sleep 10
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    log_warn "SSH not available yet. Cloud-init may still be running."
    log_warn "Check droplet console: doctl compute droplet action get ${DROPLET_ID}"
else
    # Wait for cloud-init to complete
    log_info "SSH available. Waiting for cloud-init to complete..."
    MAX_INIT_ATTEMPTS=30
    INIT_ATTEMPT=0
    while [ $INIT_ATTEMPT -lt $MAX_INIT_ATTEMPTS ]; do
        if ssh -o StrictHostKeyChecking=no -o BatchMode=yes "deploy@${DROPLET_IP}" "test -f /var/log/civic-os-init.log" 2>/dev/null; then
            log_info "Cloud-init complete!"
            break
        fi
        INIT_ATTEMPT=$((INIT_ATTEMPT + 1))
        log_info "Waiting for cloud-init... (attempt ${INIT_ATTEMPT}/${MAX_INIT_ATTEMPTS})"
        sleep 10
    done

    if [ $INIT_ATTEMPT -eq $MAX_INIT_ATTEMPTS ]; then
        log_warn "Cloud-init may still be running. Check: ssh deploy@${DROPLET_IP} 'cloud-init status'"
    fi
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Droplet provisioned successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}Droplet:${NC} ${DROPLET_NAME}"
echo -e "${CYAN}IP:${NC}      ${DROPLET_IP}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "1. Copy deployment files to the droplet:"
echo "   scp docker-compose.vps.yml Caddyfile deploy.sh .env.example deploy@${DROPLET_IP}:/opt/civic-os/"
echo ""
echo "2. SSH into the droplet and configure:"
echo "   ssh deploy@${DROPLET_IP}"
echo "   cd /opt/civic-os"
echo "   cp .env.example .env"
echo "   nano .env  # Fill in your configuration"
echo ""
echo "3. Deploy the application:"
echo "   ./deploy.sh"
echo ""
echo "4. Create DNS records pointing to ${DROPLET_IP}:"
echo "   - A record: <your-domain> -> ${DROPLET_IP}"
echo "   - A record: api.<your-domain> -> ${DROPLET_IP}"
echo "   - A record: docs.<your-domain> -> ${DROPLET_IP}"
echo ""
