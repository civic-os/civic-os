-- ============================================================================
-- STAFF PORTAL - SCHEMA DECISIONS (ADRs)
-- ============================================================================
-- Documents decisions where the "why" isn't obvious from reading the code.
-- If a future developer would look at the schema and think "that's weird,
-- why didn't they just..." — that's what belongs here.
--
-- Standard patterns (circular FKs, denormalized fields, SECURITY DEFINER
-- for RLS) are documented in code comments, not here.
--
-- Note: Uses direct INSERT (not create_schema_decision RPC) because init
-- scripts run without JWT context.
--
-- Requires: Civic OS v0.30.0+ (Schema Decisions system)
-- ============================================================================

BEGIN;

-- ============================================================================
-- ADR 1: Clock-in/out as individual entries, not paired records
-- ============================================================================
-- A developer seeing time_entries will wonder: "Why isn't there a timesheet
-- with start/end columns? Why are consecutive clock_ins allowed?"

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['time_entries', 'staff_members']::NAME[], ARRAY['entry_type', 'entry_time']::NAME[], 'staff-portal-01-schema',
    'Clock-in/out as individual entries without pairing or validation',
    'accepted',
    'Time tracking for a 3-month summer program with temporary staff. Options considered: (a) paired start/end records, (b) individual timestamped entries, (c) daily timesheet rows.',
    'Each clock action creates an individual time_entry record with entry_type (clock_in/clock_out) and entry_time. Consecutive same-type entries are intentionally allowed — no validation prevents two clock_ins without a clock_out.',
    'Paired records require tracking "open" sessions and handling forgotten clock-outs, mid-day breaks, and corrections — too complex for temporary staff. Individual entries are simpler to audit and correct: site leads review the raw log and add manual corrections with edit_reason. Hours calculation is deferred to reporting/export (pair sequential entries by staff_member ordered by entry_time) rather than enforced at the data layer.',
    'Consecutive same-type entries appear in reports as anomalies for lead review rather than being blocked at entry time. This is a deliberate tradeoff: permissive entry + post-hoc review over strict validation that blocks legitimate edge cases (phone dies, forgot to clock out yesterday).',
    '2026-02-27'
);

-- ============================================================================
-- ADR 2: Onboarding as a trigger-maintained aggregate + auto-created documents
-- ============================================================================
-- Two related decisions that together create the "onboarding checklist" pattern.
-- A developer will wonder: "Why can't I create staff_documents manually? Why is
-- onboarding_status_id hidden from forms?"

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['staff_members', 'staff_documents', 'document_requirements']::NAME[], ARRAY['onboarding_status_id', 'status_id', 'applies_to_roles']::NAME[], 'staff-portal-01-schema',
    'Auto-created document checklists with trigger-maintained aggregate status',
    'accepted',
    'HR needs each new hire to have a role-specific document checklist (I-9, W-4, background check, etc.) that automatically appears when they''re added to the system. Administrators need at-a-glance onboarding progress without manually counting document statuses.',
    'Two triggers work together: (1) trg_auto_create_staff_documents fires on staff_member INSERT and creates a staff_document row per applicable requirement (matched by applies_to_roles TEXT[]). (2) trg_update_onboarding_status fires on staff_document changes and recalculates staff_members.onboarding_status_id as Not Started / Partial / All Approved based on approved document count. Both staff_documents.show_on_create and onboarding_status_id.show_on_edit are false — the system manages these, not users.',
    'A stored aggregate on staff_members (vs. a GROUP BY view) enables filtering on the List page — "show all Not Started" to identify staff needing attention. The List filter UI operates on direct table columns, not computed views. Only documents where requires_approval=true count toward the aggregate; receipt-only documents (Direct Deposit, Handbook) are excluded.',
    'Document requirements must exist BEFORE staff members are created (the trigger reads requirements at insertion time). Adding new requirements mid-program does NOT retroactively create staff_document rows — the trigger only fires on staff_member INSERT. A backfill INSERT would be needed. UNIQUE(staff_member_id, requirement_id) prevents duplicates.',
    '2026-02-27'
);

-- ============================================================================
-- ADR 3: Status guard that silently drops direct status changes
-- ============================================================================
-- A developer will notice that PATCHing status_id on staff_documents succeeds
-- (200 OK) but the value doesn't change. This ADR explains why.

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['staff_documents']::NAME[], ARRAY['status_id', 'file']::NAME[], 'staff-portal-01-schema',
    'Silent status guard with auto-submit on file upload',
    'accepted',
    'Staff upload files to document records (setting the file column), which should auto-advance status to Submitted. But staff should NOT be able to PATCH status_id directly to Approved — only SECURITY DEFINER RPCs should change approval statuses. Two triggers were initially planned but PostgreSQL fires BEFORE triggers in alphabetical name order, making separate triggers fragile.',
    'A single BEFORE UPDATE trigger handles both concerns: (a) if current_user = ''authenticated'' and status_id changed, silently reset to old value; (b) if file changed and status is Pending/Needs Revision, set status to Submitted. Step (a) runs first, so PATCH {file: X, status_id: Approved} → guard resets status → auto-submit sets Submitted.',
    'The key insight: PostgreSQL''s current_user is ''authenticated'' for PostgREST API calls but the function owner (''postgres'') inside SECURITY DEFINER RPCs. This reliably separates "user tried to change status" from "RPC changed status programmatically" without column-level grants (which don''t integrate with Civic OS RBAC). The guard is deliberately silent (200 OK, value unchanged) rather than returning 403 — a rejection would prevent the file upload in the same PATCH from proceeding.',
    'The guard is invisible to users — status changes via PATCH are silently dropped while all other column updates succeed. This means debugging requires knowing this ADR exists. RPC functions bypass the guard because they execute as postgres.',
    '2026-02-27'
);

-- ============================================================================
-- ADR 4: Self-approval prevention with NULL bypass for pure admins
-- ============================================================================
-- A developer will ask: "Why does testadmin (no staff record) bypass the
-- self-approval check but testmanager (has staff record) cannot?"

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['time_off_requests', 'staff_documents', 'reimbursements']::NAME[], ARRAY['staff_member_id']::NAME[], 'staff-portal-01-schema',
    'Self-approval prevention with IS NOT NULL guard for pure admins',
    'accepted',
    'Staff with manager or editor roles could approve their own requests — a segregation-of-duties violation. But system administrators (who have no staff_member record) must be able to approve anything.',
    'Each approval/denial RPC checks get_current_staff_member_id() against the record''s staff_member_id. Match → rejection with explanatory message. The IS NOT NULL guard ensures that when get_current_staff_member_id() returns NULL (pure admin, no staff record), the check is skipped entirely.',
    'The check is at the RPC level, not RLS, because a manager should SEE their own reimbursement but not APPROVE it — RLS controls visibility, RPCs control actions. The action button remains visible (entity_action_roles allows the role) but execution is blocked with a clear error message. Hiding the button would confuse users who know they have the role. Six RPCs implement this: approve/deny for time_off, documents, and reimbursements.',
    'A pure admin account (no staff_member record) can approve anything, including their own hypothetical requests if they were somehow linked. This is acceptable because pure admins are system administrators, not program participants. If an admin needs to also be a staff member, they should use a separate admin account for approvals.',
    '2026-02-27'
);

-- ============================================================================
-- ADR 5: Keycloak "editor" role repurposed as site lead
-- ============================================================================
-- A developer will look at the permissions page and ask: "Why does 'editor'
-- mean 'site lead'? Where IS the site_lead role?"

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['sites', 'staff_members']::NAME[], ARRAY['lead_id']::NAME[], 'staff-portal-02-permissions',
    'Editor role repurposed as site lead for dev example simplicity',
    'accepted',
    'The portal needs a "site lead" role. Creating a custom Keycloak role would require either modifying the shared dev realm (affecting all examples) or running a separate realm (operational overhead for an example).',
    'Reuse the existing editor role. Permission mappings reference ''editor''. The actual site lead authority is data-driven (sites.lead_id), not role-driven — the editor role just gates which features are visible.',
    'This is a pragmatic shortcut for the dev example. A production deployment (instances/ffsc/) would use a custom Keycloak realm with a proper site_lead role. The separation of role (feature access) from data (site assignment) is actually more flexible: a manager can also be a site lead without needing a combined role.',
    'The Permissions page shows "editor" where users expect "Site Lead." The role description is updated but display_name stays ''editor'' to match the JWT claim.',
    '2026-02-27'
);

COMMIT;
