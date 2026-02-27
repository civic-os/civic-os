# FFSC Staff Portal Example

This example demonstrates Civic OS's capabilities for building a staff management portal for the Flint Freedom Schools Collaborative (FFSC) summer program. It showcases onboarding document workflows, time tracking, approval workflows, incident reporting, and three-tier row-level security.

## Quick Start (Docker)

```bash
cd examples/staff-portal
cp .env.example .env
docker-compose up -d

# Wait for initialization (check logs)
docker-compose logs -f postgres
```

Then open your browser to `http://localhost:4200`.

**Standard Ports** (same across all examples):
- PostgreSQL: 15432
- PostgREST: 3000
- Swagger UI: 8080
- MinIO: 9000 (API), 9001 (Console)
- Inbucket: 9100 (email testing web UI)
- Keycloak: 8082

**Note**: Only one example can run at a time. Stop any running example (`docker-compose down`) before starting this one.

## Features Demonstrated

- **Onboarding Document Management**: Auto-generated document checklists per staff member based on role, with upload, review, and approval workflow
- **File Uploads**: S3-based file storage (MinIO locally) for document and receipt uploads
- **Clock In/Clock Out**: Entity Action Buttons on staff detail pages for time tracking
- **Time-Off Request Approval**: Staff submit requests, site leads review and approve/deny
- **Expense Reimbursement**: Staff submit reimbursements with receipt uploads, managers approve/deny
- **Incident Reporting**: Site-based incident reports with notifications to site lead and managers
- **End-of-Program Feedback**: Anonymous-style offboarding survey for departing staff
- **Email Notifications**: 10 notification templates for all workflow events (document review, time-off, reimbursements, incidents, onboarding completion)
- **Three-Tier RLS**: Staff see own records, site leads see their site, managers see all
- **Status Type System**: Centralized statuses for onboarding, documents, time-off, and reimbursements
- **Full-Text Search**: Search staff members and incident reports
- **Custom Dashboards**: Staff Portal (personal view) and Admin Overview (management view)

## Test Users

| Username | Password | Role | Description |
|----------|----------|------|-------------|
| testuser | testuser | user | Basic staff member |
| testeditor | testeditor | site_lead | Site lead (mapped from Keycloak editor role) |
| testmanager | testmanager | manager | Program manager |
| testadmin | testadmin | admin | Full administrative access |

## File Structure

### Init Scripts (run in order)

- **`00_create_authenticator.sh`** - Creates PostgreSQL authenticator role
- **`01_staff_portal_schema.sql`** - Tables, triggers, RLS policies, helper functions, metadata configuration
- **`02_staff_portal_permissions.sql`** - RBAC permissions mapping roles to table operations
- **`03_staff_portal_metadata.sql`** - Entity/property metadata enhancements (display names, descriptions, visibility)
- **`04_staff_portal_actions.sql`** - Entity Action Buttons (Clock In, Clock Out, document review actions)
- **`05_staff_portal_notifications.sql`** - 10 email notification templates with trigger functions
- **`06_staff_portal_seed_data.sql`** - Reference data (staff roles, document requirements, sites)
- **`07_staff_portal_dashboards.sql`** - Custom dashboards (Staff Portal, Admin Overview)
- **`08_staff_portal_schema_decisions.sql`** - Architectural Decision Records (ADRs)

### Helper Files

- **`docker-compose.yml`** - Complete Docker stack (PostgreSQL, PostgREST, MinIO, Inbucket, Keycloak)
- **`.env.example`** - Environment variable template
- **`jwt-secret.jwks`** - Keycloak JWT public key for local development
- **`fetch-keycloak-jwk.sh`** - Script to fetch latest JWT key from Keycloak
- **`mock-data-config.json`** - Configuration for mock data generation

## Schema Overview

### Reference Tables

- **`staff_roles`** - Position types (Lead Teacher, Assistant Teacher, Site Coordinator, Administrative Support)
- **`sites`** - Program locations with site lead assignment
- **`document_requirements`** - Templates for required onboarding documents (I-9, W-4, Background Check, etc.)

### Core Tables

- **`staff_members`** - Staff roster with role, site assignment, pay rate, and aggregated onboarding status
- **`staff_documents`** - Individual document submissions per staff member with file upload and review status
- **`time_entries`** - Clock in/out records with denormalized staff and site names
- **`time_off_requests`** - Staff time-off requests with approval workflow
- **`incident_reports`** - Safety/behavioral incident reports with site association
- **`reimbursements`** - Expense reimbursement requests with receipt file upload
- **`offboarding_feedback`** - End-of-program surveys (one per staff member)

### Status Types

| Entity Type | Statuses |
|-------------|----------|
| `staff_onboarding` | Not Started, Partial, All Approved |
| `staff_document` | Pending, Submitted, Approved, Needs Revision |
| `time_off_request` | Pending, Approved, Denied |
| `reimbursement` | Pending, Approved, Denied |

## Key Workflows

### Onboarding

1. Manager creates a new staff member with name, email, site, and role
2. Trigger auto-creates `staff_documents` records for each applicable `document_requirement`
3. Staff member uploads files to each document (status auto-advances from Pending to Submitted)
4. Site lead or manager reviews and approves/denies each document
5. Trigger recalculates `onboarding_status_id` on each document status change (Not Started / Partial / All Approved)
6. When all documents are approved, managers receive an "onboarding complete" notification

### Clock In/Out

1. Staff member navigates to their own detail page (`/view/staff_members/:id`)
2. Clicks "Clock In" or "Clock Out" Entity Action Button
3. Action creates a `time_entries` record with denormalized staff name and site name
4. Site leads and managers can view time entries for reporting

### Time-Off Requests

1. Staff member creates a time-off request with start/end dates and reason
2. Site lead receives email notification
3. Site lead reviews and approves or denies (with optional response notes)
4. Staff member receives approval/denial notification

### Reimbursements

1. Staff member creates a reimbursement with amount, description, and optional receipt upload
2. All managers receive email notification
3. Manager reviews and approves or denies (with optional response notes)
4. Staff member receives approval/denial notification

## Notification System

10 email templates with database triggers that automatically send notifications:

| Template | Trigger | Recipients |
|----------|---------|------------|
| `document_needs_revision` | Document status -> Needs Revision | Staff member |
| `document_approved` | Document status -> Approved | Staff member |
| `time_off_submitted` | New time-off request | Site lead |
| `time_off_approved` | Time-off status -> Approved | Staff member |
| `time_off_denied` | Time-off status -> Denied | Staff member |
| `reimbursement_submitted` | New reimbursement | All managers |
| `reimbursement_approved` | Reimbursement status -> Approved | Staff member |
| `reimbursement_denied` | Reimbursement status -> Denied | Staff member |
| `incident_report_filed` | New incident report | Site lead + managers |
| `onboarding_complete` | Onboarding status -> All Approved | All managers |

### Testing Notifications Locally

Emails are captured by Inbucket (local SMTP server). View them at `http://localhost:9100`.

## Row-Level Security Model

| Role | Sees | Can Do |
|------|------|--------|
| **user** (staff) | Own records only | View own docs/time, submit requests |
| **site_lead** (editor) | Own site's records | Review documents, approve time-off |
| **manager** | All records | Full management, approve reimbursements |
| **admin** | All records | Full CRUD on all tables |

## License

AGPL-3.0-or-later (same as parent project)
