#!/bin/bash
set -e  # Exit on error

# Load environment variables
if [ ! -f ".env" ]; then
    echo "Error: .env file not found in current directory"
    echo "Please run this script from the deployment directory (e.g., broader-impacts/)"
    exit 1
fi

source .env

# Verify required environment variables
if [ -z "$KEYCLOAK_URL" ] || [ -z "$KEYCLOAK_REALM" ]; then
    echo "Error: Missing required environment variables"
    echo "KEYCLOAK_URL and KEYCLOAK_REALM must be set in .env"
    exit 1
fi

# Construct JWKS URL
JWKS_URL="${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs"

echo "Fetching JWKS from: $JWKS_URL"

# Fetch JWKS with error handling
JWKS_JSON=$(curl -s -f "$JWKS_URL" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$JWKS_JSON" ]; then
    echo "Error: Failed to fetch JWKS from Keycloak server"
    echo "Please verify:"
    echo "  - KEYCLOAK_URL is correct: $KEYCLOAK_URL"
    echo "  - KEYCLOAK_REALM is correct: $KEYCLOAK_REALM"
    echo "  - Keycloak server is accessible"
    exit 1
fi

# Validate JSON structure
if ! echo "$JWKS_JSON" | jq empty 2>/dev/null; then
    echo "Error: Keycloak returned invalid JSON"
    echo "Response:"
    echo "$JWKS_JSON"
    exit 1
fi

echo "Available keys in JWKS:"
echo "$JWKS_JSON" | jq -r '.keys[] | "  - kid: \(.kid), alg: \(.alg), use: \(.use // "sig")"'

# Check if token.txt exists to get the kid from the actual token
if [ -f "token.txt" ]; then
    echo ""
    echo "Found token.txt, extracting Key ID from your token..."
    TOKEN=$(cat token.txt | tr -d '\n' | tr -d '\r' | tr -d ' ' | sed 's/^Bearer//g')
    HEADER=$(echo "$TOKEN" | cut -d. -f1)
    TOKEN_KID=$(echo "$HEADER" | base64 -d 2>/dev/null | jq -r '.kid' 2>/dev/null)

    if [ ! -z "$TOKEN_KID" ] && [ "$TOKEN_KID" != "null" ]; then
        echo "Your token uses Key ID: $TOKEN_KID"
        echo "Extracting JWK with matching kid..."

        # Extract JWK with matching kid (use -c for compact JSON)
        JWK=$(echo "$JWKS_JSON" | jq -c ".keys[] | select(.kid==\"$TOKEN_KID\")" | head -1)

        if [ -z "$JWK" ] || [ "$JWK" = "null" ]; then
            echo "Warning: Could not find key with kid=$TOKEN_KID, falling back to first RS256 key"
            JWK=$(echo "$JWKS_JSON" | jq -c '.keys[] | select(.alg=="RS256")' | head -1)
        fi
    else
        echo "Token has no kid, using first RS256 key"
        JWK=$(echo "$JWKS_JSON" | jq -c '.keys[] | select(.alg=="RS256")' | head -1)
    fi
else
    echo ""
    echo "Note: Create token.txt with your JWT to auto-select the correct key"
    echo "Using first RS256 key..."
    JWK=$(echo "$JWKS_JSON" | jq -c '.keys[] | select(.alg=="RS256")' | head -1)
fi

if [ -z "$JWK" ]; then
    echo "Error: Could not extract JWK from JWKS"
    exit 1
fi

echo ""
echo "Found JWK:"
echo "$JWK" | jq .

# Create JWKS format (wrap in keys array with only necessary fields)
echo "{\"keys\": [$JWK]}" | jq '{keys: [.keys[] | {kid, kty, alg, use, n, e}]}' > jwt-secret.jwks

echo ""
echo "✓ Successfully saved JWKS to jwt-secret.jwks"
echo ""
echo "Next steps:"
echo "  1. Restart PostgREST: docker-compose restart postgrest"
echo "  2. Test your application with Keycloak authentication"
