# Instance Design UX Checklist

Scan this checklist during **interface/user flow design**, before schema generation begins. Each item represents a design-time decision that, if missed, requires significant rework later.

Derived from post-design corrections to the Neighborhood Engagement Hub (NEH) instance.

---

## Framework Feature Usage

- [ ] For any small lookup/enum (5-20 values with name + color): should this use `metadata.categories` instead of a custom table? — *Why: Categories give colored badges, admin UI, and sort_order for free with zero custom SQL. Custom tables require migrations, permissions, FK indexes, display_name columns, and admin UI.*
- [ ] Decision boundary: Use Category when values are just label/color/sort. Use a custom table only when the lookup needs additional domain columns (e.g., `total_quantity`, `is_qty_managed`).

## Workflow & State Transitions

- [ ] For every user story that says "staff can [verb]": is there an Entity Action button defined? — *Why: NEH had user stories describing approve/deny/checkout actions but no Entity Actions in the design. Staff had no way to manage workflow without them.*
- [ ] For every status visible to users: is it the BUSINESS status (not the framework lifecycle status)? — *Why: Guided form entities have a framework-managed status (draft→submitted) that users shouldn't see. Only the business workflow status (pending→approved→checked_out) should appear in lists/detail.*
- [ ] For multi-step fulfillment (request → assign items → confirm): is there a two-phase UX (prepare cart → commit)? — *Why: Single atomic actions don't match physical workflows. Staff need to review items before committing.*
- [ ] Are action buttons ordered logically (sort_order: Add=10, Remove=20, Confirm=30)? — *Why: Default alphabetical ordering is confusing. Logical sequence matches workflow progression.*

## Form & Field Visibility

- [ ] For guided forms: which fields are borrower-visible vs. staff-only? — *Why: NEH exposed `notes` and `site_review_completed` (staff-internal fields) to borrowers filling out the form.*
- [ ] For each guided form step: is it skippable or required? — *Why: Work site selection was accidentally marked skippable when the business rule requires parcel selection.*
- [ ] For system-managed fields (submitted_at, display_name, form status): are they marked hidden from all views? — *Why: These clutter the UI and confuse users who can't edit them.*
- [ ] For each entity in the design: what's the human-readable display name? — *Why: Raw table names like `checkout_instances` render as navigation labels. Define labels up front ("Checked Out Tools").*
- [ ] For each FK column: what should the display label be? — *Why: `user_id` renders as "User Id" by default. Define human labels ("Account", "Applicant", "Assigned To").*

## Dropdowns & Selection UX

- [ ] For FK dropdowns with >1K options: is a search modal specified instead of native dropdown? — *Why: Native dropdowns become unusable with large option sets. FK Search Modal provides search, sort, filter, and pagination.*
- [ ] For action modal FK params: what filters scope the options? — *Why: "Remove Item" must only show items in THIS checkout. Without filters, staff sees every item in the system.*
- [ ] For cascading selections: which param depends on which? — *Why: "Add Item" tool instance dropdown must filter by selected tool type. Without `depends_on_params`, staff sees ALL instances across ALL types.*
- [ ] For negative filtering: who should be EXCLUDED from option lists? — *Why: Barred/rejected borrowers appeared in borrower dropdowns. RPCs need explicit exclusion logic.*
- [ ] For large option sets (>1K rows): is server-side computed filtering specified? — *Why: Client-side pre-fetch of all eligible IDs caused HTTP 400 (URL too long) with 42K parcels.*

## Photo & Media Timing

- [ ] For photo capture: does it happen at REQUEST time or FULFILLMENT time? — *Why: NEH originally put photo fields on the reservation. Photos belong at checkout/return time — in action params, not entity columns.*
- [ ] For related actions that capture media: should they be consolidated? — *Why: Separate "Report Damage" and "Mark Returned" buttons were consolidated into one "Mark Returned" action with optional damage notes + photos.*

## Sidebar & Navigation

- [ ] Which entities appear in the sidebar? — *Why: Child entities (checkout_instances), junction tables (project_parcels), and system tables clutter navigation. Only top-level domain entities belong in the sidebar.*
- [ ] Which entities are only accessed from a parent's detail page? — *Why: Checkout records are always accessed via the reservation detail. They don't need independent sidebar entries.*

## Entity Group Orchestration

*When entities form parent → child → item groups with coordinated lifecycles:*

- [ ] For actions that create child entities: does the design specify `navigate_to` response? — *Why: "Start Checkout" creates a checkout record. Without navigate_to, staff has to manually find it in the list.*
- [ ] For physical items that change hands (tools, equipment): is Entity Notes (`enable_entity_notes()`) specified for audit trail? — *Why: Custom note columns don't provide the system note + user note + timestamp + attribution structure that Entity Notes gives.*
- [ ] For calendar-enabled entities with status workflows: does the design specify visual state encoding? — *Why: Calendar events were monochrome. Staff couldn't distinguish approved vs pending at a glance. Calendar color should sync with status color.*
- [ ] Is `display_name` designed to evolve across the lifecycle? — *Why: "John Smith - 2026-05-01" is useless in a list of 50 reservations. After approval, rebuild as "John Smith — Chainsaw, Leaf Blower x2".*
- [ ] For date-based scheduling: should separate start/end date columns be a single `tstzrange timeslot`? — *Why: Separate columns don't integrate with calendar view or overlap validation. A timeslot gets both for free.*
- [ ] Is this form REALLY multi-step? Decision: multi-step when selecting MULTIPLE item types across different junction tables. Single-step when it's one entity + timeslot + basic fields. — *Why: Building use was over-engineered as multi-step when single-step + calendar sufficed.*

## Permissions & Role Visibility

- [ ] For each entity: what CRUD permissions exist and who gets them? (Think in terms of permissions, not roles — roles are just groups of permissions.) — *Why: If you don't specify the permission matrix during UX design, the schema generates with either over-permissive or under-permissive defaults.*
- [ ] For each Entity Action button: what permission gates it? — *Why: "Approve" needs a permission entry. The Permissions admin page then maps that to roles. Without the permission defined, `entity_action_roles` gets omitted.*
- [ ] For custom roles: what permissions does each role bundle? — *Why: NEH defined neh_staff and neh_admin but didn't map their permissions until Entity Notes and action buttons were invisible. Define the permission matrix, then assign permissions to roles.*

### Ownership & Access Scope (User Story → RLS Mapping)

- [ ] For each user story "As a [role], I can [verb] [entity]": what's the access scope? — *Why: "I can view my reservations" vs "I can view all reservations" requires fundamentally different RLS policies. Specify per-role scope explicitly.*
  - **Own records only**: User can only see/edit records they created or are assigned to (e.g., borrower sees only their reservations)
  - **Parent-chain ownership**: User can see/edit child records attached to their parent (e.g., borrower sees checkout items on their checkout)
  - **All records**: Staff/admin sees everything (typically guarded by role check, not ownership)
- [ ] For each entity: what column establishes ownership? (e.g., `user_id`, `borrower_id`, `created_by`) — *Why: This drives the RLS policy WHERE clause. If ownership isn't decided during UX design, schemas default to "all authenticated users see everything."*
- [ ] For child entities: does ownership inherit from the parent? — *Why: A borrower should see their checkout items, but checkout_items has no direct user_id — ownership flows through tool_reservation_checkouts → tool_reservations → borrowers → user_id. The RLS policy must JOIN through the parent chain.*
- [ ] For entities with both self-service and staff workflows: does the owner only have `create` + `read` permission, while the staff permission bundle includes `update`? — *Why: Without this distinction, borrowers could edit their own reservation status directly via the Edit page instead of going through the guided form + staff approval flow. Gate edit access via the permission, not the role.*

## Notifications & Dashboards

- [ ] For notification templates with item lists: do they need structured data (JSON array) alongside summary strings? — *Why: `tools_summary = "Chainsaw, Leaf Blower"` is fine for simple emails. Rich templates need `tools = [{name, qty}]` for iteration.*
- [ ] For dashboard widget filters: are they using `status_key` names (portable) or numeric IDs (fragile)? — *Why: Status IDs differ between environments. Dot-notation `status.status_key = 'approved'` is environment-portable.*
