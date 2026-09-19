# Maintenance Mode Design Document

> **Version**: v0.76.0
> **Status**: Implemented
> **Author**: Daniel Kurin

## Overview

Civic OS supports two maintenance modes (`readonly` and `full`) to protect data integrity during deployments and database migrations. A single `MAINTENANCE_MODE` environment variable controls enforcement across all services: PostgREST (API), the Angular frontend, and the consolidated worker.

The system uses **dual detection with single enforcement** -- the API layer enforces restrictions while the frontend detects maintenance state through two complementary mechanisms for instant and idle-user coverage.

## Design Decisions

### Why Env Var Over Database Table

During `full` maintenance, the database may be unreachable (major migration, restore, failover). An environment variable works even when the DB is down. PostgREST exposes env vars as GUC settings (`app.settings.maintenance_mode`), making them readable in SQL without a dedicated table.

### Why Dual Detection

The HTTP interceptor detects maintenance instantly on any API call, but only fires when the user actively interacts. For idle users who haven't made an API call in minutes, a 30-second poll of a static `/maintenance.json` file fills the gap. Together, they ensure no user misses the transition to maintenance mode.

### Why PT503 SQLSTATE

PostgREST maps the `PT503` SQLSTATE to HTTP 503 (Service Unavailable), the semantically correct status code for maintenance windows. Clients and load balancers recognize 503 as a temporary condition, distinct from 500 (server error) or 401 (auth failure).

### Why Admin Bypass

After completing a migration, administrators need to verify the system works before opening it to all users. The admin bypass allows `is_admin()` users to perform full CRUD during maintenance, enabling smoke testing without disabling the maintenance gate for everyone.

### Why No SECURITY DEFINER

PostgreSQL 17 blocks `SET LOCAL ROLE` inside `SECURITY DEFINER` functions. Since `check_jwt()` runs in the PostgREST request lifecycle where role switching is required, the function cannot use `SECURITY DEFINER`. The maintenance check runs as the authenticated role, which has access to `is_admin()` through the standard permission chain.

## Architecture

### Configuration Flow

```
.env file: MAINTENANCE_MODE=readonly
    |
    +---> docker-compose.yml
    |       |
    |       +---> PostgREST: PGRST_APP_SETTINGS_MAINTENANCE_MODE=${MAINTENANCE_MODE}
    |       |       -> Available as current_setting('app.settings.maintenance_mode')
    |       |
    |       +---> Frontend: MAINTENANCE_MODE=${MAINTENANCE_MODE}
    |       |       -> docker-entrypoint.sh writes /maintenance.json
    |       |       -> docker-entrypoint.sh injects window.civicOsConfig.maintenance
    |       |
    |       +---> Worker: MAINTENANCE_MODE=${MAINTENANCE_MODE}
    |               -> Blocks startup when active
    |
    +---> Optional: MAINTENANCE_MESSAGE="Upgrading to v0.77.0"
            -> Included in /maintenance.json and 503 error responses
```

### Enforcement Layer (PostgREST)

The `check_jwt()` function reads `app.settings.maintenance_mode` and enforces restrictions:

- **`off`** (default): No restrictions. Normal operation.
- **`readonly`**: Blocks `POST`, `PATCH`, `PUT`, `DELETE` on table endpoints with `RAISE EXCEPTION USING ERRCODE = 'PT503'`. Allows `GET` requests with an `X-Maintenance-Mode: readonly` response header. **RPC exception**: `POST` to `/rpc/*` paths is allowed through because PostgREST uses `POST` for all RPC calls, even read-only ones (e.g., `get_dashboards`, `get_translations`). Write RPCs are still protected by their own `SECURITY DEFINER` / RLS logic.
- **`full`**: Blocks all requests with `PT503`.

**Admin bypass**: When `metadata.is_admin()` returns true, write operations are allowed. The response header changes to `X-Maintenance-Mode: readonly-admin` or `X-Maintenance-Mode: full-admin` to signal the frontend that maintenance is active but the current user has bypass privileges.

**CORS expose header**: The `X-Maintenance-Mode` header must be explicitly listed in `Access-Control-Expose-Headers` for JavaScript to read it in cross-origin requests. The SQL sets both `X-Maintenance-Mode` and `Access-Control-Expose-Headers` in the `response.headers` JSON array. Without this, the header is present on the wire but invisible to `HttpResponse.headers.get()` in the browser. This primarily matters in local development (port 4200 → port 3000); in production, PostgREST is reverse-proxied through the same origin.

**Response header behavior**: The `X-Maintenance-Mode` header is set via `set_config('response.headers', ...)`. When an exception is raised (PT503), PostgREST does NOT return the custom response headers -- only the error body. This is by design:

- Non-admin users in `full` mode: receive a 503 with error body, no custom headers.
- Non-admin users in `readonly` mode on GET: receive data with `X-Maintenance-Mode: readonly` header.
- Non-admin users in `readonly` mode on write: receive a 503 with error body, no custom headers.
- Admin users in either mode: receive data with the `-admin` suffix header on all successful requests.

### Frontend Detection

Two complementary mechanisms ensure all users are notified:

#### 1. Reactive Detection (HTTP Interceptor)

`maintenanceInterceptor` is an Angular `HttpInterceptorFn` that examines every PostgREST response:

- **On success**: reads the `X-Maintenance-Mode` response header and updates `MaintenanceService` signals.
- **On 503 error**: checks the error body for the maintenance error code and updates signals accordingly.
- Non-maintenance 503 errors (e.g., PostgREST overload) are passed through without triggering maintenance UI.

#### 2. Proactive Detection (Static File Poll)

The Docker entrypoint writes `/maintenance.json` based on the `MAINTENANCE_MODE` env var:

```json
// MAINTENANCE_MODE=readonly
{ "mode": "readonly", "message": "Scheduled maintenance in progress" }

// MAINTENANCE_MODE=off (or unset)
{ "mode": "off" }
```

The Docker entrypoint **always** writes `maintenance.json`, even when maintenance is off (`{"mode":"off"}`). This ensures the polling path can detect both activation and deactivation of maintenance mode for idle users.

`MaintenanceService` polls this file every 30 seconds. The poll uses a simple HTTP GET outside the PostgREST interceptor chain (direct `fetch` or dedicated `HttpClient` call to avoid circular detection).

**404 = no-op**: When `/maintenance.json` returns 404 (local dev without Docker), the poll preserves the current state from the interceptor. In production, the file always exists.

**nginx cache control**: `/maintenance.json` is served with `Cache-Control: no-store` to prevent CDN, proxy, or service worker caching. The PWA service worker's ngsw-config.json does not include `maintenance.json` in any asset group.

**Offline behavior**: When the poll fails (network error, device offline), the error is caught and swallowed. The last known state is preserved. The offline banner (from PWA Support) handles the network-down case separately.

### MaintenanceService

Central service managing maintenance state as Angular signals:

```
Signals:
  maintenanceMode: Signal<'off' | 'readonly' | 'full'>
  maintenanceMessage: Signal<string | null>
  isAdmin: Signal<boolean>            // true when user has admin bypass

Computed:
  isMaintenanceActive: Signal<boolean> // maintenanceMode !== 'off'
  isReadonly: Signal<boolean>          // maintenanceMode === 'readonly' && !isAdmin
  isFullMaintenance: Signal<boolean>   // maintenanceMode === 'full' && !isAdmin
```

Both detection mechanisms write to the same signals. The interceptor takes priority (instant), while the poll provides coverage for idle periods and fresh page loads.

### Detection Latency

| Scenario | Detection Path | Latency |
|----------|---------------|---------|
| User clicks save/create/edit | Interceptor (503 response) | Instant |
| User loads a list page | Interceptor (response header) | Instant |
| User is idle, not clicking | Polling `/maintenance.json` | <=30s |
| Fresh page load (container restarted) | Polling `/maintenance.json` | Instant (first poll on init) |

### UI Behavior

#### Readonly Mode (Non-Admin)

- **Warning banner**: Fixed banner at top of page (below navbar) with maintenance message.
- **Write controls hidden**: Create buttons, Edit buttons, Delete buttons, and inline edit controls are hidden via `@if` checks on `MaintenanceService.isReadonly`.
- **Form pages redirect**: Direct navigation to `/create/*` or `/edit/*` routes redirects to the corresponding list or detail page.
- **Navigation intact**: All read operations (list, detail, search, filter, export) work normally.

#### Full Mode (Non-Admin)

- **Full-screen overlay**: Opaque overlay with maintenance message replaces all page content. Only the app shell (navbar with logo) remains visible.
- **No API calls**: The interceptor short-circuits requests when `isFullMaintenance` is true, preventing unnecessary 503 errors.

#### Admin Bypass

- **Info banner**: Distinctive banner (different color from the warning banner) indicating maintenance is active but the admin has full access.
- **All controls available**: Create, edit, delete operations work normally.
- **Verification workflow**: Admins can smoke-test the system after maintenance before disabling the mode.

### Worker Behavior

The consolidated worker (Go + River) reads `MAINTENANCE_MODE` at startup:

- **`off`**: Normal operation. River job queue starts processing.
- **`readonly`** or **`full`**: Worker logs the maintenance state and blocks, waiting for a signal (SIGTERM/SIGINT) to exit. It does not start the River client or process any jobs.

This prevents background jobs (notifications, file processing, user provisioning) from running during maintenance when the database schema may be in flux.

**Resume workflow**: After clearing `MAINTENANCE_MODE`, restart the worker container. It reads the updated env var and starts normally.

### Deployment Workflow

The recommended sequence for a maintenance deployment:

```
1. Set MAINTENANCE_MODE=readonly in .env
2. Restart PostgREST (enforces API restrictions)
3. Restart frontend (updates /maintenance.json for idle users)
4. Stop worker (prevents background processing)
5. Run database migrations
6. Verify migrations succeeded
7. Set MAINTENANCE_MODE=off in .env
8. Restart PostgREST, frontend, worker
9. (Optional) Keep readonly briefly while admin verifies
```

For the VPS deploy script (`deploy.sh --maintenance`):

```
1. Set MAINTENANCE_MODE=readonly
2. Restart PostgREST via docker-rollout
3. Run migration container
4. Set MAINTENANCE_MODE=off
5. Roll out all services via docker-rollout
```

### Environment Variables

| Variable | Default | Consumed By | Description |
|----------|---------|-------------|-------------|
| `MAINTENANCE_MODE` | `off` | PostgREST, Frontend, Worker | Maintenance mode: `off`, `readonly`, or `full` |
| `MAINTENANCE_MESSAGE` | (none) | Frontend | Optional message displayed in banners and overlay |

### PWA Considerations

- `/maintenance.json` is served with `Cache-Control: no-store` in nginx, so the Angular service worker (ngsw) never caches it.
- The service worker's ngsw-config.json does not list `maintenance.json` in any asset group.
- When offline, the `/maintenance.json` poll fails gracefully via `catchError` in the Observable chain, preserving the last known state.
- The offline banner (from `PwaService`) and the maintenance banner are independent -- both can be visible simultaneously if the network drops during maintenance.

### Hardcoded UI Strings (Not i18n)

Maintenance UI strings are **hardcoded** in `MaintenanceService`, not loaded via the `TranslationService`. This is intentional: in full maintenance mode, `check_jwt()` blocks all requests including `get_translations`, so the translate pipe would show raw keys. The strings are baked into the build for 6 locales (en, es, ar, fr, de, ps) and selected based on `LocaleService.locale`.

The `MAINTENANCE_MESSAGE` env var (set via Docker `maintenance.json`) overrides the hardcoded body text, allowing operators to provide deployment-specific context like "Deploying v0.77.0 — back in 10 minutes."

Database translation rows for these keys still exist in the migration (inserted for completeness) but are not used by the frontend.

## Security Considerations

- **Enforcement is server-side**: The `check_jwt()` function in PostgreSQL is the enforcement point. Frontend UI hiding is a UX convenience, not a security boundary. Even if a user bypasses the frontend, PostgREST returns 503 for blocked operations.
- **Admin bypass uses existing RBAC**: The `is_admin()` function checks the JWT's role claims through the standard permission chain. No new privilege escalation path is introduced.
- **No new attack surface**: The `/maintenance.json` file contains only the mode string and an optional operator message. No secrets, tokens, or internal state are exposed.
- **Worker isolation**: The worker's maintenance check is a startup gate, not a runtime check. A running worker will not be affected by env var changes until restarted.

## Lessons from Verification

Three bugs were discovered and fixed during end-to-end verification:

### 1. PostgREST RPCs Blocked in Readonly Mode

**Problem**: PostgREST uses HTTP POST for all RPC calls (`/rpc/*`), even read-only functions like `get_dashboards`, `get_translations`, and `refresh_current_user`. The initial `check_jwt()` blocked all POST requests in readonly mode, causing 503 errors on page load.

**Fix**: Added `request.path` check — `POST` to `/rpc/%` paths is allowed through in readonly mode. Write RPCs remain protected by their own `SECURITY DEFINER` / RLS logic. Table endpoints (`POST /Issue`, `PATCH /Issue`, etc.) are still blocked.

### 2. Polling Overriding Interceptor State

**Problem**: In local development, `/maintenance.json` returns 404 (no Docker frontend container). The polling subscriber originally reset mode to `'off'` on any error/null response, immediately overriding the `'readonly'` state detected by the interceptor from PostgREST response headers.

**Fix**: Changed polling to be a no-op on 404 — only update state when the file exists and returns valid JSON. Added `clearFromInterceptor()` method so the interceptor can clear maintenance state when a successful PostgREST response has no `X-Maintenance-Mode` header (indicating maintenance has ended at the API level).

### 3. CORS Blocking Custom Response Header

**Problem**: The `X-Maintenance-Mode` header was present in PostgREST responses (visible in Network inspector) but `HttpResponse.headers.get('X-Maintenance-Mode')` returned null. In cross-origin requests (dev: port 4200 → port 3000), browsers hide non-safelisted response headers from JavaScript unless the server includes them in `Access-Control-Expose-Headers`.

**Fix**: Added `{"Access-Control-Expose-Headers": "X-Maintenance-Mode"}` to the `response.headers` JSON array in both the admin bypass and readonly code paths of `check_jwt()`. This is primarily a local dev issue — in production, PostgREST is reverse-proxied through the same origin.

### 4. Translation Keys Showing as Raw Text in Full Mode

**Problem**: In full maintenance mode, `check_jwt()` blocks ALL requests — including the `get_translations` RPC. The Angular `TranslatePipe` returned raw keys like `maintenance.full_title` on the overlay page because the translations never loaded.

**Fix**: Removed i18n dependency from maintenance UI entirely. All maintenance display strings are now hardcoded in `MaintenanceService` for 6 locales (en, es, ar, fr, de, ps), selected by `LocaleService.locale`. The `TranslatePipe` is not used for any maintenance-related text. Custom operator messages via `MAINTENANCE_MESSAGE` env var still work as before.

## Testing

- **Unit tests**: `MaintenanceService` signal behavior, interceptor header/503 parsing, UI component visibility based on maintenance signals.
- **Functional tests**: `check_jwt()` enforcement for each mode/role combination via PostgREST curl tests.
- **E2E tests**: Playwright tests verifying banner visibility, control hiding, route redirects, and admin bypass.
