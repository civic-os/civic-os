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

**Readonly "System" section** (from `window.civicOsConfig` / runtime env vars): Displays Docker-injected runtime configuration values as read-only fields, giving admin users visibility into infrastructure settings they cannot change themselves. Each value shows its env var name (e.g., `APP_TITLE`, `DEFAULT_THEME`) alongside the current runtime value.

Values surfaced in the System section:

| Display Name | Source | Value |
|---|---|---|
| Application Title | `APP_TITLE` | `getAppTitle()` |
| Default Theme | `DEFAULT_THEME` | `getThemeConfig().defaultTheme` |
| Default Locale | `DEFAULT_LOCALE` | `getLocaleConfig().defaultLocale` |
| Supported Languages | `SUPPORTED_LOCALES` | `getLocaleConfig().supportedLocales` |
| PWA Enabled | `PWA_ENABLED` | `getPwaConfig().enabled` |
| SMS Configured | `SMS_CONFIGURED` | `getSmsConfig().configured` |
| Analytics Enabled | `MATOMO_ENABLED` | `getMatomoConfig().enabled` |

Security-sensitive values (`postgrestUrl`, `keycloak`, `s3`, `stripe`) are **not** displayed — they expose infrastructure topology and API keys that don't help with support calls and could aid attackers.

**Support use case**: An admin can say "My Application Title is set to 'Test' — can you update it?" instead of needing to SSH into the server or understand Docker env vars. The System section provides the vocabulary for admin-to-deployer communication.

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

### Runtime Config as Readonly System Section
Docker env vars control infrastructure (PostgREST URL, Keycloak realm, S3 bucket) and a few application-level settings that can't be changed at runtime (app title, default theme, PWA toggle). The config page surfaces the safe, application-relevant subset as a readonly accordion section. This gives admins the vocabulary to communicate with their deployer without exposing infrastructure topology or API keys. Security-sensitive values (URLs, keys, secrets) are excluded.

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
- `metadata.instance_config_groups` + `metadata.instance_config` tables
- `public.instance_config` VIEW (joins groups, `security_invoker = true`)
- `set_instance_config()`, `get_config()` RPCs
- GRANTs, RLS, permission rows, schema cache version

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
