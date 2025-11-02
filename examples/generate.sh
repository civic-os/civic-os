#!/bin/bash

# Wrapper script for generating mock data for any Civic OS example deployment
# Usage: ./examples/generate.sh <example-name> [--sql]
#   example-name: pothole, broader-impacts, etc.
#   --sql: Generate SQL file only (optional)

set -e  # Exit on error

# Check if example name is provided
if [ -z "$1" ]; then
  echo "Error: No example name provided"
  echo "Usage: $0 <example-name> [--sql]"
  echo "Available examples:"
  ls -1 examples/ | grep -v "^generate.sh$" | sed 's/^/  - /'
  exit 1
fi

EXAMPLE_NAME="$1"
EXAMPLE_DIR="examples/$EXAMPLE_NAME"

# Check if example directory exists
if [ ! -d "$EXAMPLE_DIR" ]; then
  echo "Error: Example '$EXAMPLE_NAME' not found at $EXAMPLE_DIR"
  echo "Available examples:"
  ls -1 examples/ | grep -v "^generate.sh$" | sed 's/^/  - /'
  exit 1
fi

# Check if .env file exists
if [ ! -f "$EXAMPLE_DIR/.env" ]; then
  echo "Error: No .env file found at $EXAMPLE_DIR/.env"
  echo "Please copy .env.example to .env and configure it."
  exit 1
fi

# Check if generate-mock-data.ts exists
if [ ! -f "$EXAMPLE_DIR/generate-mock-data.ts" ]; then
  echo "Error: No generate-mock-data.ts found at $EXAMPLE_DIR/generate-mock-data.ts"
  exit 1
fi

echo "=== Generating mock data for '$EXAMPLE_NAME' example ==="
echo "Loading environment from $EXAMPLE_DIR/.env..."

# Source the environment file
set -a
source "$EXAMPLE_DIR/.env"
set +a

# Run the generator with optional --sql flag
if [ "$2" = "--sql" ]; then
  echo "Running generator (SQL output only)..."
  npx ts-node "$EXAMPLE_DIR/generate-mock-data.ts" --sql
else
  echo "Running generator (database + SQL output)..."
  npx ts-node "$EXAMPLE_DIR/generate-mock-data.ts"
fi

echo "=== Mock data generation complete ==="
