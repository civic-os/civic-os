#!/bin/bash
# SQL Integration Test Runner
# Runs all test files in postgres/migrations/tests/ against the target database
#
# Usage: ./run-tests.sh <database_url>
# Example: ./run-tests.sh "postgres://postgres:postgres@localhost:5432/civic_os_test"

set -e

DATABASE_URL="${1:-postgres://postgres:postgres@localhost:5432/civic_os_test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo "========================================"
echo "SQL Integration Test Runner"
echo "========================================"
echo "Database: $DATABASE_URL"
echo "Test Dir: $SCRIPT_DIR"
echo ""

# Find all test files (test_*.sql)
for test_file in "$SCRIPT_DIR"/test_*.sql; do
    if [ -f "$test_file" ]; then
        TEST_COUNT=$((TEST_COUNT + 1))
        test_name=$(basename "$test_file" .sql)

        echo -n "Running $test_name... "

        # Run the test file and capture output
        if output=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$test_file" 2>&1); then
            echo -e "${GREEN}PASS${NC}"
            PASS_COUNT=$((PASS_COUNT + 1))
        else
            echo -e "${RED}FAIL${NC}"
            echo "$output" | head -20
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi
    fi
done

echo ""
echo "========================================"
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed, $TEST_COUNT total"
echo "========================================"

if [ $FAIL_COUNT -gt 0 ]; then
    exit 1
fi

if [ $TEST_COUNT -eq 0 ]; then
    echo -e "${YELLOW}Warning: No test files found (test_*.sql)${NC}"
fi

exit 0
