# Keycloak Realm Template for Civic OS

A production-hardened Keycloak realm template (~200 lines) for Civic OS deployments. Includes security best practices, email registration with verification, Google social login, and audit logging.

## Quick Start

1. **Copy and customize the template:**
   ```bash
   cp realm-template.json my-realm.json
   # Edit my-realm.json and replace all {{PLACEHOLDER}} values
   ```

2. **Import into Keycloak:**
   - **Admin Console:** Create Realm → Import → Select file
   - **CLI:** `kcadm.sh create realms -f my-realm.json`

3. **Configure Google OAuth** (in Google Cloud Console):
   - Create OAuth 2.0 credentials
   - Add authorized redirect URI:
     ```
     https://auth.civic-os.org/realms/{{REALM_NAME}}/broker/google/endpoint
     ```

4. **Test login** at your `SITE_URL`

## Placeholder Reference

| Placeholder | Example | Description |
|-------------|---------|-------------|
| `{{REALM_NAME}}` | `mottpark-pilot` | Keycloak realm identifier (lowercase, no spaces) |
| `{{DISPLAY_NAME}}` | `Mott Park Pilot` | Human-readable realm name |
| `{{CLIENT_ID}}` | `mottpark-client` | OIDC client ID used by frontend |
| `{{APP_NAME}}` | `Mott Park App` | Client display name in Keycloak |
| `{{SITE_URL}}` | `https://mottpark.pilot.civic-os.org` | Production frontend URL |
| `{{GOOGLE_CLIENT_ID}}` | `xxx.apps.googleusercontent.com` | From Google Cloud Console |
| `{{GOOGLE_CLIENT_SECRET}}` | `GOCSPX-xxx` | From Google Cloud Console |
| `{{SMTP_HOST}}` | `email-smtp.us-east-2.amazonaws.com` | SMTP server hostname |
| `{{SMTP_PORT}}` | `587` | SMTP port (usually 587 for STARTTLS) |
| `{{SMTP_FROM}}` | `noreply@civic-os.org` | Sender email address |
| `{{SMTP_FROM_NAME}}` | `Civic OS` | Sender display name |
| `{{SMTP_USER}}` | `AKIA...` | SMTP authentication username |
| `{{SMTP_PASSWORD}}` | `xxx` | SMTP authentication password |

## Security Features

This template includes production-ready security configuration:

### Authentication
| Feature | Setting | Description |
|---------|---------|-------------|
| Email Registration | Enabled | Users can sign up with email/password |
| Email Verification | **Required** | Must verify email before login (email/password only) |
| Google Login | Enabled | Social login via Google OAuth (auto-verified) |
| Password Reset | Enabled | Self-service password recovery |
| Remember Me | Enabled | 7-day idle / 30-day max sessions |

> **Note:** Google users are automatically marked as email-verified (`trustEmail: true`) since Google already verified their email. Only email/password registrations require verification.

### Password Policy
```
- Minimum 12 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 digit
- At least 1 special character
- Cannot contain username
```

### Brute Force Protection
| Setting | Value | Description |
|---------|-------|-------------|
| Enabled | Yes | Protects against credential stuffing |
| Failure Factor | 5 | Lockout after 5 failed attempts |
| Wait Increment | 60s | Time added per failure |
| Max Wait | 15 min | Maximum lockout duration |
| Permanent Lockout | No | Temporary lockout only |

### Token Lifespans
| Token | Duration | Description |
|-------|----------|-------------|
| Access Token | 15 min | JWT validity (was 5 min) |
| SSO Idle | 30 min | Logout after inactivity |
| SSO Max | 10 hours | Maximum session duration |
| Remember Me Idle | 7 days | Extended idle with "remember me" |
| Remember Me Max | 30 days | Extended max with "remember me" |
| Refresh Token Rotation | Enabled | Tokens rotate on refresh |

### Audit Logging
Events tracked:
- `LOGIN`, `LOGIN_ERROR`
- `LOGOUT`
- `REGISTER`, `REGISTER_ERROR`
- `UPDATE_PASSWORD`, `UPDATE_PROFILE`
- `RESET_PASSWORD`, `RESET_PASSWORD_ERROR`
- `SEND_VERIFY_EMAIL`, `VERIFY_EMAIL`

Admin events also logged with full details.

## What's Included

- **Realm settings:** SSL required, login options, token lifespans
- **Custom roles:** `user`, `manager`, `admin` (for Civic OS RBAC)
- **Default role:** Assigns `user` role to all new users automatically
- **Frontend client:** Public OIDC client (no localhost - production only)
- **Google IdP:** Social login via Google OAuth
- **SMTP:** Email server for verification and password reset
- **User profile:** Includes custom `phoneNumber` attribute for Civic OS sync

## What's NOT Included (Auto-Generated)

Keycloak automatically creates these when you import the realm:

- Authentication flows (browser, registration, password reset, etc.)
- Built-in clients (account, account-console, admin-cli, broker, realm-management)
- Built-in client scopes (openid, profile, email, roles, etc.)
- Key providers (RSA, HMAC for JWT signing)

## Frontend Configuration

After importing the realm, update your Civic OS frontend environment:

```typescript
// environment.ts or runtime config
export const environment = {
  keycloakConfig: {
    url: 'https://auth.civic-os.org',
    realm: '{{REALM_NAME}}',
    clientId: '{{CLIENT_ID}}'
  }
};
```

## Local Development

This template does **not** include localhost redirect URIs for security. For local development, manually add these in Keycloak admin:

1. Go to Clients → {{CLIENT_ID}} → Settings
2. Add to Valid Redirect URIs: `http://localhost:4200/*`
3. Add to Web Origins: `http://localhost:4200`

Or create a separate development client.

## Troubleshooting

### "Invalid redirect URI" error
Ensure your `SITE_URL` in the template matches your deployment exactly (including protocol, no trailing slash).

### Google login not appearing
1. Verify Google OAuth credentials are correct
2. Check the redirect URI in Google Cloud Console matches:
   `https://auth.civic-os.org/realms/{{REALM_NAME}}/broker/google/endpoint`

### Email verification not sending
1. Verify SMTP credentials and host
2. For AWS SES: Ensure sender email is verified and account is out of sandbox mode
3. Test with Keycloak's "Test connection" button in SMTP settings

### Roles not syncing to Civic OS
Ensure the JWT contains `realm_access.roles` claim. The template configures this via the `roles` client scope.

### Account locked after failed logins
Brute force protection locks accounts after 5 failed attempts. Wait up to 15 minutes or manually unlock in Keycloak admin under Users → {{user}} → Sessions.

### Role name mismatch with default Civic OS
This template uses `manager` instead of the default Civic OS `editor` role. Ensure your Civic OS database `metadata.roles` table matches:
```sql
-- Update default 'editor' to 'manager' in new deployments
UPDATE metadata.roles SET name = 'manager' WHERE name = 'editor';
-- Or add 'manager' as a new role
INSERT INTO metadata.roles (name, description) VALUES ('manager', 'Can create, edit, and manage records');
```

## Related Documentation

- [Civic OS Authentication Guide](../../docs/AUTHENTICATION.md)
- [Production Deployment Guide](../../docs/deployment/PRODUCTION.md)
- [Keycloak Documentation](https://www.keycloak.org/documentation)
