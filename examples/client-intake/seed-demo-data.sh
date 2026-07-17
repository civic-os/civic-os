#!/bin/bash
set -e
DB_URL="${1:-postgresql://postgres:securepassword123@localhost:15432/civic_os_db}"
echo "Seeding demo data..."
psql "$DB_URL" -f "$(dirname "$0")/seed-demo-data.sql"
echo "Done."
