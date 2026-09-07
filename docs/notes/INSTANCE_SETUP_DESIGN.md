# Instance Setup & Configuration — Design Document

> **Status**: Ready to implement. Design finalized August 2026.

Two companion features that together solve instance onboarding:

1. **Instance Config Store** — A named key:value table (`metadata.instance_config`) that module builders can depend on for application-level configuration (organization name, default timezone, branding, etc.).
2. **Setup Task Checklist** — A metadata-driven admin page that guides the first admin through required configuration, with automatic completion detection, `returnTo`-based walkthrough flow, and regression warnings.

## Table of Contents

- [Motivation](#motivation)
- [Design Principles](#design-principles)
- [Part 1: Instance Config Store](#part-1-instance-config-store)
- [Part 2: Setup Task Checklist](#part-2-setup-task-checklist)
- [Part 3: RBAC](#part-3-rbac)
- [Part 4: Frontend Architecture](#part-4-frontend-architecture)
- [Design Decisions](#design-decisions)
- [Example: Childcare Instance](#example-childcare-instance)
- [Future Enhancements](#future-enhancements)

---

## Motivation

Civic OS instances are deployed with pre-installed modules (schema, entities, permissions), but the system isn't useful until a human completes initial configuration: naming the organization, creating staff records, defining statuses, etc. Today this is ad-hoc — the deployer runs SQL, then tells the admin "go fill in X, Y, Z." There's no in-product guidance.

Meanwhile, there's no standardized place for application-level configuration values. Docker env vars handle infrastructure config (PostgREST URL, Keycloak realm), but "agency name" or "support email" are scattered across hardcoded SQL with no UI to read or update them.

## Design Principles

- **Metadata-first**: Configured in SQL, not hardcoded. Presence of rows in `metadata.setup_tasks` activates the feature.
- **Non-linear**: Tasks completable in any order.
- **Navigate, don't duplicate**: Each task sends the user to an existing CRUD/admin page; no inline data entry.
- **Admin SQL pattern**: `metadata.table` → `public.VIEW` → update RPC.
- **`returnTo` walkthrough**: Setup page passes `?returnTo=/setup` when navigating to tasks, leveraging CreatePage's existing auto-return behavior.
- **Database-driven guard**: Guard checks if setup tasks exist; if none, skips for the session.
- **Three task states**: Complete, regressed (was complete, data deleted), pending.
- **Session-only dismiss**: Prompt reappears on next login until all tasks are truly complete.
- **Fail-open**: Network errors don't lock anyone out.

---

## Part 1: Instance Config Store

### Problem

Docker env vars handle infrastructure config. But application-level config (organization name, default timezone, support email, branding) has no standardized home. Module builders need a contract: "if key `agency_name` exists, use it in templates/notifications/reports."

### Tables

**`metadata.instance_config_groups`** — Groups organize config keys into display sections (like `metadata.status_types` organizes statuses):

| Column | Type | Description |
|--------|------|-------------|
| `group_key` | `TEXT PK` | e.g., `'org'`, `'system'` |
| `display_name` | `TEXT NOT NULL` | Section header label |
| `description` | `TEXT` | Section description |
| `icon` | `TEXT` | Material Symbols icon name |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | Controls section ordering |

**`metadata.instance_config`** — Config keys are flatly unique. Group FK is optional.

| Column | Type | Description |
|--------|------|-------------|
| `config_key` | `TEXT PK` | e.g., `'agency_name'` |
| `config_value` | `TEXT` | Always stored as text, cast on read |
| `config_type` | `TEXT NOT NULL DEFAULT 'string'` | `'string'`, `'integer'`, `'boolean'`, `'json'` |
| `display_name` | `TEXT NOT NULL` | Label on config page |
| `description` | `TEXT` | Help text |
| `group_key` | `TEXT FK` | References `instance_config_groups` |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | Ordering within group |

**No `is_required` column.** Setup tasks handle enforcement via `check_type: 'config_set'`. Instance config is a pure key-value store.

### Public VIEW

`public.instance_config` — Joins groups, ordered by group sort then item sort. Uses `security_invoker = true`.

### RPCs

- **`set_instance_config(p_key, p_value)`** → `JSONB` — Updates a config value. `SECURITY INVOKER`; RLS enforces `has_permission('instance_config', 'update')`.
- **`get_config(p_key)`** → `TEXT` — Reads a single config value. `STABLE SECURITY INVOKER`. Designed for use inside other RPCs and VIEWs.

### Usage by Module Builders

```sql
-- In a notification template:
'Welcome to ' || get_config('agency_name')

-- In a VIEW column:
SELECT get_config('default_timezone') AS tz;
```

### Hybrid Config Architecture: ENV vs. DB-Backed Values

The frontend runtime configuration (`window.civicOsConfig`) splits into two tiers based on **when and how the value is consumed** — not whether it's "infrastructure" or "application."

#### Tier 1: ENV-only (container restart to change)

Values needed before PostgREST is reachable, baked into static artifacts (HTML, manifest, nginx CSP), or security-sensitive. These stay in `docker-compose.yml` and the Docker entrypoint injects them into `window.civicOsConfig` and static files as today.

| Value | Reason |
|---|---|
| `postgrestUrl` | Chicken-and-egg — required to reach the database |
| `keycloak.url/realm/clientId` | Pre-auth bootstrap in `APP_INITIALIZER` |
| `swaggerUrl` | External infrastructure URL |
| `s3.endpoint/bucket` | URL construction for `<img>` src, never hits PostgREST |
| `matomo.url/siteId` | External service script injection + CSP must allow the domain |
| `faviconUrl` | Baked into `<link rel="icon">` in HTML before Angular loads |
| `pwa.enabled` | Controls `<link rel="manifest">` injection AND service worker registration at bootstrap |
| `pwa.appName` | Baked into `manifest.webmanifest` — OS reads at install time |
| `map.tileUrl/attribution` | Tile domain must appear in CSP header; changing domain still needs deploy |

#### Tier 2: DB-backed, admin-editable (live on next navigation)

Values only read by Angular **after** bootstrap, via services and signals. These migrate to `metadata.instance_config` rows and are loaded by a frontend `ConfigService` from PostgREST. Changes take effect on the next route navigation via cache-busting (see below).

| Config Key | Current ENV Source | Where Angular Reads It | Admin Change UX |
|---|---|---|---|
| `app_title` | `APP_TITLE` | Navbar brand, `Title.setTitle()`, about/settings modals | Next navigation shows new title. Brief `<title>` flash of old HTML value until Angular overwrites (already happens today). |
| `default_theme` | `DEFAULT_THEME` | `ThemeService` on init; user preference overrides | Affects new users / cleared prefs only |
| `default_locale` | `DEFAULT_LOCALE` | `LocaleService` on init | Affects users who haven't chosen a language |
| `supported_locales` | `SUPPORTED_LOCALES` | Language picker visibility, translation loading | Adding a language appears immediately (translation JSON is already DB-driven) |
| `sms_configured` | `SMS_CONFIGURED` | "Send SMS" button visibility | Toggle on/off without deploy |
| `matomo_enabled` | `MATOMO_ENABLED` | Analytics on/off toggle (URL/siteId stay Tier 1) | Disable analytics without deploy |
| `map_default_lat` | `MAP_DEFAULT_LAT` | Map component default center | Affects next map render |
| `map_default_lng` | `MAP_DEFAULT_LNG` | Map component default center | Affects next map render |
| `map_default_zoom` | `MAP_DEFAULT_ZOOM` | Map component default zoom | Affects next map render |
| `stripe_publishable_key` | `STRIPE_PUBLISHABLE_KEY` | `PaymentCheckoutComponent` Stripe.js init (deep in user flow, post-auth) | Switch from `pk_test_*` to `pk_live_*` without deploy |

#### Seed-Once Mechanism

The Docker entrypoint seeds Tier 2 values into `metadata.instance_config` on first boot only (conditional INSERT — skip if key already has a value). This provides:

1. **Clean first-boot** — Deployer sets ENV vars in `docker-compose.yml`, container seeds them into DB on first `up`.
2. **Admin self-service** — Admin changes values from `/admin/config`, changes persist across container restarts because the seed is conditional.

Seed logic in entrypoint (pseudocode):
```sh
# After PostgREST is healthy, seed Tier 2 values if not already set
for key in app_title default_theme default_locale ...; do
  curl -s -X POST "$POSTGREST_URL/rpc/seed_instance_config" \
    -d "{\"p_key\": \"$key\", \"p_value\": \"$VALUE\"}"
done
```

The `seed_instance_config(p_key, p_value)` RPC uses `INSERT ... ON CONFLICT DO NOTHING` — it only writes if the key has no value yet.

**Operational note**: A nightly rolling restart of the frontend container (e.g., via cron + `docker-rollout`) is recommended for production deployments. This re-runs the entrypoint, which syncs the HTML `<title>`, `data-theme`, and other static artifacts with the current ENV values, reducing the window for FODC divergence.

#### Three-Layer Caching Strategy

Tier 2 values use a **stale-while-revalidate** pattern across three layers to eliminate flash-of-default-content (FODC) while still allowing admin self-service:

```
Layer 1: Entrypoint HTML     — fastest, set at container startup, covers first paint
Layer 2: localStorage        — synchronous, persists across page loads, covers returning users
Layer 3: DB via cache-bust   — source of truth, propagates admin changes on next navigation
```

**Layer 1: Entrypoint writes static artifacts.** The Docker entrypoint `sed`s the ENV values into `index.html` at container startup:

- `data-theme="${DEFAULT_THEME}"` on `<html>` (DaisyUI reads this before Angular boots)
- `<title>${APP_TITLE}</title>` (browser tab before Angular boots)
- `<html lang="${DEFAULT_LOCALE}">` (browser locale hint)

This eliminates FODC for first-ever visits. These values only change on container restart.

**Layer 2: localStorage caches DB values.** After `ConfigService` loads Tier 2 values from PostgREST, it writes them to localStorage under a namespaced key (e.g., `civic-os-config:default_theme`). On subsequent page loads, `ThemeService` and `LocaleService` read from localStorage **synchronously in their constructors** — no network call, no flash. This solves the constructor-reads-synchronously constraint for both services without requiring a refactor to `effect()`.

ThemeService already uses localStorage for user-selected themes (`civic-os-theme` key). The new `civic-os-config:default_theme` key is the **admin default**, while the existing key is the **user override**. ThemeService's `loadThemeFromStorage()` priority chain becomes:

```
1. User-selected theme (civic-os-theme in localStorage)  → use it
2. Admin default theme (civic-os-config:default_theme)    → use it
3. ENV default from window.civicOsConfig                  → use it
4. Hardcoded 'corporate'                                  → fallback
```

**Layer 3: DB via schema cache-busting.** The `schemaVersionGuard` detects `instance_config` version changes on every navigation. When `ConfigService.invalidateCache()` fires, it re-fetches from PostgREST and updates localStorage. The new values take effect on the **next** navigation (not the current one — same as existing schema cache behavior).

**FODC analysis by scenario:**

| Scenario | Layer 1 (HTML) | Layer 2 (localStorage) | Layer 3 (DB) | User sees |
|---|---|---|---|---|
| First-ever visit | deployer's ENV | empty | DB value | ENV theme for ~5ms → ThemeService applies DB value |
| Return visit | deployer's ENV | DB value | DB value | DB value immediately (localStorage) |
| Admin changes default | deployer's ENV | old value | new value | Old value until next navigation → cache-bust → new value |
| Container restart after change | deployer's ENV | new value | new value | New value immediately (localStorage) |
| New user after admin change, before restart | deployer's ENV | empty | new value | ENV theme for ~5ms → ThemeService applies new value |

### Cache-Busting via Schema Cache Versioning

Instance config integrates with the existing `schema_cache_versions` system (see `docs/development/SCHEMA_CACHE_VERSIONING.md`). This gives admin config changes the same "live on next navigation" behavior as metadata changes.

#### Database Layer

1. **`updated_at` column** on `metadata.instance_config` with `set_updated_at()` trigger (standard pattern).

2. **New `instance_config` entry** in `schema_cache_versions` VIEW:

```sql
-- Added to the UNION ALL in schema_cache_versions:
SELECT 'instance_config'::text AS cache_name,
       COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) AS version
FROM metadata.instance_config
```

#### Frontend Layer

1. **`VersionService`** — Add `instanceConfigVersion` tracking and `instanceConfigNeedsRefresh` flag to `CacheUpdateCheck`:

```typescript
export interface CacheUpdateCheck {
  entitiesNeedsRefresh: boolean;
  propertiesNeedsRefresh: boolean;
  constraintMessagesNeedsRefresh: boolean;
  profileExtensionsNeedsRefresh: boolean;
  instanceConfigNeedsRefresh: boolean;  // NEW
  hasChanges: boolean;
}
```

2. **`ConfigService`** (new) — Loads Tier 2 config from `GET /instance_config` on bootstrap. Exposes values as signals. Provides `invalidateCache()` method that re-fetches from PostgREST (same pattern as `ProfileService`).

3. **`schemaVersionGuard`** — Add `instanceConfigNeedsRefresh` handling:

```typescript
if (updateCheck.instanceConfigNeedsRefresh) {
  configService.invalidateCache();
}
```

4. **`runtime.ts` helper migration** — Tier 2 helpers (`getAppTitle()`, `getThemeConfig()`, etc.) change from reading `window.civicOsConfig` to reading `ConfigService` signals. Tier 1 helpers remain unchanged.

#### Update Flow

```
Admin changes app_title on /admin/config
  ↓
set_instance_config() RPC updates config_value
  ↓
updated_at trigger fires on metadata.instance_config
  ↓
schema_cache_versions VIEW reflects new max timestamp
  ↓
Any user navigates to a new route
  ↓
schemaVersionGuard → VersionService.checkForUpdates()
  ↓
instanceConfigNeedsRefresh = true
  ↓
ConfigService.invalidateCache() → re-fetches from PostgREST
  ↓
Signals update → components re-render with new values
```

#### Anonymous Access for Pre-Auth Config

`supported_locales` and `default_locale` drive the login page language picker, which renders **before authentication**. The `instance_config` VIEW needs a targeted RLS policy for anonymous reads of non-sensitive keys:

```sql
-- Anonymous can read presentation and locale config (needed before auth + Stripe is client-safe)
CREATE POLICY "anon_read_safe_config" ON metadata.instance_config
  FOR SELECT TO web_anon
  USING (config_key IN (
    'default_locale', 'supported_locales', 'default_theme', 'app_title',
    'stripe_publishable_key'
  ));
```

`stripe_publishable_key` is also anonymous-readable — Stripe publishable keys are explicitly designed for client-side exposure, and making it anonymous simplifies the RLS policy. `sms_configured` remains gated to `has_permission('instance_config', 'read')` since it's only relevant inside the authenticated app.

---

## Part 2: Setup Task Checklist

### Tables

**`metadata.setup_task_groups`** — Groups organize setup tasks into accordion sections. Separate from `instance_config_groups` — setup groups are about workflow steps ("Staff Setup"), config groups are about settings categories ("Organization").

| Column | Type | Description |
|--------|------|-------------|
| `group_key` | `TEXT PK` | e.g., `'org'`, `'staff'` |
| `display_name` | `TEXT NOT NULL` | Accordion header label |
| `description` | `TEXT` | Group description |
| `icon` | `TEXT` | Material Symbols icon |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | Accordion section ordering |

**`metadata.setup_tasks`** — Defines what needs to be done. Populated by init scripts (like dashboards/widgets).

| Column | Type | Description |
|--------|------|-------------|
| `task_key` | `TEXT PK` | e.g., `'add_staff'` |
| `display_name` | `TEXT NOT NULL` | Task label |
| `description` | `TEXT` | Markdown description shown on setup page |
| `icon` | `TEXT DEFAULT 'task'` | Material Symbols icon |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | Ordering within group |
| `is_required` | `BOOLEAN NOT NULL DEFAULT true` | Required vs optional |
| `group_key` | `TEXT FK` | References `setup_task_groups` |
| `check_type` | `TEXT NOT NULL` | `'record_count'`, `'config_set'`, `'rpc_check'`, `'manual'` |
| `check_config` | `JSONB NOT NULL DEFAULT '{}'` | Parameters for the check |
| `action_route` | `TEXT` | Angular route to navigate to |
| `action_label` | `TEXT DEFAULT 'Get Started'` | Button text |
| `action_query_params` | `JSONB` | Optional query params for pre-filling |

### Check Types

| `check_type` | `check_config` | Completion condition |
|---|---|---|
| `record_count` | `{"table": "staff", "min_count": 1}` | Table has at least N rows |
| `config_set` | `{"key": "agency_name"}` | `get_config(key)` is not null/empty |
| `rpc_check` | `{"function": "has_enrollment_statuses"}` | Function returns `true` |
| `manual` | `{}` | User explicitly marks it complete |

**`metadata.setup_task_completions`** — Tracks manual completion records. Per-instance (not per-user).

| Column | Type | Description |
|--------|------|-------------|
| `task_key` | `TEXT PK FK` | References `setup_tasks` with `ON DELETE CASCADE` |
| `completed_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | When completed |
| `completed_by` | `UUID` | Who completed it |

### Public VIEW

`public.setup_tasks` — Joins groups and completions. Uses `security_invoker = true`. Ordered by `group_sort_order NULLS LAST`, then `task sort_order`.

### RPC: `get_setup_status()`

Returns all tasks with **live** completion status. Uses `SECURITY DEFINER` so `check_record_count()` gets accurate counts regardless of the calling user's RLS policies (the RPC returns only task metadata, not actual records).

**Three task states** (not just complete/incomplete):

| State | Meaning | Visual |
|-------|---------|--------|
| `complete` | Live check passes | `badge-success` ✓ |
| `regressed` | Has completion record but live check now fails | `badge-warning` ⚠ "Needs attention" |
| `pending` | No completion record and live check fails | No badge |

Live checks always run and override completion records. This detects regression (e.g., someone deletes all staff records after completing the "Add Staff" task). The `regressed` state is visually distinct from `pending` so the admin knows it worked before.

### RPC: `complete_setup_task(p_task_key)`

Marks a task as manually completed. Uses `ON CONFLICT DO UPDATE` to refresh the timestamp if re-completing a regressed task.

---

## Part 3: RBAC

Setup permissions are mapped to the existing `admin` role. No separate `setup` role — instance deployment scripts handle first-user provisioning by inviting the customer by email and auto-assigning them `admin`.

Permissions created:
- `setup_tasks` — `read`, `update`
- `instance_config` — `read`, `update`

All mapped to the `admin` role. If a future need arises for a non-admin setup user (e.g., a consultant), just add the role and map the existing permissions — no code changes.

Frontend gates on `has_permission('setup_tasks', 'read')`.

---

## Part 4: Frontend Architecture

### ConfigService (new)

Loads Tier 2 config from `GET /instance_config` on bootstrap. Exposes values as signals. Provides `invalidateCache()` for cache-busting.

**Bootstrap ordering:**

```
Keycloak SSO check completes (KeycloakEventType.Ready)
  ↓
AuthService.loadPermissions() + loadUserRoles()
  ↓
ConfigService.init() → GET /instance_config from PostgREST
  ↓
Signals hydrate → localStorage updated → components read new values
```

ConfigService initializes **after Keycloak Ready** so authenticated requests get a valid JWT. However, the anonymous RLS policy on safe keys (`default_locale`, `supported_locales`, `default_theme`, `app_title`) means a pre-auth fetch is also possible as a future optimization.

**On first load before ConfigService resolves**, ThemeService and LocaleService read from localStorage (Layer 2) or `window.civicOsConfig` (Layer 1). ConfigService updates localStorage asynchronously once the DB response arrives. This means:
- No blocking spinner on the critical render path
- No constructor refactoring needed for ThemeService or LocaleService
- Values converge to DB truth within one navigation cycle

**runtime.ts migration**: Tier 2 helpers (`getAppTitle()`, `getThemeConfig()`, etc.) add a localStorage read to their fallback chain: `ConfigService signal → localStorage → window.civicOsConfig → hardcoded default`. Tier 1 helpers remain unchanged.

### SetupService

Pattern follows `ProfileService`:
- `setupTasks` signal with all tasks and status
- `incompleteTasks` computed signal (required + incomplete, including regressed)
- `setupComplete` session flag (skip guard after verification)
- `setupDismissed` session flag (hide prompt; resets on page reload)
- 60-second TTL cache

### Setup Guard

`CanActivateChild` guard, wired alongside `profileCompletionGuard`. **Database-driven activation** — calls `get_setup_status()`. If zero tasks returned (instance has no setup tasks configured), sets `setupComplete = true` for the session.

Guard logic:
1. Not authenticated → pass
2. `setupComplete` or `setupDismissed` → pass (session flags)
3. No setup permission → pass
4. URL starts with `/setup` or `/admin/config` → pass (prevent redirect loop)
5. Call `getSetupStatus()` (cached 60s)
6. Zero tasks → set `setupComplete = true`
7. All complete → set `setupComplete = true`
8. Incomplete required tasks → set signal (triggers modal prompt)
9. Always return `true` (fail-open)

**Cost**: One RPC call per session for instances without setup tasks. Zero after that.

### The `returnTo` Walkthrough

The setup page passes `?returnTo=/setup` when navigating to tasks. This leverages CreatePage's existing auto-return behavior (`create.page.ts:153,348-352`):

```
/setup → "Add Staff" → /view/staff?returnTo=/setup → /create/staff?returnTo=/setup
→ user saves → auto-return to /setup → task shows ✓
```

For tasks that navigate to List or admin pages, the user browses and returns via the sidebar "Setup Guide" link. The config admin page (`/admin/config`) also supports `returnTo` (new behavior).

### Setup Page UI

- **Progress header**: Counts down — "4 remaining tasks of 7"
- **Progress bar**: DaisyUI progress, fills as tasks complete
- **Accordion layout**: Each group is a collapsible section
  - Group header: icon + label + remaining-count badge (`badge-primary` when tasks remain, `badge-success` ✓ when group is complete)
  - Groups with remaining tasks default to expanded; completed groups collapse
- **Task cards**: Three visual states (complete, regressed, pending)
- **Sidebar link**: Shows `badge-primary` with remaining count; vanishes entirely when all tasks are complete (no setup artifacts in steady-state operating UI)
- **"All done" state**: Celebration message on `/setup` page only; sidebar link and guard prompt disappear

### Instance Config Page (`/admin/config`)

Standalone admin page with two tiers of configuration:

**Editable section** (from `metadata.instance_config`): Groups config keys by group (accordion sections). Appropriate input per `config_type` (text, number, boolean toggle, JSON textarea). Supports `returnTo` for round-trip from setup tasks. Debounced auto-save.

**Readonly "System" section** (from `window.civicOsConfig` / runtime env vars): Displays Tier 1 Docker-injected runtime configuration values as read-only fields, giving admin users visibility into infrastructure settings they cannot change themselves. Each value shows its env var name alongside the current runtime value. Only Tier 1 values appear here — Tier 2 values (app title, theme, locale, SMS, analytics, Stripe, map defaults) are in the editable section above.

Values surfaced in the System section:

| Display Name | Source | Value |
|---|---|---|
| Favicon URL | `FAVICON_URL` | `getFaviconUrl()` |
| PWA Enabled | `PWA_ENABLED` | `getPwaConfig().enabled` |
| PWA App Name | `PWA_APP_NAME` | `getPwaAppName()` |
| Map Tile Provider | `MAP_TILE_URL` | `getMapConfig().tileUrl` |

Security-sensitive values (`postgrestUrl`, `keycloak`, `s3`, `stripe`, `matomo.url/siteId`) are **not** displayed — they expose infrastructure topology and API keys that don't help with support calls and could aid attackers.

**Support use case**: An admin can say "Can you enable PWA for our instance?" or "Can you change our favicon?" — these require a deploy, so the readonly section communicates what the deployer needs to change.

### Setup Prompt

Global modal in `app.component.html` (same pattern as profile completion prompt). Shows when guard detects incomplete required tasks. "Open Setup Guide" button navigates to `/setup`. "Later" button dismisses for the session (reappears on next login).

---

## Design Decisions

### Admin Page, Not Dashboard Widget
Setup progress is temporary — it disappears when complete. Dashboard widgets are integrator-configured. An admin page auto-hides from the sidebar when all tasks are complete — no stale widget.

### Guard is Database-Configured, Not Code-Configured
Empty `metadata.setup_tasks` table = guard is disabled. No feature flags, env vars, or config files needed.

### `returnTo` Creates a Walkthrough Without a Wizard
Instead of inline forms, the setup page leverages the existing `returnTo` pattern. The user works in real pages and auto-returns to the checklist. This teaches them where things live while still feeling guided.

### Live Checks Override Completions
Completion records are human signals ("I'm done"), but live checks detect regression. A task can revert from "complete" to "regressed" if data is deleted. This prevents a false sense of security while visually distinguishing regression from never-started.

### Separate Groups Tables
`setup_task_groups` and `instance_config_groups` are independent. Setup groups are workflow steps ("Staff Setup"), config groups are settings categories ("Organization"). They'll typically have different entries.

### Instance Config Has No `is_required`
Setup tasks handle enforcement. A `config_set` setup task checks whether a config key has been populated. The config table is a pure key-value store — no validation semantics.

### Session-Only Dismiss
Dismissing the setup prompt hides it for the current session only. On next login, it reappears until all required tasks are complete. This provides gentle reminders without being permanent.

### Hybrid Two-Tier Config (ENV vs. DB-Backed)
The dividing line isn't "infrastructure vs. application" — it's **what layer serves the value**. If nginx serves it (CSP headers, HTML `<title>`, `manifest.webmanifest`), it must be an ENV var because no amount of Angular code can update a static file. If Angular reads it from JavaScript after bootstrap, it can live in the database. This gives admins self-service for the values they actually want to change (app title, theme, locale, payment keys) while keeping the container startup reliable for the values that can't be hot-swapped.

### Seed-Once, Not Sync
The entrypoint seeds Tier 2 values into `instance_config` only if the key has no value (`ON CONFLICT DO NOTHING`). This is intentionally one-way: the DB is the source of truth after first boot. If the deployer changes an ENV var and restarts, it does NOT overwrite an admin's change. To force a reset, the deployer must explicitly clear the DB value. This prevents the "deploy clobbers admin work" anti-pattern.

### Cache-Busting Over Polling
Instance config piggybacks on the existing `schema_cache_versions` system rather than introducing a timer or WebSocket. The guard already runs on every navigation, making config changes visible within one route transition — fast enough for settings that change rarely, with zero additional infrastructure.

### Go Worker Reads from DB, Not ENV
The consolidated Go worker uses `APP_TITLE` in email template rendering (e.g., "Welcome to Acme Agency"). Rather than keeping this as a parallel ENV var that drifts from the DB, the worker reads `app_title` from the database at startup via a direct SQL query or PostgREST fetch. This ensures emails match the admin-configured title without requiring a container restart. The worker already has a database connection for River job processing, so this adds no new infrastructure dependency.

### Config Labels Are English-Only
The `display_name` and `description` columns on `instance_config` and `instance_config_groups` are not piped through the `metadata.translations` system. The `/admin/config` page is deployer/admin-facing, not end-user-facing. Keeping labels in English avoids translation pipeline complexity for a rarely-visited page. Revisit if admin localization becomes a priority.

### Runtime Config Readonly System Section (Tier 1 Visibility)
Tier 1 env vars that affect admin-visible behavior (PostgREST URL excluded, but `PWA_ENABLED`, `FAVICON_URL`, etc.) are surfaced as a readonly accordion section on `/admin/config`. This gives admins the vocabulary to communicate with their deployer ("My PWA is disabled, can you enable it?") without exposing infrastructure topology or API keys.

---

## Example: Childcare Instance

### Config keys:
```sql
INSERT INTO metadata.instance_config_groups (group_key, display_name, icon, sort_order) VALUES
('org',    'Organization', 'business', 10),
('system', 'System',       'settings', 20);

INSERT INTO metadata.instance_config (config_key, config_value, config_type, display_name, group_key, sort_order) VALUES
('agency_name',     NULL,               'string', 'Organization Name',  'org',    10),
('agency_phone',    NULL,               'string', 'Main Phone Number',  'org',    20),
('agency_email',    NULL,               'string', 'Contact Email',      'org',    30),
('default_timezone','America/New_York', 'string', 'Default Timezone',   'system', 10);
```

### Setup tasks:
```sql
INSERT INTO metadata.setup_task_groups (group_key, display_name, icon, sort_order) VALUES
('org',    'Organization', 'business', 10),
('staff',  'Staff',        'group',    20),
('config', 'Configuration','settings', 30);

INSERT INTO metadata.setup_tasks
  (task_key, display_name, description, icon, sort_order, is_required, group_key,
   check_type, check_config, action_route, action_label) VALUES
('set_agency_name', 'Name your organization',
  'Set your agency name — it appears in headers, notifications, and reports.',
  'badge', 10, true, 'org',
  'config_set', '{"key": "agency_name"}', '/admin/config', 'Set Name'),
('add_locations', 'Add your locations',
  'Create entries for each physical site you manage.',
  'location_on', 20, true, 'org',
  'record_count', '{"table": "locations", "min_count": 1}', '/view/locations', 'Manage Locations'),
('add_staff', 'Add staff members',
  'Create records for your team. You can import from Excel too.',
  'group', 30, true, 'staff',
  'record_count', '{"table": "staff", "min_count": 1}', '/view/staff', 'Manage Staff'),
('define_rooms', 'Define classrooms',
  'Set up the rooms or classrooms at your site.',
  'meeting_room', 40, false, 'staff',
  'record_count', '{"table": "rooms", "min_count": 1}', '/view/rooms', 'Manage Rooms'),
('set_statuses', 'Configure enrollment statuses',
  'Customize the status workflow for enrollments.',
  'checklist', 50, false, 'config',
  'rpc_check', '{"function": "has_enrollment_statuses"}', '/admin/statuses', 'Configure Statuses');
```

---

## Migrations

### `v0-XX-0-instance-config`
- `metadata.instance_config_groups` + `metadata.instance_config` tables (with `updated_at` + trigger)
- `public.instance_config` VIEW (joins groups, `security_invoker = true`)
- `set_instance_config()`, `get_config()`, `seed_instance_config()` RPCs
- GRANTs, RLS (admin read/update + anonymous read for safe keys), permission rows
- Add `instance_config` entry to `schema_cache_versions` VIEW

### `v0-XX-1-setup-wizard`
- `metadata.setup_task_groups` + `metadata.setup_tasks` + `metadata.setup_task_completions` tables
- `public.setup_tasks` VIEW (joins groups, `security_invoker = true`)
- `get_setup_status()` RPC (`SECURITY DEFINER`), `complete_setup_task()` RPC
- `check_record_count()`, `check_config_set()`, `check_rpc()` helper functions
- GRANTs, RLS, permission rows, schema cache version

---

## Future Enhancements

- **Auto-detection** — Automatically create setup tasks based on empty required tables in schema.
- **`returnTo` on List pages** — Extend the `returnTo` pattern to List pages for tighter round-trip flow.
- **On-page guided tours** — Scrim + highlight pattern for element-level guidance (deferred).
- **Per-user onboarding** — Non-admin onboarding flows (different from instance setup).
- **Completion webhooks** — Notify deployer when setup is complete.
