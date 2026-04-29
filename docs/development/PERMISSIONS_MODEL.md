/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

# Civic OS Permissions Model

This document describes the three-layer access control architecture used throughout Civic OS. Every feature that involves data access — from CRUD pages to guided forms to admin tools — must follow these principles.

## The Three Layers

Civic OS uses three independent layers of access control. Each serves a distinct purpose.

### Layer 1: Database GRANTs (Table Access)

PostgreSQL `GRANT` statements control which database roles can access tables at all. Civic OS uses two database roles:

| Role | Purpose | Typical Grants |
|------|---------|---------------|
| `web_anon` | Unauthenticated users | `SELECT` on public data (entities, properties, statuses) |
| `authenticated` | Logged-in users | `SELECT, INSERT, UPDATE, DELETE` on application tables |

GRANTs are binary: either the role can access the table or it can't. They don't distinguish between individual users or their application-level roles.

### Layer 2: RBAC (Blanket Access for Roles)

RBAC permissions are stored in `metadata.permissions` and `metadata.permission_roles`. The `has_permission(table, operation)` function checks whether the current user's JWT roles have been granted a specific permission.

**Key principle: RBAC is always blanket access.** Granting a permission to a role means everyone with that role gets that access to ALL rows, not specific rows. RBAC answers the question: "Does this role have this type of access to this table?"

| Permission | Meaning | Typical Roles |
|------------|---------|---------------|
| `read` | **Blanket SELECT.** Can see ALL rows in the table. Used in RLS as `has_permission(table, 'read')` for SELECT policies. | `user`, `editor`, `manager`, `admin` |
| `create` | **Blanket INSERT.** Can create new records. Frontend shows "Create" button. | `user`, `editor`, `manager`, `admin` |
| `update` | **Blanket UPDATE.** Can edit ANY row. Also bypasses lock triggers. | `editor`, `manager`, `admin` |
| `delete` | **Blanket DELETE.** Can delete ANY row. | `admin` |

**Users without RBAC permissions are not locked out.** Ownership RLS policies (Layer 3) give users control over records they created — they can see, edit, and delete their own records without any RBAC grants beyond what's needed for the frontend to render.

**Sidebar visibility** is controlled independently by `metadata.entities.show_in_sidebar`, not by `read` permission.

### Layer 3: RLS (Row-Level Security)

PostgreSQL Row Level Security policies control which specific rows each user can access. Civic OS uses two tiers of RLS policies:

**Tier 1: Ownership policies** — Give users control over records they created:
```sql
-- User can see their own records
CREATE POLICY owner_select FOR SELECT USING (created_by = current_user_id());
-- User can edit their own records
CREATE POLICY owner_update FOR UPDATE USING (created_by = current_user_id());
-- User can delete their own records
CREATE POLICY owner_delete FOR DELETE USING (created_by = current_user_id());
```

**Tier 2: RBAC policies** — Give elevated roles blanket access to all rows:
```sql
-- Users with 'read' permission can see all rows
CREATE POLICY rbac_select FOR SELECT USING (has_permission(table, 'read'));
-- Users with 'update' permission can edit all rows
CREATE POLICY rbac_update FOR UPDATE USING (has_permission(table, 'update'));
-- Users with 'delete' permission can delete all rows
CREATE POLICY rbac_delete FOR DELETE USING (has_permission(table, 'delete'));
```

PostgreSQL ORs all permissive policies of the same command type. So a user who owns a record AND has `read` permission gets SELECT access through both paths — either is sufficient.

## How the Layers Work Together

### Example: Building Use Request (Guided Form)

**GRANTs:**
```sql
GRANT ALL ON building_use_requests TO authenticated;
```

**RBAC:**
```
user role:  read, create
admin role: read, create, update, delete
```

**RLS:**
```
gf_owner_select:  created_by = current_user_id()     -- see own
gf_owner_update:  created_by = current_user_id()     -- edit own
gf_owner_delete:  created_by = current_user_id()     -- delete own
gf_insert:        true                                -- anyone can start
gf_rbac_select:   has_permission(table, 'read')      -- blanket browse
gf_rbac_update:   has_permission(table, 'update')    -- blanket edit
gf_rbac_delete:   has_permission(table, 'delete')    -- blanket delete
```

**Result for each role:**

| User Action | `user` role | `admin` role |
|-------------|-------------|--------------|
| See entity in sidebar | Yes (`show_in_sidebar`) | Yes (`show_in_sidebar`) |
| See list page data table | Yes (always renders) | Yes (always renders) |
| Which rows visible | All (RBAC SELECT via `read`) | All (RBAC SELECT via `read`) |
| Create new record | Yes (`create` + INSERT policy) | Yes |
| Edit own record | Yes (ownership UPDATE) | Yes |
| Edit others' records | No | Yes (RBAC UPDATE via `update`) |
| Delete own record | Yes (ownership DELETE) | Yes |
| Delete others' records | No | Yes (RBAC DELETE via `delete`) |
| Bypass lock triggers | No | Yes (`update` permission) |

### Example: Private Guided Form (No `read` for Users)

For guided forms where users should only see their own records, simply omit `read` from the user role:

**RBAC:**
```
user role:  create
admin role: read, create, update, delete
```

**Result:** Users can start new forms (`create`) and see/edit their own records (ownership RLS), but they cannot browse other users' records. Admins see everything via `read`.

### Example: Public Entity (No Ownership)

For entities without ownership restrictions (e.g., a public issues table):

**RBAC:**
```
user role:  read
editor role: read, create, update
admin role: read, create, update, delete
```

No RLS needed — all authenticated users see all rows (via database GRANTs). RBAC controls which operations the frontend enables.

## Common Patterns

### "Read Own Only" (Private Data, No Browse)

Users see only their own records. Managers/admins see all.

```
user:    create               → creates new, sees/edits own via ownership RLS
manager: read, create, update → sees ALL rows, edits any
admin:   read, create, update, delete → full access
```

RLS: ownership policies (Tier 1) + RBAC per-operation policies (Tier 2).

### "Read All, Edit Own" (Semi-Public Data)

All users can browse all records, but only edit their own.

```
user:    read, create          → sees all rows (via blanket read RLS), edits own
manager: read, create, update  → sees all, edits any
```

RLS: ownership UPDATE/DELETE + blanket SELECT using `read`, blanket UPDATE using `update`.

### "Fully Public" (Open Data)

All authenticated users have full read access. Editing restricted by role.

```
user:    read
editor:  read, create, update
admin:   read, create, update, delete
```

No RLS needed. Database GRANTs + RBAC frontend checks are sufficient.

## Anti-Patterns

### Don't use `is_admin()` as a RLS bypass on public tables

Admin can intentionally revoke permissions to prevent accidental modifications. Using `is_admin()` bypasses that intention. Instead, use per-operation `has_permission()` checks so that admins can fine-tune their own access.

**Exception:** `is_admin()` is acceptable on `metadata.*` tables (framework-level data that admins should always access).

### Don't grant `update` to general users for ownership scenarios

If users should only edit their own records, don't grant `update` to the `user` role. The `update` permission means "can edit ANY row" — it's blanket access for managers/admins. Instead, let ownership RLS handle user self-service.

### Don't confuse sidebar visibility with RBAC permissions

Sidebar visibility is controlled by `metadata.entities.show_in_sidebar`. RBAC permissions control data access, not navigation. A table can be visible in the sidebar without granting any RBAC permissions (users would see only their own records via ownership RLS).

## Implementation Details

### `has_permission()` Function

Extracts roles from the JWT token and checks against `metadata.permission_roles`:

```sql
-- Returns TRUE if any of the user's roles has the specified permission
SELECT has_permission('building_use_requests', 'update');
```

### `current_user_id()` Function

Extracts the user's UUID from the JWT token for ownership checks:

```sql
-- Returns the UUID of the current authenticated user
SELECT current_user_id();
```

### SECURITY DEFINER vs INVOKER

- **SECURITY INVOKER** (default): Function runs with the caller's permissions. RLS applies naturally. Use for all operational functions.
- **SECURITY DEFINER**: Function runs with the owner's permissions, bypassing RLS. Use ONLY for DDL operations (creating RLS policies, triggers, altering tables).

### Guided Form Auto-RLS

`register_guided_form()` and `add_guided_form_step()` auto-create ownership + RBAC RLS policies on parent and child tables when `ownership_column` is set.

**Parent table policies** (created by `register_guided_form()`):
- **Tier 1 — Ownership**: `gf_owner_select`, `gf_owner_update`, `gf_owner_delete` use `ownership_column = current_user_id()`. `gf_insert` allows any authenticated user to start a new form.
- **Tier 2 — RBAC**: `gf_rbac_select`, `gf_rbac_update`, `gf_rbac_delete` use `has_permission(parent_table, 'read'/'update'/'delete')` for blanket role-based access.

**Child step table policies** (created by `add_guided_form_step()`):
- **Tier 1 — Ownership delegation**: `gf_child_select`, `gf_child_insert`, `gf_child_update`, `gf_child_delete` delegate ownership checks to the parent table via an `EXISTS` subquery on the parent FK.
- **Tier 2 — RBAC inheritance**: `gf_child_rbac_select`, `gf_child_rbac_insert`, `gf_child_rbac_update`, `gf_child_rbac_delete` check the **parent table's** permission entries (not the step table's). This means you only need to assign RBAC permissions on the parent entity.

**Key design principle**: Step tables do NOT have their own permission entries in `metadata.permissions`. They inherit all access control from the parent. This simplifies permission management — integrators only configure RBAC on the parent table via `grant_guided_form_permissions()` or the Permissions UI.

See `docs/notes/GUIDED_FORM_SYSTEM_DESIGN.md` for the complete policy matrix.

### Frontend Data Rendering

The list and detail pages always render data tables for authenticated users. They do **not** gate on `entity.select` (`has_permission(table, 'read')`). RLS alone determines which rows appear:

- User with `read` → sees all rows (blanket SELECT)
- User without `read` but with ownership → sees own rows only
- User without `read` and no ownership → empty table
- Unauthenticated user → "Sign in to view data" prompt

## Related Documentation

- `docs/AUTHENTICATION.md` — Keycloak setup, role configuration, JWT structure
- `docs/notes/GUIDED_FORM_SYSTEM_DESIGN.md` — Guided form RLS policy details
- `docs/INTEGRATOR_GUIDE.md` — Configuring permissions for new entities
