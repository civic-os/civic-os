# Instance Design Schema Checklist

Scan this checklist during **schema SQL generation**, after UX design is approved. Each item represents a schema-level decision that, if missed, requires ALTER TABLE, new triggers, or RPC rework later.

Derived from post-design corrections to the Neighborhood Engagement Hub (NEH) instance.

---

## Framework Feature Selection

- [ ] For small lookup/enum values (5-20 rows, just name + color + sort): use `metadata.categories` instead of a custom table. — *Why: Custom tables require migration, permissions, FK indexes, display_name, and admin UI. Categories give all of this for free.*
- [ ] Decision boundary: If the lookup needs extra columns beyond name/color/sort (e.g., `total_quantity`, `is_qty_managed`), THEN a custom table is justified.

## Entity Architecture

- [ ] Does this entity use a guided form? → It needs TWO status columns: `guided_form_status_id` (framework-managed) + `status_id` or `workflow_status_id` (business workflow). — *Why: A single status_id served two masters — framework RPCs and staff workflow. Separation required ALTER TABLE, new column, trigger rewrites, and dashboard re-mapping.*
- [ ] Is there a fulfillment/checkout phase separate from the request phase? → Extract to a child entity with its own status lifecycle. — *Why: Checkout details (specific instances, photos, notes) were originally on the reservation. Extraction required CREATE TABLE, column migration, new triggers, and permissions — essentially building a second entity from scratch.*
- [ ] For item tracking: does the domain have both serialized units AND bulk quantities? → Use nullable `instance_id` (serial when set, qty-managed when NULL). — *Why: This schema choice is very hard to retrofit after data exists.*
- [ ] For M:M in guided forms: do junctions reference the STEP record (not the parent entity)? — *Why: Step-owned junctions enable step-level independence. Fixing this requires DROP + recreate junction tables.*

## Column Design

- [ ] Does every entity have a `display_name` column? — *Why: PostgREST errors crash FK references, list views, and breadcrumbs. Use a BEFORE INSERT/UPDATE trigger to auto-generate from content.*
- [ ] Are timeslot/required fields on guided form entities NULLABLE? — *Why: Guided forms create a draft row before the user fills fields. NOT NULL causes immediate failure on page load.*
- [ ] For nullable GF fields: is there a CHECK constraint with `is_guided_form_draft()` enforcement? — *Why: Nullable allows drafts, but without a CHECK, the field is never enforced — submitted forms can have NULL timeslots.*
- [ ] Do ALL FK columns have both a `REFERENCES` constraint AND a `CREATE INDEX`? — *Why: Missing REFERENCES breaks framework auto-detection (status badges, visibility_condition dot-notation, action button gating ALL silently fail). Missing INDEX causes full table scans on inverse relationship queries.*
- [ ] For status columns: does FK reference `metadata.statuses(id)`? — *Why: Without the FK constraint, schema_properties can't auto-detect the join. Status renders as raw integer. Dot-notation visibility_condition fails, hiding all action buttons.*
- [ ] For category columns: is `category_entity_type` set in `metadata.properties`? — *Why: Categories don't render as colored badges without this metadata link. Looks like a bug, confusing to debug.*
- [ ] For status columns: is `status_entity_type` set in `metadata.properties`? — *Why: Same as categories — status renders as raw integer without this annotation.*

## Triggers & Validation

- [ ] Is overlap/availability validation gated to the CORRECT status transition? — *Why: NEH's overlap trigger fired on both 'approved' AND 'checked_out' transitions. But confirm_checkout marks instances checked_out BEFORE updating reservation status → trigger sees 0 available → blocks confirm. Gate to approval only.*
- [ ] Does `on_submit_rpc` validate completeness? (e.g., ≥1 item selected, required M:M populated) — *Why: Without this, users submit empty forms. RAISE EXCEPTION rolls back the entire submission with a user-friendly error.*
- [ ] For triggers that fire on status change: enumerate ALL transitions that hit each status — are any of them side effects of other RPCs? — *Why: confirm_checkout updates multiple entities' statuses. If a trigger fires on one of those downstream transitions, it may see intermediate state and fail.*

## Scaling & Search

- [ ] For option sets >1K rows: use `options_filter_column` (computed server-side) instead of `options_source_rpc` (client pre-fetch). — *Why: Client pre-fetch of 42K parcel IDs exceeded URL length limits (HTTP 400). Computed columns filter at the database level before PostgREST exposes the query.*
- [ ] If using `options_source_rpc`: will it ever return >2K IDs? — *Why: PostgREST URL length limit. Manifests as HTTP 400 only at production scale — invisible in dev with small datasets.*
- [ ] For searchable tables: set both `fulltext_search_column` (tsvector) AND `substring_search_column` (for ILIKE). — *Why: FTS handles stemming/synonyms. Substring handles partial matches (phone numbers, GEOIDs). Frontend constructs hybrid OR query.*
- [ ] For large tables with substring search: add `pg_trgm` GIN index. — *Why: Without the index, ILIKE on 70K rows is a sequential scan.*

## Permissions & Access Control

### Table-Level Grants
- [ ] Does every new table have GRANT statements for the correct database roles? — *Why: Without GRANTs, PostgREST returns 401/403. No data is accessible regardless of RLS.*
  - Public tables: `GRANT SELECT ON table TO web_anon; GRANT ALL ON table TO authenticated;`
  - Sensitive tables: `GRANT ALL ON table TO authenticated;` (withhold from `web_anon`)
  - Sequences: `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;`
- [ ] For child/junction tables: do they inherit the same grant pattern as their parent? — *Why: Checkout items need the same authenticated access as checkouts. Easy to forget on extracted entities.*

### Row-Level Security
- [ ] Is `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` set on every table? — *Why: Without RLS enabled, authenticated users see ALL rows. GRANTs control table access; RLS controls row access.*
- [ ] Does every table have appropriate RLS policies (SELECT/INSERT/UPDATE/DELETE)? — *Why: RLS with no policies = no access for non-superusers. At minimum, need a SELECT policy.*
- [ ] For multi-tenant or ownership-scoped data: does the policy use `current_user_id()` or `has_permission()`? — *Why: These helpers extract identity from the JWT. Raw `current_user` gives you the PostgREST role name, not the application user.*

### RBAC Metadata
- [ ] For each entity: are `metadata.permissions` entries created (read, create, update, delete)? — *Why: Without permission entries, `has_permission()` checks always return false. Sidebar visibility and data rendering rely on these.*
- [ ] For each permission: are `metadata.permission_roles` mappings created for all relevant roles? — *Why: Permissions exist but aren't granted to any role = invisible entity. Map to at minimum the roles that correspond to your GRANTs.*
- [ ] For custom roles (beyond the standard user/editor/manager/admin): are they registered in `metadata.roles` with a `role_key`? — *Why: JWT role claims must match role_key values for `get_user_roles()` to find them.*

### Entity Actions & Functions
- [ ] For every Entity Action RPC: is there a matching `entity_action_roles` INSERT granting it to the correct roles? — *Why: Actions without role grants are invisible to ALL users. Looks like a bug, very hard to diagnose — the button simply doesn't appear.*
- [ ] For action param FK dropdowns: specify `options_source_rpc` + `depends_on_params` for cascading. — *Why: Without options_source_rpc, action params show raw numeric IDs. Without depends_on_params, staff sees ALL instances instead of only those filtered by the parent selection.*
- [ ] For RPCs that modify data across tables: is `SECURITY DEFINER` set with explicit `SET search_path`? — *Why: SECURITY INVOKER RPCs inherit the caller's permissions. If the RPC updates a table the caller can't directly access (e.g., updating instance status from a checkout RPC), it needs DEFINER.*
- [ ] For Entity Notes on entities with custom roles: are notes permissions granted beyond the defaults? — *Why: `enable_entity_notes()` only grants to standard editor/user roles. Custom roles (neh_staff) need explicit `permission_roles` INSERT.*
- [ ] For admin roles: is `role_can_manage` populated for role delegation? — *Why: Admin can't assign/revoke roles on the User Management page without delegation rights.*

## Entity Group Lifecycle

*When parent → child → item entities have coordinated lifecycles:*

- [ ] For entity groups with two-phase commit: child/item statuses only change at COMMIT time, never during cart-building (preparing phase). — *Why: Eager status changes (marking items 'checked_out' at add time) cause overlap triggers to see 0 available items and block confirm_checkout.*
- [ ] For entities with calendar + status: add `calendar_hex_color` column synced via BEFORE INSERT/UPDATE trigger to status color. — *Why: Staff needs at-a-glance visual state encoding on the calendar. Auto-sync ensures color stays current.*
- [ ] For items that pass through hands: insert system notes on each item during parent transitions ("Checked out to X — Reservation #Y"). — *Why: Individual item audit trail is needed for accountability. Knowing that a checkout happened isn't enough — you need to know which items were involved.*
- [ ] For date-based scheduling: use `timeslot tstzrange` instead of separate start/end columns. — *Why: tstzrange enables calendar integration, GIST exclusion constraints for overlap prevention, and range operators (`&&` for overlap, `@>` for containment) — none of which work with separate columns.*
- [ ] For display_name: design enrichment trigger that rebuilds name after items are confirmed. — *Why: Generic names ("John Smith - 2026-05-01") are useless in lists of 50 similar records. After approval/confirmation, rebuild with content ("John Smith — Chainsaw, Table x3").*

## Notification Data

- [ ] For notification triggers with lists of items: include BOTH denormalized string (`tools_summary`) AND structured JSON array (`tools`) in entity_data. — *Why: Simple templates use the string. Rich templates need to iterate the array for per-item formatting.*
