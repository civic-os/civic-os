# User Profile Extension System — Design Notes

> Added in v0.65.0, refactored in v0.65.2

## Problem

Civic OS users are limited to built-in `civic_os_users` fields (name, email, phone) synced from Keycloak. Real-world instances need richer profiles — a toolshed app needs "borrower" info, a volunteer platform needs skills/availability. These are app-level 1:1 extensions of the user entity with no framework coupling today.

## Solution

A metadata-driven system that lets integrators register any table as a "user profile extension", then surfaces those extensions in a self-service profile page with an optional completion guard.

### Architecture (v0.65.2+)

```
metadata.user_profile_extensions (config table)
    │
    ├── public.user_profile_extensions VIEW (i18n, computed FK constraint)
    │   ├── ProfileService.fetchExtensionMetadata()
    │   └── schema_cache_versions → VersionService cache invalidation
    │
    ├── PostgREST resource embedding (has_record check)
    │   ├── Profile Page (loads config + record status via single query)
    │   └── Profile Completion Guard (checks required + has_record)
    │
    └── update_own_profile() RPC
        └── Profile Page (self-service name/phone editing)
```

### Extension Table Convention

Extension tables MUST have:
1. A `UUID` FK column referencing `metadata.civic_os_users(id)`
2. A `UNIQUE` constraint on that FK column (enforcing 0-or-1 per user)

The `user_fk_column` in the config table tells the framework which column is the FK. The `user_fk_constraint` (computed by the VIEW as `{table_name}_{user_fk_column}_fkey` by default) provides the PostgREST embedding hint for disambiguation.

### Key Decisions

**Why VIEW + PostgREST embedding instead of RPCs? (v0.65.2)** — The original v0.65.0 RPCs (`get_user_profile_extensions`, `get_user_profile_extensions_admin`) mixed metadata with data queries and used SECURITY DEFINER, bypassing RLS for `has_record` checks. The v0.65.2 refactor separates concerns: metadata from a VIEW (cacheable, translatable), existence checks via PostgREST resource embedding (RLS-enforced). This follows the standard Civic OS pattern where metadata flows through VIEWs and data flows through PostgREST.

**Why computed FK constraint name?** — PostgREST resource embedding needs a constraint name to disambiguate when a table has multiple FKs to the same parent (e.g., `user_id` + `created_by` both referencing `civic_os_users`). The VIEW computes `COALESCE(user_fk_constraint, table_name || '_' || user_fk_column || '_fkey')` — convention-based default with explicit override for non-standard names.

**Why i18n via `metadata.t()` in the VIEW?** — Extension display names and descriptions are now translatable without requiring integrators to add translation entries manually. The VIEW wraps both fields with `metadata.t()` using the `entity` source type, consistent with how entity display names are translated elsewhere.

**Why `SECURITY DEFINER` for `update_own_profile()`?** — Users need to update both `metadata.civic_os_users` (public) and `metadata.civic_os_users_private` (private) tables. Rather than granting direct UPDATE on these tables (which would require complex RLS), the SECURITY DEFINER function validates identity via `current_user_id()` and only modifies the calling user's own records.

**Why signal-based caching in ProfileService?** — The profile completion guard runs on every navigation. Without caching, this would fire API calls per route change. A 60-second TTL cache in a signal balances freshness with performance. Cache is invalidated explicitly when users create/edit extension records, or when `schema_cache_versions` detects a `profile_extensions` version bump.

**Why `canActivateChild` wrapper route?** — Adding `profileCompletionGuard` to every individual route would be error-prone and noisy. A single wrapper parent route with `canActivateChild` protects all child routes. The `/profile` route sits outside the wrapper to prevent redirect loops.

**Why fail-open on guard errors?** — If the API fails (network error, PostgREST down), blocking navigation would lock users out entirely. Since security enforcement happens at the RLS layer (not the UI guard), failing open is the safe default.

### Security Model

- **Config table**: `SELECT` for all (needed for profile page + guard); `INSERT/UPDATE/DELETE` admin-only via RLS
- **Self-service RPC**: No permission check — `current_user_id()` from JWT ensures users only modify their own records
- **Extension data (has_record)**: PostgREST resource embedding respects per-table RLS — each extension table's policies determine visibility
- **Admin viewing other user**: Same `getProfileExtensions(userId)` call — RLS determines what the admin can see per extension table

### Files

| Purpose | File |
|---------|------|
| Migration v0.65.0 (deploy) | `postgres/migrations/deploy/v0-65-0-user-profile-extensions.sql` |
| Migration v0.65.2 (deploy) | `postgres/migrations/deploy/v0-65-2-profile-i18n-fixes.sql` |
| Migration v0.65.2 (revert) | `postgres/migrations/revert/v0-65-2-profile-i18n-fixes.sql` |
| Migration v0.65.2 (verify) | `postgres/migrations/verify/v0-65-2-profile-i18n-fixes.sql` |
| Frontend service | `src/app/services/profile.service.ts` |
| Profile page | `src/app/pages/profile/profile.page.ts` |
| Completion guard | `src/app/guards/profile-completion.guard.ts` |
| Cache versioning | `src/app/services/version.service.ts` |
| i18n keys | `src/app/i18n/en.translations.ts` (profile.\* namespace) |

### Rollback

- **Migration revert**: Restores v0.65.0 RPCs, drops `user_fk_constraint` column and `set_updated_at` trigger, restores pass-through VIEW, removes `profile_extensions` from `schema_cache_versions`, recreates dependent payment VIEWs (CASCADE).
- **Frontend**: Remove `profileCompletionGuard` from parent route wrapper, remove `/profile` route, remove menu item, delete new files.
- **No breaking changes** to existing behavior — feature is entirely opt-in.
