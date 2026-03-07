# Staff Portal Notifications

All notifications use **email + SMS** channels. SMS messages include a deep link to the relevant record.

## Document Workflow

| # | Template | Trigger | Recipient | Entity Data |
|---|----------|---------|-----------|-------------|
| 1 | `document_needs_revision` | `staff_documents.status_id` → "Needs Revision" | Staff member | DocumentId, DocumentName, StaffName, RequirementName, ReviewerNotes |
| 2 | `document_approved` | `staff_documents.status_id` → "Approved" | Staff member | DocumentId, DocumentName, StaffName, RequirementName |
| 11 | `document_submitted` | `staff_documents.status_id` → "Submitted" | All managers | DocumentId, DocumentName, StaffName, RequirementName, SiteName |

All three are handled by `notify_document_status_change()` (single trigger on `staff_documents`). Staff-facing notifications (1, 2) silently skip if the staff member has no linked user account.

## Time Off Workflow

| # | Template | Trigger | Recipient | Entity Data |
|---|----------|---------|-----------|-------------|
| 3 | `time_off_submitted` | INSERT on `time_off_requests` | Site lead | RequestId, StaffName, SiteName, StartDate, EndDate, Reason |
| 4 | `time_off_approved` | `time_off_requests.status_id` → "Approved" | Staff member | RequestId, StaffName, StartDate, EndDate, ResponseNotes |
| 5 | `time_off_denied` | `time_off_requests.status_id` → "Denied" | Staff member | RequestId, StaffName, StartDate, EndDate, ResponseNotes |

Template 3 uses `get_site_lead_email()` to find the site lead via `sites.lead_id`. If no lead is assigned, no notification is sent.

## Reimbursement Workflow

| # | Template | Trigger | Recipient | Entity Data |
|---|----------|---------|-----------|-------------|
| 6 | `reimbursement_submitted` | INSERT on `reimbursements` | All managers | ReimbursementId, StaffName, Amount, Description, HasReceipt |
| 7 | `reimbursement_approved` | `reimbursements.status_id` → "Approved" | Staff member | ReimbursementId, StaffName, Amount, Description, ResponseNotes |
| 8 | `reimbursement_denied` | `reimbursements.status_id` → "Denied" | Staff member | ReimbursementId, StaffName, Amount, Description, ResponseNotes |

## Incident Reporting

| # | Template | Trigger | Recipient | Entity Data |
|---|----------|---------|-----------|-------------|
| 9 | `incident_report_filed` | INSERT on `incident_reports` | Site lead + all managers (deduplicated) | ReportId, SiteName, ReporterName, IncidentDate, IncidentTime, Description, PeopleInvolved, ActionTaken, FollowUpNeeded |

Uses a `v_notified_users` array to prevent duplicate notifications when the site lead also holds the manager role.

## Onboarding

| # | Template | Trigger | Recipient | Entity Data |
|---|----------|---------|-----------|-------------|
| 10 | `onboarding_complete` | `staff_members.onboarding_status_id` → "All Approved" | All managers | StaffMemberId, StaffName, RoleName, SiteName |

Only fires on transition **to** "All Approved" (not if already in that state).

## Task Assignment

| # | Template | Trigger | Recipient | Entity Data |
|---|----------|---------|-----------|-------------|
| 12 | `task_assigned` | INSERT on `staff_tasks` | Assigned staff member | TaskId, TaskTitle, Description, DueDate, SiteName, StaffName |

Defined in `10_staff_tasks.sql`. Silently skips if the assigned staff member has no linked user account.

## Routing Summary

- **Staff-facing** (1, 2, 4, 5, 7, 8, 12): Sent to the individual staff member. Requires `staff_members.user_id` to be set.
- **Site lead** (3): Sent via `get_site_lead_email()` lookup on `sites.lead_id`.
- **Site lead + managers** (9): Sent to site lead first, then all managers (deduplicated).
- **All managers** (6, 10, 11): Broadcast to all users with `manager` role.

## Helper Functions

- `get_users_with_role(role_name)` — Returns `(user_id, user_email)` for all users holding a given role.
- `get_site_lead_email(site_id)` — Returns `(user_id, user_email)` for the site lead of the given site.

## Template Variables

All templates have access to:
- `{{.Entity.*}}` — Entity-specific data (see Entity Data columns above)
- `{{.Metadata.site_url}}` — Base URL of the application (used for deep links)
