# Central OS

**Status**: Design Complete
**Author**: Daniel Kurin
**Date**: 2026-03-13
**Version**: 2.0 (expanded with CRM entities, 2026-03-20)

## Executive Summary

Build an internal operations system for Civic OS L3C using the Civic OS framework. This provides dogfooding benefits while creating a reusable "internal ops" example for customers.

### Decision: Build on Civic OS

After analysis, we determined that the requirements (time tracking, design docs, client/project management, CRM) are **structured CRUD data** rather than unstructured wiki content. This maps directly to Civic OS's strengths.

**Key Insight**: What was initially described as a "knowledge base" is actually client relationship management — tracking projects, hours, design documentation, and outreach as structured records, not wiki-style content.

### Decision: Unified Client Lifecycle

Rather than separate "prospects" and "clients" tables, we use a **single `clients` table with status workflow** (Lead → Qualified → Proposal → Pilot → Active → Inactive | Lost). "Converting a prospect" is just changing status and filling in contract fields. No data migration needed.

## Requirements

### Must-Have (Phase 1)
1. **Time Tracking** — Log hours against projects with calendar visualization
2. **Design Docs** — Centralized home for design documents tied to clients and projects
3. **Client & Project Management** — Core entities with status-driven lifecycle
4. **CRM / Contact Tracking** — Historical contact log + scheduled future outreach with calendar

### Future Phases
5. **Client Configurations** — Deployment details, customizations, with version history (Phase 2)
6. **Conversation Logs** — RAG-optimized for future AI querying (Phase 2)
7. **Billing Management** — Invoice generation from time entries (Phase 3)
8. **Support Tickets** — Issue tracking with status workflow (Phase 3)

### Constraints
- Team size: 1 person now, scaling to ~12
- Time tracking: Logging after-the-fact (no real-time timer needed)
- Billability: Tracked at project level, not per time entry

## Schema Design (6 Tables)

### Entity Relationship Diagram

```
┌─────────────┐       ┌─────────────┐       ┌──────────────┐
│   clients   │──────<│  projects   │──────<│ time_entries  │
│  (status)   │       │  (status)   │       │ (time_slot)   │
└──────┬──────┘       └──────┬──────┘       └──────────────┘
       │                     │
       ├────────────┐  ┌─────┘
       │            ▼  ▼
       │       ┌──────────────┐
       │       │ design_docs  │
       │       │  (status)    │
       │       └──────────────┘
       │
       ├──────<┌──────────────┐
       │       │ contact_log  │
       │       │ (category)   │
       │       └──────────────┘
       │
       └──────<┌───────────────────┐
               │scheduled_contacts │
               │(status+time_slot) │
               └───────────────────┘
```

### Table: `clients`

Primary entity for tracking client companies. Uses **status workflow** for prospect-to-client lifecycle.

**Status workflow**: Lead → Qualified → Proposal → Pilot → Active → Inactive | Lost

```sql
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  website VARCHAR(255),
  primary_contact_name VARCHAR(100),
  primary_contact_email email_address,
  primary_contact_phone phone_number,
  notes TEXT,
  status_id INT NOT NULL DEFAULT get_initial_status('client')
    REFERENCES metadata.statuses(id),
  contract_type VARCHAR(50),       -- retainer, project, hourly, pilot, etc.
  contract_start DATE,             -- NULL until contract exists
  contract_end DATE,               -- NULL for open-ended contracts
  contract_value money,            -- NULL until contract exists
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Full-text search
  civic_os_text_search tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(display_name,'') || ' ' || coalesce(notes,''))
  ) STORED
);

CREATE INDEX idx_clients_search ON clients USING GIN(civic_os_text_search);
CREATE INDEX idx_clients_status_id ON clients(status_id);
```

**UI Features**: List page with search and status filter, Detail page shows related projects, time entries, design docs, contact log, and scheduled contacts. Status badge shows lifecycle stage.

### Table: `projects`

Projects for each client, with billability and status workflow.

```sql
CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  is_billable BOOLEAN NOT NULL DEFAULT TRUE,
  hourly_rate money,  -- NULL if not billable or fixed price
  status_id INT NOT NULL DEFAULT get_initial_status('project')
    REFERENCES metadata.statuses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Required indexes for FK columns
CREATE INDEX idx_projects_client_id ON projects(client_id);
CREATE INDEX idx_projects_status_id ON projects(status_id);
```

**Status workflow**: Active → On Hold → Completed

**UI Features**: Status badge with color, filterable by status and billable flag, shows on client Detail page.

### Table: `time_entries`

Time logged against projects, with calendar visualization.

```sql
CREATE TABLE time_entries (
  id BIGSERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES civic_os_users(id),
  time_slot time_slot NOT NULL,  -- When the work was done (tstzrange)
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Required indexes
CREATE INDEX idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX idx_time_entries_user_id ON time_entries(user_id);
CREATE INDEX idx_time_entries_time_slot ON time_entries USING GIST(time_slot);
```

**Calendar Configuration**: `show_calendar=true`, `calendar_property_name='time_slot'`

**UI Features**: Calendar view on List page, time range picker on Create/Edit forms.

### Table: `design_docs`

Centralized design documents tied to clients and (optionally) projects.

```sql
CREATE TABLE design_docs (
  id SERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id INT REFERENCES projects(id) ON DELETE SET NULL,  -- Optional project link
  display_name VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,  -- Markdown content (renders as TextLong)
  status_id INT NOT NULL DEFAULT get_initial_status('design_doc')
    REFERENCES metadata.statuses(id),
  created_by UUID NOT NULL DEFAULT current_user_id()
    REFERENCES civic_os_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Full-text search on title + body
  civic_os_text_search tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(display_name,'') || ' ' || coalesce(body,''))
  ) STORED
);

-- Required indexes for FK columns
CREATE INDEX idx_design_docs_client_id ON design_docs(client_id);
CREATE INDEX idx_design_docs_project_id ON design_docs(project_id);
CREATE INDEX idx_design_docs_status_id ON design_docs(status_id);
CREATE INDEX idx_design_docs_search ON design_docs USING GIN(civic_os_text_search);
```

**Status workflow**: Draft → Final → Archived

**UI Features**: Searchable list, status badge, filterable by client/project/status. Shows on both client and project Detail pages via inverse relationships.

### Table: `contact_log`

Historical record of interactions with clients. Uses the **Category system** (v0.34.0+) for contact method with colored badges.

```sql
CREATE TABLE contact_log (
  id BIGSERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  category_id INT NOT NULL REFERENCES metadata.categories(id),
  contacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID NOT NULL DEFAULT current_user_id()
    REFERENCES civic_os_users(id),
  summary VARCHAR(200) NOT NULL,  -- Quick description
  notes TEXT,                      -- Detailed notes
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Required indexes for FK columns
CREATE INDEX idx_contact_log_client_id ON contact_log(client_id);
CREATE INDEX idx_contact_log_category_id ON contact_log(category_id);
CREATE INDEX idx_contact_log_user_id ON contact_log(user_id);
```

**Category entity_type**: `contact_method` — Call, Email, Meeting, Demo, Other

**UI Features**: Category badges for contact method, filterable by client and method. Shows on client Detail page via inverse relationship. Sorted by `contacted_at` descending (most recent first).

### Table: `scheduled_contacts`

Future planned interactions with clients. Uses **calendar integration** and **status workflow**.

```sql
CREATE TABLE scheduled_contacts (
  id BIGSERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  category_id INT NOT NULL REFERENCES metadata.categories(id),
  time_slot time_slot NOT NULL,   -- Calendar integration
  user_id UUID NOT NULL DEFAULT current_user_id()
    REFERENCES civic_os_users(id),
  purpose VARCHAR(200) NOT NULL,
  notes TEXT,
  status_id INT NOT NULL DEFAULT get_initial_status('scheduled_contact')
    REFERENCES metadata.statuses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Required indexes for FK columns
CREATE INDEX idx_scheduled_contacts_client_id ON scheduled_contacts(client_id);
CREATE INDEX idx_scheduled_contacts_category_id ON scheduled_contacts(category_id);
CREATE INDEX idx_scheduled_contacts_user_id ON scheduled_contacts(user_id);
CREATE INDEX idx_scheduled_contacts_status_id ON scheduled_contacts(status_id);
CREATE INDEX idx_scheduled_contacts_time_slot ON scheduled_contacts USING GIST(time_slot);
```

**Status workflow**: Scheduled → Completed | Cancelled

**Calendar Configuration**: `show_calendar=true`, `calendar_property_name='time_slot'`

**UI Features**: Calendar view for outreach schedule, status badge, category badge for contact method. Shows on client Detail page. Two calendar views available: `time_entries` (work log) and `scheduled_contacts` (outreach schedule).

## Status Type Configuration

```sql
-- Client lifecycle (6 statuses)
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('client', 'Client', 'Client lifecycle from lead to active/inactive');

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal)
VALUES
  ('client', 'Lead',      '#3B82F6', 1, TRUE,  FALSE),
  ('client', 'Qualified', '#8B5CF6', 2, FALSE, FALSE),
  ('client', 'Proposal',  '#F59E0B', 3, FALSE, FALSE),
  ('client', 'Pilot',     '#EC4899', 4, FALSE, FALSE),
  ('client', 'Active',    '#22C55E', 5, FALSE, FALSE),
  ('client', 'Inactive',  '#6B7280', 6, FALSE, TRUE),
  ('client', 'Lost',      '#EF4444', 7, FALSE, TRUE);

-- Project lifecycle (3 statuses)
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('project', 'Project', 'Project lifecycle status');

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal)
VALUES
  ('project', 'Active',    '#22C55E', 1, TRUE,  FALSE),
  ('project', 'On Hold',   '#F59E0B', 2, FALSE, FALSE),
  ('project', 'Completed', '#6B7280', 3, FALSE, TRUE);

-- Design doc lifecycle (3 statuses)
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('design_doc', 'Design Doc', 'Design document lifecycle status');

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal)
VALUES
  ('design_doc', 'Draft',    '#F59E0B', 1, TRUE,  FALSE),
  ('design_doc', 'Final',    '#22C55E', 2, FALSE, FALSE),
  ('design_doc', 'Archived', '#6B7280', 3, FALSE, TRUE);

-- Scheduled contact workflow (3 statuses)
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('scheduled_contact', 'Scheduled Contact', 'Scheduled contact workflow');

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal)
VALUES
  ('scheduled_contact', 'Scheduled', '#3B82F6', 1, TRUE,  FALSE),
  ('scheduled_contact', 'Completed', '#22C55E', 2, FALSE, TRUE),
  ('scheduled_contact', 'Cancelled', '#6B7280', 3, FALSE, TRUE);
```

## Category Configuration

```sql
-- Contact method categories (shared by contact_log and scheduled_contacts)
INSERT INTO metadata.category_types (entity_type, description)
VALUES ('contact_method', 'Contact interaction method');

INSERT INTO metadata.categories (entity_type, display_name, color, sort_order)
VALUES
  ('contact_method', 'Call',    '#3B82F6', 1),
  ('contact_method', 'Email',   '#22C55E', 2),
  ('contact_method', 'Meeting', '#8B5CF6', 3),
  ('contact_method', 'Demo',    '#F59E0B', 4),
  ('contact_method', 'Other',   '#6B7280', 5);
```

## Metadata Configuration

### Entity Display Settings

```sql
INSERT INTO metadata.entities (table_name, display_name, display_name_plural, description, sort_order, search_fields)
VALUES
  ('clients',             'Client',            'Clients',            'Client companies and prospects',           1, ARRAY['display_name', 'notes']),
  ('projects',            'Project',           'Projects',           'Projects for clients',                     2, NULL),
  ('time_entries',        'Time Entry',        'Time Entries',       'Logged work hours',                        3, NULL),
  ('design_docs',        'Design Doc',        'Design Docs',        'Design documents and specifications',       4, ARRAY['display_name', 'body']),
  ('contact_log',        'Contact Log',       'Contact Log',        'Historical client interaction records',     5, NULL),
  ('scheduled_contacts', 'Scheduled Contact', 'Scheduled Contacts', 'Planned future client interactions',        6, NULL)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  display_name_plural = EXCLUDED.display_name_plural,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  search_fields = EXCLUDED.search_fields;
```

### Property Customization

```sql
-- Enable filtering
UPDATE metadata.properties SET filterable = TRUE
WHERE (table_name = 'clients' AND column_name = 'status_id')
   OR (table_name = 'projects' AND column_name = 'status_id')
   OR (table_name = 'projects' AND column_name = 'is_billable')
   OR (table_name = 'design_docs' AND column_name = 'status_id')
   OR (table_name = 'design_docs' AND column_name = 'client_id')
   OR (table_name = 'design_docs' AND column_name = 'project_id')
   OR (table_name = 'contact_log' AND column_name = 'client_id')
   OR (table_name = 'contact_log' AND column_name = 'category_id')
   OR (table_name = 'scheduled_contacts' AND column_name = 'client_id')
   OR (table_name = 'scheduled_contacts' AND column_name = 'category_id')
   OR (table_name = 'scheduled_contacts' AND column_name = 'status_id');

-- Link status columns to their status entity types
UPDATE metadata.properties SET status_entity_type = 'client'
WHERE table_name = 'clients' AND column_name = 'status_id';

UPDATE metadata.properties SET status_entity_type = 'project'
WHERE table_name = 'projects' AND column_name = 'status_id';

UPDATE metadata.properties SET status_entity_type = 'design_doc'
WHERE table_name = 'design_docs' AND column_name = 'status_id';

UPDATE metadata.properties SET status_entity_type = 'scheduled_contact'
WHERE table_name = 'scheduled_contacts' AND column_name = 'status_id';

-- Link category columns to their category entity types
UPDATE metadata.properties SET category_entity_type = 'contact_method'
WHERE (table_name = 'contact_log' AND column_name = 'category_id')
   OR (table_name = 'scheduled_contacts' AND column_name = 'category_id');

-- Full-width text fields
UPDATE metadata.properties SET column_width = 2
WHERE column_name IN ('notes', 'description', 'body');

-- Calendar configuration
UPDATE metadata.entities SET
  show_calendar = TRUE,
  calendar_property_name = 'time_slot'
WHERE table_name IN ('time_entries', 'scheduled_contacts');
```

## Permissions

Simple permissions for a small internal team:

```sql
-- All authenticated users have full access
GRANT SELECT, INSERT, UPDATE, DELETE ON
  clients, projects, time_entries, design_docs, contact_log, scheduled_contacts
TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- No anonymous access (internal tool)
```

## Deployment

Central OS is deployed to a $12/mo DigitalOcean droplet at `central.civic-os.org`. Unlike the standard VPS template (which uses managed PostgreSQL), this deployment bundles PostgreSQL inside Docker for simplicity.

**Deployment files**: `../deployments/central-os/` (outside the repo)

See `../deployments/central-os/README.md` for the full deployment runbook.

### Key Differences from Standard VPS

| Aspect | Standard VPS | Central OS |
|--------|-------------|------------|
| Database | Managed PostgreSQL (external) | Dockerized PostgreSQL (internal) |
| SSL for DB | `sslmode=require` | `sslmode=disable` (Docker network) |
| Swagger UI | Included | Removed (internal tool) |
| Payment Worker | Optional profile | Not included |
| Keycloak | Self-hosted or shared | Shared at `auth.civic-os.org` (dedicated `central-os` realm) |

## Success Criteria

- [ ] Can create/edit/view all 6 entities
- [ ] Calendar view shows time entries and scheduled contacts
- [ ] Full-text search works on design docs and clients
- [ ] Client lifecycle: Lead → Qualified → Proposal → Pilot → Active → Inactive | Lost
- [ ] Project status workflow: Active → On Hold → Completed
- [ ] Design doc status workflow: Draft → Final → Archived
- [ ] Scheduled contact workflow: Scheduled → Completed | Cancelled
- [ ] Contact method categories display with colored badges
- [ ] Relationships display on detail pages (client shows all related entities)
- [ ] Filter bar works for status, billable, client, category on relevant entities

## Future Enhancements

### Phase 2: Client Configurations + Conversations
- Add `client_configurations` table with version history and audit trigger
- Add `conversations` table (RAG-optimized) for tracking client interactions
- Vector search preparation with pgvector for conversation notes

### Phase 3: Billing & Support
- Add `invoices` table linked to projects
- RPC to calculate total hours from time_entries for a date range
- Integrate with payment system for invoice collection
- Add `support_tickets` table with status workflow and notifications

### Future Framework Feature: First-Class Auditing
After using the manual history implementation (Phase 2), consider extracting to a framework feature:
- `enable_history` flag on `metadata.entities`
- Auto-generated history tables and triggers
- "History" tab on Detail pages
- Learnings from Central OS will inform the design

## Reference Materials

- `examples/community-center/` — Status types, time_slot usage, calendar integration
- `examples/pothole/` — Full-text search, validation rules, notifications
- `examples/broader-impacts/` — User references, complex relationships
- `examples/staff-portal/` — Category system usage
- `docs/development/CALENDAR_INTEGRATION.md` — Calendar configuration guide
- `docs/development/STATUS_TYPE_SYSTEM.md` — Status workflow documentation

## Appendix: Dogfooding Benefits

Building this on Civic OS provides:

| Benefit | What We Learn |
|---------|---------------|
| **time_slot usage** | Real-world testing of calendar integration |
| **Status workflow** | Validates multi-entity lifecycle patterns (4 status types) |
| **Category system** | First production use of Category (v0.34.0+) |
| **Full-text search** | Tests search at realistic scale |
| **Design docs (TextLong)** | Validates markdown-heavy entity workflows |
| **User references** | Validates user management integration |
| **CRM patterns** | Validates contact tracking as a reusable pattern |

This creates a feedback loop where internal usage drives framework improvements that benefit all Civic OS customers.
