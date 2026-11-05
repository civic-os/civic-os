# Recurring TimeSlot System Design Document

> **Status**: Implemented (v0.19.0+, updated v0.38.5)
> **Version**: v0.19.0+
> **Last Updated**: March 2026

## Executive Summary

This document describes the architecture for adding recurring timeslot support to Civic OS as a **first-class framework feature**. The design supports full RFC 5545 RRULE compliance, conflict preview before commit, and complete exception handling (cancel/reschedule individual occurrences, "this and future" modifications).

**Key Design Principles**:
1. **Hybrid storage**: Store both RRULE patterns AND expanded instances for GIST constraint compatibility
2. **Junction table**: No schema changes to entity tables - series/instance mapping lives in `metadata` schema
3. **Series groups**: Split series (from "edit this and future") stay logically connected for unified UX
4. **Entity templates**: Series stores JSONB template of entity field values to copy into each instance

---

## Problem Statement

### Current Limitation

The existing `time_slot` domain (PostgreSQL `tstzrange`) supports single occurrences only. For scheduling use cases like:
- Weekly yoga classes
- Bi-weekly team meetings
- Monthly board meetings
- Daily facility reservations

Users must manually create each occurrence, which is tedious and error-prone.

### Challenges with Recurring Events

1. **Conflict Detection**: GIST exclusion constraints (`EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&)`) enforce no-overlap at the database level. Recurring series could generate instances that conflict with existing bookings.

2. **Exception Handling**: Real-world calendars need to handle:
   - "Cancel just this week's class"
   - "Reschedule the March 15th meeting to March 17th"
   - "Change all future meetings to a new time"

3. **UI Complexity**: Building a recurrence editor that handles RFC 5545 RRULE patterns is non-trivial.

4. **Entity Data**: Each instance needs entity-specific field values (resource_id, purpose, attendee_count) beyond just the time slot.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Angular Frontend                             │
├─────────────────────────────────────────────────────────────────────┤
│  SeriesGroupManagementPage        │  RecurrenceRuleEditorComponent  │
│  RecurringTimeSlotEditComponent   │  ConflictPreviewComponent       │
│  ExceptionEditorComponent         │  SeriesVersionTimelineComponent │
│  TimeSlotCalendarComponent (+rrule plugin)                          │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PostgREST API / RPCs                              │
├─────────────────────────────────────────────────────────────────────┤
│  preview_recurring_conflicts()    │  create_recurring_series()      │
│  cancel_series_occurrence()       │  reschedule_occurrence()        │
│  split_series_from_date()         │  delete_series_with_instances() │
│  update_series_template()         │  expand_series_instances()      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Go Consolidated Worker (River)                          │
├─────────────────────────────────────────────────────────────────────┤
│  ExpandRecurringSeriesJob         │  RRULE parsing (go-rrule lib)   │
│  Background expansion as time passes                                 │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        PostgreSQL                                    │
├─────────────────────────────────────────────────────────────────────┤
│  metadata.time_slot_series_groups │  metadata.time_slot_series      │
│  metadata.time_slot_instances     │  Entity tables (unchanged)      │
│  GIST exclusion constraints (unchanged)                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### Conceptual Model

```
┌─────────────────────────┐
│  Series Groups          │  ← User-facing: "Weekly Team Standup"
│  (logical container)    │     One group can have multiple versions
└───────────┬─────────────┘
            │ 1:N
            ▼
┌─────────────────────────┐
│  Series (versions)      │  ← Internal: Version 1 (Jan-Feb), Version 2 (Mar+)
│  (RRULE + template)     │     Created when user edits "this and future"
└───────────┬─────────────┘
            │ 1:N
            ▼
┌─────────────────────────┐
│  Instances (junction)   │  ← Maps series → entity records
│  (tracks exceptions)    │     Tracks cancellations, modifications
└───────────┬─────────────┘
            │ 1:1
            ▼
┌─────────────────────────┐
│  Entity Records         │  ← Actual reservations, classes, etc.
│  (reservations, etc.)   │     NO SCHEMA CHANGES REQUIRED
└─────────────────────────┘
```

### Core Tables

```sql
-- ============================================================
-- SERIES GROUPS
-- Logical container for related series versions
-- This is what users see and manage in the UI
-- ============================================================
CREATE TABLE metadata.time_slot_series_groups (
  id BIGSERIAL PRIMARY KEY,

  -- Display information
  display_name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Visual identification (shared across all instances)
  color hex_color,

  -- Audit
  created_by UUID REFERENCES metadata.civic_os_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.time_slot_series_groups IS
  'Logical grouping of related series versions - what users see as "one recurring event"';

CREATE INDEX idx_series_groups_created_by ON metadata.time_slot_series_groups(created_by);


-- ============================================================
-- SERIES (Versions)
-- Stores RRULE definition, entity template, and version info
-- Multiple series can belong to one group (after splits)
-- ============================================================
CREATE TABLE metadata.time_slot_series (
  id BIGSERIAL PRIMARY KEY,

  -- Link to logical group (NULL for standalone/legacy series)
  group_id BIGINT REFERENCES metadata.time_slot_series_groups(id) ON DELETE CASCADE,

  -- Version tracking within group
  version_number INT NOT NULL DEFAULT 1,
  effective_from DATE NOT NULL,
  effective_until DATE,  -- NULL means "ongoing"

  -- Target entity configuration
  entity_table TEXT NOT NULL,

  -- Template data: JSONB of field values to copy into each instance
  -- Example: {"resource_id": 5, "purpose": "Team Standup", "attendee_count": 10}
  entity_template JSONB NOT NULL,

  -- RRULE definition (RFC 5545 compliant)
  -- Examples:
  --   "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  --   "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12"
  --   "FREQ=DAILY;INTERVAL=2;UNTIL=20251231T235959Z"
  rrule TEXT NOT NULL,

  -- Series anchor point
  dtstart TIMESTAMP NOT NULL,  -- First occurrence start (wall-clock local time, NOT UTC)
  duration INTERVAL NOT NULL,    -- Duration of each occurrence

  -- IANA timezone for RRULE expansion and tstzrange construction
  timezone TEXT NOT NULL,  -- e.g., "America/New_York" (required, pairs with dtstart)

  -- Series status (for pause/notify on schema drift)
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'needs_attention', 'ended')),

  -- Expansion tracking
  expanded_until DATE,

  -- Audit
  created_by UUID REFERENCES metadata.civic_os_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Template change tracking
  template_updated_at TIMESTAMPTZ,
  template_updated_by UUID REFERENCES metadata.civic_os_users(id)
);

COMMENT ON TABLE metadata.time_slot_series IS
  'RRULE definitions and entity templates - multiple versions per group after splits';
COMMENT ON COLUMN metadata.time_slot_series.entity_template IS
  'JSONB template of field values copied to each expanded instance';
COMMENT ON COLUMN metadata.time_slot_series.effective_from IS
  'Date this version of the series starts applying';
COMMENT ON COLUMN metadata.time_slot_series.effective_until IS
  'Date this version ends (NULL = ongoing, set when split occurs)';

CREATE INDEX idx_series_group ON metadata.time_slot_series(group_id);
CREATE INDEX idx_series_entity_table ON metadata.time_slot_series(entity_table);
CREATE INDEX idx_series_effective ON metadata.time_slot_series(effective_from, effective_until);


-- ============================================================
-- INSTANCES (Junction Table)
-- Maps series to entity records WITHOUT requiring entity schema changes
-- Tracks exceptions (cancelled, modified, rescheduled)
-- ============================================================
CREATE TABLE metadata.time_slot_instances (
  id BIGSERIAL PRIMARY KEY,

  -- Link to series
  series_id BIGINT NOT NULL REFERENCES metadata.time_slot_series(id) ON DELETE CASCADE,

  -- Which occurrence this represents
  occurrence_date DATE NOT NULL,

  -- Link to entity record (polymorphic)
  -- NULL if cancelled or conflict-skipped (no entity record exists)
  entity_table TEXT NOT NULL,
  entity_id BIGINT,

  -- Exception tracking
  is_exception BOOLEAN DEFAULT FALSE,
  exception_type VARCHAR(20) CHECK (exception_type IN (
    'modified',          -- Entity data changed from template
    'rescheduled',       -- Moved to different time
    'cancelled',         -- User deleted this occurrence
    'conflict_skipped'   -- Never created due to conflict at expansion time
  )),

  -- Audit trail for exceptions
  original_time_slot TSTZRANGE,  -- What time it was before rescheduling
  exception_reason TEXT,
  exception_at TIMESTAMPTZ,
  exception_by UUID REFERENCES metadata.civic_os_users(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  UNIQUE(series_id, occurrence_date),
  UNIQUE(entity_table, entity_id)  -- Each entity record belongs to at most one series
);

COMMENT ON TABLE metadata.time_slot_instances IS
  'Junction table mapping series to entity records - enables recurrence without entity schema changes';
COMMENT ON COLUMN metadata.time_slot_instances.entity_id IS
  'FK to actual entity record (NULL if cancelled or never created due to conflict)';
COMMENT ON COLUMN metadata.time_slot_instances.is_exception IS
  'TRUE if this instance differs from series template (modified, rescheduled, or cancelled)';

CREATE INDEX idx_instances_series ON metadata.time_slot_instances(series_id);
CREATE INDEX idx_instances_entity ON metadata.time_slot_instances(entity_table, entity_id);
CREATE INDEX idx_instances_occurrence ON metadata.time_slot_instances(occurrence_date);
CREATE INDEX idx_instances_exceptions ON metadata.time_slot_instances(series_id) WHERE is_exception = TRUE;
```

### Metadata Entity Configuration (Explicit Opt-In)

**IMPORTANT**: Recurring time slot functionality is **explicitly opt-in** per entity. The framework does NOT assume all entities with `time_slot` columns support recurrence. Integrators must explicitly enable it for specific entities via `metadata.entities`.

```sql
-- Add columns to metadata.entities to enable recurring for an entity
ALTER TABLE metadata.entities
  ADD COLUMN supports_recurring BOOLEAN DEFAULT FALSE,
  ADD COLUMN recurring_property_name NAME;

COMMENT ON COLUMN metadata.entities.supports_recurring IS
  'Enables recurring series UI and behavior for this entity. Default FALSE - must be explicitly enabled.';

COMMENT ON COLUMN metadata.entities.recurring_property_name IS
  'The time_slot column to use for recurring schedules. Required when supports_recurring = TRUE.';

-- Enable recurring for a specific entity
INSERT INTO metadata.entities (table_name, supports_recurring, recurring_property_name)
VALUES ('reservations', TRUE, 'time_slot')
ON CONFLICT (table_name) DO UPDATE SET
  supports_recurring = TRUE,
  recurring_property_name = 'time_slot';
```

**Configuration Flow:**

1. Integrator creates entity with `time_slot` column (as before)
2. Entity works immediately for one-time bookings (default behavior)
3. To enable recurring, integrator sets `supports_recurring = TRUE` and `recurring_property_name`
4. Admin can also enable via Entity Management page UI (same as calendar toggle)
5. Series management UI becomes available for this entity

**Why Entity-Level (Not Property-Level)?**

- **One recurring schedule per entity**: Each entity can only have one time slot configured for recurring
- **Consistent with calendar config**: Follows the same pattern as `show_calendar` + `calendar_property_name`
- **Simpler admin UX**: Calendar and recurring settings are in the same place (Entity Management)
- **Business logic varies**: Some time slots don't make sense as recurring (one-off appointments)
- **GIST constraint requirements**: Recurring requires proper exclusion constraints
- **Permission considerations**: Series management may need different permissions than single records

**Validation on Enable:**

The `upsert_entity_metadata` RPC validates that the specified property exists and is a time_slot type:

```sql
-- Validation is built into upsert_entity_metadata RPC
-- When supports_recurring = TRUE:
-- 1. recurring_property_name must be provided
-- 2. The property must exist for that entity
-- 3. The property must be of type time_slot/tstzrange
```

### Key Design Decision: No Entity Schema Changes

Unlike earlier designs, **integrators do NOT need to add columns to their entity tables**. The junction table (`time_slot_instances`) handles all series/instance relationships:

| Approach | Entity Changes Required | Pros | Cons |
|----------|------------------------|------|------|
| Columns in entity table | `series_id`, `occurrence_date`, `is_exception` | Simple queries | Pollutes entity schema |
| **Junction table** | **None** | Clean separation, opt-in | One JOIN for series info |

### Primary Key Requirements

> **Limitation**: Recurring time slots only support entities with `SERIAL` or `BIGSERIAL` primary keys. Entities with `UUID` primary keys cannot use the recurring feature.

This design decision keeps the junction table simple and avoids the complexity of polymorphic foreign keys. Most scheduling entities (reservations, appointments, classes) use integer primary keys.

If UUID support is needed in the future, a migration can add a parallel `entity_id_uuid` column with appropriate constraints.

---

## Security: RRULE Validation

### DoS Prevention

RRULE strings must be validated before storage to prevent denial-of-service attacks. A malicious RRULE like `FREQ=SECONDLY;INTERVAL=1` could generate millions of instances.

**Validation Rules:**
1. **Block sub-hourly frequencies**: Reject `SECONDLY` and `MINUTELY` (allow `HOURLY` and above)
2. **Configurable occurrence cap**: Runtime setting for max instances per expansion batch
3. **Require end condition** (optional): When `recurring_allow_infinite_series=false`, require `COUNT` or `UNTIL`

```sql
-- Configurable settings
INSERT INTO metadata.settings (key, value, description) VALUES
  ('recurring_max_instances_per_batch', '500', 'Maximum instances created per expansion batch'),
  ('recurring_max_instances_per_series', '2000', 'Maximum total instances per series (soft limit)');

CREATE FUNCTION validate_rrule(p_rrule TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_freq TEXT;
  v_has_limit BOOLEAN;
BEGIN
  -- Extract frequency
  v_freq := substring(p_rrule from 'FREQ=([A-Z]+)');

  -- Reject sub-hourly frequencies (SECONDLY, MINUTELY)
  IF v_freq IN ('SECONDLY', 'MINUTELY') THEN
    RAISE EXCEPTION 'FREQ=% is not allowed. Use HOURLY or less frequent.', v_freq;
  END IF;

  -- Check for occurrence limit (COUNT or UNTIL)
  v_has_limit := p_rrule ~ 'COUNT=' OR p_rrule ~ 'UNTIL=';

  -- If infinite series disabled, require limit
  IF NOT v_has_limit THEN
    IF NOT COALESCE((SELECT value::boolean FROM metadata.settings
            WHERE key = 'recurring_allow_infinite_series'), true) THEN
      RAISE EXCEPTION 'Series must have COUNT or UNTIL when infinite series disabled';
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;

-- Add constraint to series table
ALTER TABLE metadata.time_slot_series
  ADD CONSTRAINT rrule_valid CHECK (validate_rrule(rrule));
```

**Go Worker Enforcement** (additional layer):
- Maximum occurrence count per expansion batch (default: 500, configurable)
- Soft limit on total series instances (default: 2000, warns but allows)
- Timeout on RRULE parsing operations

### Template Field Validation

The `entity_template` JSONB is copied directly into entity records during expansion. To prevent injection of protected fields (audit columns, system fields), templates must be validated against an allowlist.

```sql
CREATE FUNCTION validate_entity_template(
  p_entity_table TEXT,
  p_template JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed_fields TEXT[];
  v_template_field TEXT;
BEGIN
  -- Validate entity_table exists
  IF NOT EXISTS (
    SELECT 1 FROM metadata.entities
    WHERE table_name = p_entity_table AND schema_name = 'public'
  ) THEN
    RAISE EXCEPTION 'Invalid entity table: %', p_entity_table;
  END IF;

  -- Get fields that are editable (show_on_create=true)
  SELECT array_agg(column_name) INTO v_allowed_fields
  FROM metadata.properties
  WHERE table_name = p_entity_table
    AND show_on_create = TRUE
    AND column_name NOT IN ('id', 'created_at', 'created_by', 'updated_at', 'updated_by');

  -- Check each template field is allowed
  FOR v_template_field IN SELECT jsonb_object_keys(p_template)
  LOOP
    IF NOT v_template_field = ANY(v_allowed_fields) THEN
      RAISE EXCEPTION 'Template field "%" is not allowed for entity %',
        v_template_field, p_entity_table;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;
```

**Apply validation in:**
- `create_recurring_series()` RPC
- `update_series_template()` RPC
- Go worker before INSERT

### Series Deletion Protection

Direct deletion of series records would orphan entity records. A trigger prevents this, forcing use of the proper RPC:

```sql
CREATE FUNCTION prevent_direct_series_delete() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('recurring.allow_direct_delete', true) != 'true' THEN
    RAISE EXCEPTION 'Use delete_series_with_instances() RPC instead of direct DELETE';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_series_delete_rpc
  BEFORE DELETE ON metadata.time_slot_series
  FOR EACH ROW EXECUTE FUNCTION prevent_direct_series_delete();

-- The RPC sets a session variable to bypass:
-- SET LOCAL recurring.allow_direct_delete = 'true';
```

---

## Schema Drift Detection

When the entity schema changes after a series is created (e.g., a new required column is added), expansion may fail. The system detects this and pauses the series with a notification.

### Validation Function

```sql
CREATE FUNCTION validate_template_against_schema(
  p_entity_table TEXT,
  p_template JSONB
) RETURNS TABLE(field TEXT, issue TEXT)
LANGUAGE plpgsql AS $$
BEGIN
  -- Check for missing required fields
  RETURN QUERY
  SELECT p.column_name, 'Required field missing from template'::TEXT
  FROM metadata.properties p
  LEFT JOIN LATERAL jsonb_object_keys(p_template) t(key) ON p.column_name = t.key
  WHERE p.table_name = p_entity_table
    AND p.is_nullable = 'NO'
    AND p.column_default IS NULL
    AND t.key IS NULL
    AND p.column_name NOT IN ('id', 'created_at', 'created_by', 'updated_at', 'updated_by');

  -- Check for fields that no longer exist
  RETURN QUERY
  SELECT t.key, 'Field no longer exists in entity schema'::TEXT
  FROM jsonb_object_keys(p_template) t(key)
  LEFT JOIN metadata.properties p ON p.table_name = p_entity_table AND p.column_name = t.key
  WHERE p.column_name IS NULL;
END;
$$;
```

### Go Worker Handling

```go
func expandSeries(series SeriesRecord) error {
    // Check for schema drift before expanding
    issues := validateTemplateAgainstSchema(series.EntityTable, series.EntityTemplate)

    if len(issues) > 0 {
        // Pause series
        db.Exec(`UPDATE metadata.time_slot_series
                 SET status = 'needs_attention'
                 WHERE id = $1`, series.ID)

        // Send notification to series creator
        createNotification(CreateNotificationParams{
            UserID:       series.CreatedBy,
            TemplateName: "series_schema_drift",
            EntityType:   "time_slot_series",
            EntityID:     strconv.FormatInt(series.ID, 10),
            EntityData: map[string]interface{}{
                "series_id":  series.ID,
                "group_id":   series.GroupID,
                "group_name": series.GroupName,
                "issues":     issues,
            },
            Channels: []string{"email"},
        })

        // Also notify admins
        notifyAdmins("series_schema_drift", series.ID, issues)

        return nil // Don't fail the job, just skip expansion
    }

    // Proceed with normal expansion...
}
```

### Notification Template

```sql
INSERT INTO metadata.notification_templates (
  name, description, entity_type,
  subject_template, html_template, text_template
) VALUES (
  'series_schema_drift',
  'Alert when recurring series template becomes incompatible with entity schema',
  'time_slot_series',
  'Action Required: Recurring schedule "{{.Entity.group_name}}" needs attention',
  '<h2>Schema Change Detected</h2>
   <p>The recurring schedule "{{.Entity.group_name}}" cannot expand new instances because the entity schema has changed.</p>
   <h3>Issues Found:</h3>
   <ul>{{range .Entity.issues}}<li><strong>{{.field}}</strong>: {{.issue}}</li>{{end}}</ul>
   <p><a href="{{.Metadata.site_url}}/recurring-schedules/{{.Entity.group_id}}">Update Series Template</a></p>',
  'Schema Change Detected for "{{.Entity.group_name}}"

Issues:
{{range .Entity.issues}}- {{.field}}: {{.issue}}
{{end}}

Update at: {{.Metadata.site_url}}/recurring-schedules/{{.Entity.group_id}}'
);
```

---

## Worker Authentication Context

The Go consolidated worker expands series using a service account context:

### RLS Handling

1. **Connection**: Worker connects as `authenticator` role
2. **Impersonation**: Sets JWT claims to impersonate the series creator for RLS evaluation:
   ```go
   db.Exec(`SELECT set_config('request.jwt.claims',
            '{"sub":"` + series.CreatedBy + `","roles":["authenticated"]}',
            true)`)
   ```
3. **Entity Records**: Created with `created_by = series.CreatedBy` (original creator)

### Audit Field Population

| Field | Value | Notes |
|-------|-------|-------|
| `created_by` | Series creator | From `time_slot_series.created_by` |
| `created_at` | Expansion timestamp | When the instance was expanded |
| `updated_by` | NULL | System-generated, no user action |

### Permission Validation

Before expanding, the worker validates the series creator still has permission:

```go
func canExpandSeries(series SeriesRecord) bool {
    // Check if creator still has entity:create permission
    var hasPermission bool
    db.QueryRow(`SELECT has_permission($1, 'create')`,
                series.EntityTable).Scan(&hasPermission)

    if !hasPermission {
        // Pause series - creator lost permission
        pauseSeriesWithReason(series.ID, "Creator no longer has create permission")
        return false
    }
    return true
}
```

---

## Instance Expansion Strategy

### Hybrid Approach: Stored RRULE + Expanded Instances

**Why hybrid?**
| Approach | Query Simplicity | Storage | Constraint Compatibility |
|----------|------------------|---------|-------------------------|
| RRULE only (virtual) | Complex (runtime expansion) | Minimal | GIST can't check |
| Instances only | Simple | High | Works |
| **Hybrid (both)** | Simple | Medium | Works |

The hybrid approach stores the RRULE in `time_slot_series` for pattern definition, but also creates actual rows in the entity table (e.g., `reservations`) for each expanded instance. This allows:
- GIST exclusion constraints to work unchanged
- Simple PostgREST queries (no runtime expansion)
- Clear audit trail of what was actually booked

### Go Worker Expansion

```go
// services/consolidated-worker-go/jobs/expand_recurring_series.go

type ExpandRecurringSeriesArgs struct {
    SeriesID    int64     `json:"series_id"`
    ExpandUntil time.Time `json:"expand_until"`
}

func (w *ExpandRecurringSeriesWorker) Work(ctx context.Context, job *river.Job[ExpandRecurringSeriesArgs]) error {
    // 1. Fetch series record
    series := fetchSeries(job.Args.SeriesID)

    // 2. Parse RRULE, generate occurrence dates
    rule, _ := rrule.StrToRRule(series.RRULE)
    occurrences := rule.Between(series.Dtstart, job.Args.ExpandUntil, true)

    // 3. Get existing instances to skip
    existingDates := getExistingInstanceDates(series.ID)

    // 4. For each new occurrence
    for _, occDate := range occurrences {
        if existingDates[occDate] {
            continue // Already expanded
        }

        // Build time_slot from occurrence + duration
        timeSlot := fmt.Sprintf("[%s,%s)",
            occDate.Format(time.RFC3339),
            occDate.Add(series.Duration).Format(time.RFC3339))

        // Start with template, add computed fields
        record := series.EntityTemplate
        record["time_slot"] = timeSlot

        // Insert entity record
        entityID := insertIntoTable(series.EntityTable, record)

        // Create junction record
        insertInstance(series.ID, occDate, series.EntityTable, entityID)
    }

    // 5. Update expanded_until
    updateExpandedUntil(series.ID, job.Args.ExpandUntil)
}
```

### Expansion Horizon

#### Default Horizon

- **Creation time**: Expand 90 days ahead (configurable via `RECURRING_SERIES_HORIZON_DAYS` env var, default 90)
- **Maximum "until never" limit**: 2 years ahead (prevents runaway expansion)

#### Configuration

```
Configured via environment variable on the consolidated worker:
- `RECURRING_SERIES_HORIZON_DAYS=90` (default, in docker-compose)
- SQL functions accept `p_expand_horizon_days INTEGER DEFAULT 90` parameter for per-call override
```

**Admin Option: Disable "Until Never"**

For organizations that need strict booking limits, administrators can disable infinite series:

```sql
-- Disable infinite series (require explicit end)
UPDATE metadata.settings
SET value = 'false'
WHERE key = 'recurring_allow_infinite_series';
```

When disabled, the Recurrence Rule Editor component will:
- Remove "Never" from the end condition dropdown
- Require either "After X occurrences" or "On date" end condition
- Validate RRULE contains either COUNT or UNTIL clause before submission

#### Scheduled Expansion Task (River Job)

> **Note**: The periodic scheduled expansion below is a design-phase concept not yet implemented. Current expansion is on-demand via River jobs triggered by series creation/modification.

A River periodic job maintains expansion horizons for all active series:

```go
// services/consolidated-worker-go/jobs/maintain_series_expansion.go

type MaintainSeriesExpansionArgs struct {
    // Empty - runs for all series needing expansion
}

func (w *MaintainSeriesExpansionWorker) Work(ctx context.Context, job *river.Job[MaintainSeriesExpansionArgs]) error {
    // 1. Find series approaching expansion horizon (within 30 days)
    rows := db.Query(`
        SELECT id, rrule, dtstart, duration, expanded_until, entity_table, entity_template
        FROM metadata.time_slot_series
        WHERE effective_until IS NULL  -- Only ongoing series
          AND (expanded_until IS NULL OR expanded_until < NOW() + INTERVAL '30 days')
    `)

    // 2. For each series, expand another 3 months
    for rows.Next() {
        var series SeriesRecord
        rows.Scan(&series)

        newHorizon := time.Now().AddDate(0, 3, 0)
        expandSeries(series, newHorizon)
    }

    return nil
}

// Register as periodic job (runs weekly)
riverClient.PeriodicJobs().Add(river.PeriodicJobConfig{
    Schedule: "0 3 * * 0",  // Every Sunday at 3 AM
    Job:      MaintainSeriesExpansionArgs{},
})
```

#### On-Demand Expansion

When the calendar navigates beyond the expanded range:

```typescript
// src/app/components/calendar/calendar.component.ts

onDatesSet(info: { start: Date; end: Date }) {
  // Check if we're viewing beyond expanded horizon
  if (this.series && info.end > new Date(this.series.expanded_until)) {
    // Request expansion via RPC
    this.dataService.rpc('expand_series_instances', {
      series_id: this.series.id,
      expand_until: addMonths(info.end, 1)
    }).subscribe(() => {
      this.refetchEvents();
    });
  }
}
```

#### Cleanup Job (Optional)

For series with many past instances, optionally archive old junction records:

```sql
-- Run monthly to archive instances older than 2 years
DELETE FROM metadata.time_slot_instances
WHERE occurrence_date < NOW() - INTERVAL '2 years'
  AND entity_id IS NULL;  -- Only delete cancelled/skipped (preserve active records)
```

---

## Timezone Handling

### Storage Model

- `dtstart` stores the first occurrence as **wall-clock local time** (`TIMESTAMP`, no timezone conversion)
- `timezone` stores the IANA timezone for RRULE expansion and tstzrange construction (e.g., `"America/New_York"`)
- Entity `time_slot` values are always stored as **UTC** (`TIMESTAMPTZ` range)
- `time_slot_instances.occurrence_date` is the occurrence's **local calendar date in the series `timezone`** (v0.76.9+). It names the *scheduled* occurrence (a this-only edit that moves the event keeps it), and it is what split dates, `effective_from`/`effective_until`, `UNTIL` and "upcoming/past" filters compare against. Before v0.76.9 the worker wrote the UTC date, so a Monday 19:00 New York occurrence (00:00 UTC Tuesday) was dated Tuesday, and across DST changes dates were skipped or doubled. The frontend parses these values with `parseDateOnly()` and compares them with `dateInTimeZone(<series timezone>)` (`src/app/utils/date.utils.ts`; `current_version.timezone` on `schema_series_groups`), never `new Date('YYYY-MM-DD')`, `toISOString()` or the browser's date.

#### Converting existing rows (v0.76.9, one-time, in the migration)

Migration `v0-76-9-occurrence-date-local` converts the stored UTC dates once, in SQL, inside its transaction. No conversion code lives in the worker. The worker only got the expansion fixes that apply every day (`wallClockInstant()`, `planOccurrences()`).

The SQL evaluates exactly the RRULE subset it supports and never approximates the rest:
- **Supported**: `FREQ` DAILY, WEEKLY, MONTHLY or YEARLY, with `INTERVAL`, `COUNT`, `WKST`, `BYMONTH`, `BYMONTHDAY` (negative values included) and `BYDAY`. `BYDAY` ordinals (`1MO`, `-1FR`) work with MONTHLY, and with YEARLY when `BYMONTH` is set.
- Expansion is set-based. `pg_temp.occ_parse()` reads the rule and `pg_temp.occ_expand()` checks each day from `dtstart` against it. It follows rrule-go's semantics: DTSTART counts only if it matches, COUNT is counted from DTSTART, and invalid dates such as Feb 30 are skipped.
- **UNTIL is ignored.** Splits added it after the rows were expanded.
- This was checked against rrule-go v1.8.2 on 24 rules, 206 occurrences, all identical. The rules covered ordinals, last-day-of-month, WKST with INTERVAL, invalid dates and several DST zones.
- **Anything else is not evaluated**: BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR/BYMINUTE/BYSECOND, sub-daily FREQ, and BYDAY ordinals in DAILY, WEEKLY or YEARLY-without-BYMONTH. Every row of a group that uses one of these is left as stored. Its candidates are the local dates the stored UTC day can stand for: one in UTC, otherwise two.

Rules, applied per series group (`pg_temp.occ_plan()`, which builds temp tables only):
1. **The schedule decides.** A row's candidates are the occurrences whose UTC date equals the stored date. The row's own version is checked first; if it has none, the group's other versions are tried, earlier ones first (rows re-linked by pre-v0.76.5 splits). A single candidate wins, even if the booking was moved "this only".
2. **The booking only breaks ties.** A tie is two occurrences on one UTC date around a DST change. The evidence is the booking's start, or `original_time_slot` for rescheduled exceptions.
3. **Nothing is guessed.** These rows keep their stored date and are recorded as `unresolved` with their candidates:
   - a tie without evidence;
   - a row no occurrence explains (e.g. the schedule was edited in place);
   - every row of a group whose rule is not evaluated.

   All series of such a group are paused: `status = 'needs_attention'`, with the previous status kept in `metadata.time_slot_date_repair.prior_status`. The unchanged worker already skips every series that is not `active`, so it books nothing for them. `split_series_from_date` also refuses the group.
4. **One row per occurrence.** If two resolved rows land on one occurrence (an earlier split booked it twice), the row matching its own version keeps it, then the older row. The other row is **detached**: its booking stays as a standalone record and is reported. A row never moves onto a date that an unresolved row still holds.
5. **Orphans.** When two occurrences shared a UTC date, the UTC-keyed worker inserted the second one's booking without an instance row. For each resolved tie, the other occurrence is re-linked if exactly one unlinked booking matches it: the same slot and template, Status columns excluded (`metadata.occurrence_date_relink()`). If several match, a `conflict_skipped` placeholder row without a booking is added instead, so the worker does not book the occurrence a third time. It is reported.
6. **Split boundaries.** A version split before v0.76.9 ended on (UTC split date − 1), which can include the local split day. It now ends the day before its successor's first occurrence, and the original is kept in `detail.boundary_moved` for the revert.

The outcome is recorded in `metadata.time_slot_instance_date_repair`, one row per instance:
- the original `utc_date`;
- `local_date` and status (`repaired`, `unchanged`, `unresolved` or `detached`);
- `candidates`;
- `scheduled_start` and `scheduled_duration` of the matched occurrence. v0.76.9's edit tracking uses these to mark bookings moved "this only" as `rescheduled`.
- `detached_row`.

Per series, `metadata.time_slot_date_repair` holds the status, `prior_status` and a `detail` summary.

**Remedy**: `metadata.resolve_occurrence_date(instance_id, local_date)`.
- Who can run it: administrators only. It is SECURITY DEFINER with an `is_admin()`/DB-admin guard and a fixed `search_path`. It is not executable by PUBLIC, and PostgREST does not expose `metadata`.
- What it accepts: a date that is one of the row's candidates and free in its series.
- What it does: it re-links the other candidate's orphaned booking, and it resumes the group's series (restoring `prior_status`) once nothing in the group is unresolved.

**Upgrade and revert**:
- **Pre-flight**: `postgres/migrations/scripts/v0-76-9-occurrence-date-preflight.sql` runs the same planning code in a transaction it rolls back, and lists what the upgrade will not decide. `tests/functional/v0-76-9-occurrence-date-preflight-sync-test.sh` keeps the shared block identical to the migration's.
- **Re-runs**: the deploy is a no-op when its tables exist.
- **Locks**: the conversion takes row locks only, with no ACCESS EXCLUSIVE on `time_slot_instances`. Rows swap dates through a parking date instead of dropping the unique constraint.
- **Revert**: restores the saved UTC dates, the boundaries and the paused series' statuses. Rows that existed before the upgrade win collisions, and detached rows are re-linked when their date is free. It is lossy only where the UTC model cannot hold two occurrences on one date.

Verified by an upgrade from v0.76.8 data expanded by the old worker:
- daily and weekly New York series across spring-forward, and a daily Sydney series across DST start;
- an entity-less cancelled occurrence;
- a pre-v0.76.5 split with a re-linked cancellation;
- a "this only" move to the next day;
- a `BYSETPOS=4` weekend series, which is not evaluated and is resolved through the remedy;
- a pre-v0.76.5 split that had booked occurrences twice;
- a tie row holding the later day;
- a tie without evidence, resolved through the remedy.

### Expansion Algorithm

1. Parse RRULE with `dtstart` converted to `timezone`
2. Generate occurrence local times in that timezone (go-rrule default behavior)
3. Convert each occurrence to UTC for storage
4. Apply series `duration` to compute end time
5. Key the instance by its local date: `occurrenceDate()` formats the UTC instant **in the series timezone** (`seriesLocation()`, UTC when unset or invalid). This key is also the de-duplication key for re-expansion (`planOccurrences()`, which also drops a date repeated within one batch), so worker and stored rows must agree; that is why the v0.76.9 conversion runs in the migration, with the worker stopped, and series it cannot decide stay paused.
6. Wall-clock times inside a DST transition hour resolve like PostgreSQL's `AT TIME ZONE` (`wallClockInstant()`): an ambiguous time (fall back) takes the offset after the transition, a nonexistent one (spring forward) the offset before it. The SQL split and conversion functions use `AT TIME ZONE`, so both sides agree; `services/consolidated-worker-go/testdata/dst_wallclock_cases.json` pins it for Go (`TestWallClockInstant_MatchesPostgreSQL`) and PostgreSQL (`tests/functional/recurring-dst-agreement-test.sh`).

### DST Handling (Wall Clock Approach)

The system uses the **wall clock** approach for DST transitions:

- Uses IANA timezone database (updated quarterly via OS or container)
- **Always uses the local time specified in the RRULE**
- Example: "2 PM every Monday" stays at 2 PM local time year-round
- This matches user expectations for recurring meetings

**Trade-off**: Events may shift by 1 hour relative to UTC during DST transitions. This is intentional—users scheduling "team standup at 9 AM" expect it at 9 AM local time regardless of DST.

**Edge Cases**:
- If an occurrence falls during DST "spring forward" gap (e.g., 2:00 AM doesn't exist), the occurrence shifts to the next valid time (3:00 AM in most US timezones)
- If an occurrence falls during DST "fall back" overlap, the first occurrence (standard time) is used

### Frontend Display

- Calendar displays times in user's browser timezone
- Series edit UI shows times in series timezone with indicator
- Time zone conversion handled by FullCalendar's timezone support

> **Note**: Users in different timezones viewing the same series will see times converted to their local timezone. The series `timezone` field indicates which timezone was used for scheduling.

### Split Re-link (restored v0.76.9)

`split_series_from_date()` re-links the original version's instances on/after the split date to the new version (`UPDATE time_slot_instances SET series_id = <new>`). This existed since v0.38.5; the v0.76.5 security rewrite dropped it, so the old version kept its expanded future occurrences and the worker expanded the new version onto the same dates: every following occurrence existed twice. v0.76.9 restores it.

Re-linked occurrences then take the new schedule and template (next section).

Duplicates created by splits between v0.76.5 and v0.76.9 are not removed automatically (that would delete entity records). Find them with:

```sql
SELECT s.group_id, i.occurrence_date, array_agg(i.series_id ORDER BY i.series_id) AS versions,
       array_agg(i.entity_id ORDER BY i.series_id) AS entity_ids
FROM metadata.time_slot_instances i
JOIN metadata.time_slot_series s ON s.id = i.series_id
GROUP BY s.group_id, i.occurrence_date
HAVING count(*) > 1;
```

### Split Applies the New Schedule (v0.76.9)

Migration `v0-76-9-split-applies-new-schedule` implements design step 7 and closes the permission gap in the series RPCs.

- **Atomic split and edit**: `split_series_from_date(..., p_edited_entity_id, p_edited_values)` saves the edited occurrence in the same transaction as the split (the 5-argument call still works). The edit page sends only the fields the user changed: `p_edited_values` for the occurrence, and the same fields minus the time slot as `p_new_template`, which is merged into the original template. It then saves only the related data (M:M, galleries) and skips its own PATCH. A failed split saves nothing.
- **Following occurrences move in place**: `metadata.apply_split_to_future_instances()` moves every following non-exception occurrence to the new time of day, duration and template, keeping its entity record (approvals, payments and notes stay attached). Exceptions keep their own values. `COUNT` stays a series total: the new version gets the original COUNT minus the occurrences before the split. Versions whose COUNT an earlier split restarted are reported with a NOTICE at deploy time; no data is changed.
- **Exceptions are tracked**: an AFTER UPDATE trigger, `zz_time_slot_series_instance_modified` (`metadata.mark_series_instance_modified()`), marks an occurrence edited outside the series RPCs as an exception. If its time slot changed it becomes `rescheduled` and keeps `original_time_slot`; any other change, an approval for example, makes it `modified`. Splits and template updates then leave it alone. The series RPCs set the transaction-local GUC `civic_os.series_write` to bypass the trigger. The trigger is attached to every entity table that has series, and again whenever a series is inserted by any path (`attach_series_modified_trigger`). Existing rows were checked once by the migration. A booking no longer on the slot that the occurrence-date conversion matched it to (`time_slot_instance_date_repair.scheduled_start`) is marked `rescheduled`; then template drift is marked `modified`.
- **Status never propagates**: Status columns (FKs to `metadata.statuses`) are stripped from every template (`metadata.strip_series_status_columns()`). Workflow changes go through actions.
- **Permissions**: both `split_series_from_date` and `update_series_template` require `has_permission(entity_table, 'update')` in addition to the owner-or-admin check, set `search_path`, and have EXECUTE revoked from PUBLIC. Before this release a series owner without update permission could rewrite records through a template, for example approving their own reservation requests.
- **Refusals**:
  - a second split of the group on the same date;
  - a split on or before the version's own first occurrence (use "all occurrences");
  - an edited occurrence moved to or before the previous occurrence;
  - a change of day that would detach following occurrences edited individually;
  - a split while the group has occurrence dates the conversion left unresolved.
- **Timezone**: `time_slot_series.timezone` must be an exact `pg_timezone_names` name (`validate_series_timezone`). The worker's `LoadLocation` would reject offsets and wrong-case names. The frontend checks the same rule with `isIanaTimeZone()` (`src/app/utils/date.utils.ts`).

Verified by `tests/functional/recurring-series-split-test.sh`, which runs as `authenticator` with real JWTs: permission refusals, Status non-propagation, this-only edits marked `modified`, the atomic split, COUNT, the refusals, 5-argument compatibility and timezone validation.

### Frontend: `dtstart` for a Series Split (v0.76.7 fix)

`split_series_from_date(p_new_dtstart TIMESTAMP)` expects wall-clock time in the series `timezone`, but the edit form holds the occurrence's `time_slot` as UTC instants. `recordEditor`'s `saveWithScope('this_and_future')` reads the series' `timezone`, `dtstart` and `time_slot_property` (`public.time_slot_series`, readable by everyone under RLS) and passes them to `buildSplitSchedule()` (`packages/core/src/transform/series-schedule.ts`), which converts the edited start instant into that timezone through core's `wallClockAt` (UTC when the series has none, like the worker), sends the edited length as `p_new_duration`, and, when the edit didn't touch the time slot, keeps the original time of day and duration. If the schedule cannot be read the split is aborted rather than sent with a guessed `dtstart`. Since v0.76.9 the occurrence is saved inside the split RPC, so a failure saves nothing. Earlier versions sent the UTC ISO start, which PostgreSQL cast to `timestamp` by dropping the zone, shifting the new version by the UTC offset. See `docs/development/DATETIME_HANDLING.md` (Recurring Series `dtstart`).

---

## Conflict Preview & Resolution

> **Implementation Status (v0.38.5):**
> - **Backend**: `preview_recurring_conflicts()` RPC and `ConflictPreviewComponent` exist and work.
> - **edit-recurring-time-slot**: Conflict preview is wired up — users can click "Preview Schedule" to see conflicts before saving.
> - **create-series-wizard**: **NOT YET IMPLEMENTED.** The wizard shows occurrence dates without conflict checking. Conflicts are enforced server-side via GIST exclusion constraints — conflicting slots are silently skipped at expansion time.
> - **To wire it up**: Call `RecurringService.previewConflicts()` in the wizard's `loadPreview()` method and merge results into `previewOccurrences`. The RPC, service method, and UI component all exist; they just need to be connected. See `edit-recurring-time-slot.component.ts` for the working pattern.

### The Conflict Problem

When a user creates "every Monday 2-4pm for 6 months", some Mondays may already have conflicting bookings. The GIST exclusion constraint would reject the batch INSERT.

### Solution: Preview Before Commit

```sql
CREATE OR REPLACE FUNCTION preview_recurring_conflicts(
  p_entity_table TEXT,
  p_scope_column TEXT,      -- e.g., 'resource_id'
  p_scope_value TEXT,       -- e.g., '5'
  p_occurrences TSTZRANGE[] -- Array of time slots to check
) RETURNS TABLE (
  occurrence_index INTEGER,
  occurrence_slot TSTZRANGE,
  has_conflict BOOLEAN,
  conflicting_id BIGINT,
  conflicting_display TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER;
```

### Conflict Resolution UX (Design Target)

```
┌─────────────────────────────────────────────────────────────┐
│ Creating: Weekly on Mondays, 2:00 PM - 4:00 PM              │
│ Starting: Jan 6, 2025  Ending: Jun 30, 2025 (26 occurrences)│
├─────────────────────────────────────────────────────────────┤
│ ✅ Jan 6, 2025      2:00 PM - 4:00 PM     Available         │
│ ✅ Jan 13, 2025     2:00 PM - 4:00 PM     Available         │
│ ❌ Jan 20, 2025     2:00 PM - 4:00 PM     CONFLICT          │
│    └─ Conflicts with: "Team Meeting" (Reservation #42)      │
│ ✅ Jan 27, 2025     2:00 PM - 4:00 PM     Available         │
│ ... (22 more available)                                      │
├─────────────────────────────────────────────────────────────┤
│ Summary: 25 available, 1 conflict                            │
│                                                              │
│ ┌─────────────────────┐  ┌──────────────────────────────┐   │
│ │ Create 25 Available │  │ Cancel - Adjust Times First  │   │
│ └─────────────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Option 1: "Create Available Only"**
- Create instances for non-conflicting dates
- Create junction records with `entity_id=NULL, exception_type='conflict_skipped'` for conflicts
- User can later try to reschedule those specific dates

**Option 2: "Cancel - Adjust Times First"**
- Return to form to adjust time or reduce series
- Helps user find a conflict-free slot

---

## Editing Behavior

### Edit Scope Options

When editing an instance that belongs to a series:

```
┌─────────────────────────────────────────────────────────────┐
│ Edit Reservation                                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  This reservation is part of a recurring series.            │
│  How would you like to apply your changes?                  │
│                                                              │
│  ○ This occurrence only                                     │
│  ○ This and all future occurrences                          │
│  ○ All occurrences in series                                │
│                                                              │
│  [Cancel]  [Continue]                                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Edit: "This Occurrence Only"

```sql
-- 1. Update the entity record directly
UPDATE reservations
SET time_slot = '[2025-01-10 15:00:00, 2025-01-10 17:00:00)'
WHERE id = 103;

-- 2. Mark as exception in junction table
UPDATE metadata.time_slot_instances
SET
  is_exception = TRUE,
  exception_type = 'rescheduled',
  original_time_slot = '[2025-01-10 14:00:00, 2025-01-10 16:00:00)',
  exception_at = NOW(),
  exception_by = current_user_id()
WHERE series_id = 1 AND occurrence_date = '2025-01-10';
```

### Edit: "This and All Future" (Series Split)

Creates a new series version within the same group:

```sql
-- Helper function to safely modify RRULE UNTIL clause
CREATE OR REPLACE FUNCTION modify_rrule_until(p_rrule TEXT, p_until DATE) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_result TEXT;
  v_until_str TEXT;
BEGIN
  v_until_str := to_char(p_until, 'YYYYMMDD') || 'T235959Z';

  -- Remove existing UNTIL or COUNT (can't have both)
  v_result := regexp_replace(p_rrule, ';?(UNTIL|COUNT)=[^;]+', '', 'g');

  -- Add new UNTIL
  v_result := v_result || ';UNTIL=' || v_until_str;

  -- Clean up any leading/trailing/duplicate semicolons
  v_result := regexp_replace(v_result, '^;|;$', '', 'g');
  v_result := regexp_replace(v_result, ';;+', ';', 'g');

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION split_series_from_date(
  p_series_id BIGINT,
  p_split_date DATE,
  p_new_dtstart TIMESTAMP,  -- wall-clock in the series timezone (TIMESTAMPTZ before v0.38.5)
  p_new_duration INTERVAL DEFAULT NULL,
  p_new_template JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_original RECORD;
  v_group_id BIGINT;
  v_new_version INT;
  v_new_series_id BIGINT;
BEGIN
  -- 1. Get original series
  SELECT * INTO v_original
  FROM metadata.time_slot_series
  WHERE id = p_series_id;

  -- 2. Ensure series has a group (create if standalone)
  IF v_original.group_id IS NULL THEN
    INSERT INTO metadata.time_slot_series_groups (display_name, created_by)
    VALUES (
      COALESCE(v_original.entity_template->>'purpose', 'Recurring Schedule'),
      current_user_id()
    )
    RETURNING id INTO v_group_id;

    UPDATE metadata.time_slot_series
    SET group_id = v_group_id, version_number = 1
    WHERE id = p_series_id;
  ELSE
    v_group_id := v_original.group_id;
  END IF;

  -- 3. Get next version number
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_new_version
  FROM metadata.time_slot_series
  WHERE group_id = v_group_id;

  -- 4. Terminate original series (use helper to safely modify RRULE)
  UPDATE metadata.time_slot_series
  SET
    effective_until = p_split_date - INTERVAL '1 day',
    rrule = modify_rrule_until(v_original.rrule, p_split_date - INTERVAL '1 day')
  WHERE id = p_series_id;

  -- 5. Create new version
  INSERT INTO metadata.time_slot_series (
    group_id, version_number, effective_from, effective_until,
    entity_table, entity_template, rrule, dtstart, duration, timezone, created_by
  ) VALUES (
    v_group_id,
    v_new_version,
    p_split_date,
    NULL,  -- Ongoing
    v_original.entity_table,
    COALESCE(p_new_template, v_original.entity_template),
    v_original.rrule,
    p_new_dtstart,
    COALESCE(p_new_duration, v_original.duration),
    v_original.timezone,
    current_user_id()
  )
  RETURNING id INTO v_new_series_id;

  -- 6. Re-link future instances to new series
  UPDATE metadata.time_slot_instances
  SET series_id = v_new_series_id
  WHERE series_id = p_series_id
    AND occurrence_date >= p_split_date;

  -- 7. Update future entity records with new template values
  PERFORM update_future_entity_records(v_new_series_id, p_new_template);

  RETURN v_new_series_id;
END;
$$;
```

### Edit: "All Occurrences"

```sql
-- 1. Update the series template
UPDATE metadata.time_slot_series
SET entity_template = jsonb_set(entity_template, '{attendee_count}', '15')
WHERE id = 1;

-- 2. Update all non-exception entity records
UPDATE reservations r
SET attendee_count = 15
FROM metadata.time_slot_instances tsi
WHERE tsi.entity_table = 'reservations'
  AND tsi.entity_id = r.id
  AND tsi.series_id = 1
  AND tsi.is_exception = FALSE;  -- Preserve exceptions
```

---

## Deletion Behavior

### Delete Scopes (v0.78.1)

Deleting a record that belongs to a series opens a scope dialog on the Detail page. `recordViewer.deleteRecord(scope)` (`packages/core/src/facades/record-viewer.ts`) sends one RPC per scope:

| Scope | RPC | Effect |
|---|---|---|
| This occurrence only | `cancel_series_occurrence(entity_table, entity_id, NULL)` | Deletes the record; its instance row stays as a `cancelled` tombstone so the worker never re-creates that date |
| This and future occurrences | `end_series_from_date(series_id, occurrence_date)` | Ends the series the day before the occurrence and deletes every record from that date on, later versions included |
| All occurrences | `delete_series_group(group_id)` | Deletes every version, every record and the group |

**Hard delete.** All three remove the entity records. There is no soft delete in the framework yet; until there is, a deleted record can only be recovered from a backup. A restricting foreign key on the entity (a payment, a note table without `ON DELETE CASCADE`) raises, the whole RPC rolls back, and the page shows the constraint error through `ErrorService`.

**Permissions (v0.78.1).** Every delete RPC requires the series owner or an admin (through the group, or the series' own `created_by` when it has no group) **and** `has_permission(entity_table, 'delete')`, as v0.76.9 required `update` for edits. Before v0.78.1, `delete_series_with_instances` and `delete_series_group` checked ownership only, and `cancel_series_occurrence` checked `delete` only for records outside a series, so an owner whose role had lost `delete` could still delete the series' records. All three now set `search_path` too.

Before v0.78.1 the Detail page's "This and future occurrences" canceled only the one occurrence and left the series running, so the following occurrences stayed and the worker kept expanding.

### Delete: This and Following (`end_series_from_date`, v0.78.1)

`end_series_from_date(p_series_id BIGINT, p_occurrence_date DATE) RETURNS JSONB`, `SECURITY DEFINER`. `p_occurrence_date` is the occurrence's `occurrence_date` from `get_series_membership`, the local date in the series timezone.

**Guards**, in `split_series_from_date`'s order: authentication; the series exists (else `{success: false, message: 'Series not found'}`); no unresolved date repair in the group; owner or admin; `<entity>:delete`; an instance row exists for the series and date (a stale page or a forged date raises); the version has not already ended before that date (raises, with a hint to reload).

**Body**, one transaction:
1. Lock the version and the group's later versions (`FOR UPDATE`), so a concurrent split or delete of them waits.
2. Targets: this version's instances with `occurrence_date >= p_occurrence_date`, and every instance of a later version in the group. Exceptions and occurrences moved "this only" are included: the scope is by scheduled date.
3. Delete the target instance rows (tombstones included), then the entity rows they named (`DELETE ... RETURNING entity_id`). Deleting the instances first means a record the worker committed before that statement goes with its occurrence rather than staying behind with none.
4. Delete the later versions (`recurring.allow_direct_delete`, transaction-local).
5. When no earlier occurrence of the version is left, delete the version too; otherwise set `effective_until = date - 1` and `rrule = modify_rrule_until(rrule, date - 1)`, as a split does. The status stays `active`, so the worker keeps expanding up to the new `UNTIL`.
   "No earlier occurrence" rather than "the date is `effective_from`": the worker leaves out a `DTSTART` that does not match the rule (a Monday start with `BYDAY=WE`), so a version's first occurrence can fall after `effective_from`.
6. Delete the group if no version is left.
7. Return `{success, message, series_id, group_id, entities_deleted, versions_deleted}`.

**Why the RRULE, not only `effective_until`.** The worker never reads `effective_until`; it stops at the RRULE's `UNTIL` (or `COUNT`). It expands on wall-clock numbers tagged UTC, so `UNTIL=<date-1>T235959Z` is the end of that local day in any zone: a Kolkata or New York series ends on the right local date without a zone conversion. `tests/e2e/integrity-series.spec.ts` (cases E and F) re-runs `expand_series_instances` after the delete and checks that nothing comes back.

### Delete: Single Instance ("Cancel This Occurrence")

```sql
CREATE OR REPLACE FUNCTION cancel_series_occurrence(
  p_entity_table TEXT,
  p_entity_id BIGINT,
  p_reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_instance RECORD;
BEGIN
  -- 1. Get instance info
  SELECT * INTO v_instance
  FROM metadata.time_slot_instances
  WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

  IF NOT FOUND THEN
    -- Not part of a series, just delete normally
    EXECUTE format('DELETE FROM %I WHERE id = $1', p_entity_table) USING p_entity_id;
    RETURN;
  END IF;

  -- 2. Mark junction as cancelled (keep row for history)
  UPDATE metadata.time_slot_instances
  SET
    entity_id = NULL,  -- No longer points to entity record
    is_exception = TRUE,
    exception_type = 'cancelled',
    exception_reason = p_reason,
    exception_at = NOW(),
    exception_by = current_user_id()
  WHERE id = v_instance.id;

  -- 3. Delete the entity record
  EXECUTE format('DELETE FROM %I WHERE id = $1', p_entity_table) USING p_entity_id;
END;
$$;
```

**Result**: Junction row stays with `entity_id=NULL` to preserve knowledge that "this date was supposed to have an occurrence but was cancelled."

### Delete: Entire Series

```sql
CREATE OR REPLACE FUNCTION delete_series_with_instances(
  p_series_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_series RECORD;
  v_entity_ids BIGINT[];
BEGIN
  -- 1. Get series info
  SELECT * INTO v_series
  FROM metadata.time_slot_series WHERE id = p_series_id;

  -- 2. Collect all entity IDs
  SELECT array_agg(entity_id) INTO v_entity_ids
  FROM metadata.time_slot_instances
  WHERE series_id = p_series_id AND entity_id IS NOT NULL;

  -- 3. Delete entity records
  IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
    EXECUTE format(
      'DELETE FROM %I WHERE id = ANY($1)',
      v_series.entity_table
    ) USING v_entity_ids;
  END IF;

  -- 4. Delete series (cascades to instances via FK)
  DELETE FROM metadata.time_slot_series WHERE id = p_series_id;

  -- 5. If this was the last series in the group, delete the group
  DELETE FROM metadata.time_slot_series_groups g
  WHERE g.id = v_series.group_id
    AND NOT EXISTS (
      SELECT 1 FROM metadata.time_slot_series s WHERE s.group_id = g.id
    );
END;
$$;
```

### Delete: Entire Group (All Versions)

```sql
CREATE OR REPLACE FUNCTION delete_series_group(
  p_group_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_series RECORD;
BEGIN
  -- Delete each series in the group
  FOR v_series IN
    SELECT id FROM metadata.time_slot_series WHERE group_id = p_group_id
  LOOP
    PERFORM delete_series_with_instances(v_series.id);
  END LOOP;

  -- Group is deleted via cascade when last series is deleted
END;
$$;
```

### Instance State Machine

```
                    ┌─────────────────┐
                    │  RRULE Expands  │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    ACTIVE       │
                    │  entity_id: 123 │
                    │  is_exception: F│
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   MODIFIED    │   │  RESCHEDULED  │   │   CANCELLED   │
│ entity_id: 123│   │ entity_id: 123│   │ entity_id:NULL│
│ is_exception:T│   │ is_exception:T│   │ is_exception:T│
│ type: modified│   │ type: resched │   │ type:cancelled│
└───────────────┘   └───────────────┘   └───────────────┘

Special case (never created):
┌─────────────────────┐
│  CONFLICT_SKIPPED   │
│  entity_id: NULL    │
│  is_exception: TRUE │
│  type:conflict_skipped
└─────────────────────┘
```

### Summary: Deletion/Edit Rules

| Action | Series | Junction Row | Entity Record |
|--------|--------|--------------|---------------|
| **Delete single instance** | Unchanged | `entity_id=NULL, type='cancelled'` | Deleted |
| **Conflict during creation** | Unchanged | `entity_id=NULL, type='conflict_skipped'` | Never created |
| **Delete entire series** | Deleted | Cascade deleted | Deleted via RPC |
| **Delete entire group** | All versions deleted | Cascade deleted | All deleted via RPC |
| **Edit "this only"** | Unchanged | `is_exception=TRUE, type='modified'` | Updated |
| **Edit "this and future"** | Split into two versions | Re-linked to new version | Moved to new time/template (skip exceptions) |
| **Edit "all"** | Template updated | Non-exceptions unchanged | Updated (skip exceptions) |

---

## UI Components

### Series Group Management Page

Users manage **groups** (logical containers), not individual series versions:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Manage Recurring Schedules                                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─ Filters ───────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  Entity: [All ▼]  Status: [● Active ○ Ended ○ All]          │    │
│  │                                                              │    │
│  │  Has instances in: [Date range picker]  🔍 Search...        │    │
│  │                                                              │    │
│  │  [Admin only: Created by: [All users ▼]]                    │    │
│  │                                                              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Showing 2 of 15 recurring schedules                                 │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 🔵 Weekly Team Standup                        [Reservations] │    │
│  │    Engineering team sync                                     │    │
│  │    Mon, Wed, Fri • Started Jan 6, 2025                       │    │
│  │    78 occurrences • 2 versions                               │    │
│  │                                            [View] [Edit]     │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 🟢 Monthly Board Meeting                      [Reservations] │    │
│  │    Third Thursday of each month                              │    │
│  │    Started Feb 2025                                          │    │
│  │    12 occurrences • 1 version                                │    │
│  │                                            [View] [Edit]     │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

#### Available Filters

| Filter | Type | Description | Visibility |
|--------|------|-------------|------------|
| **Entity Type** | Multi-select dropdown | Filter by entity table (reservations, classes, etc.) | All privileged |
| **Status** | Radio group | Active (ongoing), Ended (effective_until passed), All | All privileged |
| **Has Instances In** | Date range picker | Series with instances overlapping the date range | All privileged |
| **Search** | Text input | Full-text search on group name and description | All privileged |
| **Created By** | User picker | Filter by series owner (for accountability) | All privileged |
| **Color** | Color chip selector | Filter by group color (if meaningful) | All privileged |

#### Filter Query Implementation

```sql
-- View with filter support
CREATE VIEW metadata.series_groups_filtered AS
SELECT
  g.*,

  -- For entity type filter
  (
    SELECT array_agg(DISTINCT s.entity_table)
    FROM metadata.time_slot_series s
    WHERE s.group_id = g.id
  ) AS entity_tables,

  -- For status filter
  CASE
    WHEN EXISTS (
      SELECT 1 FROM metadata.time_slot_series s
      WHERE s.group_id = g.id AND s.effective_until IS NULL
    ) THEN 'active'
    ELSE 'ended'
  END AS status,

  -- For date range filter (min/max instance dates)
  (
    SELECT MIN(tsi.occurrence_date)
    FROM metadata.time_slot_instances tsi
    JOIN metadata.time_slot_series s ON s.id = tsi.series_id
    WHERE s.group_id = g.id
  ) AS first_occurrence,
  (
    SELECT MAX(tsi.occurrence_date)
    FROM metadata.time_slot_instances tsi
    JOIN metadata.time_slot_series s ON s.id = tsi.series_id
    WHERE s.group_id = g.id
  ) AS last_occurrence,

  -- For search (uses tsvector if enabled)
  to_tsvector('english', g.display_name || ' ' || COALESCE(g.description, '')) AS search_vector

FROM metadata.time_slot_series_groups g;

-- Example filtered query
SELECT * FROM metadata.series_groups_filtered
WHERE
  'reservations' = ANY(entity_tables)           -- Entity filter
  AND status = 'active'                          -- Status filter
  AND first_occurrence <= '2025-03-31'           -- Date range
  AND last_occurrence >= '2025-03-01'
  AND search_vector @@ to_tsquery('standup');    -- Search
```

#### Angular Filter Component

```typescript
// src/app/pages/series-group-management/series-group-management.page.ts

interface SeriesGroupFilters {
  entityTables: string[];      // Multi-select
  status: 'active' | 'ended' | 'all';
  dateRange: { start?: Date; end?: Date };
  search: string;
  createdBy?: string;          // All users with series:read can filter
  colors?: string[];           // Optional
}

export class SeriesGroupManagementPage {
  filters = signal<SeriesGroupFilters>({
    entityTables: [],
    status: 'active',
    dateRange: {},
    search: ''
  });

  // Available entity types (fetched from schema)
  availableEntities = signal<{ table: string; displayName: string }[]>([]);

  // Available users for "Created By" filter
  availableUsers = signal<{ id: string; displayName: string }[]>([]);

  private permissionService = inject(PermissionService);
  private router = inject(Router);

  ngOnInit() {
    // Guard: Check permission on series tables (RBAC-based, not role-based)
    this.permissionService.hasPermission('time_slot_series_groups', 'read')
      .pipe(take(1))
      .subscribe(hasPermission => {
        if (!hasPermission) {
          this.router.navigate(['/']);
          return;
        }

        this.loadFilters();
      });
  }

  private loadFilters() {
    // Load entities that have supports_recurring=true
    this.schemaService.getRecurringEntities().subscribe(entities => {
      this.availableEntities.set(entities);
    });

    // Load users for "Created By" filter
    this.userService.getSeriesCreators().subscribe(users => {
      this.availableUsers.set(users);
    });
  }

  buildQueryParams(): string {
    const f = this.filters();
    const params: string[] = [];

    if (f.entityTables.length > 0) {
      params.push(`entity_tables=ov.{${f.entityTables.join(',')}}`);
    }
    if (f.status !== 'all') {
      params.push(`status=eq.${f.status}`);
    }
    if (f.dateRange.start) {
      params.push(`last_occurrence=gte.${f.dateRange.start.toISOString().split('T')[0]}`);
    }
    if (f.dateRange.end) {
      params.push(`first_occurrence=lte.${f.dateRange.end.toISOString().split('T')[0]}`);
    }
    if (f.search) {
      params.push(`search_vector=fts.${f.search}`);
    }
    if (f.createdBy) {
      params.push(`created_by=eq.${f.createdBy}`);
    }

    return params.join('&');
  }
}
```

### Series Group Detail View (Version Timeline)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Weekly Team Standup                                     [Edit Name] │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Schedule Versions                                                   │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
│  ┌─ Version 2 (Current) ──────────────────────────────────────────┐ │
│  │  Mar 1, 2025 → Ongoing                                          │ │
│  │  Every Mon, Wed, Fri at 3:00 PM - 5:00 PM                       │ │
│  │  Room: Conference Room A                                        │ │
│  │  Attendees: 10                                                  │ │
│  │                                                      [Edit]     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─ Version 1 (Historical) ───────────────────────────────────────┐ │
│  │  Jan 6, 2025 → Feb 28, 2025                                     │ │
│  │  Every Mon, Wed, Fri at 2:00 PM - 4:00 PM                       │ │
│  │  Room: Conference Room A                                        │ │
│  │  Attendees: 10                                                  │ │
│  │                                              [View Instances]   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│  Upcoming Instances                                                  │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
│  ✅ Mon, Mar 3    3:00 PM - 5:00 PM                                 │
│  ✅ Wed, Mar 5    3:00 PM - 5:00 PM                                 │
│  ⚠️  Fri, Mar 7    3:00 PM - 5:00 PM  (Modified: ends 5:30 PM)     │
│  ✅ Mon, Mar 10   3:00 PM - 5:00 PM                                 │
│  ...                                                                 │
│                                                                      │
│  [View All]  [View Calendar]  [Delete Series]                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### New Components Required

| Component | Purpose | Key Features |
|-----------|---------|--------------|
| `SeriesGroupManagementPage` | List/manage all recurring schedules | Group list, summary stats, quick actions |
| `SeriesGroupDetailComponent` | View group with version timeline | Version history, upcoming instances, exceptions |
| `RecurrenceRuleEditorComponent` | RRULE builder UI | Frequency picker, day selector, end condition |
| `RecurringTimeSlotEditComponent` | Form control for recurring slots | Toggle one-time/recurring, entity fields + recurrence |
| `ConflictPreviewComponent` | Shows conflicts before creation | Color-coded list, resolution options |
| `ExceptionEditorComponent` | Modal for editing single occurrence | Scope selector, cancel/reschedule |
| `SeriesVersionTimelineComponent` | Shows version history | Effective dates, what changed |

### Property Type Detection

```typescript
// src/app/services/schema.service.ts

// NOTE: Property type detection is unchanged - all time_slot columns are TimeSlot type.
// Recurring behavior is determined by entity.supports_recurring, not property type.
private getPropertyType(val: SchemaPropertyTable): EntityPropertyType {
  if (val.udt_name === 'time_slot') {
    return EntityPropertyType.TimeSlot;  // Recurring is entity-level config
  }
  // ... rest
}

// Check for recurring-enabled entities
getRecurringEntities(): Observable<SchemaEntityTable[]> {
  return this.getEntities().pipe(
    map(entities => entities.filter(e => e.supports_recurring === true))
  );
}
```

### FullCalendar Integration

```bash
npm install @fullcalendar/rrule rrule
```

Calendar events from a group share the group's color, regardless of which version they belong to.

---

## Exception Detection & Angular Integration

> **⚠️ IMPORTANT IMPLEMENTATION NOTE**
>
> This section requires careful implementation. The system must reliably detect when a user modifies a series instance (vs. a standalone record) and trigger the appropriate RPCs. Getting this wrong could result in data inconsistency or lost changes.

### Core Challenge: Detecting Series Membership

When a user opens an entity record for editing, the frontend must determine:

1. **Is this record part of a series?** (junction table lookup)
2. **If yes, what was the original template data?** (to detect if changes constitute an "exception")
3. **What edit scope options should be shown?** (this only, this+future, all)

### Junction Table Lookup

The Angular services must augment entity data with series membership:

```typescript
// src/app/services/recurring.service.ts

interface SeriesMembership {
  isMember: boolean;
  seriesId?: number;
  groupId?: number;
  groupName?: string;
  occurrenceDate?: string;
  isException?: boolean;
  exceptionType?: 'modified' | 'rescheduled' | 'cancelled' | 'conflict_skipped';
  originalTemplate?: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class RecurringService {
  private http = inject(HttpClient);
  private config = inject(ConfigService);

  /**
   * Check if an entity record belongs to a recurring series.
   * Called when loading Detail or Edit pages for entities with supports_recurring=true.
   */
  getSeriesMembership(entityTable: string, entityId: number): Observable<SeriesMembership> {
    // Query junction + series + group in one call
    const url = `${this.config.postgrestUrl}/time_slot_instances?` +
      `entity_table=eq.${entityTable}&entity_id=eq.${entityId}&` +
      `select=*,series:time_slot_series(*,group:time_slot_series_groups(*))`;

    return this.http.get<any[]>(url).pipe(
      map(results => {
        if (!results.length) {
          return { isMember: false };
        }

        const instance = results[0];
        return {
          isMember: true,
          seriesId: instance.series_id,
          groupId: instance.series?.group_id,
          groupName: instance.series?.group?.display_name,
          occurrenceDate: instance.occurrence_date,
          isException: instance.is_exception,
          exceptionType: instance.exception_type,
          originalTemplate: instance.series?.entity_template
        };
      })
    );
  }
}
```

### Detecting Modifications (Template Drift)

When saving, compare current values to the series template to detect if this is now an "exception":

```typescript
// src/app/pages/edit/edit.page.ts

interface ChangeAnalysis {
  hasChanges: boolean;
  changedFields: string[];
  timeSlotChanged: boolean;
  templateDriftFields: string[];  // Fields that differ from series template
}

private analyzeChanges(
  formValue: Record<string, unknown>,
  originalRecord: Record<string, unknown>,
  seriesTemplate?: Record<string, unknown>
): ChangeAnalysis {
  const changedFields: string[] = [];
  const templateDriftFields: string[] = [];

  for (const [key, value] of Object.entries(formValue)) {
    // Detect changes from original record
    if (!this.isEqual(value, originalRecord[key])) {
      changedFields.push(key);
    }

    // Detect drift from series template (if part of series)
    if (seriesTemplate && key in seriesTemplate) {
      if (!this.isEqual(value, seriesTemplate[key])) {
        templateDriftFields.push(key);
      }
    }
  }

  return {
    hasChanges: changedFields.length > 0,
    changedFields,
    timeSlotChanged: changedFields.includes('time_slot'),
    templateDriftFields
  };
}
```

### Edit Scope Decision Flow

```
                    ┌─────────────────────────┐
                    │  User clicks "Save"     │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │  Is record in series?   │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │ NO              │ YES             │
              ▼                 ▼                 │
    ┌─────────────────┐  ┌─────────────────────┐ │
    │ Normal update   │  │ Analyze changes     │ │
    │ (standard REST) │  └──────────┬──────────┘ │
    └─────────────────┘             │             │
                                    ▼             │
                        ┌───────────────────────┐ │
                        │ Show scope dialog     │ │
                        │ "This only" /         │ │
                        │ "This and future" /   │ │
                        │ "All occurrences"     │ │
                        └───────────┬───────────┘ │
                                    │             │
        ┌───────────────────────────┼─────────────┘
        │                           │
        ▼                           ▼                           ▼
┌───────────────┐         ┌───────────────────┐       ┌───────────────┐
│ "This only"   │         │ "This and future" │       │ "All"         │
├───────────────┤         ├───────────────────┤       ├───────────────┤
│ 1. Update     │         │ 1. Call RPC:      │       │ 1. Call RPC:  │
│    entity     │         │    split_series_  │       │    update_    │
│    record     │         │    from_date()    │       │    series_    │
│               │         │                   │       │    template() │
│ 2. If drifted │         │ 2. Creates new    │       │               │
│    from       │         │    series version │       │ 2. Updates    │
│    template:  │         │    in same group  │       │    all non-   │
│    Mark as    │         │                   │       │    exception  │
│    exception  │         │ 3. Updates all    │       │    instances  │
│    in         │         │    future         │       │               │
│    junction   │         │    instances      │       │               │
└───────────────┘         └───────────────────┘       └───────────────┘
```

### Angular Component Changes

#### EditPage Modifications

```typescript
// src/app/pages/edit/edit.page.ts

export class EditPage implements OnInit {
  // New signals for series context
  seriesMembership = signal<SeriesMembership | null>(null);
  editScope = signal<'this_only' | 'this_and_future' | 'all' | null>(null);
  showScopeDialog = signal(false);

  private recurringService = inject(RecurringService);

  async ngOnInit() {
    // Existing init logic...

    // If entity has supports_recurring=true, check membership
    if (this.entity.supports_recurring) {
      const membership = await firstValueFrom(
        this.recurringService.getSeriesMembership(this.entityName, this.entityId)
      );
      this.seriesMembership.set(membership);
    }
  }

  async onSave() {
    if (this.seriesMembership()?.isMember && !this.editScope()) {
      // Show scope selection dialog
      this.showScopeDialog.set(true);
      return;
    }

    await this.performSave();
  }

  private async performSave() {
    const scope = this.editScope();
    const membership = this.seriesMembership();
    const formValue = this.form.value;

    if (!membership?.isMember || scope === 'this_only') {
      // Standard update + mark as exception if drifted
      await this.updateRecord(formValue);

      if (membership?.isMember) {
        const analysis = this.analyzeChanges(formValue, this.originalRecord, membership.originalTemplate);
        if (analysis.templateDriftFields.length > 0) {
          await this.markAsException(membership.seriesId, membership.occurrenceDate, analysis);
        }
      }
    }
    else if (scope === 'this_and_future') {
      // Split series RPC
      await firstValueFrom(this.dataService.rpc('split_series_from_date', {
        series_id: membership.seriesId,
        split_date: membership.occurrenceDate,
        new_template: formValue
      }));
    }
    else if (scope === 'all') {
      // Update template RPC
      await firstValueFrom(this.dataService.rpc('update_series_template', {
        series_id: membership.seriesId,
        new_template: formValue
      }));
    }

    this.navigateToDetail();
  }
}
```

#### DetailPage Modifications

```typescript
// src/app/pages/detail/detail.page.ts

export class DetailPage implements OnInit {
  seriesMembership = signal<SeriesMembership | null>(null);

  ngOnInit() {
    // Existing init...

    // Check series membership for recurring-enabled entities
    if (this.hasRecurringProperty()) {
      this.loadSeriesMembership();
    }
  }

  // Template shows series badge and link to group management
  // @if (seriesMembership()?.isMember) {
  //   <div class="badge badge-info gap-2">
  //     <svg>...</svg>
  //     Part of: {{ seriesMembership().groupName }}
  //     <a [routerLink]="['/recurring-groups', seriesMembership().groupId]">View Series</a>
  //   </div>
  // }
}
```

### RPC Contracts for Frontend

```typescript
// src/app/services/data.service.ts - RPC type definitions

interface MarkAsExceptionParams {
  entity_table: string;
  entity_id: number;
  exception_type: 'modified' | 'rescheduled';
  original_time_slot?: string;  // For rescheduled type
  changed_fields?: string[];    // For audit
}

interface SplitSeriesParams {
  series_id: number;
  split_date: string;  // ISO date
  new_template?: Record<string, unknown>;
  new_dtstart?: string;
  new_duration?: string;
}

interface UpdateSeriesTemplateParams {
  series_id: number;
  new_template: Record<string, unknown>;
  skip_exceptions?: boolean;  // Default true - preserve exceptions
}

interface CancelOccurrenceParams {
  entity_table: string;
  entity_id: number;
  reason?: string;
}
```

### Delete Flow for Series Instances

```typescript
// src/app/pages/detail/detail.page.ts

async onDelete() {
  const membership = this.seriesMembership();

  if (membership?.isMember) {
    // Show series-aware delete dialog
    const result = await this.showDeleteScopeDialog();

    switch (result) {
      case 'this_only':
        // Cancel single occurrence (keeps junction row)
        await firstValueFrom(this.dataService.rpc('cancel_series_occurrence', {
          entity_table: this.entityName,
          entity_id: this.entityId,
          reason: 'Cancelled by user'
        }));
        break;

      case 'this_and_future':
        // Delete this + all future instances
        await firstValueFrom(this.dataService.rpc('delete_series_from_date', {
          series_id: membership.seriesId,
          from_date: membership.occurrenceDate
        }));
        break;

      case 'entire_series':
        // Delete entire series
        await firstValueFrom(this.dataService.rpc('delete_series_with_instances', {
          series_id: membership.seriesId
        }));
        break;
    }
  } else {
    // Standard delete
    await this.standardDelete();
  }
}
```

### Cache Invalidation Considerations

When series operations occur, multiple cache entries may need invalidation:

```typescript
// src/app/services/schema.service.ts

// After series operations, invalidate:
// 1. Entity list cache (new/deleted instances)
// 2. Entity detail cache (modified instance)
// 3. Calendar cache (time slot changes)
// 4. Series summary cache (instance counts)

onSeriesOperationComplete(entityTable: string, seriesId: number) {
  this.cacheInvalidation.next({
    entities: [entityTable],
    seriesId: seriesId,
    fullRefresh: true
  });
}
```

---

## Queries & Views

### Summary View for UI

```sql
CREATE VIEW metadata.series_groups_summary AS
SELECT
  g.id,
  g.display_name,
  g.description,
  g.color,
  g.created_by,
  g.created_at,

  -- Aggregate stats
  COUNT(DISTINCT s.id) AS version_count,
  MIN(s.effective_from) AS started_on,

  -- Current version info
  (
    SELECT jsonb_build_object(
      'series_id', cs.id,
      'rrule', cs.rrule,
      'dtstart', cs.dtstart,
      'duration', cs.duration,
      'entity_table', cs.entity_table
    )
    FROM metadata.time_slot_series cs
    WHERE cs.group_id = g.id AND cs.effective_until IS NULL
    ORDER BY cs.version_number DESC
    LIMIT 1
  ) AS current_version,

  -- Instance counts
  (
    SELECT COUNT(*)
    FROM metadata.time_slot_instances tsi
    JOIN metadata.time_slot_series s2 ON s2.id = tsi.series_id
    WHERE s2.group_id = g.id AND tsi.entity_id IS NOT NULL
  ) AS active_instance_count,

  (
    SELECT COUNT(*)
    FROM metadata.time_slot_instances tsi
    JOIN metadata.time_slot_series s2 ON s2.id = tsi.series_id
    WHERE s2.group_id = g.id AND tsi.is_exception = TRUE
  ) AS exception_count

FROM metadata.time_slot_series_groups g
LEFT JOIN metadata.time_slot_series s ON s.group_id = g.id
GROUP BY g.id;
```

### Query: Is This Entity Part of a Series?

```sql
SELECT
  r.*,
  tsi.series_id,
  tsi.is_exception,
  tsi.exception_type,
  ts.rrule,
  tsg.display_name AS series_group_name,
  tsg.color AS series_color
FROM reservations r
LEFT JOIN metadata.time_slot_instances tsi
  ON tsi.entity_table = 'reservations' AND tsi.entity_id = r.id
LEFT JOIN metadata.time_slot_series ts
  ON ts.id = tsi.series_id
LEFT JOIN metadata.time_slot_series_groups tsg
  ON tsg.id = ts.group_id
WHERE r.id = 101;
```

### Query: All Instances in a Group

```sql
SELECT
  r.*,
  tsi.occurrence_date,
  tsi.is_exception,
  tsi.exception_type,
  ts.version_number
FROM reservations r
JOIN metadata.time_slot_instances tsi
  ON tsi.entity_table = 'reservations' AND tsi.entity_id = r.id
JOIN metadata.time_slot_series ts
  ON ts.id = tsi.series_id
WHERE ts.group_id = 1
ORDER BY tsi.occurrence_date;
```

---

## API Design

### Creating a Recurring Series

```http
POST /rpc/create_recurring_series
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "group_name": "Weekly Team Standup",
  "group_description": "Engineering sync",
  "group_color": "#3B82F6",
  "entity_table": "reservations",
  "entity_template": {
    "resource_id": 5,
    "purpose": "Team Standup",
    "attendee_count": 10,
    "setup_notes": "Arrange chairs in circle"
  },
  "rrule": "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "dtstart": "2025-01-06T14:00:00Z",
  "duration": "02:00:00",
  "expand_months": 6,
  "skip_conflicts": true
}
```

Response:
```json
{
  "group_id": 1,
  "series_id": 1,
  "instances_created": 78,
  "instances_skipped": 2,
  "skipped_dates": ["2025-03-17", "2025-04-21"],
  "expanded_until": "2025-07-06"
}
```

---

## Migration Path

### Migration: v0.16.0-add-recurring-timeslot

```sql
-- deploy/v0-19-0-add-recurring-timeslot.sql

-- 1. Core tables
CREATE TABLE metadata.time_slot_series_groups ( ... );
CREATE TABLE metadata.time_slot_series ( ... );
CREATE TABLE metadata.time_slot_instances ( ... );

-- 2. Metadata extension (entity-level, not property-level)
ALTER TABLE metadata.entities
  ADD COLUMN supports_recurring BOOLEAN DEFAULT FALSE,
  ADD COLUMN recurring_property_name NAME;

-- 3. Views
CREATE VIEW metadata.series_groups_summary AS ...;
-- Update schema_entities to include supports_recurring, recurring_property_name

-- 4. RPCs
CREATE FUNCTION preview_recurring_conflicts(...);
CREATE FUNCTION create_recurring_series(...);
CREATE FUNCTION cancel_series_occurrence(...);
CREATE FUNCTION reschedule_series_occurrence(...);
CREATE FUNCTION split_series_from_date(...);
CREATE FUNCTION delete_series_with_instances(...);
CREATE FUNCTION delete_series_group(...);
CREATE FUNCTION update_series_template(...);
-- Update upsert_entity_metadata to accept supports_recurring, recurring_property_name

-- 5. Cache invalidation
-- Update schema_cache_versions when supports_recurring changes
```

---

## Testing Strategy

### Unit Tests
- RRULE parsing edge cases (DST transitions, leap years, timezone boundaries)
- Conflict detection logic
- Exception state machine transitions
- Series split logic

### Integration Tests
- Create series → verify instances and junction records created
- Create conflicting series → verify preview shows conflicts
- Cancel single occurrence → verify junction updated, entity deleted
- Reschedule occurrence → verify junction and entity updated
- Split series → verify two versions exist in same group
- Edit "all" → verify non-exceptions updated, exceptions preserved
- Delete series → verify entity records cleaned up

### E2E Tests
- Full workflow: create recurring reservation with conflicts, resolve, verify calendar
- Series management page: view groups, drill into versions
- Exception editing modal flow
- "This and future" series split with UI confirmation

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| RRULE edge cases (DST, leap years) | Incorrect occurrence times | Battle-tested libraries (go-rrule, rrule.js) |
| Storage bloat from expansion | Database growth | Bounded horizon, cleanup job |
| GIST constraint failures | Failed expansion | Preview conflicts before commit (partially implemented — see Conflict Preview section) |
| Complex exception state machine | Bugs, inconsistencies | Clear enums, extensive tests |
| Series splits create confusion | UX issues | Groups unify split series visually |
| Orphaned entity records | Data integrity | RPC handles deletion atomically |
| Junction table JOIN overhead | Query performance | Proper indexes, summary views |

---

## Future Enhancements (Out of Scope)

- Multi-resource recurring events (book room + projector together)
- Recurring event templates (save patterns for reuse)
- Conflict suggestions ("The next available slot is...")
- Bulk exception operations ("Cancel all March occurrences")
- iCalendar (.ics) import/export
- External calendar sync (Google Calendar, Outlook)

---

## Implementation Summary

This section summarizes all key design decisions for quick reference.

### Storage Model

| Layer | Purpose | Key Fields |
|-------|---------|------------|
| **Series Groups** | User-facing logical container | `display_name`, `color`, `description` |
| **Series (versions)** | RRULE definition + template | `rrule`, `dtstart`, `duration`, `entity_template`, `effective_from/until` |
| **Instances (junction)** | Maps series → entity records | `series_id`, `entity_id`, `occurrence_date`, `is_exception` |
| **Entity records** | Actual data (reservations, etc.) | No schema changes required |

### Expansion Strategy

| Aspect | Decision |
|--------|----------|
| Default horizon | 90 days ahead (configurable via `RECURRING_SERIES_HORIZON_DAYS` env var) |
| Max infinite horizon | 2 years (configurable) |
| Scheduled refresh | Not yet implemented; current expansion is on-demand via River jobs |
| On-demand | Calendar navigation triggers expansion |
| Admin control | Can disable "until never" via `metadata.settings` |

### Edit/Delete Behaviors

| Action | Scope | Result |
|--------|-------|--------|
| Edit | This only | Update entity, mark as exception if drifted from template |
| Edit | This + future | Split series into two versions in same group |
| Edit | All | Update template, propagate to non-exception instances |
| Delete | This only | Mark junction as cancelled, delete entity record |
| Delete | This + future | Delete this and all future instances |
| Delete | Entire series | Delete series + all instances + group if empty |

### Angular Integration Points

| Component | Change Required |
|-----------|-----------------|
| `SchemaService` | `getRecurringEntities()` filters by `supports_recurring=true` |
| `RecurringService` (new) | Junction table lookups, series membership (privileged only) |
| `EditPage` | Scope dialog for privileged users; regular users get auto-exception |
| `DetailPage` | Series badge for privileged users only |
| `EntityManagementPage` | UI for enabling/configuring recurring per entity |
| `SeriesGroupManagementPage` (new) | Privileged-only page for managing recurring schedules |
| `Navbar` | "Manage Recurring Schedules" menu item (manager/admin only) |

### Access Control (RBAC-Based)

Access is determined by permissions on series tables, not hardcoded roles:

| Permission | Series Management | Edit Instance | See Series Badge |
|------------|-------------------|---------------|------------------|
| No series permissions | ❌ No access | Normal edit (auto-exception) | ❌ Hidden |
| `time_slot_series:read` | ✅ View only | Scope dialog | ✅ Visible |
| `time_slot_series:create/update/delete` | ✅ Full access | Scope dialog | ✅ Visible |
| Admin (always) | ✅ Full access | Scope dialog | ✅ Visible |

Integrators configure which roles get series permissions via the Permissions UI.

### Key RPCs

| RPC | Purpose |
|-----|---------|
| `preview_recurring_conflicts()` | Check conflicts before creation |
| `create_recurring_series()` | Create group + series + instances |
| `expand_series_instances()` | On-demand expansion |
| `cancel_series_occurrence()` | Cancel single instance |
| `split_series_from_date()` | "This + future" edits |
| `update_series_template()` | "All" edits |
| `delete_series_with_instances()` | Delete entire series |

### Permissions Model

**Series tables are standard permissionable entities** - access is controlled via the existing Permissions UI (`/permissions`), not hardcoded roles. This follows Civic OS's strict RBAC model.

#### Permissionable Tables

The migration registers these tables in `metadata.entities` so they appear in the Permissions UI:

| Table | Suggested Permissions | Description |
|-------|----------------------|-------------|
| `time_slot_series_groups` | read, create, update, delete | Manage logical groupings |
| `time_slot_series` | read, create, update, delete | Manage RRULE definitions |
| `time_slot_instances` | read, update | View/modify junction records |

```sql
-- Register series tables as permissionable entities
INSERT INTO metadata.entities (table_name, display_name, description, schema_name)
VALUES
  ('time_slot_series_groups', 'Recurring Schedule Groups', 'Logical groupings of recurring schedules', 'metadata'),
  ('time_slot_series', 'Recurring Series', 'RRULE definitions and templates', 'metadata'),
  ('time_slot_instances', 'Series Instances', 'Individual occurrences within a series', 'metadata');

-- Example: Grant series management to 'scheduler' role
-- (Integrators configure this via Permissions UI or SQL)
INSERT INTO metadata.permission_roles (role_name, table_name, can_create, can_read, can_update, can_delete)
VALUES
  ('scheduler', 'time_slot_series_groups', TRUE, TRUE, TRUE, TRUE),
  ('scheduler', 'time_slot_series', TRUE, TRUE, TRUE, TRUE),
  ('scheduler', 'time_slot_instances', FALSE, TRUE, TRUE, FALSE);

-- Admins always have access (existing admin bypass)
```

#### Permission Requirements

| Series Operation | Required Permission | Additional Check |
|-----------------|---------------------|------------------|
| View Series Management UI | `time_slot_series_groups:read` | — |
| Create series | `time_slot_series:create` | + `entity:create` on target table |
| View series details | `time_slot_series:read` | + `entity:read` on target table |
| Edit series | `time_slot_series:update` | + `entity:update` on target table |
| Delete series | `time_slot_series:delete` | + `entity:delete` on target table |
| Cancel/modify instances | `time_slot_instances:update` | + `entity:update` on target table |

#### User Experience Based on Permissions

Users **without** `time_slot_series:read` permission:
- Individual instances appear as normal entity records
- No "Part of series" badge on Detail pages
- No scope dialog on edit ("this only" vs "all") - just normal edit
- Edits to instances automatically mark them as exceptions (handled server-side)

Users **with** series permissions:
- See "Manage Recurring Schedules" in navigation
- See series badge on Detail pages
- Get scope dialog when editing series instances

#### RLS Policy Pattern

```sql
-- Series groups - use standard permission check
CREATE POLICY "Users with permission can manage series groups"
ON metadata.time_slot_series_groups FOR ALL
USING (
  has_permission('time_slot_series_groups', 'read')
  OR is_admin()
)
WITH CHECK (
  has_permission('time_slot_series_groups', 'create')
  OR is_admin()
);

-- Series table - requires series permission AND entity permission
CREATE POLICY "Users can read series they have permission for"
ON metadata.time_slot_series FOR SELECT
USING (
  (has_permission('time_slot_series', 'read') OR is_admin())
  AND has_permission(entity_table, 'read')
);

CREATE POLICY "Users can create series for entities they can create"
ON metadata.time_slot_series FOR INSERT
WITH CHECK (
  (has_permission('time_slot_series', 'create') OR is_admin())
  AND has_permission(entity_table, 'create')
);

CREATE POLICY "Users can update series for entities they can update"
ON metadata.time_slot_series FOR UPDATE
USING (
  (has_permission('time_slot_series', 'update') OR is_admin())
  AND has_permission(entity_table, 'update')
);

CREATE POLICY "Users can delete series for entities they can delete"
ON metadata.time_slot_series FOR DELETE
USING (
  (has_permission('time_slot_series', 'delete') OR is_admin())
  AND has_permission(entity_table, 'delete')
);

-- Junction table - read requires series read, modify requires series update
CREATE POLICY "Users can view instances"
ON metadata.time_slot_instances FOR SELECT
USING (
  (has_permission('time_slot_instances', 'read') OR is_admin())
  AND has_permission(entity_table, 'read')
);

CREATE POLICY "Users can modify instances"
ON metadata.time_slot_instances FOR UPDATE
USING (
  (has_permission('time_slot_instances', 'update') OR is_admin())
  AND has_permission(entity_table, 'update')
);
```

#### Auto-Exception on Unprivileged Edits

When a user without series permissions edits an entity record that's part of a series:

```sql
-- Trigger on entity tables with supports_recurring=true
CREATE OR REPLACE FUNCTION auto_mark_series_exception()
RETURNS TRIGGER AS $$
DECLARE
  v_instance RECORD;
  v_can_manage_series BOOLEAN;
BEGIN
  -- Check if user can manage series (they use the explicit scope dialog)
  v_can_manage_series := has_permission('time_slot_series', 'update') OR is_admin();

  IF v_can_manage_series THEN
    RETURN NEW;  -- Skip auto-exception; frontend handles scope dialog
  END IF;

  -- Check if this entity is part of a series
  SELECT * INTO v_instance
  FROM metadata.time_slot_instances
  WHERE entity_table = TG_TABLE_NAME AND entity_id = NEW.id;

  IF FOUND AND NOT v_instance.is_exception THEN
    -- Auto-mark as exception
    UPDATE metadata.time_slot_instances
    SET
      is_exception = TRUE,
      exception_type = 'modified',
      exception_at = NOW(),
      exception_by = current_user_id()
    WHERE id = v_instance.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Applied to each recurring-enabled entity
CREATE TRIGGER auto_exception_on_edit
  AFTER UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION auto_mark_series_exception();
```

#### UI Entry Points

Series Management UI visibility is determined by permissions:

```typescript
// src/app/components/navbar/navbar.component.ts

// Check permission, not role
canManageSeries$ = this.permissionService.hasPermission('time_slot_series_groups', 'read');

// Template
@if (canManageSeries$ | async) {
  <li>
    <a routerLink="/recurring-schedules">
      <svg><!-- calendar-repeat icon --></svg>
      Manage Recurring Schedules
    </a>
  </li>
}
```

#### Integrator Configuration Examples

**Example 1: Only admins can create recurring schedules**
```sql
-- No additional grants needed; admin bypass handles it
```

**Example 2: "Scheduler" role can manage schedules**
```sql
INSERT INTO metadata.roles (name, description) VALUES
  ('scheduler', 'Can create and manage recurring schedules');

INSERT INTO metadata.permission_roles (role_name, table_name, can_create, can_read, can_update, can_delete)
VALUES
  ('scheduler', 'time_slot_series_groups', TRUE, TRUE, TRUE, TRUE),
  ('scheduler', 'time_slot_series', TRUE, TRUE, TRUE, TRUE),
  ('scheduler', 'time_slot_instances', FALSE, TRUE, TRUE, FALSE);
```

**Example 3: Managers can view but not create**
```sql
INSERT INTO metadata.permission_roles (role_name, table_name, can_create, can_read, can_update, can_delete)
VALUES
  ('manager', 'time_slot_series_groups', FALSE, TRUE, FALSE, FALSE),
  ('manager', 'time_slot_series', FALSE, TRUE, FALSE, FALSE),
  ('manager', 'time_slot_instances', FALSE, TRUE, FALSE, FALSE);
```

#### Why RBAC-Based?

1. **Consistency**: Same permission model as all other entities
2. **Flexibility**: Integrators decide who gets access, not the framework
3. **Visibility**: Permissions appear in existing UI, no hidden configuration
4. **Composability**: Combine with entity permissions (need both series + entity access)
5. **Auditability**: Standard permission grants, standard audit trail

### Configuration Checklist

```sql
-- 1. Enable recurring for entity (can also be done via Entity Management UI)
INSERT INTO metadata.entities (table_name, supports_recurring, recurring_property_name)
VALUES ('reservations', TRUE, 'time_slot')
ON CONFLICT (table_name) DO UPDATE SET
  supports_recurring = TRUE,
  recurring_property_name = 'time_slot';

-- 2. (Optional) Customize expansion settings
INSERT INTO metadata.settings (key, value) VALUES
  ('recurring_default_horizon_months', '6'),
  ('recurring_allow_infinite_series', 'true');

-- 3. Ensure GIST exclusion constraint exists on entity table
-- (for conflict detection)

-- 4. No additional permission grants needed!
-- Users with reservations:create can create recurring reservations
-- Users with reservations:update can edit series instances
-- Users with reservations:delete can cancel/delete instances
```

---

## RLS-Respecting Occurrence Writes (Issue #18)

**Status**: research, not scheduled. Recommendation only; nothing here is built.

### Problem

The series functions write entity rows with definer rights, so the instance's own policies and column grants never apply to those writes. Each function substitutes its own check, and the checks drift from the instance's policies. Current definitions and gates:

| Function | Defined in (`postgres/migrations/deploy/`) | Role | Gate on the entity table |
|----------|-----------|------|--------------------------|
| `create_recurring_series` | `v0-76-5-revoke-public-execute` | DEFINER | `has_permission(table, 'create')`; writes only bookkeeping rows and enqueues the worker job |
| `update_series_template` | `v0-76-9-split-applies-new-schedule` | DEFINER | `has_permission(table, 'update')`; Status columns stripped |
| `split_series_from_date` and its helper `metadata.apply_split_to_future_instances` | `v0-76-9-split-applies-new-schedule` | DEFINER (helper runs under the caller's definer context) | `has_permission(table, 'update')`; Status columns stripped from the template, not from `p_edited_values` |
| `end_series_from_date`, `delete_series_with_instances`, `delete_series_group`, `cancel_series_occurrence` | `v0-78-1-end-series-from-date` | DEFINER | `has_permission(table, 'delete')` |
| `reschedule_occurrence` | `v0-76-5-revoke-public-execute` | DEFINER | `has_permission(table, 'update')` for non-series rows; series owner or admin otherwise |
| Expansion worker insert | `services/consolidated-worker-go/expand_recurring_series_worker.go` | superuser connection | none (see below) |

Every gate is a table-level RBAC check. None can express "only rows the caller owns", "only while the row is in status X" or "not this column", which is what instances use RLS and column grants for.

### Facts that shape the options

1. **Definer bypasses RLS entirely.** The functions run as the migration owner, who owns the entity tables (no `FORCE ROW LEVEL SECURITY`), so an instance policy referencing `current_user_id()` is not evaluated at all, rather than evaluated wrongly. `current_user_id()`, `get_user_roles()` and `has_permission()` read the `request.jwt.claims` GUC, which is unchanged inside a definer function, so identity helpers still report the caller; only `current_user`, `session_user` and ownership change. A policy written on those helpers therefore behaves under invoker execution exactly as it does for a PostgREST write, which is the property the issue asks for.
2. **The worker has no RLS and no roles.** The examples set `DATABASE_URL` to the `postgres` superuser. `insertEntityWithInstance` sets `request.jwt.claims` to `{"sub": <series.created_by>, "role": "authenticated"}` with `set_config(..., true)`, which makes `current_user_id()` and `created_by` defaults correct. It never runs `SET ROLE`, so RLS is bypassed, and the claims carry no `roles`, so `has_permission()` and `is_admin()` see a user with no roles.
3. **Roles come from the JWT.** `get_user_roles()` reads `realm_access.roles` or `roles` from the claims. A worker that wants the creator's permissions must rebuild a roles claim (from `metadata.user_roles`, current at expansion time) before any `has_permission()` call means anything. Current versus creation-time roles is a policy decision (open question 2).
4. **The bookkeeping tables have their own RLS.** `metadata.time_slot_series_groups`, `time_slot_series` and `time_slot_instances` have RLS enabled. `time_slot_instances` INSERT/UPDATE/DELETE policies require explicit `time_slot_instances:*` permissions (or admin), so a plain series owner cannot re-link instances, set `is_exception` or shift `occurrence_date` directly. Those writes need definer rights under every option.
5. **`civic_os.series_write`** (`v0-76-9-split-applies-new-schedule.sql:84`) is a transaction-local GUC that the AFTER UPDATE trigger `mark_series_instance_modified()` (SECURITY DEFINER) reads to skip marking the occurrence as an exception. The RPCs set it with `set_config(..., true)` around their writes. Any code that can call `set_config` can set it. PostgREST exposes no `set_config`, so reachable setters today are SQL functions in exposed schemas, including integrator functions. A caller who sets it hides their own edit from exception tracking, so a later template update or split overwrites it. It is an integrity flag, not an authorization flag: low severity today, more relevant once callers run their own statements (Option 2).
6. **Status columns.** `metadata.series_status_columns()` finds columns with an FK to `metadata.statuses`. `update_series_template` and `split_series_from_date` strip them from templates. `create_recurring_series` does not: a template created with `status_id` keeps it and the worker inserts it into every occurrence (the pre-approved series case), under no check beyond table-level `create`. After creation no template change moves a status. Nothing in the framework restricts which roles may insert a non-initial status; that is true of plain PostgREST inserts too, so it is a separate framework question.
7. **`p_edited_values` is not stripped.** `split_series_from_date` writes the edited occurrence's values as definer after only `has_permission(table, 'update')`, so a caller with `update` but no right to set a Status column (per instance policy) can set it through the split. This is the clearest concrete example of the drift in the issue.
8. **Series ownership columns are weakly pinned.** `series_insert` and `series_groups_insert` check only `has_permission(...create)`, not `created_by = current_user_id()`, and the UPDATE `WITH CHECK` accepts any `created_by` for a holder of the `update` permission. The worker trusts `time_slot_series.created_by` as the identity to impersonate, so this matters the moment the worker's identity carries real authority (worker section).

### Option 1: payments-style polymorphic permission checks

The operator's lead is to keep definer execution and make the check richer, as other subsystems do:

- **Notes** (`v0-16-0`, `entity_notes_select`): `has_permission(entity_type || ':notes', 'read') OR is_admin()`. The permission name is derived from the entity, which suits a subsystem with no row policy of its own; it ignores the entity's row rules.
- **Files** (`v0-39-0`, "Tiered file visibility"): `is_admin() OR created_by = current_user_id() OR has_permission(entity_type, 'read') OR metadata.can_view_entity_record(entity_type, entity_id)`. The last term matters most. `can_view_entity_record` is `SECURITY INVOKER` and runs `SELECT EXISTS(... WHERE id = $1)` on the entity table, so the instance's own SELECT policy decides. It is the only existing pattern that delegates to entity RLS, and it works only because it is invoker.
- **Galleries** (`v0-47-0`): same tiered shape as files.
- **Payments** (`v0-76-9-restore-view-security-invoker`, `docs/development/PAYMENT_PROCESSING.md`): `payment_transactions` is a definer view with `security_barrier` that repeats the base-table predicate (`user_id = current_user_id() OR has_permission('payment_transactions', 'read')`). It does so because the `payments` schema is deliberately unreachable by API roles; the file header says to keep the predicates in sync with the policies by hand.

Applied to series this means richer per-entity predicates evaluated inside the definer function bodies. Assessment:

- It does not meet the goal. The payments view is the case where the caller cannot reach the base schema, so mirroring is the only choice there. Entity tables are reachable, and mirroring their policies reintroduces the drift, with a hand-maintenance note as the only control.
- The one pattern that truly delegates (`can_view_entity_record`) is invoker execution, which is Option 2 in miniature.
- Polymorphic `entity_type`-keyed permissions remain right for things with no row-level equivalent, such as who may run series operations at all (a `{table}:series` permission, if wanted). That is a coarse toggle, not a replacement for RLS.

Spoofing and audit surface: a mirrored predicate runs as the owner role, so a bug in it is a privilege escalation (the v0.76.9 finding was this class). Database logs attribute the write to the owner role; the user id exists only in the JWT GUC.

### Option 2: invoker writes

The occurrence writes run as the caller, so grants, RLS and column grants apply as for PostgREST. Two shapes:

- **2a. Definer outer function plus an invoker inner function.** Does not work as stated. A SECURITY INVOKER function called from a definer function runs as the definer (the current role at the call site), so the inner function gains nothing. It would need an explicit `SET LOCAL ROLE authenticated`, which a definer function can do only if the owner role is a member of `authenticated`, and a failure path that must `RESET ROLE`. Rejected as fragile.
- **2b. Invoker entry points plus short definer helpers.** `update_series_template`, `split_series_from_date`, the delete RPCs and `reschedule_occurrence` become SECURITY INVOKER, so every entity-table statement runs under the caller's real role. Bookkeeping writes (fact 4) go through small SECURITY DEFINER helpers that touch only `metadata.time_slot_*` and `metadata.river_job`, take ids rather than SQL fragments, and re-check the series owner-or-admin rule themselves. `create_recurring_series` stays definer, since it inserts no entity rows.

Behavior under 2b:

- **Updates**: an `UPDATE` on rows the caller's policy hides affects zero rows instead of raising. The function must compare `ROW_COUNT` with the expected occurrence count and report `records_denied`. A column grant violation raises `42501` for the whole statement. Recommended: any denial fails the whole call (atomic), with a message naming the first denied record. The v0.76.9 and v0.78.1 `has_permission` pre-checks stay as early, readable errors and stop being the authority.
- **Deletes**: `DELETE` removes only rows the caller's DELETE policy allows. `end_series_from_date` today deletes instance rows first and entities second; a denied entity would leave a record with no instance row. The order must change (delete entities, then instances for the deleted ids) or the whole call must fail on any denial.
- **Exception marking**: the AFTER UPDATE trigger stays definer and keeps working. Callers still cannot write `is_exception` themselves.
- **Policies using `current_user_id()`**: evaluated for the real caller. The worker stamps `created_by = series.created_by`, so a creator-only policy lets the series creator edit all occurrences, while a delegated manager or an admin acting on someone else's series is judged by the instance's policy like any other write. This can deny edits that work today, which is the correct reading of the goal. It is the main compatibility cost and integrators must be told.
- **Per-field propagation** needs no extra check (below): each propagated field is an `UPDATE` the database already authorizes.

Spoofing and audit surface: database logs and `pg_stat_statements` attribute the write to the caller's role, and a bug in a series function cannot exceed the caller's rights. `civic_os.series_write` becomes the remaining forgery vector, since callers now run SQL in the same transaction. Remove the GUC: have the trigger skip rows registered in a definer-owned table (written only by the definer helpers, cleared at commit), or drop the skip and let the helpers reset the exception flag after their own writes. The second is simpler; the first keeps the trigger as the single marking path.

### The worker: creating occurrences on the creator's behalf

Whatever the RPCs do, the worker is the largest real bypass: a superuser inserting every occurrence from a stored template.

- **W1. Impersonate the creator inside the database.** In each per-occurrence transaction run `SET LOCAL ROLE authenticated`, and set `request.jwt.claims` to `{sub, role: authenticated, roles: [<creator's current roles from metadata.user_roles>]}`. The insert is then an ordinary RLS write by the creator. A denied occurrence becomes an exception (new type `denied`, like `conflict_skipped`) plus a notification and never fails the job. This also answers status-on-insert: the instance's INSERT `WITH CHECK` decides whether the template's `status_id` is allowed for this creator, with no framework rule. Costs: the worker's database role must be able to `SET ROLE authenticated` (always for a superuser; a membership grant on managed databases), a roles lookup per expansion, and a creator who loses a role sees expansion stop for the occurrences their policy now denies (intended, but visible).
- **W2. Probe, then insert as superuser.** Run the INSERT `WITH CHECK` as a rolled-back dry run under `SET LOCAL ROLE`, then insert as superuser. This is W1 plus a redundant step.
- **W3. Leave the worker.** Defensible only with a create-time probe of the first occurrence. Weak, because a series outlives the policy and the creator's roles.

W1 is the consistent choice. It requires the guards in fact 8: the worker must not trust `series.created_by` unless policy pins it to the creating caller (non-admin inserts and updates must satisfy `created_by = current_user_id()`).

### Status columns and the template

- **Initial status**: a Status column with no template value takes the table default (or an instance trigger). The series machinery must not assume either, and the worker writes a Status column only from the template.
- **Template status is the starting status for new occurrences only.** Splits and template updates never carry it forward or rewrite existing occurrences (current behavior; keep it). Make this explicit for `create_recurring_series` and `update_series_template`: both may carry a Status key, only the worker consumes it, and changing it affects only occurrences not yet expanded. The new value is checked by the INSERT `WITH CHECK` when the worker inserts (W1).
- **`p_edited_values`**: under 2b the instance's UPDATE policy decides whether the edited occurrence may take a Status value. Until then, strip Status columns from `p_edited_values` unless the caller is admin, a smaller fix that closes fact 7 without waiting for the invoker conversion.
- **Framework rule for non-initial Status on insert**: out of scope for series. If wanted, it is one decision for PostgREST and worker inserts alike (for example an optional per-entity guard trigger honoring a `{table}:set_status` style permission), and belongs with the Status type. Until then instances express it as an RLS `WITH CHECK`, which W1 honors.

### Per-field propagation

Propagate a template field to an occurrence only where its current value equals the old template value, compared as typed values (`IS NOT DISTINCT FROM` on the column's own type, not text). Non-exception rows match the template on every field the series writes, because the trigger turns any other edit into an exception, so the benefit is confined to exceptions: they keep following the series on fields nobody changed, instead of freezing the whole row. It needs no permission check of its own: under 2b each propagated field is an `UPDATE` the database authorizes through column grants and policies. Under definer execution it would need a per-field denylist, which is the drift the issue describes, and is one more argument for 2b. The old template is available (version rows and `template_updated_at`); a split must compare against the version being split.

### Comparison

| | Option 1: polymorphic checks | Option 2b: invoker entry points | Worker W1 |
|---|---|---|---|
| Honors per-row policies | no (mirrored role check) | yes | yes |
| Honors column grants | no | yes | yes |
| A bug can exceed caller's rights | yes | no | no |
| Drift from instance policy | by construction | none | none |
| Compatibility cost | none | creator-only policies deny delegated managers | creator-role lookup, `denied` exception type |
| Attribution in database logs | owner role | caller | creator |
| Spoofing surface | mirrored predicate bugs | `civic_os.series_write` (removable) | `series.created_by` (pin by policy) |

### Recommendation

[4/5] Adopt Option 2b (invoker entry points with a short list of definer bookkeeping helpers) together with worker W1, and keep polymorphic permissions only for what has no row-level equivalent (who may run series operations at all). Keep the v0.76.9 and v0.78.1 table-level checks as early, readable errors rather than the authority. Remove the `civic_os.series_write` GUC by moving exception marking into a definer helper. Treat a framework rule for non-initial Status on insert as a separate decision. Option 1 is the fallback if the compatibility cost in open question 1 is unacceptable [3/5], at the price of permanent drift.

### Phased plan

1. **Guards (no behavior change for admins)**: pin `created_by` in series and group INSERT/UPDATE policies for non-admins; strip Status columns from `p_edited_values` for non-admins; report `records_denied` and row counts from the update and delete RPCs; build the test matrix as a failing-first harness.
2. **Bookkeeping helpers**: definer helpers for re-linking instances, exception marking and instance deletion; replace `civic_os.series_write` with post-write marking.
3. **Invoker entry points**: convert the update, split, delete and reschedule RPCs; atomic failure on any denial; fix the delete ordering. This is the breaking step: ship with an audit query, an Integrator Guide section, and release-note callout.
4. **Worker W1**: per-occurrence `SET LOCAL ROLE`, creator-role lookup, `denied` exception type and notification, optional create-time probe of the first occurrence; deployment checklist entry for the worker's database role.
5. **Per-field propagation** for exceptions, after step 3.

### Test matrix

Roles: admin, manager (RBAC `update`, narrower RLS), editor (own rows), user (own rows, create only), anonymous. Entity variants: RBAC only; owner-only UPDATE and DELETE policies; INSERT `WITH CHECK` limiting `status_id` to the initial status; column grant excluding a template column.

- Create series: allowed or denied by INSERT `WITH CHECK`, including a template with a non-initial status, per role.
- Worker expansion: creator keeps or loses a role between create and expansion; a denied occurrence becomes a `denied` exception plus notification while the others still expand; forged `series.created_by` by a non-admin is rejected by policy.
- Template update: all writable; some hidden by policy; a column denied by grant (whole call fails, nothing changed); a Status key never changes existing rows.
- Split with `p_edited_values`: edited occurrence denied; Status key in `p_edited_values` gated.
- Delete, end-from-date, cancel occurrence, delete group: some records not deletable; instance rows stay linked to survivors.
- `reschedule_occurrence` for series and non-series rows.
- Policy referencing `current_user_id()`: series creator, other manager, admin impersonating a role via `x-impersonate-roles`.
- `civic_os.series_write` forgery attempt through an integrator function (marking must still happen).
- Exception tracking: a direct PostgREST edit still yields `modified` or `rescheduled`.
- Log attribution for invoker writes.
- Regression gate: the existing v0.76.9 and v0.78.1 functional tests pass unchanged for admin.

### Open questions for the operator

1. Is it acceptable that a delegated manager who did not create the series can no longer edit occurrences under creator-only policies, or should series get a per-table opt-out?
2. Worker roles: the creator's current roles at expansion time, or a snapshot at series creation?
3. May the worker's database role `SET ROLE authenticated` in every deployment, including managed databases, or does W1 need a per-instance setup step?
4. Should partial denial fail the whole template update or split, or apply to permitted occurrences and report the rest? This section assumes atomic failure.
5. Is a separate `{table}:series` permission wanted, so series operations can be granted without general `update`?
6. Who owns the framework rule for non-initial Status on insert: this issue or a Status-type follow-up?
7. Should `create_recurring_series` probe the first occurrence's INSERT `WITH CHECK` at create time (a rolled-back dry run under `SET LOCAL ROLE`)?

## References

- [RFC 5545 - iCalendar](https://datatracker.ietf.org/doc/html/rfc5545) - RRULE specification
- [rrule npm package](https://www.npmjs.com/package/rrule) - JavaScript RRULE library
- [go-rrule](https://github.com/teambition/rrule-go) - Go RRULE library
- [FullCalendar RRule Plugin](https://fullcalendar.io/docs/rrule-plugin) - Calendar integration
- [PostgreSQL Range Types](https://www.postgresql.org/docs/current/rangetypes.html) - tstzrange documentation
