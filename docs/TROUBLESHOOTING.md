# Troubleshooting Guide

## Role-Based Access Control Issues

### Problem: "Admin access required" message even though user has admin role in Keycloak

**Symptoms:**
- Keycloak JWT contains the `admin` role (visible in browser DevTools)
- Frontend `AuthService.isAdmin()` returns `true` (Permissions menu item shows)
- Backend `is_admin()` RPC returns `false` (Permissions page shows error)

**Root Cause:**
The PostgreSQL `get_user_roles()` function cannot extract roles from the JWT claims because Keycloak stores roles in a nested JSON structure that differs from the expected format.

**Solution:**

1. **Apply the updated database functions** by re-running the SQL scripts:
   ```bash
   cd example
   docker-compose down -v  # WARNING: This deletes all data
   docker-compose up -d
   ```

   Or manually apply just the updated function:
   ```sql
   -- Connect to your database and run the updated get_user_roles() function
   -- from postgres/migrations/deploy/v0-4-0-baseline.sql
   ```

2. **Use the Debug Panel** to diagnose the issue:
   - Navigate to `/permissions` page
   - Click "Show Debug Info" button
   - Compare the three pieces of information:
     - **Frontend Roles**: What Angular extracted from Keycloak JWT
     - **Backend Roles**: What PostgreSQL extracted from JWT claims
     - **Full JWT Claims**: The complete JWT payload sent to PostgreSQL

3. **Common JWT claim structures:**

   **Keycloak realm roles** (most common):
   ```json
   {
     "realm_access": {
       "roles": ["admin", "user"]
     }
   }
   ```

   **Keycloak client roles**:
   ```json
   {
     "resource_access": {
       "myclient": {
         "roles": ["admin", "user"]
       }
     }
   }
   ```

   **Custom roles claim**:
   ```json
   {
     "roles": ["admin", "user"]
   }
   ```

4. **If backend roles are empty**, check:
   - PostgREST is receiving the JWT (check `docker-compose logs postgrest`)
   - JWT is being parsed correctly (look at "Full JWT Claims" in debug panel)
   - The claim path in `get_user_roles()` matches your Keycloak configuration

5. **Update get_user_roles() if needed**:
   If your Keycloak uses a different claim structure, modify the function in `postgres/migrations/deploy/v0-4-0-baseline.sql` to match. The updated function already tries three common patterns in order:
   - `realm_access.roles`
   - `resource_access.myclient.roles`
   - `roles`

### Problem: Permissions page loads but shows no tables

**Possible Causes:**
- No tables exist in the public schema
- User doesn't have SELECT permission on `schema_entities` view
- PostgREST connection issue

**Debug Steps:**
1. Check browser console for errors
2. Check Network tab for failed API calls
3. Verify tables exist: `docker exec -it example-postgres-1 psql -U postgres -d civic_os -c "SELECT * FROM schema_entities;"`

### Problem: Cannot toggle permissions (checkboxes don't save)

**Possible Causes:**
- User is not actually admin (backend check fails)
- Permission doesn't exist in `metadata.permissions` table
- Database constraint violation

**Debug Steps:**
1. Check browser console for error responses
2. Verify admin status with debug panel
3. Check database logs: `docker-compose logs postgres`
4. Manually verify permissions exist: `SELECT * FROM metadata.permissions WHERE table_name = 'YourTable';`

## Database Connection Issues

### Problem: "Failed to load roles" or "Failed to load permissions"

**Possible Causes:**
- PostgREST not running or misconfigured
- Database connection failed
- JWT authentication failed

**Debug Steps:**
1. Check PostgREST is running: `docker-compose ps`
2. Check PostgREST logs: `docker-compose logs postgrest`
3. Test PostgREST directly: `curl http://localhost:3000/`
4. Verify JWT token in Network tab (should be in Authorization header)

## Keycloak Configuration Issues

### Problem: Roles not appearing in JWT

See the "Configuring Keycloak Roles" section in [CLAUDE.md](../CLAUDE.md#configuring-keycloak-roles) for step-by-step instructions on:
- Creating realm roles
- Assigning roles to users
- Configuring client scopes and mappers
- Verifying JWT token contents
