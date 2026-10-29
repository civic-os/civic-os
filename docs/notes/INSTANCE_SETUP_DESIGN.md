# Instance Setup & Configuration — Design Document

> **Status**: Part 1 (Instance Config Store and `/admin/config`) revised after validation against the code, October 2026; targeted for v0.78.0. Part 2 (Setup Task Checklist) is designed and follows Part 1. Design first written August 2026.

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

> **Revision (October 2026, v0.78.0).** This part was checked against the code before it was built. The check changed the seeding path, the visibility model, the type list and several claims about how the frontend boots. Each change is marked **(revised)** below, and [Validation Findings](#validation-findings-october-2026) lists what was found and where.

### Problem

Docker env vars handle infrastructure config. But application-level config (organization name, default timezone, support email, branding) has no standardized home. Module builders need a contract: "if key `agency_name` exists, use it in templates/notifications/reports."

### Tables

**`metadata.instance_config_groups`** — Groups organize config keys into display sections (like `metadata.status_types` organizes statuses):

| Column | Type | Description |
|--------|------|-------------|
| `group_key` | `TEXT PK` | e.g., `'org'`, `'appearance'` |
| `display_name` | `TEXT NOT NULL` | Section header label |
| `description` | `TEXT` | Section description |
| `icon` | `TEXT` | Material Symbols icon name |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | Controls section ordering |

**`metadata.instance_config`** — Config keys are flatly unique. Group FK is optional.

| Column | Type | Description |
|--------|------|-------------|
| `config_key` | `TEXT PK` | e.g., `'agency_name'` |
| `config_value` | `TEXT` | Always stored as text, cast on read. NULL means "not set": the frontend falls back to the ENV value, then to the built-in default. |
| `config_type` | `TEXT NOT NULL DEFAULT 'string'` | **(revised)** `CHECK` in `'string'`, `'integer'`, `'number'`, `'boolean'`, `'json'`, `'theme'`, `'locale'`, `'locale_list'`. `number` covers decimals (map lat/lng); `theme`, `locale` and `locale_list` pick the input on `/admin/config` and the validation in `set_instance_config()`. |
| `display_name` | `TEXT NOT NULL` | Label on config page |
| `description` | `TEXT` | Help text |
| `group_key` | `TEXT FK` | References `instance_config_groups` |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | Ordering within group |
| `is_public` | `BOOLEAN NOT NULL DEFAULT false` | **(revised)** Anonymous (`web_anon`) may read the row. Authenticated users read every row regardless. |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Maintained by `public.set_updated_at()`; drives cache-busting |

**No `is_required` column.** Setup tasks handle enforcement via `check_type: 'config_set'`. Instance config is a pure key-value store.

**No secrets.** Every authenticated user can read every key, and public keys are readable without logging in. API secrets, SMTP passwords and the like stay in ENV or a secret store. A Stripe *publishable* key is fine here; a Stripe *secret* key never is.

### Visibility and Writes (revised)

| Who | Read | Write |
|---|---|---|
| `web_anon` | rows with `is_public = true` | none |
| `authenticated` | every row | only with `has_permission('metadata.instance_config', 'update')` (mapped to `admin`), and only `config_value` |

RLS on `metadata.instance_config`: `SELECT TO web_anon USING (is_public)`, `SELECT TO authenticated USING (true)`, `UPDATE TO authenticated USING/WITH CHECK (has_permission('metadata.instance_config','update'))`. Column grant: `UPDATE (config_value)` to `authenticated`, so even an admin cannot rewrite a key's type, label or visibility over the API; integrators do that in SQL.

Groups are not sensitive: `SELECT` is `true` for both roles.

The permission follows the `metadata.<table>` naming the status and category admin uses (`metadata.statuses`, `metadata.categories`). It has `update` only: reading is governed by the policies above, so a `read` permission would gate nothing.

The original design gated reads on admin. That made `get_config()` return NULL to every non-admin caller, which broke its main use (inside notification templates, views and RPCs that run as the end user), and a hardcoded list of anonymous keys could never cover keys an integrator adds. A per-row `is_public` flag fixes both.

### Public VIEW

`public.instance_config` — `WITH (security_invoker = true)`, a LEFT JOIN of groups exposing `group_display_name`, `group_description`, `group_icon` and `group_sort_order`, ordered by group sort then item sort. Because it is a VIEW with no `metadata.entities` row, it does not enter the schema contract hash and does not appear as a CRUD entity.

### RPCs

- **`set_instance_config(p_key, p_value)`** → `JSONB` — Updates a config value. `SECURITY INVOKER` with a pinned `search_path`; the RLS update policy is the authorization. An empty string or NULL stores NULL (reset to the ENV/default). The value is validated by `config_type`: `integer` and `number` must parse, `boolean` is `true`/`false`, `json` must parse, `locale` matches `^[a-z]{2}(-[A-Z]{2})?$`, `locale_list` is a comma list of locales, `theme` and `string` are free text. An unknown key is an error. Returns `{"success": true}` or `{"success": false, "error": "..."}`, catching `insufficient_privilege` the way the v0.40.0 status admin RPCs do.
- **`get_config(p_key)`** → `TEXT` — Reads a single config value. `STABLE SECURITY INVOKER`, executable by `web_anon` and `authenticated`. Designed for use inside other RPCs and VIEWs: it returns the value the caller may see, so a non-public key reads as NULL for anonymous callers.

Both functions `REVOKE EXECUTE ... FROM PUBLIC` and grant to the API roles explicitly (v0.76.5 function-security rule).

There is **no** `seed_instance_config()` RPC **(revised)**: an HTTP-reachable seed function would be an anonymous writer. Seeding runs in SQL from the migrations container (below).

### Usage by Module Builders

```sql
-- Define a key in an instance init script or migration:
INSERT INTO metadata.instance_config_groups (group_key, display_name, icon, sort_order)
VALUES ('org', 'Organization', 'business', 10)
ON CONFLICT DO NOTHING;

INSERT INTO metadata.instance_config
  (config_key, config_type, display_name, description, group_key, sort_order, is_public)
VALUES ('agency_name', 'string', 'Organization Name', 'Shown in emails and reports', 'org', 10, true)
ON CONFLICT DO NOTHING;

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
| `map.tileUrl/attribution` | **(revised)** `MAP_TILE_URL` never reaches the CSP: the tile domains are hardcoded in `docker/frontend/nginx.conf`, so a new tile provider needs an image change either way. It stays Tier 1 because a wrong value breaks every map and the allowed domains must change with it. |

#### Tier 2: DB-backed, admin-editable (live on next navigation)

Values only read by Angular **after** bootstrap, via services and signals. These are `metadata.instance_config` rows loaded by a frontend `ConfigService` from PostgREST. Changes take effect on the next route navigation via cache-busting (see below). Every value resolves **DB → ENV (`runtime.ts`) → built-in default**, so an empty table behaves exactly like v0.77.

| Config Key | Type | Public | Current ENV Source | Where Angular Reads It | Admin Change UX |
|---|---|---|---|---|---|
| `app_title` | `string` | yes | `APP_TITLE` | Navbar brand, `document.title`, page titles, settings modal, PWA banner fallback; worker email `site_name` | Next navigation shows new title. The pre-boot `<title>` keeps the ENV value until Angular overwrites it. |
| `default_theme` | `theme` | yes | `DEFAULT_THEME` | `ThemeService`, below the user's own choice | Affects users who have not picked a theme |
| `default_locale` | `locale` | yes | `DEFAULT_LOCALE` | `LocaleService`, below the saved choice and the browser language | Affects users with no saved choice whose browser language is unsupported |
| `supported_locales` | `locale_list` | yes | `SUPPORTED_LOCALES` | Settings language tab, profile page, translations admin link (2+ entries) | Adding a language appears on the next navigation (translations are already DB-driven) |
| `sms_configured` | `boolean` | **no** | `SMS_CONFIGURED` | SMS controls in settings, profile and user management | Toggle on/off without deploy |
| `matomo_enabled` | `boolean` | yes | `MATOMO_ENABLED` | Deferred Matomo tracker init and `AnalyticsService.isEnabled()` (URL/siteId stay Tier 1) | Turn analytics on or off without deploy; see the Matomo note below |
| `map_default_lat` | `number` | yes | `MAP_DEFAULT_LAT` | Map component default center | Affects next map render |
| `map_default_lng` | `number` | yes | `MAP_DEFAULT_LNG` | Map component default center | Affects next map render |
| `map_default_zoom` | `integer` | yes | `MAP_DEFAULT_ZOOM` | Map component default zoom | Affects next map render |
| `stripe_publishable_key` | `string` | yes | `STRIPE_PUBLISHABLE_KEY` | `PaymentCheckoutComponent` Stripe.js init | Switch from `pk_test_*` to `pk_live_*` without deploy. If no key resolves, the Pay button shows an error instead of calling Stripe with an empty key. |

The framework ships these keys in four groups (`appearance`, `language`, `integrations`, `map`) with NULL values.

**Matomo note (revised).** In its default `AUTO` mode, `ngx-matomo-client` injects `matomo.js` at bootstrap, and `withRouter()` records a page view on every navigation without asking `AnalyticsService`. A flag that only gated `isEnabled()` would therefore still send traffic. Instead, `app.config.ts` provides Matomo in `AUTO_DEFERRED` mode whenever the ENV `url` and `siteId` are set, whatever the ENV enabled flag says. `ConfigService` calls `MatomoInitializerService.initializeTracker()` once, when the resolved `matomoEnabled` (DB → ENV → `true`) is true. Until that call, router page views only queue in `window._paq`, so a false flag means no Matomo network requests at all. The DB flag works in both directions. Switching it off mid-session stops the app's own calls at once, and stops the script on the next page load.

#### Seed-Once Mechanism (revised)

The **migrations container** seeds Tier 2 values after a successful `sqitch deploy`, using `psql` with the same database URL. For each Tier 2 ENV var that is set, it runs:

```sql
UPDATE metadata.instance_config
   SET config_value = :'val'
 WHERE config_key = :'key' AND config_value IS NULL;
```

The value is passed as a psql variable (`-v val=...`) and quoted by psql, never interpolated into the SQL text, so a title like `A | B & "C" '; DROP ...` is stored verbatim.

This gives:

1. **Clean first boot** — the deployer sets ENV vars, the first migration run copies them into the DB, and SQL readers (`get_config()`, the worker) see real values from day one.
2. **Admin self-service** — an admin's value is never overwritten, because the seed only fills NULL rows. To make a changed ENV value take effect, clear the DB value (Reset on `/admin/config`).
3. **Compose drift tolerance** — production compose files do not all set every var (e.g. the VPS file has no locale vars). Unset vars are skipped, and the frontend keeps falling back to ENV for them.

Why not the original plan: the frontend entrypoint has no database credentials, no `curl`, and no health wait on PostgREST; an HTTP seed RPC would have to be callable by `web_anon`; and `INSERT ... ON CONFLICT DO NOTHING` never fills a key row that already exists with a NULL value, which is exactly the state the framework migration creates.

The "nightly rolling restart" recommendation is dropped **(revised)**: Layer 1 only ever carries ENV values, so restarting the frontend does not bring it closer to the DB.

#### Three-Layer Caching Strategy

Tier 2 values use a **stale-while-revalidate** pattern across three layers to eliminate flash-of-default-content (FODC) while still allowing admin self-service:

```
Layer 1: Entrypoint HTML     — fastest, set at container startup, covers first paint
Layer 2: localStorage        — synchronous, persists across page loads, covers returning users
Layer 3: DB via cache-bust   — source of truth, propagates admin changes on next navigation
```

**Layer 1: Entrypoint writes static artifacts (revised).** The frontend entrypoint `sed`s ENV values into `index.html` at container startup, before it rehashes `index.html` in `ngsw.json`:

- `data-theme="${DEFAULT_THEME}"` on `<html>` (DaisyUI reads this before Angular boots) — new
- `lang="${DEFAULT_LOCALE}"` on `<html>` (replaces the hardcoded `lang="en"`) — new
- `<title>${APP_TITLE}</title>` — already existed; now escaped for `|`, `&` and `\` so a title containing them no longer breaks the `sed`

This covers first-ever visits. These values only change on container restart.

**Layer 2: localStorage caches DB values (revised).** After `ConfigService` loads Tier 2 values from PostgREST, it writes them all to one localStorage key, `civic-os-config`, as a JSON object. `ConfigService` hydrates its `values` signal from that key **synchronously in its constructor** (inside try/catch; a private window or blocked storage just starts empty), so ThemeService and LocaleService get the cached admin default on the first frame of a return visit.

ThemeService already uses localStorage for the user-selected theme (`civic-os-theme`). That stays the **user override**; the config value is the **admin default**. ThemeService today has no admin layer: `DEFAULT_THEME` is read once into a field through `resolveDefaultTheme()`, which maps an unvetted value to `corporate`. The priority chain becomes:

```
1. User-selected theme (civic-os-theme in localStorage)        → use it
2. configService.defaultTheme():
     DB value (live, or cached in civic-os-config)             → resolveDefaultTheme()
     else ENV DEFAULT_THEME from window.civicOsConfig          → resolveDefaultTheme()
     else 'corporate'
```

An `effect()` re-applies the default when it changes and the user has no choice of their own.

LocaleService froze its config at construction, including `supportedLocales`. It now reads `supportedLocales` and `defaultLocale` as signals from ConfigService. Its priority is unchanged and is stated here as it is: **saved choice → browser language (if supported) → instance default → `en`**. The instance default therefore only applies when the browser language is not supported.

**Layer 3: DB via schema cache-busting.** The `schemaVersionGuard` detects `instance_config` version changes on every navigation. When `ConfigService.invalidateCache()` fires, it re-fetches from PostgREST and updates localStorage. Signals update in place, so the current page re-renders with the new value.

**FODC analysis by scenario:**

| Scenario | Layer 1 (HTML) | Layer 2 (localStorage) | Layer 3 (DB) | User sees |
|---|---|---|---|---|
| First-ever visit | deployer's ENV | empty | DB value | ENV theme until the config fetch returns → DB value |
| Return visit | deployer's ENV | DB value | DB value | DB value immediately (localStorage) |
| Admin changes default | deployer's ENV | old value | new value | Old value until next navigation → cache-bust → new value |
| New user after admin change | deployer's ENV | empty | new value | ENV theme until the config fetch returns → new value |

Because the seed copies ENV into the DB on first deploy, the first-visit flash only appears after an admin has changed a value away from ENV.

### Cache-Busting via Schema Cache Versioning

Instance config integrates with the existing `schema_cache_versions` system (see `docs/development/SCHEMA_CACHE_VERSIONING.md`). This gives admin config changes the same "live on next navigation" behavior as metadata changes.

#### Database Layer

1. **`updated_at` column** on `metadata.instance_config` with the `public.set_updated_at()` trigger (standard pattern).

2. **New `instance_config` row** in the `schema_cache_versions` VIEW **(revised)**. That view is a deliberate definer view (allowlisted in `tests/functional/view-security-guard-test.sh`) whose body was last replaced in `v0-65-2-profile-i18n-fixes`. The migration drops and re-creates it with one more branch, keeping its comment and grants. The branch uses a scalar subselect so it always yields one row:

```sql
UNION ALL
SELECT 'instance_config'::text AS cache_name,
       COALESCE((SELECT MAX(updated_at) FROM metadata.instance_config),
                '1970-01-01'::timestamptz) AS version
```

Because the view is definer-owned, the max timestamp covers non-public rows for anonymous callers too. That reveals only *when* config last changed, not any value, which is the same exposure every other row of this view has.

The SDK core (`packages/core`) and the MCP server ignore cache names they do not know, so neither changes. The raw golden captures gain one row.

#### Frontend Layer

1. **`VersionService`** — Add `instance_config` version tracking and an `instanceConfigNeedsRefresh` flag to `CacheUpdateCheck`.

2. **`ConfigService`** (new) — Loads Tier 2 config with `GET /instance_config?select=config_key,config_value`. Exposes typed computed accessors and an `envValue(key)` lookup for the admin page. Provides `invalidateCache()`, which re-fetches.

3. **`schemaVersionGuard`** — on `instanceConfigNeedsRefresh`, calls `configService.invalidateCache()`.

4. **`runtime.ts` stays ENV-only (revised).** The original plan had the Tier 2 helpers in `runtime.ts` read ConfigService. That would make a module of plain functions depend on an injectable service. Instead the helpers keep reading `window.civicOsConfig`, and ConfigService calls them as its fallback layer. Consumers that need the live value inject ConfigService.

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

#### Anonymous Access (revised)

The original design justified anonymous reads with a pre-auth language picker on the login page. There is none: `/login` is a redirect stub to Keycloak and the Keycloak theme has no picker. Anonymous reads still matter, because public pages (an anonymous list, a public dashboard) render the title, theme, locale, map and Stripe values. `is_public` covers them without a hardcoded key list. `stripe_publishable_key` is public by design (Stripe publishable keys are made for the browser); `sms_configured` is not, since it only matters inside the authenticated app.

ConfigService loads on three triggers: a non-blocking app initializer (anonymous or cached token), AuthService reaching Ready (to pick up the non-public keys once a JWT exists), and the cache-bust guard.

### Validation Findings (October 2026)

What the pre-implementation check found, and what changed because of it.

1. **Seeding.** The frontend entrypoint has no DB credentials, `curl` or PostgREST health wait; an HTTP seed RPC would be an anonymous writer; `ON CONFLICT DO NOTHING` never fills an existing NULL row. → psql seed in the migrations container after `sqitch deploy`, `UPDATE ... WHERE config_value IS NULL`.
2. **Read access.** An INVOKER `get_config()` over admin-only rows returns NULL to non-admins, breaking use in views and RPCs; a hardcoded anonymous key list cannot cover integrator keys. → `is_public`; authenticated users read every row; no secrets in the table.
3. **Pre-auth picker.** None exists (`auth-action.page.ts` makes `/login` a redirect; nothing in the Keycloak theme). Anonymous reads are still needed for public pages.
4. **Layer 1.** The `<title>` sed existed but was unescaped for `|` and `&`; there were no `data-theme` or `lang` seds (`index.html` hardcodes `lang="en"`). New seds go before the `ngsw.json` rehash.
5. **ThemeService** had no admin-default layer; `DEFAULT_THEME` was a field resolved once via `resolveDefaultTheme()` (unvetted → `corporate`).
6. **LocaleService** froze `supportedLocales`; `navigator.language` outranks the instance default. → signals; priority kept and documented as it is.
7. **Matomo** is gated at module load in `app.config.ts`, and its `AUTO` mode tracks router navigations on its own. → `AUTO_DEFERRED` mode, initialized by `ConfigService` once the resolved flag is true.
8. **`MAP_TILE_URL`** never reaches the CSP (tile domains are hardcoded in `nginx.conf`): still Tier 1, for a different reason than first stated.
9. **`schema_cache_versions`** is an allowlisted definer view: DROP + CREATE with a scalar-subselect branch. Core and MCP ignore unknown cache names; raw goldens gain a row.
10. **Permission naming** follows `metadata.<table>` (`metadata.instance_config`), `update` only.
11. **Contract hash.** `public.instance_config` stays a VIEW without a `metadata.entities` row, so `schema_contract_hash()` does not change.
12. **Types.** `string|integer|boolean|json` could not express decimals or the theme/locale pickers → `string|integer|number|boolean|json|theme|locale|locale_list`.
13. **Worker.** The Go worker read `APP_TITLE` once at startup and connects as `postgres` (bypassing RLS). → per-render lookup with a 60-second cache, falling back to `APP_TITLE`.
14. **Compose drift.** Production compose files differ in which Tier 2 vars they set. → the seed writes only the vars that are set.
15. **Dropped.** The nightly rolling restart, and `runtime.ts` reading ConfigService. `runtime.ts` stays ENV-only and is ConfigService's fallback layer.

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
- `metadata.instance_config` — `update` only **(revised)**: reads are governed by `is_public` and the authenticated read policy, so a `read` permission would gate nothing. The name follows the `metadata.<table>` convention of the status and category admin.

All mapped to the `admin` role. If a future need arises for a non-admin setup user (e.g., a consultant), just add the role and map the existing permissions — no code changes.

Frontend gates on `has_permission('setup_tasks', 'read')`.

---

## Part 4: Frontend Architecture

### ConfigService (new)

Loads Tier 2 config from `GET /instance_config?select=config_key,config_value`. Exposes values as typed computed signals that resolve DB → ENV → default. Provides `invalidateCache()` for cache-busting. **(revised)**

**Load triggers:**

```
Constructor: hydrate the values signal from localStorage 'civic-os-config' (sync)
  ↓
Non-blocking app initializer → load()            (public keys for anonymous callers)
  ↓
AuthService Ready → load()                       (adds non-public keys once a JWT exists)
  ↓
schemaVersionGuard: instanceConfigNeedsRefresh → invalidateCache() → load()
  ↓
Each load writes the whole result back to 'civic-os-config'
```

The initializer does not block bootstrap: a slow or failed fetch leaves the cached or ENV values in place, so the app never waits on config to paint.

**On first load before ConfigService resolves**, ThemeService and LocaleService read ConfigService's accessors, which already hold the localStorage value (Layer 2) or fall back to `window.civicOsConfig`. This means:
- No blocking spinner on the critical render path
- ThemeService and LocaleService react to later values through signals and `effect()`
- Values converge to DB truth within one navigation cycle

**runtime.ts stays ENV-only (revised)**: Tier 2 helpers (`getAppTitle()`, `getThemeConfig()`, etc.) keep reading `window.civicOsConfig` and are ConfigService's fallback layer. Tier 1 helpers remain unchanged.

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

Standalone admin page, one unified view: each editable DB value sits next to the ENV value it overrides. Visible in the sidebar's Admin section to users with `has_permission('metadata.instance_config', 'update')`.

**Editable section** (from `public.instance_config`): one DaisyUI `collapse` per group. Input per `config_type`: text (`string`), number (`integer`, `number`), toggle (`boolean`), textarea (`json`), theme select from `src/app/constants/themes.ts` (`theme`), locale input (`locale`, `locale_list`). **(revised)** Each field saves on its own 1000 ms debounce through `set_instance_config()` and shows its own status (saving, saved, error). When a value is NULL the input's placeholder shows the inherited ENV value labelled with its env var name (e.g. `APP_TITLE: Pothole Tracker`), and **Reset** sets the value back to NULL. A **Done** button follows `?returnTo=` when it is a same-origin path (starts with exactly one `/`), for the round trip from setup tasks.

**Read-only "Deployment" section** (from `window.civicOsConfig` / runtime env vars): Displays Tier 1 Docker-injected runtime configuration values as read-only fields, giving admin users visibility into infrastructure settings they cannot change themselves. Each value shows its env var name alongside the current runtime value. Only Tier 1 values appear here — Tier 2 values (app title, theme, locale, SMS, analytics, Stripe, map defaults) are in the editable section above.

Page strings (`admin_config.*`, `sidebar.config`) are translated like every framework string. The `display_name` and `description` of each key are not (see Config Labels Are English-Only).

Values surfaced in the Deployment section:

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
The migrations container seeds Tier 2 values into `instance_config` only where the value is NULL (`UPDATE ... WHERE config_value IS NULL`) **(revised)**. This is intentionally one-way: the DB is the source of truth after first boot. If the deployer changes an ENV var and restarts, it does NOT overwrite an admin's change. To force a reset, the deployer must explicitly clear the DB value. This prevents the "deploy clobbers admin work" anti-pattern.

### Cache-Busting Over Polling
Instance config piggybacks on the existing `schema_cache_versions` system rather than introducing a timer or WebSocket. The guard already runs on every navigation, making config changes visible within one route transition — fast enough for settings that change rarely, with zero additional infrastructure.

### Go Worker Reads from DB, Not ENV
The consolidated Go worker uses `APP_TITLE` in email template rendering (e.g., "Welcome to Acme Agency"). Rather than keeping this as a parallel ENV var that drifts from the DB, the worker reads `app_title` from `metadata.instance_config` when it renders, through a 60-second cache, and falls back to `APP_TITLE` when the value is NULL, the table is missing or the query fails **(revised: the first version read it once at startup, which would need a restart after every change)**. This ensures emails match the admin-configured title within a minute without a container restart. The worker already has a database connection for River job processing, so this adds no new infrastructure dependency. It connects as `postgres`, so RLS does not apply to this read.

### Config Labels Are English-Only
The `display_name` and `description` columns on `instance_config` and `instance_config_groups` are not piped through the `metadata.translations` system. The `/admin/config` page is deployer/admin-facing, not end-user-facing. Keeping labels in English avoids translation pipeline complexity for a rarely-visited page. Revisit if admin localization becomes a priority.

### Read-Only Deployment Section (Tier 1 Visibility)
Tier 1 env vars that affect admin-visible behavior (PostgREST URL excluded, but `PWA_ENABLED`, `FAVICON_URL`, etc.) are surfaced as a read-only "Deployment" section on `/admin/config`. This gives admins the vocabulary to communicate with their deployer ("My PWA is disabled, can you enable it?") without exposing infrastructure topology or API keys.

---

## Example: Childcare Instance

### Config keys:
```sql
INSERT INTO metadata.instance_config_groups (group_key, display_name, icon, sort_order) VALUES
('org',    'Organization', 'business', 10),
('system', 'System',       'settings', 20);

INSERT INTO metadata.instance_config (config_key, config_value, config_type, display_name, group_key, sort_order, is_public) VALUES
('agency_name',     NULL,               'string', 'Organization Name',  'org',    10, true),
('agency_phone',    NULL,               'string', 'Main Phone Number',  'org',    20, true),
('agency_email',    NULL,               'string', 'Contact Email',      'org',    30, true),
('default_timezone','America/New_York', 'string', 'Default Timezone',   'system', 10, false);
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

### `v0-78-0-instance-config` (revised)
- `metadata.instance_config_groups` + `metadata.instance_config` tables (with `is_public`, `updated_at` + trigger, `config_type` CHECK)
- `public.instance_config` VIEW (joins groups, `security_invoker = true`)
- `set_instance_config()` and `get_config()` RPCs (no seed RPC)
- GRANTs, RLS (anonymous reads public rows, authenticated reads all, `metadata.instance_config:update` writes `config_value`), permission row mapped to `admin`
- Framework groups and the 10 Tier 2 keys with NULL values
- Re-create the `schema_cache_versions` VIEW with an `instance_config` branch
- No `create_schema_decision()` call: framework migrations do not log ADRs

### `v0-78-0-instance-config-translations`
- es and ar strings for the `/admin/config` page and its sidebar link

Seeding is not a migration: `docker/migrations/seed-instance-config.sh` runs after each deploy and fills only NULL values.

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
