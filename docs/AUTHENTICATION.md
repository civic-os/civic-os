# Civic OS Authentication Setup

This guide explains how to configure Keycloak authentication for Civic OS, with emphasis on setting up roles for testing RBAC (Role-Based Access Control) features.

## Overview

Civic OS uses Keycloak for authentication and role-based authorization. You have two options:

| Option | Best For | Pros | Cons |
|--------|----------|------|------|
| **A. Shared Instance** | Quick testing, learning | No setup required | Can't manage roles/users, can't test RBAC |
| **B. Your Own Keycloak** | Development, RBAC testing | Full control, test all features | Requires setup |

## Option A: Using the Shared Instance (Quick Start)

The default configuration uses a shared Keycloak instance at `auth.civic-os.org`.

**What you can do:**
- ✅ Login and test basic authentication
- ✅ See how the application works

**What you CANNOT do:**
- ❌ Create or manage roles (`admin`, `editor`, `user`)
- ❌ Assign roles to users
- ❌ Test permission system or RBAC features
- ❌ Access the Permissions management page (requires `admin` role)

**Setup:**
1. Use the default settings in `.env.example`
2. Run `./fetch-keycloak-jwk.sh` in the `example/` directory
3. Start the application

**When to use this:** Initial exploration of Civic OS, understanding the basic flow.

---

## Option B: Running Your Own Keycloak (Recommended)

To fully test Civic OS features, especially RBAC, you need your own Keycloak instance where you have admin access.

### B1: Local Keycloak with Docker (Easiest)

Add Keycloak to your Docker Compose setup:

#### 1. Add Keycloak Service to docker-compose.yml

Edit `example/docker-compose.yml` and uncomment (or add) the Keycloak service:

```yaml
services:
  # ... existing services (postgres, postgrest) ...

  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    container_name: keycloak_server
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
      KC_HEALTH_ENABLED: true
      KC_METRICS_ENABLED: true
    ports:
      - "8080:8080"
    command: start-dev
    networks:
      - postgrest-network
```

#### 2. Start Keycloak

```bash
cd example
docker-compose up -d keycloak
```

Access Keycloak admin console at: **http://localhost:8080**
- Username: `admin`
- Password: `admin`

#### 3. Update Configuration

Edit `example/.env`:

```bash
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=civic-os-dev
KEYCLOAK_CLIENT_ID=myclient
```

Edit `src/app/app.config.ts` (lines 36-39):

```typescript
provideKeycloak({
  config: {
    url: 'http://localhost:8080',        // Changed from https://auth.civic-os.org
    realm: 'civic-os-dev',               // Keep same or customize
    clientId: 'myclient'                 // Keep same or customize
  },
  // ... rest of config
```

Now proceed to **Realm Configuration** below.

---

### B2: Cloud Keycloak

Use a hosted Keycloak instance (Keycloak.cloud, AWS, GCP, Azure, etc.)

#### Popular Options:
- **[Keycloak.cloud](https://www.keycloak.org/cloud)** - Official hosted service
- **[Auth0](https://auth0.com/)** - Commercial alternative (OIDC compatible)
- **AWS**: Deploy Keycloak on EC2/ECS
- **GCP/Azure**: Use container services

#### Setup Steps:
1. Deploy Keycloak to your chosen platform
2. Note your Keycloak URL (e.g., `https://keycloak.example.com`)
3. Update `.env` and `app.config.ts` with your URL
4. Proceed to **Realm Configuration** below

---

## Realm Configuration (Required for Option B)

Once you have your own Keycloak instance, configure a realm for Civic OS.

### Step 1: Create Realm

1. **Login to Keycloak Admin Console**
   - Local: http://localhost:8080
   - Cloud: Your Keycloak URL

2. **Create Realm**
   - Click dropdown in top-left (says "master")
   - Click "Create Realm"
   - **Realm name**: `civic-os-dev` (or your choice)
   - Click "Create"

### Step 2: Create Client

1. **Navigate to Clients**
   - In left sidebar: Clients → Create client

2. **General Settings**
   - **Client type**: OpenID Connect
   - **Client ID**: `myclient` (or your choice)
   - Click "Next"

3. **Capability Config**
   - **Client authentication**: OFF (public client for frontend)
   - **Authorization**: OFF
   - **Authentication flow**:
     - ✅ Standard flow (login redirect)
     - ✅ Direct access grants (for testing)
   - Click "Next"

4. **Login Settings**
   - **Root URL**: `http://localhost:4200`
   - **Home URL**: `http://localhost:4200`
   - **Valid redirect URIs**:
     - `http://localhost:4200/*`
     - `http://localhost:4200/silent-check-sso.html`
   - **Valid post logout redirect URIs**: `http://localhost:4200/*`
   - **Web origins**: `http://localhost:4200`
   - Click "Save"

### Step 3: Create Roles

This is the **critical step** for testing RBAC features.

1. **Navigate to Realm Roles**
   - In left sidebar: Realm roles → Create role

2. **Create each role:**

   **Role: `user`**
   - Role name: `user`
   - Description: "Standard authenticated user"
   - Click "Save"

   **Role: `editor`**
   - Role name: `editor`
   - Description: "Can create and edit content"
   - Click "Save"

   **Role: `admin`**
   - Role name: `admin`
   - Description: "Full administrative access"
   - Click "Save"

> **Note**: The `anonymous` role is automatically assigned by the backend for unauthenticated requests. Don't create it in Keycloak.

### Step 4: Configure Role Mapper

Ensure roles appear in JWT tokens so Civic OS can read them.

1. **Navigate to Client Scopes**
   - In left sidebar: Client scopes → `roles`

2. **Add Mapper (if not exists)**
   - Click "Mappers" tab
   - If "realm roles" mapper exists, you're done!
   - If not: Click "Add mapper" → "By configuration" → "User Realm Role"

3. **Configure Realm Roles Mapper**
   - **Name**: `realm roles`
   - **Mapper Type**: User Realm Role
   - **Token Claim Name**: `realm_access.roles` (default)
   - **Claim JSON Type**: String
   - **Add to ID token**: ON
   - **Add to access token**: ON
   - **Add to userinfo**: ON
   - Click "Save"

### Step 5: Configure User Profile (Phone Number)

Civic OS syncs user profile data from Keycloak JWT claims to the database. To enable phone number management, add a custom user attribute and JWT mapper.

#### 5a. Add Phone Number User Attribute

1. **Navigate to Realm Settings**
   - In left sidebar: Realm settings → User profile tab

2. **Create Attribute**
   - Click "Create attribute"
   - **Attribute name**: `phoneNumber`
   - **Display name**: `Phone number`
   - **Validation**: (Optional) Add phone number format validation
   - **Required for**: Select "users" and "admins" if you want to make it required
   - **Permissions**: "Users can view" and "Users can edit"
   - Click "Create"

#### 5b. Create JWT Token Mapper for Phone

1. **Navigate to Client Scopes**
   - In left sidebar: Client scopes → `profile`

2. **Add Phone Mapper**
   - Click "Mappers" tab
   - Click "Add mapper" → "By configuration"
   - Select "User Attribute"

3. **Configure Mapper**
   - **Name**: `phone number`
   - **User Attribute**: `phoneNumber`
   - **Token Claim Name**: `phone_number`
   - **Claim JSON Type**: String
   - **Add to ID token**: ON
   - **Add to access token**: ON
   - **Add to userinfo**: ON
   - Click "Save"

#### 5c. Verify Phone Sync

After configuring the mapper:

1. **Create or Edit a User** and set their phone number
2. **Login to Civic OS** as that user
3. **Check Database** - Phone should appear in `civic_os_users` view:
   ```sql
   SELECT id, display_name, phone FROM civic_os_users WHERE phone IS NOT NULL;
   ```

> **Note**: Phone numbers are synced from Keycloak on login. Users manage their phone number via Keycloak's account console (accessible from the "Account Settings" menu in Civic OS).

### Step 6: Create Test Users

1. **Navigate to Users**
   - In left sidebar: Users → Create new user

2. **Create User**
   - **Username**: `testuser` (or your choice)
   - **Email**: `testuser@example.com`
   - **Email verified**: ON
   - **First name**: Test
   - **Last name**: User
   - Click "Create"

3. **Set Password**
   - Click "Credentials" tab
   - Click "Set password"
   - **Password**: Choose a password
   - **Temporary**: OFF (so you don't have to reset on first login)
   - Click "Save"

4. **Assign Roles**
   - Click "Role mappings" tab
   - Click "Assign role"
   - Select the roles you want this user to have:
     - Start with `user` for basic access
     - Add `admin` to test the Permissions page
   - Click "Assign"

5. **Create Multiple Test Users** (Recommended)
   - Create `admin-user` with `admin` role
   - Create `editor-user` with `user` and `editor` roles
   - Create `regular-user` with only `user` role

### Step 7: Verify Role Configuration

It's critical to verify roles are included in JWT tokens:

1. **Login to Civic OS**
   - Start Civic OS: `npm start`
   - Click "Login"
   - Login with your test user

2. **Get JWT Token**
   - Open browser DevTools (F12)
   - Go to: Application → Local Storage → `http://localhost:4200`
   - Look for a key containing "keycloak" and your token

   OR use this in browser console:
   ```javascript
   localStorage.getItem('kc-callback-civic-os-dev')
   ```

3. **Decode JWT**
   - Copy the token value
   - Go to [jwt.io](https://jwt.io)
   - Paste the token
   - Look for `realm_access.roles` in the payload:
     ```json
     {
       "realm_access": {
         "roles": ["admin", "user"]
       }
     }
     ```

4. **If roles are missing:**
   - Check Step 4 (Role Mapper configuration)
   - Ensure you selected "Add to access token"
   - Try logging out and back in
   - Check the client scope is assigned to your client

---

## Update Application Configuration

After setting up your Keycloak realm, configure Civic OS to use it.

### 1. Update Environment File

Edit `example/.env`:

```bash
# Database Configuration
POSTGRES_DB=civic_os_db
POSTGRES_PASSWORD=YOUR_SECURE_PASSWORD

# Keycloak Settings
KEYCLOAK_URL=http://localhost:8080              # Your Keycloak URL
KEYCLOAK_REALM=civic-os-dev                     # Your realm name
KEYCLOAK_CLIENT_ID=myclient                     # Your client ID
```

### 2. Update Frontend Configuration

Edit `src/app/app.config.ts`:

```typescript
provideKeycloak({
  config: {
    url: 'http://localhost:8080',        // Match .env KEYCLOAK_URL
    realm: 'civic-os-dev',               // Match .env KEYCLOAK_REALM
    clientId: 'myclient'                 // Match .env KEYCLOAK_CLIENT_ID
  },
  initOptions: {
    onLoad: 'check-sso',
    silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html'
  },
}),
```

### 3. Fetch JWKS (JWT Signing Key)

PostgREST needs Keycloak's public key to verify JWT tokens:

```bash
cd example
./fetch-keycloak-jwk.sh
```

This creates `jwt-secret.jwks` containing Keycloak's public key.

### 4. Restart Services

```bash
cd example
docker-compose restart postgrest
cd ..
npm start
```

---

## Testing RBAC Features

With your Keycloak configured and roles assigned, test the RBAC system:

### 1. Test Basic Authentication

- Login as any user
- Verify you can see entities and navigate the application

### 2. Test Role-Based UI

Login as different users and observe UI changes:

**User with `admin` role:**
- ✅ Can see "Admin" section in left menu
- ✅ Can access Permissions page (`/permissions`)
- ✅ Can access Entities page (`/entity-management`)

**User with `editor` role:**
- ✅ Can create and edit entities
- ✅ No admin menu section

**User with only `user` role:**
- ✅ Can view entities
- ❌ Cannot create/edit (depending on permissions configuration)

### 3. Test Permissions Page

1. Login as a user with `admin` role
2. Navigate to: Permissions (in left menu under Admin)
3. Select a role from dropdown
4. Toggle CRUD permissions for different tables
5. Changes save automatically

### 4. Verify Database Permissions

Test that roles and permissions are working through the PostgREST API.

**Important**: JWT-dependent functions (`get_user_roles()`, `has_permission()`, `is_admin()`) only work when requests come through PostgREST with a valid JWT token. Direct psql queries will return NULL because there's no JWT context in a database console session.

#### Getting Your JWT Token

1. **Login to Civic OS** at http://localhost:4200
2. **Open Browser DevTools** (F12)
3. **Option A - Local Storage Method**:
   - Go to: Application → Local Storage → `http://localhost:4200`
   - Look for key containing your token

4. **Option B - Console Method** (easiest):
   ```javascript
   // Paste this in browser console
   localStorage.getItem('kc-callback-civic-os-dev')
   ```

5. **Copy the token value** (the long string after opening quotes)

#### Test RBAC Through PostgREST

```bash
# Set your JWT token as environment variable
export TOKEN="your-jwt-token-here"

# Test 1: Check API access (should return list of entities)
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:3000/schema_entities

# Test 2: Check your roles (calls get_user_roles() via PostgREST RPC)
curl -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -X POST \
     http://localhost:3000/rpc/get_user_roles

# Test 3: Check if you have read permission on Issue table
curl -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"table_name":"Issue","permission":"read"}' \
     -X POST \
     http://localhost:3000/rpc/has_permission

# Test 4: Check if you're an admin
curl -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -X POST \
     http://localhost:3000/rpc/is_admin
```

**Expected Results:**
- If you have `admin` role: `get_user_roles()` should include "admin", `is_admin()` should return true
- If you have `user` role: `get_user_roles()` should include "user"
- Permissions depend on your configuration in the Permissions page

**Troubleshooting:**
- If you get 401 Unauthorized: Token expired or invalid, login again and get new token
- If you get empty response: Function may not be exposed via RPC (check postgres/2_rbac_functions.sql)
- If roles are empty: Check JWT token at jwt.io - roles should be in `realm_access.roles`

---

## Troubleshooting

### Roles Not Appearing in Token

**Symptoms:**
- Permissions page not visible for admin users
- `AuthService.userRoles` is empty in browser console

**Solutions:**
1. Verify role mapper configuration (Step 4)
2. Check that "Add to access token" is enabled
3. Log out completely and log back in
4. Clear browser localStorage and cookies
5. Check JWT at jwt.io to see what's in the token

### Cannot Login

**Symptoms:**
- Redirect loop
- "Invalid redirect URI" error

**Solutions:**
1. Check Valid Redirect URIs in client configuration
2. Ensure Web Origins matches your frontend URL
3. Check browser console for errors
4. Verify KEYCLOAK_URL is correct in both `.env` and `app.config.ts`

### JWT Validation Fails (PostgREST)

**Symptoms:**
- 401 Unauthorized errors
- "JWT verification failed" in PostgREST logs

**Solutions:**
1. Re-run `./fetch-keycloak-jwk.sh` to update public key
2. Restart PostgREST: `docker-compose restart postgrest`
3. Check `jwt-secret.jwks` exists and contains a key
4. Verify JWKS URL is accessible:
   ```bash
   curl http://localhost:8080/realms/civic-os-dev/protocol/openid-connect/certs
   ```

### Permissions Not Working

**Symptoms:**
- User can access resources they shouldn't
- Permission changes in UI don't take effect

**Solutions:**
1. Verify roles are correctly assigned in Keycloak
2. Check database has role-permission mappings:
   ```sql
   SELECT * FROM metadata.permission_roles WHERE role_name = 'your-role';
   ```
3. Verify RLS policies are enabled on tables
4. Check PostgREST logs for SQL errors

---

## Best Practices

### Development

- **Use local Keycloak** (Docker) for development
- **Create multiple test users** with different role combinations
- **Keep realm configuration in code** - Export realm configuration and commit it to version control

### Production

- **Use managed Keycloak** or highly available setup
- **Enable HTTPS** for all Keycloak connections
- **Rotate JWT signing keys** periodically
- **Use strong passwords** for admin accounts
- **Enable MFA** for admin users
- **Monitor token expiration** and implement refresh token flow
- **Review and audit** role assignments regularly

---

## Reference Links

- **Keycloak Documentation**: https://www.keycloak.org/documentation
- **Keycloak Admin Guide**: https://www.keycloak.org/docs/latest/server_admin/
- **JWT.io**: https://jwt.io - Decode and inspect JWT tokens
- **OIDC Spec**: https://openid.net/connect/ - OpenID Connect specification

---

## Next Steps

After completing authentication setup:

1. **Configure Database Permissions** - Use the Permissions page to set table-level CRUD permissions
2. **Test with Different Roles** - Login as different users to see how the UI adapts
3. **Add Custom Entities** - Create your own tables and see them automatically appear in the UI
4. **Explore RBAC** - Understand how database Row-Level Security policies work with Keycloak roles

For more information, see:
- [CLAUDE.md](../CLAUDE.md) - Developer guide and architecture details
- [example/README.md](../example/README.md) - Docker setup and database initialization
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues and solutions
