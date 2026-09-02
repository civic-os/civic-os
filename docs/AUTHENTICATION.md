# Civic OS Authentication Setup

This guide explains how to configure Keycloak authentication for Civic OS, with emphasis on setting up roles for testing RBAC (Role-Based Access Control) features.

**Related Guides:**
- [Keycloak Upgrade Guide](deployment/KEYCLOAK_UPGRADES.md) — procedure for upgrading hosted Keycloak servers

## Overview

Civic OS uses Keycloak for authentication and role-based authorization. You have two options:

| Option | Best For | Pros | Cons |
|--------|----------|------|------|
| **A. Local Keycloak (Default)** | Development, RBAC testing | Full control, test all features, auto-imports realm config | Requires Docker |
| **B. Shared Instance** | Quick testing without Docker | No Keycloak setup required | Can't manage roles/users, can't test RBAC |

## Option A: Local Keycloak with Docker (Default)

All example docker-compose files include a pre-configured Keycloak service that automatically imports a development realm (`civic-os-dev`) with users and roles ready to use.

**What you can do:**
- ✅ Full RBAC testing with admin, editor, and user roles
- ✅ Create and manage users in Keycloak admin console
- ✅ Access the Permissions management page
- ✅ Test all Civic OS features

**Setup:**

1. Start the example with Docker Compose:
   ```bash
   cd examples/pothole  # or any example
   docker-compose up -d
   ```

2. Wait for Keycloak to initialize (~90 seconds on first start)

3. Access Keycloak admin console at: **http://localhost:8082**
   - Username: `admin`
   - Password: `admin`

4. The `civic-os-dev` realm is auto-imported with pre-configured:
   - Client: `civic-os-dev-client`
   - Roles: `user`, `editor`, `manager`, `admin`
   - Role mappers for JWT token claims
   - Test users (password = username): `testuser`, `testeditor`, `testmanager`, `testadmin`

**Angular Configuration (already set):**

The Angular environment files (`src/environments/environment*.ts`) are pre-configured for local Keycloak:

```typescript
keycloak: {
  url: 'http://localhost:8082',
  realm: 'civic-os-dev',
  clientId: 'civic-os-dev-client'
}
```

---

## Option B: Using the Shared Instance

For quick testing without running Docker, you can use the shared Keycloak instance at `auth.civic-os.org`.

**What you can do:**
- ✅ Login and test basic authentication
- ✅ See how the application works

**What you CANNOT do:**
- ❌ Create or manage roles (`admin`, `editor`, `user`)
- ❌ Assign roles to users
- ❌ Test permission system or RBAC features
- ❌ Access the Permissions management page (requires `admin` role)

**Setup:**

1. Update `src/environments/environment.development.ts`:
   ```typescript
   keycloak: {
     url: 'https://auth.civic-os.org',
     realm: 'civic-os-dev',
     clientId: 'myclient'
   }
   ```

2. Start the application

**When to use this:** Initial exploration of Civic OS when you can't run Docker locally.

---

## Option C: Cloud Keycloak (Production)

For production deployments, use a hosted Keycloak instance (Keycloak.cloud, AWS, GCP, Azure, etc.)

**Popular Options:**
- **[Keycloak.cloud](https://www.keycloak.org/cloud)** - Official hosted service
- **[Auth0](https://auth0.com/)** - Commercial alternative (OIDC compatible)
- **AWS**: Deploy Keycloak on EC2/ECS
- **GCP/Azure**: Use container services

**Setup Steps:**
1. Deploy Keycloak to your chosen platform
2. Note your Keycloak URL (e.g., `https://keycloak.example.com`)
3. Update Angular environment files and example `.env` with your URL
4. Proceed to **Realm Configuration** below to set up your realm

---

## Realm Configuration (Required for Options B and C)

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

### Step 8: Create Service Account Client (v0.31.0+, Required for User Provisioning)

The consolidated worker needs a Keycloak service account to create users and manage roles via the Keycloak Admin REST API.

1. **Create client** in Keycloak admin console:
   - Go to: Clients → Create client
   - **Client ID**: `civic-os-service-account`
   - **Client authentication**: ON (confidential client)
   - **Authentication flow**: Check only "Service accounts roles"
   - Click Save

2. **Get client credentials**:
   - Go to: Clients → civic-os-service-account → Credentials tab
   - Copy the **Client secret**

3. **Assign realm management roles**:
   - Go to: Clients → civic-os-service-account → Service account roles tab
   - Click "Assign role" → Filter by clients → Select `realm-management`
   - Assign: `manage-users`, `view-users`, `view-realm`, `manage-realm`

4. **Configure worker environment variables**:
   ```bash
   KEYCLOAK_SERVICE_ACCOUNT_CLIENT_ID=civic-os-service-account
   KEYCLOAK_SERVICE_ACCOUNT_CLIENT_SECRET=<secret from step 2>
   ```

**Note**: The pre-configured `examples/keycloak/civic-os-dev.json` realm export already includes this service account client with secret `civic-os-service-secret` for local development. Production deployments must generate a new secret.

### Step 9: Configure MCP Server OAuth (v0.72.1+)

MCP clients (Claude Code, Claude Desktop, claude.ai web) authenticate users via OAuth 2.1 with Keycloak. This step covers Keycloak client setup, DCR policies, scopes, reverse proxy routing, and MCP server configuration.

For full MCP OAuth spec compliance details, see `docs/notes/MCP_OAUTH_COMPATIBILITY_GUIDE.md`.

#### 9a. Keycloak: Create `civic-os-mcp` Client

The `civic-os-mcp` public client is **already included** in the realm template (`templates/keycloak/realm-template.json`) and dev realm (`examples/keycloak/civic-os-dev.json`). New deployments get it automatically.

For existing deployments, create the client in Keycloak admin console:

1. **Create client**:
   - Go to: Clients → Create client
   - **Client ID**: `civic-os-mcp`
   - **Client type**: OpenID Connect
   - **Name**: MCP Server OAuth
2. **Capability config**:
   - **Client authentication**: OFF (public client — no client secret)
   - **Standard flow**: ON
   - **Direct access grants**: OFF
3. **Login settings**:
   - **Root URL**: (leave blank — headless client, no UI)
   - **Home URL**: (leave blank)
   - **Valid redirect URIs** (all required for broad MCP client compatibility):
     - `http://localhost/callback` — Claude Code RFC 8252 loopback (no port)
     - `http://localhost:*/callback` — Claude Code RFC 8252 loopback (ephemeral port)
     - `http://127.0.0.1/callback` — same, IP form
     - `http://127.0.0.1:*/callback` — same, IP form with port
     - `http://localhost:*` — backward compat for existing MCP clients
     - `http://127.0.0.1:*` — backward compat for existing MCP clients
     - `https://claude.ai/api/mcp/auth_callback` — Claude hosted (Desktop/web/mobile)
     - `https://claude.com/api/mcp/auth_callback` — future Claude callback domain
   - **Web origins**: `+` (auto-derives CORS from redirect URIs)
4. **Advanced tab**:
   - **Proof Key for Code Exchange (PKCE)**: `S256` (required by MCP spec's OAuth 2.1)
5. **Client scopes tab** — verify these default scopes are assigned: `web-origins`, `acr`, `roles`, `profile`, `basic`, `email`. Add `offline_access` and `mcp:tools` as optional.

#### 9b. Keycloak: Configure Dynamic Client Registration (DCR)

MCP clients (including Claude Code and Claude Desktop) use DCR to self-register OAuth clients at runtime. Even when `oauthClientId` is specified in the MCP config, Claude Code still performs DCR — the `oauthClientId` is a hint, not a bypass.

**Important**: Keycloak's **Trusted Hosts** DCR policy filters by source IP, which blocks registrations from Anthropic's MCP proxy (cloud IPs, not localhost). Use **Consent Required** instead — it allows DCR from any host but requires user consent for dynamically registered clients.

1. Go to: **Clients** → **Client registration** tab (top bar, next to "Client list")
2. Click **Client Registration Policies** sub-tab
3. Under **Anonymous Access Policies**, configure as follows:

**Required policies:**

| Policy | Provider | Configuration |
|--------|----------|---------------|
| Consent Required | `consent-required` | (no config needed) — ensures dynamically registered clients require user consent |
| Max Clients Limit | `max-clients` | max-clients: `200` — prevents unbounded client table growth from DCR |

**Policies to REMOVE** (delete from the anonymous policies list):

| Policy to Remove | Why |
|-------------------|-----|
| Trusted Hosts | Filters by source IP — blocks DCR from Anthropic's MCP proxy and other cloud-based clients |
| Allowed Client Scopes | Blocks DCR when requested scopes aren't whitelisted — causes "Policy rejected request to client-registration service" error |
| Full Scope Disabled | Sets `fullScopeAllowed: false` on DCR clients — causes JWTs to omit realm roles, so PostgREST sees no permissions and returns empty results |
| Allowed Protocol Mappers | May block mappers the MCP client requests |

#### 9c. Keycloak: CIMD Setup (Future)

Client Identity Metadata Documents (CIMD) allow MCP clients to present a signed identity document for automatic client provisioning without DCR. Keycloak does not yet support CIMD. When it becomes available:

1. Enable CIMD feature: `--features=cimd`
2. Configure trusted domains for identity verification
3. Set client policies for CIMD-provisioned clients

Until CIMD is supported, DCR (Step 9b) is the primary registration path.

#### 9d. Keycloak: Create `mcp:tools` Scope + Audience Mapper

The `mcp:tools` scope is **already included** in the realm template. For existing deployments:

1. Go to: **Client scopes** → **Create client scope**
   - **Name**: `mcp:tools`
   - **Description**: MCP tool access — carries audience claim for the MCP resource server
   - **Type**: Optional
   - **Include in token scope**: ON
   - **Display on consent screen**: ON
   - **Consent screen text**: "Access your data via AI tools"

2. **Add audience mapper** (per-deployment — the MCP public URL is instance-specific):
   - Go to: Client scopes → `mcp:tools` → Mappers tab → Add mapper → By configuration → Audience
   - **Name**: `mcp-resource-audience`
   - **Included Custom Audience**: `https://your-instance.example.com/_/mcp` (your MCP public URL)
   - **Add to ID token**: OFF
   - **Add to access token**: ON

3. **Assign to `civic-os-mcp` client**:
   - Go to: Clients → `civic-os-mcp` → Client scopes tab → Add client scope → select `mcp:tools` → Add as Optional

> **Note**: The audience mapper bridges Keycloak's lack of RFC 8707 support. Without it, tokens lack an `aud` claim for the MCP resource server.

> **⚠️ Realm export/import pitfall**: If you export your realm to JSON (for backup or migration), be aware that a `clientScopes` array in the realm JSON tells Keycloak to use it as the **complete** set of client scopes. Keycloak will NOT auto-create the built-in defaults (`profile`, `email`, `roles`, `web-origins`, `acr`, `basic`, etc.). If you add `mcp:tools` to a realm export, ensure the export already contains the full set of default scope definitions. The realm template and dev JSON in this repository include all required scopes.

#### 9e. Reverse Proxy: Route OAuth Well-Known Paths

The MCP SDK constructs OAuth discovery URLs based on the resource URL. For a resource at `https://example.com/_/mcp`, it fetches:

- `/.well-known/oauth-protected-resource/_/mcp` (RFC 9728)
- `/.well-known/oauth-authorization-server/_/mcp` (RFC 8414)
- `/.well-known/oauth-authorization-server` (fallback)

These paths do NOT start with `/_/mcp`, so they won't be caught by typical path-prefix routing rules (e.g., Caddy's `handle_path /_/mcp/*`). Without explicit routing, they fall through to the Angular frontend, which returns HTML (causing `Unexpected token '<'` errors).

**Architecture: Self-contained MCP server (v0.72.5+)**

The MCP server handles both well-known endpoints internally:
- `oauth-protected-resource` — serves the RFC 9728 metadata directly (including `scopes_supported: ["mcp:tools"]` and `resource_name`)
- `oauth-authorization-server` — fetches Keycloak's OIDC discovery document, caches it for 1 hour, and serves it to clients

This means the routing layer only needs one simple rule: **route `/.well-known/oauth-*` to the MCP server.** No Keycloak-specific proxy rules, no URL rewriting, no TLS header manipulation. The same routing config works across Caddy, nginx, K8s HTTPRoute, and any other reverse proxy.

**Caddy** — add before the frontend catch-all (use `handle`, not `handle_path`, so the full path reaches the MCP server):

```
# MCP server (Streamable HTTP transport)
handle_path /_/mcp/* {
    reverse_proxy mcp-server:3001
}

# OAuth discovery — MCP server handles both endpoints
handle /.well-known/oauth-protected-resource* {
    reverse_proxy mcp-server:3001
}

handle /.well-known/oauth-authorization-server* {
    reverse_proxy mcp-server:3001
}
```

After updating, reload: `docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile`

**Kubernetes Gateway API** (HTTPRoute):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: mcp-oauth-wellknown
spec:
  parentRefs:
    - name: main-gateway
  hostnames:
    - "your-instance.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /.well-known/oauth-protected-resource
        - path:
            type: PathPrefix
            value: /.well-known/oauth-authorization-server
      backendRefs:
        - name: mcp-server
          port: 3001
```

**nginx** (ingress annotation or server block):

```nginx
location ~ ^/\.well-known/oauth-(protected-resource|authorization-server) {
    proxy_pass http://mcp-server:3001;
}
```

**Verify** all three paths return JSON, not HTML:
```bash
curl -s https://your-instance.example.com/.well-known/oauth-protected-resource/_/mcp
curl -s https://your-instance.example.com/.well-known/oauth-authorization-server/_/mcp
curl -s https://your-instance.example.com/.well-known/oauth-authorization-server
```

#### 9f. MCP Server: Environment Variables

Add these to your MCP server's docker-compose environment:

```yaml
mcp-server:
  environment:
    POSTGREST_URL: http://postgrest:3000
    MCP_TRANSPORT: http
    MCP_PORT: 3001
    KEYCLOAK_URL: ${KEYCLOAK_URL}          # e.g., https://auth.example.com
    KEYCLOAK_REALM: ${KEYCLOAK_REALM}      # e.g., my-realm
    MCP_PUBLIC_URL: https://${APP_DOMAIN}/_/mcp  # public URL of the MCP server
```

`MCP_PUBLIC_URL` is **critical** — without it, the OAuth protected resource metadata advertises `http://localhost:3001` as the resource URL, which breaks the OAuth flow.

#### 9g. MCP Client Configuration

**Claude Desktop** — Add via Connectors:
1. Settings → Connectors → Add → enter URL: `https://your-instance.example.com/_/mcp`
2. In Advanced settings, enter Client ID: `civic-os-mcp`
3. Click Connect → Keycloak login page opens → authenticate → tools load

**Claude Code**:
```bash
claude mcp add --transport http my-instance https://your-instance.example.com/_/mcp/
```

Or in `.mcp.json` / `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "my-instance": {
      "type": "http",
      "url": "https://your-instance.example.com/_/mcp/"
    }
  }
}
```

**VS Code** (Copilot MCP):
```json
{
  "mcp": {
    "servers": {
      "my-instance": {
        "type": "http",
        "url": "https://your-instance.example.com/_/mcp/"
      }
    }
  }
}
```

#### 9h. Verification

After deploying, verify the full OAuth flow:

```bash
# 1. 401 challenge shape (should include error="invalid_token", resource_metadata, scope)
curl -si https://your-instance.example.com/_/mcp/ \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# Expect: 401 + WWW-Authenticate: Bearer error="invalid_token", resource_metadata="...", scope="mcp:tools"

# 2. Protected Resource Metadata (both paths)
curl -s https://your-instance.example.com/.well-known/oauth-protected-resource/_/mcp | jq .
curl -s https://your-instance.example.com/.well-known/oauth-protected-resource | jq .
# Expect: { resource, authorization_servers, scopes_supported: ["mcp:tools"], resource_name }

# 3. Authorization Server Metadata
curl -s https://your-instance.example.com/.well-known/oauth-authorization-server | jq .
# Expect: Keycloak OIDC config with authorization_endpoint, token_endpoint, registration_endpoint

# 4. DCR test (should succeed without Trusted Hosts)
curl -s -X POST "$(curl -s https://your-instance.example.com/.well-known/oauth-authorization-server | jq -r .registration_endpoint)" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"test","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code"],"response_types":["code"],"token_endpoint_auth_method":"none"}'
# Expect: 201 Created (not "Host not trusted")
```

#### 9i. How It Works

1. MCP client sends request without Bearer token → MCP server returns 401 with `WWW-Authenticate` challenge containing `resource_metadata` URL
2. MCP client fetches `/.well-known/oauth-protected-resource` → discovers `authorization_servers` and `scopes_supported`
3. MCP client fetches `/.well-known/oauth-authorization-server` → gets cached Keycloak OIDC discovery (auth/token/registration endpoints)
4. MCP client performs DCR at Keycloak's `registration_endpoint` → gets a dynamic client (or uses pre-registered `civic-os-mcp`)
5. MCP client opens browser for OAuth 2.1 Authorization Code + PKCE flow → user logs in at Keycloak
6. MCP client exchanges code for JWT → sends Bearer token with each MCP request
7. MCP server forwards Bearer token to PostgREST → PostgREST validates JWT against Keycloak JWKS → RLS enforces permissions

The MCP server never validates JWTs itself — it's a transparent token passthrough to PostgREST. The OIDC config from Keycloak is cached for 1 hour, with stale-on-error fallback.

#### 9j. Troubleshooting MCP OAuth

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Unexpected token '<', "<!doctype"` | Well-known paths hitting Angular frontend (HTML) | Route `/.well-known/oauth-*` to MCP server per Step 9e |
| `Policy rejected request to client-registration service` | Keycloak DCR policy blocking registration | Replace Trusted Hosts with Consent Required per Step 9b |
| `Host not trusted` on DCR | Trusted Hosts policy blocking cloud IPs | Replace Trusted Hosts with Consent Required per Step 9b |
| Connected but `list_entities` returns empty / "No Entities" | JWT missing realm roles (`fullScopeAllowed: false`) | Remove "Full Scope Disabled" DCR policy per Step 9b |
| `resource: "http://localhost:3001"` in metadata | `MCP_PUBLIC_URL` not set | Add `MCP_PUBLIC_URL` to docker-compose per Step 9f |
| 302/400 on OAuth auth request | `civic-os-mcp` client doesn't exist in realm | Create client per Step 9a |
| `invalid_redirect_uri` on Claude Desktop | Missing Claude callback redirect URI | Add `https://claude.ai/api/mcp/auth_callback` to redirect URIs per Step 9a |
| 401 not triggering OAuth flow | Malformed `WWW-Authenticate` header | Upgrade MCP server — 401 must include `error="invalid_token"` |

---

## Update Application Configuration

After setting up your Keycloak realm, configure Civic OS to use it.

### 1. Update Environment File

Edit `examples/pothole/.env`:

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

### 3. Start Services

PostgREST uses a custom Docker image that automatically fetches Keycloak's JWKS (signing key) on startup — no manual steps needed:

```bash
cd example
docker-compose up -d --build
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
- If you get empty response: Function may not be exposed via RPC (check `postgres/migrations/deploy/v0-4-0-baseline.sql`)
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
1. Restart PostgREST to re-fetch JWKS: `docker-compose restart postgrest`
2. Check PostgREST logs for JWKS fetch errors: `docker-compose logs postgrest`
3. Verify Keycloak JWKS URL is accessible:
   ```bash
   curl http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/certs
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

## User Registration Model

> **Deployment Decision:** When setting up a new Civic OS instance, ask the deployer: *"Should new accounts be created only by admins, or can anyone sign up (defaulting to a basic user role)?"*

### Default: Open Registration

Out of the box, both the dev realm (`examples/keycloak/civic-os-dev.json`) and the production template (`templates/keycloak/realm-template.json`) ship with:

- **Self-registration enabled** (`registrationAllowed: true`) — users can create accounts with email/password
- **`auto-link first broker login` flow** — social login (Google, Microsoft, etc.) auto-creates a local Keycloak account on first use and auto-links to existing accounts by email
- **Default `user` role** — all new accounts (self-registered or social) receive the `user` role automatically

The User Provisioning system (`/admin/users`) still works alongside open registration — admins can pre-create accounts with specific roles while users can also self-register with the default role.

### Restricting to Admin-Only Registration

For staff portals, internal tools, and controlled-access deployments where only administrators should create accounts via `/admin/users`:

**1. Disable self-registration:**

Realm settings → Login → **User registration** = OFF

| Setting (Realm settings → Login) | Recommended | Why |
|---|---|---|
| User registration | OFF | No self-signup |
| Forgot password | ON (optional) | Email-verified reset doesn't create accounts |
| Edit username | OFF | Prevents users changing their own username |

**2. Replace the first broker login flow for admin-only linking:**

The default `auto-link first broker login` flow ships with a **"Create User If Unique"** step that auto-creates accounts for new social logins. Simply removing this step does **not** work — the `idp-auto-link` authenticator requires a prior step to set the user context in the auth session, and without it, all first-time social logins fail with `invalid_user_credentials` ([Keycloak #8900](https://github.com/keycloak/keycloak/issues/8900)).

Instead, replace the flow to use **"Detect Existing Broker User"** which finds existing users by email without ever creating new accounts:

1. Go to Authentication → Flows → `auto-link first broker login`
2. **Delete all existing steps** (both "Create User If Unique" and the "Auto-link existing" sub-flow)
3. Add **"Detect Existing Broker User"** (`idp-detect-existing-broker-user`) as **Required**
4. Add **"Automatically Set Existing User"** (`idp-auto-link`) as **Required**

Before (default — allows new signups via social login):

| Step | Type | Requirement |
|---|---|---|
| Create User If Unique | execution | Alternative |
| Auto-link existing (sub-flow) | flow | Alternative |
| └─ Automatically set existing user | step | Required |

After (admin-only — links pre-existing accounts only):

| Step | Type | Requirement |
|---|---|---|
| Detect Existing Broker User | execution | Required |
| Automatically Set Existing User | execution | Required |

**How it works after restricting:**
- Admin pre-creates user in Civic OS with their corporate email → Go worker creates Keycloak account with `emailVerified: true`
- User clicks "Sign in with Google/Microsoft" → "Detect Existing Broker User" finds the pre-existing account by email → "Automatically Set Existing User" links the identity → login succeeds
- Unknown email via social login → "Detect Existing Broker User" finds no match → Required step fails → access denied (no account created)

> **Important:** The Identity Provider must have **"Trust email" = ON** so Keycloak trusts the email from the social provider for matching. The provisioned Keycloak account must also have `emailVerified: true` (the Go worker sets this automatically).

**3. Ensure the service account client is configured** (see [Step 8](#step-8-create-service-account-client-v0310-required-for-user-provisioning)) — this becomes the sole path for account creation.

**Optional — Disable Keycloak Account Console:** Keycloak exposes an account management UI at `https://<keycloak>/realms/<realm>/account/`. To prevent users from editing their own profile outside the app, disable the `account-console` client. Note: Civic OS links to this console for "Account Settings" — remove or redirect that link if disabled.

---

## Social Login: Microsoft / Azure AD

Keycloak can delegate authentication to Microsoft Azure AD, letting users sign in with their organizational Microsoft accounts.

### Setup

1. **Azure App Registration**: In the Azure portal, create an App Registration with redirect URI `https://<your-keycloak>/realms/<realm>/broker/microsoft/endpoint`
2. **Keycloak Identity Provider**: In the Keycloak admin console, go to **Identity providers** → **Add provider** → **OpenID Connect v1.0** (not the legacy "Microsoft" type)
3. **Set alias to `microsoft`**: This exact alias makes Keycloak display the Microsoft logo on the login button
4. **Configure endpoints** using your Azure tenant ID:
   - Authorization URL: `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/authorize`
   - Token URL: `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token`
5. **Client ID and Secret**: From the Azure App Registration
6. **Default Scopes**: `openid profile email`
7. **First login flow**: Set to `auto-link first broker login` (included in the Civic OS realm template — see [User Registration Model](#user-registration-model) for details)
8. **Trust email**: ON — Azure AD has already verified the user's email, so Keycloak can skip redundant verification

### Common Pitfalls

**Use tenant-specific endpoints, not `/common/`**: Azure's `/common/` discovery document returns `{tenantid}` as a literal placeholder in the issuer field. Keycloak validates the JWT issuer against this value and fails. Always use `https://login.microsoftonline.com/{your-actual-tenant-id}/oauth2/v2.0/...`.

**Client Authentication method**: Under the provider's **Advanced** settings, set **Client Authentication** to "Client secret sent as post" (`client_secret_post`). Azure AD's v2.0 token endpoint may reject Basic auth headers.

**Debugging "Unexpected error when authenticating with identity provider"**: This generic error means the token exchange failed server-side. The Keycloak admin UI Events tab won't show it — check container logs (`docker compose logs keycloak`) for the Java stack trace. Also check browser DevTools Network tab for error parameters in the redirect URL.

---

## Reference Links

- **Keycloak Documentation**: https://www.keycloak.org/documentation
- **Keycloak Admin Guide**: https://www.keycloak.org/docs/latest/server_admin/
- **JWT.io**: https://jwt.io - Decode and inspect JWT tokens
- **OIDC Spec**: https://openid.net/connect/ - OpenID Connect specification

---

## Role Impersonation (v0.26.0+)

Admins can test RLS policies and permission configurations as different roles without logging out.

**How to use**: Settings modal (gear icon) → select roles to impersonate → Start Impersonation. An orange "Impersonating" badge appears in the navbar. Click "Stop Impersonation" to return to your real roles.

**How it works**:
- Frontend sends an `X-Impersonate-Roles` header on PostgREST requests when impersonation is active
- The database `get_user_roles()` function checks this header and returns impersonated roles instead of JWT roles — but **only if the real JWT contains `admin`**
- A non-admin sending the header is silently ignored — no privilege escalation is possible
- All RLS policies and `has_permission()` checks then operate against the impersonated roles

**Safety guarantees** (v0.41.2+):
- `refresh_current_user()` uses `get_real_user_roles()` which **ignores the impersonation header**, ensuring role sync always operates on the user's real JWT roles
- The frontend interceptor explicitly excludes `/rpc/refresh_current_user` from receiving the impersonation header as a secondary safeguard
- Audit logging (`log_impersonation()`) uses `is_real_admin()` which also ignores the header

**Audit trail**: Impersonation start/stop events are logged to `metadata.admin_audit_log` with user ID, email, impersonated roles, and timestamp.

---

## Next Steps

After completing authentication setup:

1. **Configure Database Permissions** - Use the Permissions page to set table-level CRUD permissions
2. **Test with Different Roles** - Login as different users to see how the UI adapts
3. **Add Custom Entities** - Create your own tables and see them automatically appear in the UI
4. **Explore RBAC** - Understand how database Row-Level Security policies work with Keycloak roles

For more information, see:
- [CLAUDE.md](../CLAUDE.md) - Developer guide and architecture details
- [examples/pothole/README.md](../examples/pothole/README.md) - Docker setup and database initialization
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues and solutions
