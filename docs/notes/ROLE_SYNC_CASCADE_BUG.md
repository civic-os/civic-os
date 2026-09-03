# Role Sync Cascade Bug

**Status**: Known issue, not yet fixed
**Severity**: High — causes permanent, silent role loss
**Discovered**: 2026-09 during v0.74.0 Playwright verification; confirmed to have occurred in production

## The Anti-Pattern

`refresh_current_user()` runs on every login and performs a **destructive bidirectional sync** between the JWT and the database:

1. **Phase 1** (additive): INSERT roles from JWT into `metadata.user_roles` — safe
2. **Phase 2** (destructive): DELETE roles from `metadata.user_roles` that are NOT in the JWT — **this is the bug**

The DELETE fires an AFTER DELETE trigger that enqueues a `revoke_keycloak_role` River job. The consolidated worker then removes the role from Keycloak via the admin API. On the next login, Keycloak issues a JWT without the role, which Phase 2 treats as confirmation to delete again — **the role is permanently lost**.

## Cascade Sequence

```
Keycloak JWT missing role (transient glitch, realm re-import, token cache)
  → refresh_current_user() Phase 2 DELETEs role from DB
    → AFTER DELETE trigger fires
      → River job: revoke_keycloak_role
        → Worker removes role from Keycloak
          → Next JWT definitely missing role
            → Permanent loss — no recovery path
```

## Root Cause

The sync treats Keycloak as the **sole source of truth** for roles, but also **writes back to Keycloak** on delete. This creates a feedback loop where a single transient absence (realm re-import, token caching, clock skew) becomes permanent.

## Affected Code

- `postgres/migrations/deploy/v0-31-0-user-management.sql` — `refresh_current_user()` function
- `services/consolidated-worker-go/workers/keycloak.go` — `revoke_keycloak_role` job handler
- Trigger: AFTER DELETE on `metadata.user_roles`

## Potential Fixes

1. **Remove the delete-side Keycloak sync entirely** — treat DB roles as additive only; Keycloak admin UI is the authority for role removal
2. **Add a `source` column** to `metadata.user_roles` (`keycloak` vs `admin`) — only delete `keycloak`-sourced roles during JWT sync; `admin`-sourced roles are immune
3. **Soft-delete with grace period** — mark roles as "pending removal" instead of deleting; only finalize after N logins still missing the role
4. **One-way sync** — JWT → DB is additive only; admin panel → Keycloak is the only removal path

Option 1 is the simplest and safest. The current behavior (DB deletes propagating to Keycloak) was never an explicit design goal — it's an emergent side effect of the trigger + worker pipeline.

## Workaround

If a user loses a role, manually re-assign it via Keycloak admin UI (`/admin/master/console/#/civic-os-dev/users/{user-id}/role-mapping`). The next login will re-sync it to the database.
