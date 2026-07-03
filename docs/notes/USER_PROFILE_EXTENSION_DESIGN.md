# User Profile Extension System — Design Notes

> Added in v0.65.0

## Problem

Civic OS users are limited to built-in `civic_os_users` fields (name, email, phone) synced from Keycloak. Real-world instances need richer profiles — a toolshed app needs "borrower" info, a volunteer platform needs skills/availability. These are app-level 1:1 extensions of the user entity with no framework coupling today.

## Solution

A metadata-driven system that lets integrators register any table as a "user profile extension", then surfaces those extensions in a self-service profile page with an optional completion guard.

### Architecture

```
metadata.user_profile_extensions (config table)
    │
    ├── get_user_profile_extensions() RPC
    │   ├── Profile Page (loads config + record status)
    │   └── Profile Completion Guard (checks required + has_record)
    │
    ├── get_user_profile_extensions_admin() RPC
    │   └── User Management Page (admin edit modal)
    │
    └── update_own_profile() RPC
        └── Profile Page (self-service name/phone editing)
```

### Extension Table Convention

Extension tables MUST have:
1. A `UUID` FK column referencing `metadata.civic_os_users(id)`
2. A `UNIQUE` constraint on that FK column (enforcing 0-or-1 per user)

This is documented convention, not schema-enforced. The `get_user_profile_extensions()` RPC discovers the FK column via `information_schema` at runtime.

### Key Decisions

**Why `information_schema` for FK discovery?** — Rather than requiring integrators to specify the FK column name in the config table, the RPC discovers it automatically. This reduces configuration burden and prevents misconfiguration. The performance cost is minimal since the RPC is called infrequently and cached on the frontend.

**Why `SECURITY DEFINER` for `update_own_profile()`?** — Users need to update both `metadata.civic_os_users` (public) and `metadata.civic_os_users_private` (private) tables. Rather than granting direct UPDATE on these tables (which would require complex RLS), the SECURITY DEFINER function validates identity via `current_user_id()` and only modifies the calling user's own records.

**Why signal-based caching in ProfileService?** — The profile completion guard runs on every navigation. Without caching, this would fire an RPC per route change. A 60-second TTL cache in a signal balances freshness with performance. Cache is invalidated explicitly when users create/edit extension records.

**Why `canActivateChild` wrapper route?** — Adding `profileCompletionGuard` to every individual route would be error-prone and noisy. A single wrapper parent route with `canActivateChild` protects all child routes. The `/profile` route sits outside the wrapper to prevent redirect loops.

**Why fail-open on guard errors?** — If the RPC fails (network error, PostgREST down), blocking navigation would lock users out entirely. Since security enforcement happens at the RLS layer (not the UI guard), failing open is the safe default.

### Security Model

- **Config table**: `SELECT` for all (needed for profile page + guard); `INSERT/UPDATE/DELETE` admin-only via RLS
- **Self-service RPC**: No permission check — `current_user_id()` from JWT ensures users only modify their own records
- **Admin RPC**: Gated by `has_permission('civic_os_users_private', 'update')` — same gate as existing user management
- **Extension table data**: Respects per-table RLS — each extension table has its own access policies

### Files

| Purpose | File |
|---------|------|
| Migration (deploy) | `postgres/migrations/deploy/v0-65-0-user-profile-extensions.sql` |
| Migration (revert) | `postgres/migrations/revert/v0-65-0-user-profile-extensions.sql` |
| Migration (verify) | `postgres/migrations/verify/v0-65-0-user-profile-extensions.sql` |
| Frontend service | `src/app/services/profile.service.ts` |
| Profile page | `src/app/pages/profile/profile.page.ts` |
| Completion guard | `src/app/guards/profile-completion.guard.ts` |
| i18n keys | `src/app/i18n/en.translations.ts` (profile.\* namespace) |

### Rollback

- **Migration revert**: Drops VIEW, RPCs, config table. No other objects depend on these.
- **Frontend**: Remove `profileCompletionGuard` from parent route wrapper, remove `/profile` route, remove menu item, delete new files.
- **No breaking changes** to existing behavior — feature is entirely opt-in.
