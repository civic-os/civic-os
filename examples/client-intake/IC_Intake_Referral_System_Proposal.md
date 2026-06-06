# International Center of Greater Flint — Client Intake & Referral System

> **Status:** Ready for entity design
> **Source partner:** International Center of Greater Flint (ICGF), Flint, MI
> **Last updated:** May 2026

---

## Overview

The International Center of Greater Flint serves Flint's immigrant and refugee community by connecting individuals with essential services — ESL classes, employment, legal aid, housing, healthcare, and more. This system replaces manual intake and referral tracking with a structured four-step workflow: **Intake → Assessment → Referral → Follow-Up Survey**.

The system tracks client demographics, manages a directory of partner agencies with subject-matter tags, supports two referral types (Warm and Info), and collects follow-up survey data to measure referral effectiveness. Monthly reporting is delivered via database views that surface key metrics: referral volume, client contacts, top needs, partner utilization, and time-to-contact lag.

Built on Civic OS with multi-language UI support. All required platform features are built or in progress — no launch blockers remain.

---

## The Four-Step Workflow

**Step 1 — Intake:** Staff (or the client themselves via self-service) creates a client record with identity, contact, and demographic information. Service needs are tagged using a many-to-many checkbox relationship to service categories. Client status is set to "Intake Pending."

**Step 2 — Assessment:** Staff review the intake record, verify information, confirm service needs, and add notes for context. Staff transition the client to "Active" once assessment is complete. Post-intake editing is staff-only — clients cannot modify their records after submission.

**Step 3 — Referral:** Staff create a referral connecting the client to a partner agency. Referrals are typed as either **Warm** (a direct connection to a specific contact at the partner) or **Info** (information about the partner shared with the client for self-directed follow-up). The partner's tagged service categories help staff identify appropriate matches. On creation, an email is sent **To** the client and partner, **CC** the creating staff member.

**Step 4 — Follow-Up Survey:** After the referral is created, the system sends automated survey reminders at 3, 5, and 7 days until the client completes the survey. The survey uses dropdown fields for structured data collection and includes a text box for open feedback.

---

## User Stories

### IC Staff — Intake & Assessment

**New client walk-in.** Staff creates a new client record with name, contact info, and demographics, then checks the applicable service need tags (ESL, Employment, Legal, etc.) on the create form. Client status is automatically set to "Intake Pending." Staff adds an internal note: "Client speaks limited English, prefers Arabic."

**Client self-service intake.** A client accesses the intake form in their preferred language, enters their own information, and submits. The record is created with "Intake Pending" status. Staff later reviews the submission during assessment.

**Assessment review.** Staff opens an Intake Pending client, reviews demographics and tagged needs, adds context notes, and transitions the client to "Active." If information is incomplete, staff contacts the client and updates the record before activating.

**Returning client with new needs.** Staff searches for an existing Active client by name, adds a new service need tag and a note describing the new need. No new intake is needed.

**Deactivating a client.** Staff transitions a client who has moved away or is no longer engaged to "Inactive." The client's referral history is preserved for reporting.

### IC Staff — Referrals

**Warm referral.** Staff opens an Active client's record, creates a new referral, selects a partner agency (filtered to those offering relevant services), chooses "Warm" as the referral type, and selects the service categories this referral covers — all in a single create form. An email is sent to the client and the partner's contact, with the creating staff member CC'd.

**Info referral.** Staff creates a referral typed as "Info," selecting the partner and service categories. The client receives partner information (address, phone, website) to follow up independently. The email notification shares partner details with the client.

**Finding the right partner.** Staff needs to refer a client for Legal Aid. They browse the partner list filtered by the "Legal Aid" service tag, check the partner map to find one near the client's neighborhood, and review the partner's languages supported to ensure a match.

**Referral to partner offering multiple services.** Staff refers a client to a partner agency that provides both ESL and Employment services. The referral covers both service categories in a single record, avoiding duplicate referrals.

**Referral not completed.** A referral was made two weeks ago. The follow-up survey indicates the client was unable to make contact. Staff transitions the referral to "Not Completed" and adds outcome notes. Staff may create a new referral to an alternative partner.

### IC Staff — Follow-Up & Surveys

**Survey auto-send.** Three days after a referral is created, the system automatically sends a survey notification to the client (email and/or SMS). If no survey is completed, reminders are sent at 5 and 7 days.

**Reviewing survey results.** Staff opens a referral's detail page and sees the attached survey response: the client selected "Very Helpful" from the helpfulness dropdown, "1-2 Days" from the time-to-contact dropdown, selected "Enrolled in Services" as the outcome, and left a comment: "The ESL class schedule works with my shifts." Staff transitions the referral to "Completed."

**Survey indicates problem.** The survey response shows "Not Helpful" and "Unable to Make Contact." Staff follows up with the partner, adds notes, and may create a new referral or update the partner's capacity notes.

### IC Staff — Reporting

**Monthly referral report.** Staff navigates to the Monthly Referral Report view, which shows referral counts, types (Warm/Info), partners referred to, service categories, and completion rates for the current month. Staff exports to Excel for funder submission.

**Top 5 needs analysis.** Staff views the Top Needs Report, which aggregates client service need tags across the population. The top 5 service categories are displayed with client counts.

**Time lag report.** Staff views the Time Lag Report, which aggregates survey "days to contact" data broken down by referral type (Warm vs. Info) and partner. This measures referral effectiveness.

### Clients (Self-Service)

**Submit intake.** Client accesses the system in their preferred language, fills out the intake form with their information and service need checkboxes, and submits. They receive confirmation that their record was created.

**Check referral status.** Client logs in and sees a list of referrals made on their behalf — which partners they were referred to, the service categories, and the current status.

**Complete follow-up survey.** Client receives a survey notification 3 days after a referral. They select from dropdown menus for helpfulness and time-to-contact, select an outcome category, and optionally leave feedback in the text box.

### Edge Cases

**Duplicate client.** Staff searches before creating a new record and finds an existing client with the same name. They open the existing record instead of creating a duplicate. Full-text search on name, country, and language helps catch near-matches.

**Partner becomes inactive.** A partner agency closes or stops accepting referrals. Staff marks the partner as Inactive. The partner no longer appears in filtered lists for new referrals. Existing referrals to that partner are unaffected.

**Client referred to same partner twice.** Staff creates a second referral to the same partner for different services. Each referral is a distinct record with its own service categories, status, and survey.

**Survey never completed.** After the 3-day, 5-day, and 7-day reminders, the client still hasn't completed the survey. A scheduled job marks the survey as "Expired." Staff can follow up manually or close the referral based on other information.

---

## Core Entities

### Clients

Individual immigrant or refugee community members seeking services.

**Identity & Contact:** First name, last name, email, phone. Display name auto-generated from first + last name.

**Demographics:** Country of origin, primary language, preferred communication language, date of birth, gender (Category), date of arrival in the US, immigration status (Category), household size.

**Service Needs:** M:M junction to service categories — staff check applicable boxes during intake via inline multi-select on the create form. Context goes into Entity Notes.

**Status Workflow:** Intake Pending → Active ↔ Inactive.

**Ownership:** Clients have a `user_id` FK linking the record to their user account for self-service access (distinct from `created_by` which tracks who created the record). A BEFORE INSERT trigger auto-sets `user_id = current_user_id()` for self-service clients; staff-created records leave `user_id` NULL until the client creates an account.

**Privacy:** No anonymous access. PII (especially immigration status) protected by RLS using `user_id` ownership chain. Clients can only see their own record. Post-intake editing is staff-only — locked on creation.

**Entity Notes:** Staff-only (`ic_staff` + `admin`). Clients cannot view or create notes. Used for internal assessment context during intake review.

**Search:** Hybrid full-text + substring. FTS on first name, last name, country of origin, primary language (`search_vector` tsvector). Substring search on `display_name` via `pg_trgm` for partial name matching and duplicate detection during intake.

**Form:** Standard CreatePage (not Guided Form). Self-service intake or staff-created.

### Service Categories

The shared vocabulary across the system — tags that connect clients (needs), partners (expertise), and referrals (services covered). Seeded with 12 categories:

ESL / English Classes · Employment / Job Placement · Legal Aid / Immigration Legal · Housing Assistance · Healthcare / Medical · Translation / Interpretation · Transportation · Food / Nutrition · Education (non-ESL) · Financial Literacy / Benefits · Mental Health / Counseling · Childcare

Administrators can add, rename, or deactivate categories. Publicly readable.

### Partners

Organizations or individuals that provide services. Seeded initially from ICGF's partner directory at icgflint.org/services, filtered to actual service agencies. ICGF can update the partner list via the UI after launch.

**Fields:** Name, partner type (Organization / Individual — Category), contact name, email, phone, address, map location (GeoPoint), website, languages supported, capacity/availability notes, active/inactive status, description.

**Service Tags:** M:M junction to service categories — tags indicating which services a partner provides. These tags drive partner discovery when staff create referrals (via dependent/filtered options on the referral form).

**Map View:** Interactive map on the partner list page showing active partner locations.

**Public Access:** Publicly readable so clients can browse available resources.

### Referrals

The core operational record — connects one client to one partner for one or more services. The referral itself functions like a rich junction between client and partner, with additional fields for type, status, dates, and outcomes.

**Fields:** Client (FK, required), partner (FK, required), referral type (Category: Warm / Info), referral date (default today), referred by (auto-set to current user), service categories (M:M, filtered to selected partner's tags), outcome notes, completed date.

**Referral Types:**
- **Warm** — A direct connection between the client and a specific contact at the partner agency. Both client and partner are emailed.
- **Info** — Information about the partner shared with the client for self-directed follow-up. Client receives partner details via email.

**Email on Creation:** When a referral is created, an email is sent **To** the client (with referral details and partner contact info) and **To** the partner (with client details and the service categories), with the creating staff member **CC'd**. This requires a flexible email notification system that supports multiple recipients with different roles (To/CC) — see Enhancement #1.

**Status Workflow:** Referred → Completed / Not Completed.

**Needs-Based Partner Filtering:** The partner dropdown is filtered by the client's identified service needs via `get_partners_for_client_needs()` RPC (`options_source_rpc` on `referrals.partner_id`, `depends_on_columns: [client_id]`). When staff selects a client, only active partners whose service categories overlap with at least one of the client's tagged needs appear in the dropdown. If no client is selected yet, all active partners are shown. Service categories are then filtered to the intersection of client needs AND partner offerings via `get_referral_service_options()` with dual cascading (`depends_on_columns: [client_id, partner_id]`).

**Navigation:** After creating a referral, the user navigates to the client's detail page (showing the new referral in the inverse relationships section).

### Follow-Up Surveys

A separate entity attached to a specific referral. Auto-created when a referral is made. Captures structured self-reported data from the client via dropdown fields.

**Fields:**
- Referral (FK, required)
- Survey status (Status: Pending / Completed / Expired)
- Was the connection helpful? (Category dropdown: Very Helpful / Somewhat Helpful / Not Helpful / Could Not Make Contact)
- How long did it take to make contact? (Category dropdown: Same Day / 1-2 Days / 3-5 Days / More Than 5 Days / Unable to Make Contact)
- What was the outcome? (Category dropdown: Enrolled in Services / Received Information / Referred Elsewhere / No Action Taken / Other)
- Open feedback (TextLong — freeform text box)
- Completed date

**Automated Reminders:** A scheduled job (v0.22.0+) runs daily, checking for referrals that are 3, 5, or 7 days old with a survey still in "Pending" status. For each, a notification is sent to the client via email and/or SMS. After 7 days with no response, the survey is transitioned to "Expired."

---

## Impact Tracking & Reporting

### Dashboard

Staff-facing home page with operational visibility:

- **Quick Actions** — New Client Intake, New Referral, View All Clients, Partner Map.
- **Recent Clients** — 10 most recently registered clients with country of origin and status.
- **Open Referrals** — Referrals in "Referred" status sorted by date, showing client, partner, and referral type.
- **Pending Surveys** — Surveys in "Pending" status where a reminder is due or overdue.
- **Partner Map** — Interactive map of active partner locations.

### Monthly Reports (as Database Views)

Reports are implemented as PostgreSQL views registered as Virtual Entities (v0.28.0+), making them browsable in the UI with built-in filtering and Excel export. Each view aggregates data for the current month by default, with date filters available.

**Monthly Referral Summary** — Aggregates referrals by month: total referral count, breakdown by type (Warm/Info), breakdown by status (Referred/Completed/Not Completed), completion rate percentage.

**Client Contact Summary** — New clients registered per month, broken down by country of origin and primary language. Active vs. Intake Pending counts.

**Top Needs Report** — Aggregates client service need tags (from the M:M junction) across the active client population. Shows service category name, client count, and percentage of total. Sorted descending — top 5 needs are immediately visible.

**Partner Utilization Report** — Referrals grouped by partner, showing referral count, completion rate, and most common service categories. Identifies heavily vs. lightly used partners.

**Time Lag Report** — Aggregates survey "days to contact" responses. Breaks down by referral type (Warm vs. Info) and by partner. Calculates average time-to-contact for each dimension.

---

## Entity Actions

Staff use entity action buttons on Detail pages to manage status transitions. Each action is an RPC with `SECURITY DEFINER`, visibility controlled via dot-notation `status_key` conditions, and gated to `ic_staff` and `admin` roles via `entity_action_roles`.

### Client Actions

| Action | RPC | Transition | Visibility Condition | Sort |
|---|---|---|---|---|
| **Activate Client** | `activate_client` | Intake Pending → Active | `status_id.status_key = 'intake_pending'` | 10 |
| **Deactivate Client** | `deactivate_client` | Active → Inactive | `status_id.status_key = 'active'` | 20 |
| **Reactivate Client** | `reactivate_client` | Inactive → Active | `status_id.status_key = 'inactive'` | 10 |

### Referral Actions

| Action | RPC | Transition | Visibility Condition | Sort |
|---|---|---|---|---|
| **Mark Completed** | `complete_referral` | Referred → Completed | `status_id.status_key = 'referred'` | 10 |
| **Mark Not Completed** | `mark_referral_not_completed` | Referred → Not Completed | `status_id.status_key = 'referred'` | 20 |

**Mark Not Completed** includes an action parameter `outcome_notes` (TextLong, required) — staff must explain why the referral was unsuccessful. The RPC also auto-sets `completed_date = CURRENT_DATE`.

---

## Users & Access

### Roles

**`ic_staff`** (custom role) — Full CRUD on all entities. Can create/edit clients, partners, referrals, surveys. Can view all data, manage notes, and access dashboards and reports. Registered via `INSERT INTO metadata.roles`.

**`user`** (built-in role = client role) — Self-service. Can create their own intake record (with service need tags), view their own referrals via RLS, and complete surveys via RLS. Cannot edit their record after submission. Cannot see other clients' data. All authenticated clients automatically receive this role.

**`admin`** (built-in role) — Full access + permissions UI, user management, role delegation.

**Role Delegation:** Admin manages `ic_staff` via User Management page (`metadata.role_can_manage`).

**RLS Ownership Model:** The `user` role has minimal RBAC permissions (`clients:create`, `service_categories:read`, `partners:read`). All other data access is handled by RLS ownership chains using `clients.user_id = current_user_id()` — no broad `read` grants needed. This prevents clients from seeing each other's records while allowing full self-service access to their own data.

### Permissions Summary

| Entity | `ic_staff` | `user` (client) | `anonymous` |
|---|---|---|---|
| Service Categories | Full CRUD | Read | Read |
| Clients | Full CRUD + Notes | Create own (RLS reads own) | No access |
| Client Service Needs (M:M) | Full CRUD | Create with intake (RLS reads own) | No access |
| Partners | Full CRUD | Read | Read |
| Partner Service Categories (M:M) | Full CRUD | Read | Read |
| Referrals | Full CRUD | No RBAC (RLS reads own) | No access |
| Referral Service Categories (M:M) | Full CRUD | No access | No access |
| Follow-Up Surveys | Full CRUD | No RBAC (RLS reads + updates own) | No access |
| Entity Notes (clients) | Read + Create | No access | No access |
| Report Views | Read | No access | No access |

### Sidebar Visibility

| Entity | `show_in_sidebar` | Notes |
|---|---|---|
| Service Categories | TRUE (default) | Browse available services |
| Clients | TRUE (default) | Client list (staff) / own record (client via RLS) |
| Partners | TRUE (default) | Partner directory |
| Referrals | TRUE (default) | Referral list (staff) / own referrals (client via RLS) |
| Follow-Up Surveys | TRUE (explicit) | Survey list (staff) / own surveys (client via RLS) |
| M:M Junction Tables | FALSE (default) | Never shown in sidebar |
| Report Views | FALSE (explicit) | Linked from dashboard or direct URL |

---

## External Data

**Partner Directory Seed:** The initial partner list will be seeded from icgflint.org/services, filtered to actual service agencies. The current list includes ~40 entries, many of which are political offices and supporters rather than referral targets. Likely seed candidates include Legal Services of Eastern Michigan, Mott Community College, Michigan Works, Mass Transportation Authority, American Red Cross of Genesee County, and others. ICGF will maintain and update the partner list via the UI after launch.

**No external system integrations** beyond email/SMS notifications. All data originates within the system.

---

## Platform Features — Status

### Built ✅

| Feature | Used For |
|---|---|
| Status Type System (v0.15.0+) | Client intake workflow, referral lifecycle, survey status |
| Category System (v0.34.0+) | Gender, immigration status, partner type, referral type, survey dropdowns |
| Entity Notes (v0.16.0+) | Internal staff notes on client records |
| M:M Relationships (v1.0) | Client↔services, partner↔services, referral↔services. Auto-detected from composite-PK junction tables |
| Inline M:M on Create/Edit — `show_inline` (v0.46.0) | Service need checkboxes on client create form, service categories on referral create form. Buffered save via `SaveProgressComponent` |
| Filtered M:M Options — `options_source_rpc` (v0.44.0) | Referral service categories filtered to intersection of client needs and partner offerings via dual-cascade RPC |
| M:M Search Modal — `fk_search_modal` (v0.45.0+) | Available for partner list if it grows large — split-panel modal with search, sort, filter, pagination |
| Rich Junction M:M (v0.51.0+) | Available if referral-service junction needs extra columns (e.g., notes per service) in the future |
| Entity Action Parameters (v0.32.0+, multi-select) | Composite actions with checkbox inputs |
| Geography/Map | Partner location visualization |
| Dashboard Widgets | Filtered lists, nav buttons, map |
| Virtual Entities (v0.28.0+) | Report views as browsable/exportable entities |
| Import/Export | Excel reporting and CSV partner import |
| Row-Level Security | Client data protection |
| Full-Text Search | Client, partner, referral search |
| Scheduled Jobs (v0.22.0+) | Survey reminder automation |
| Notification System (v0.11.0+) | Survey reminders to clients |
| Multi-Language UI | Client-facing intake forms, surveys, and navigation |

### In Progress — Available for ICGF Launch

| Feature | Version | Description |
|---|---|---|
| **Flexible multi-recipient email — `metadata.send_email()`** | v0.59.0 | Send email with distinct To/CC recipients sourced from entity fields (client email, partner email, current user). Used for referral creation notifications. |

---

## Complexity Assessment vs. Mott Park

| Dimension | Mott Park (MPRA) | ICGF Intake & Referral |
|---|---|---|
| Domain tables | 3 (resources, reservation_requests, reservations) | 5 (clients, service_categories, partners, referrals, follow_up_surveys) |
| Junction tables (M:M) | 0 | 3 (client_service_needs, partner_service_categories, referral_service_categories) |
| Report views | 0 | 5 (monthly referrals, client contacts, top needs, partner utilization, time lag) |
| Distinct workflows | 1 (reservation request approval) | 3 (client intake, referral lifecycle, survey lifecycle) |
| Status entity types | 1 (reservation_request) | 3 (client, referral, survey) |
| Category groups | 0 | 7 (gender, immigration_status, partner_type, referral_type, helpfulness, time_to_contact, outcome) |
| External integrations | 0 | 1 (multi-recipient email via `metadata.send_email()` v0.59.0) |
| Platform features needed | 0 | 0 (all built or in progress) |
| Trigger chain depth | 2 (request approval → create reservation) | 2 (referral creation → create pending survey + send email) |
| Notification channels | 0 | 2 (email + SMS) |
| Scheduled jobs | 0 | 1 (survey reminder check + expiration) |

**Estimate: ~2.5–3x Mott Park.** The entity count is higher, there are three M:M relationships, five report views, three status workflows, seven category groups, and a scheduled job. All required platform features are built or in progress — no blockers remain.

**Biggest unknowns:**
- Partner directory cleanup effort — how many of the ~40 listed partners are actual service agencies, and how much contact info needs to be gathered
- Survey UX refinement — dropdown option labels may need adjustment after initial use
- Report view SQL complexity — five virtual entities with aggregate queries across M:M junctions

---

## Schema Design Decisions

**Individual-only client model.** Tracks individuals, not households. `household_size` integer captures family context for reporting without a separate household entity.

**Client needs as pure M:M.** Service needs are a simple junction (client ↔ service_categories), not a full entity with freeform fields. Fast checkbox intake on the create form via `show_inline=true` (v0.46.0); narrative context goes in Entity Notes. Clean aggregate reporting.

**Unified partner model.** Organizations and individuals share one table, distinguished by partner_type category. Contact info fields live directly on the partner record (can be separated into a contacts entity later if needed).

**Two referral types via category, not separate entities.** Warm and Info referrals share the same fields and workflow. A category field distinguishes them for filtering and reporting.

**Needs-based referral filtering.** The referral creation form uses a cascading filter chain driven by the client's identified service needs. When staff selects a client, the partner dropdown shows only active partners whose service categories overlap with at least one of the client's needs (`get_partners_for_client_needs()`). The service category checkboxes then show the intersection of the client's needs and the selected partner's offerings (`get_referral_service_options()` with `depends_on_columns = '{client_id, partner_id}'`). This prevents mismatched referrals and guides staff to the most relevant partner for each client.

**Simple referral lifecycle.** Three states (Referred → Completed / Not Completed). Survey data provides the real outcome signal.

**Survey as separate entity.** The follow-up survey has its own lifecycle, automated reminders, and client-facing edit access. Dropdown fields (Category type) for structured data collection; open text box for freeform feedback.

**Survey dropdowns as categories.** The three survey questions (helpfulness, time-to-contact, outcome) each use the Category system rather than freeform text. This ensures consistent data for aggregate reporting while keeping the survey fast to complete.

**Reports as virtual entities.** Monthly reports are PostgreSQL views registered via Virtual Entities (v0.28.0+). This gives them list pages with filtering and export for free, rather than requiring custom dashboard widgets or external reporting tools.

**Service categories as shared vocabulary.** One lookup table connects to clients (needs), partners (expertise), and referrals (services covered) via three M:M junctions. This is the reporting backbone of the entire system.

**`user_id` vs `created_by` — ownership vs audit.** The `created_by` column (DEFAULT `current_user_id()`) records who created the record (could be staff). The `user_id` column links the client to their own user account for RLS ownership. A BEFORE INSERT trigger auto-sets `user_id` for self-service clients; staff-created records have `user_id = NULL`. This separation lets staff create records on behalf of clients without polluting the ownership model.

**Standard CreatePage for intake.** Client intake uses the standard CreatePage, not Guided Forms. The intake form is a single-page submission with inline M:M checkboxes for service needs. Guided Forms add complexity (multi-step, auto-save, draft state) that isn't needed for a straightforward demographic intake.

**Custom `ic_staff` role, not built-in `editor`.** A custom role (`ic_staff`) is registered instead of reusing the built-in `editor` role. This enables instance-specific role delegation (`admin` manages `ic_staff`) and clearer semantics. Role delegation is configured via `metadata.role_can_manage`.

**Minimal RBAC for `user` role.** The `user` (client) role receives only `clients:create`, `service_categories:read`, and `partners:read` RBAC permissions. All other access (reading own referrals, updating own surveys) is handled by RLS ownership chains via `clients.user_id = current_user_id()`. This prevents over-permissioning — clients never accidentally see each other's data.

**Entity notes are staff-only.** The default `enable_entity_notes()` grants are overridden to remove `user` role access and grant only to `ic_staff` and `admin`. Notes contain internal assessment context not appropriate for client self-service.

**Needs-driven partner filtering via `options_source_rpc`.** The referral partner dropdown uses `get_partners_for_client_needs()` with `depends_on_columns = '{client_id}'`. When a client is selected, the partner list narrows to active partners whose service categories overlap with the client's tagged needs. If no client is selected, all active partners are shown as a fallback.

**Dual-cascade service category filtering.** The referral service categories M:M uses `get_referral_service_options()` with `depends_on_columns = '{client_id, partner_id}'` — a dual dependency that re-queries when *either* value changes. The RPC returns the intersection of what the client needs and what the partner offers, ensuring the referral only covers services that are both relevant to the client and available from the partner.

---

## Referral Email Notification — Implementation Note

The IC's core communication mechanism uses `metadata.send_email()` (v0.59.0) to send multi-recipient email when a referral is created. This is triggered by a property change trigger (v0.33.0+) on referral creation, calling an RPC that composes and sends the email.

**Recipients:**
- **To:** The client (email sourced from `clients.email` via `referrals.client_id`)
- **To:** The partner contact (email sourced from `partners.email` via `referrals.partner_id`)
- **CC:** The staff member who created the referral (email from `civic_os_users` via `referrals.referred_by`)

**Email content varies by referral type:**
- **Warm:** Client receives partner contact details (name, phone, email) for direct connection. Partner receives client name and the service categories covered.
- **Info:** Client receives partner information (address, phone, website) for self-directed follow-up. Partner notification may be optional for Info referrals.

**Implementation:** The `send_referral_notification()` RPC is triggered via `metadata.property_change_triggers` on referral creation (`partner_id` set). It queries client, partner, and staff details, aggregates service categories via `string_agg()`, and calls `metadata.send_email()` with the `referral_created` template. The email data payload includes:

```
{
  "client_name": "...",
  "partner_name": "...",
  "partner_contact": "...",
  "partner_email": "...",
  "partner_phone": "...",
  "partner_address": "...",
  "partner_website": "...",
  "staff_name": "...",
  "referral_type": "Warm|Info",
  "referral_date": "YYYY-MM-DD",
  "service_categories": "ESL, Employment, ..."
}
```

**Auto-Survey Creation:** An AFTER INSERT trigger on referrals (`create_survey_for_referral()`) automatically creates a pending `follow_up_surveys` row for each new referral. The survey lifecycle then runs independently.

**Survey Reminders:** A scheduled job (`run_survey_reminders`, daily at 8 AM ET) sends `survey_reminder` emails at days 3, 5, and 7 after referral creation. Surveys with no response after 7 days are auto-transitioned to "Expired" status.

---

## Multi-Language Support

The platform's multi-language UI ensures intake and survey accessibility. Form labels, validation messages, status names, category names (including survey dropdown options), and navigation render in the client's preferred language. Critical for self-service intake and survey completion.

Language selection is UI-level — the data model stores values in their original language. The multi-language feature translates system chrome, not user-entered data.

---

## Appendix A: Entity Relationship Diagram

```
┌─────────────────────┐       ┌──────────────────────┐
│  service_categories │       │   [categories]       │
│─────────────────────│       │  (gender,            │
│  id                 │       │   immigration_status, │
│  display_name       │       │   partner_type,      │
│  description        │       │   referral_type,     │
│  color              │       │   helpfulness,       │
│  active             │       │   time_to_contact,   │
└────────┬────────────┘       │   outcome)           │
         │                    └──────────────────────┘
    M:M  │  M:M   M:M               │
         │                           │ FK
┌────────┴────────────────────────────┴──────────────┐
│                    clients                          │
│────────────────────────────────────────────────────│
│  first_name, last_name (display_name generated)     │
│  email, phone                                       │
│  date_of_birth, gender_id → categories              │
│  country_of_origin, primary_language                │
│  preferred_comm_language, date_of_arrival            │
│  immigration_status_id → categories                 │
│  household_size                                     │
│  user_id → civic_os_users (self-service ownership)  │
│  status_id → statuses (Intake Pending/Active/Inactive)│
│  [notes enabled — staff-only]                       │
│  ◆ client_service_needs (M:M → service_categories)  │
└─────────────────────┬───────────────────────────────┘
                      │ FK
         ┌────────────┴─────────────┐
         │        referrals          │
         │──────────────────────────│
         │  client_id → clients      │
         │  partner_id → partners ───┼──┐
         │  referral_type_id → categories (Warm/Info) │
         │  referred_by (auto-set)   │  │
         │  referral_date            │  │
         │  status_id → statuses     │  │
         │    (Referred/Completed/Not Completed)      │
         │  outcome_notes            │  │
         │  completed_date           │  │
         │  ◆ referral_service_categories             │
         │    (M:M → service_categories,              │
         │     filtered by partner's tags)            │
         │                           │  │
         │  📧 On create: email To client + partner,  │
         │     CC referring staff member               │
         └──────────┬───────────────┘  │
                    │ FK               │
         ┌──────────┴───────────┐      │
         │  follow_up_surveys   │      │
         │─────────────────────│      │
         │  referral_id         │      │
         │  status_id → statuses│      │
         │    (Pending/Completed/Expired)             │
         │  helpfulness_id → categories (dropdown)    │
         │  time_to_contact_id → categories (dropdown)│
         │  outcome_id → categories (dropdown)        │
         │  open_feedback (text)│      │
         │  completed_date      │      │
         │                      │      │
         │  ⏰ Auto-reminders at 3/5/7 days           │
         └─────────────────────┘      │
                                       │
         ┌─────────────────────────────┘
         ▼
┌─────────────────────────┐
│        partners          │
│─────────────────────────│
│  display_name            │
│  partner_type_id → categories (Org/Individual)     │
│  contact_name, email, phone                        │
│  address, location (GeoPoint/map)                  │
│  website, languages_supported                      │
│  capacity_notes, active, description               │
│  ◆ partner_service_categories                      │
│    (M:M → service_categories)                      │
└──────────────────────────┘


         ┌─────────────────────────────────┐
         │  REPORT VIEWS (Virtual Entities) │
         │─────────────────────────────────│
         │  monthly_referral_summary        │
         │  client_contact_summary          │
         │  top_needs_report                │
         │  partner_utilization_report      │
         │  time_lag_report                 │
         └─────────────────────────────────┘
```

**5 domain tables** + **3 M:M junctions** + **5 report views**, all connected through `service_categories` as the shared vocabulary.

---

## Appendix B: Partner Directory Seed Notes

The current ICGF partner list at icgflint.org/services includes ~40 entries. Many are political offices, supporters, or community organizations rather than service agencies. Candidates for the initial seed (actual service providers) likely include:

- Legal Services of Eastern Michigan (Legal Aid)
- Mott Community College (ESL, Education)
- Michigan Works (Employment)
- Mass Transportation Authority (Transportation)
- American Red Cross of Genesee County (Multiple services)
- Arab American Heritage Council (Cultural services, Translation)
- Sylvester Broome Empowerment Village (Youth services)
- Gloria Coles Flint Public Library (Education, ESL)
- Michigan Small Business Development Corporation (Employment, Financial)
- Genesee Intermediate School District (Education)

ICGF staff will review the full list, identify actual referral partners, assign service category tags, and gather current contact information. The partner list will be seeded at launch and maintained by ICGF via the UI.
