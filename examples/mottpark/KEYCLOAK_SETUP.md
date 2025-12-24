# Local Keycloak Setup for Mottpark

This guide covers running a local Keycloak instance for RBAC testing and user management.

## Quick Start

```bash
# 1. Start Keycloak (takes ~90 seconds to be ready)
docker-compose up -d keycloak

# 2. Wait for Keycloak to be healthy
docker-compose ps keycloak  # Should show "healthy"

# 3. Fetch JWT keys and restart PostgREST
./fetch-keycloak-jwk.sh && docker-compose restart postgrest

# 4. Start the Angular frontend
npm start
```

## Access Points

| Service | URL | Credentials |
|---------|-----|-------------|
| Keycloak Admin Console | http://localhost:8082 | admin / admin |
| Keycloak Account Console | http://localhost:8082/realms/mottpark-dev/account | (test user) |
| Angular Frontend | http://localhost:4200 | (test user) |

## Pre-configured Test Users

| Username | Password | Roles | Use Case |
|----------|----------|-------|----------|
| testuser | testuser | user | Standard authenticated user |
| testmanager | testmanager | user, manager | Can create, edit, manage records |
| testadmin | testadmin | user, admin | Full admin access + Permissions page |

All test users have email verification disabled for convenience.

## Keycloak Admin REST API

The Admin API allows programmatic user and role management. Useful for scripting test scenarios.

### Step 1: Get Admin Access Token

```bash
# Get token (valid for 60 seconds by default)
TOKEN=$(curl -s -X POST "http://localhost:8082/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=admin-cli" \
  -d "username=admin" \
  -d "password=admin" \
  -d "grant_type=password" | jq -r '.access_token')

# Verify token was obtained
echo $TOKEN | head -c 50
```

### Step 2: List All Users

```bash
curl -s "http://localhost:8082/admin/realms/mottpark-dev/users" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Step 3: Create a New User

```bash
curl -X POST "http://localhost:8082/admin/realms/mottpark-dev/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "newuser",
    "email": "newuser@example.com",
    "firstName": "New",
    "lastName": "User",
    "enabled": true,
    "emailVerified": true,
    "credentials": [{
      "type": "password",
      "value": "password123",
      "temporary": false
    }]
  }'

# Get the new user's ID
USER_ID=$(curl -s "http://localhost:8082/admin/realms/mottpark-dev/users?username=newuser" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

echo "Created user with ID: $USER_ID"
```

### Step 4: List Available Roles

```bash
curl -s "http://localhost:8082/admin/realms/mottpark-dev/roles" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {name, id}'
```

### Step 5: Assign a Role to a User

```bash
# Get role details (e.g., 'manager')
ROLE=$(curl -s "http://localhost:8082/admin/realms/mottpark-dev/roles/manager" \
  -H "Authorization: Bearer $TOKEN")

# Assign role to user
curl -X POST "http://localhost:8082/admin/realms/mottpark-dev/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[$ROLE]"
```

### Step 6: Get User's Assigned Roles

```bash
curl -s "http://localhost:8082/admin/realms/mottpark-dev/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $TOKEN" | jq '.[].name'
```

### Step 7: Remove a Role from a User

```bash
ROLE=$(curl -s "http://localhost:8082/admin/realms/mottpark-dev/roles/manager" \
  -H "Authorization: Bearer $TOKEN")

curl -X DELETE "http://localhost:8082/admin/realms/mottpark-dev/users/$USER_ID/role-mappings/realm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[$ROLE]"
```

### Step 8: Delete a User

```bash
curl -X DELETE "http://localhost:8082/admin/realms/mottpark-dev/users/$USER_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## Complete Script Example

```bash
#!/bin/bash
# create-test-user.sh - Create a user with specific roles

set -e

USERNAME="$1"
PASSWORD="$2"
ROLES="$3"  # Comma-separated: "user,manager"

if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  echo "Usage: $0 <username> <password> [roles]"
  exit 1
fi

# Get admin token
TOKEN=$(curl -s -X POST "http://localhost:8082/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" \
  -d "username=admin" \
  -d "password=admin" \
  -d "grant_type=password" | jq -r '.access_token')

# Create user
curl -s -X POST "http://localhost:8082/admin/realms/mottpark-dev/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"username\": \"$USERNAME\",
    \"email\": \"$USERNAME@example.com\",
    \"enabled\": true,
    \"emailVerified\": true,
    \"credentials\": [{\"type\": \"password\", \"value\": \"$PASSWORD\", \"temporary\": false}]
  }"

# Get user ID
USER_ID=$(curl -s "http://localhost:8082/admin/realms/mottpark-dev/users?username=$USERNAME" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

echo "Created user: $USERNAME (ID: $USER_ID)"

# Assign roles if specified
if [ -n "$ROLES" ]; then
  IFS=',' read -ra ROLE_ARRAY <<< "$ROLES"
  for ROLE_NAME in "${ROLE_ARRAY[@]}"; do
    ROLE=$(curl -s "http://localhost:8082/admin/realms/mottpark-dev/roles/$ROLE_NAME" \
      -H "Authorization: Bearer $TOKEN")
    curl -s -X POST "http://localhost:8082/admin/realms/mottpark-dev/users/$USER_ID/role-mappings/realm" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "[$ROLE]"
    echo "  Assigned role: $ROLE_NAME"
  done
fi
```

Usage:
```bash
chmod +x create-test-user.sh
./create-test-user.sh myuser mypassword "user,manager"
```

## Switching Between Local and Shared Keycloak

### To use local Keycloak (default):

1. Ensure `.env` has:
   ```bash
   KEYCLOAK_URL=http://localhost:8082
   KEYCLOAK_REALM=mottpark-dev
   KEYCLOAK_CLIENT_ID=mottpark-dev-client
   ```

2. Start Keycloak and fetch keys:
   ```bash
   docker-compose up -d keycloak
   # Wait for healthy
   ./fetch-keycloak-jwk.sh
   docker-compose restart postgrest
   ```

### To use shared Keycloak:

1. Update `.env`:
   ```bash
   KEYCLOAK_URL=https://auth.civic-os.org
   KEYCLOAK_REALM=civic-os-dev
   KEYCLOAK_CLIENT_ID=myclient
   ```

2. Fetch shared instance keys:
   ```bash
   ./fetch-keycloak-jwk.sh
   docker-compose restart postgrest
   ```

3. Stop local Keycloak (optional):
   ```bash
   docker-compose stop keycloak
   ```

## Troubleshooting

### Keycloak not starting

Check logs:
```bash
docker-compose logs keycloak
```

Common issues:
- Port 8082 already in use
- Not enough memory (Keycloak needs ~512MB)

### "Invalid token" errors in PostgREST

The JWT keys haven't been refreshed after Keycloak started:
```bash
./fetch-keycloak-jwk.sh
docker-compose restart postgrest
```

### Login redirects to wrong URL

Clear browser cookies/cache for localhost:4200, or use incognito mode.

### "User not found" after login

The user exists in Keycloak but hasn't been synced to Civic OS. The `refresh_current_user()` RPC runs automatically on login to sync profile data.

### Token expired during API calls

Admin tokens expire after 60 seconds. Get a fresh token:
```bash
TOKEN=$(curl -s -X POST "http://localhost:8082/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" -d "username=admin" -d "password=admin" \
  -d "grant_type=password" | jq -r '.access_token')
```

### Realm not imported on startup

If test users are missing, check that the realm JSON was mounted correctly:
```bash
docker-compose exec keycloak ls -la /opt/keycloak/data/import/
```

Should show `mottpark-dev.json`. If missing, ensure the keycloak directory exists:
```bash
ls -la examples/mottpark/keycloak/
```

## API Reference

Full Keycloak Admin REST API documentation:
- https://www.keycloak.org/docs-api/24.0.0/rest-api/index.html

Key endpoints used:
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/realms/{realm}/users` | GET | List users |
| `/admin/realms/{realm}/users` | POST | Create user |
| `/admin/realms/{realm}/users/{id}` | DELETE | Delete user |
| `/admin/realms/{realm}/roles` | GET | List realm roles |
| `/admin/realms/{realm}/roles/{name}` | GET | Get role by name |
| `/admin/realms/{realm}/users/{id}/role-mappings/realm` | GET | Get user's roles |
| `/admin/realms/{realm}/users/{id}/role-mappings/realm` | POST | Assign roles |
| `/admin/realms/{realm}/users/{id}/role-mappings/realm` | DELETE | Remove roles |
