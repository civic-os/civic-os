# Recurring TimeSlot System Design Document

> **Status**: Design Document (not yet implemented)
> **Target Version**: v0.16.0+
> **Last Updated**: November 2025

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
  dtstart TIMESTAMPTZ NOT NULL,  -- First occurrence start time (UTC)
  duration INTERVAL NOT NULL,    -- Duration of each occurrence

  -- Optional timezone for display (IANA timezone name)
  timezone TEXT,  -- e.g., "America/New_York"

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

### Metadata Property Configuration (Explicit Opt-In)

**IMPORTANT**: Recurring time slot functionality is **explicitly opt-in** per entity/property. The framework does NOT assume all `time_slot` columns support recurrence. Integrators must explicitly enable it for specific columns.

```sql
-- Add column to metadata.properties to mark time_slot columns as recurring-enabled
ALTER TABLE metadata.properties
  ADD COLUMN is_recurring BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN metadata.properties.is_recurring IS
  'For time_slot columns: enables recurring series UI and behavior. Default FALSE - must be explicitly enabled.';

-- Enable recurring for a specific column
UPDATE metadata.properties
SET is_recurring = TRUE
WHERE table_name = 'reservations' AND column_name = 'time_slot';
```

**Configuration Flow:**

1. Integrator creates entity with `time_slot` column (as before)
2. Entity works immediately for one-time bookings (default behavior)
3. To enable recurring, integrator explicitly sets `is_recurring = TRUE`
4. Frontend then shows "Make this recurring" toggle in Create/Edit forms
5. Series management UI becomes available for this entity

**Why Explicit Opt-In?**

- **Business logic varies**: Some time slots don't make sense as recurring (one-off appointments)
- **GIST constraint requirements**: Recurring requires proper exclusion constraints
- **Permission considerations**: Series management may need different permissions than single records
- **Data complexity**: Not all entities need the junction table overhead

**Validation on Enable:**

When setting `is_recurring = TRUE`, the migration/RPC should verify:

```sql
CREATE OR REPLACE FUNCTION validate_recurring_enablement(
  p_table_name TEXT,
  p_column_name TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_property RECORD;
  v_has_gist BOOLEAN;
BEGIN
  -- 1. Verify column is time_slot type
  SELECT * INTO v_property
  FROM metadata.properties
  WHERE table_name = p_table_name AND column_name = p_column_name;

  IF v_property.udt_name != 'time_slot' AND v_property.udt_name != 'tstzrange' THEN
    RAISE EXCEPTION 'is_recurring can only be enabled on time_slot/tstzrange columns';
  END IF;

  -- 2. Recommend GIST exclusion constraint (warning, not error)
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = p_table_name
      AND c.contype = 'x'  -- exclusion constraint
  ) INTO v_has_gist;

  IF NOT v_has_gist THEN
    RAISE WARNING 'Table % has no exclusion constraint. Consider adding GIST constraint for conflict prevention.', p_table_name;
  END IF;

  RETURN TRUE;
END;
$$;
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

- **Creation time**: Expand 6 months ahead (default, configurable per-deployment)
- **Maximum "until never" limit**: 2 years ahead (prevents runaway expansion)

#### Configuration

```sql
-- Add to metadata.settings table (or deployment env vars)
INSERT INTO metadata.settings (key, value, description) VALUES
  ('recurring_default_horizon_months', '6', 'Default expansion horizon for new series'),
  ('recurring_max_horizon_months', '24', 'Maximum expansion for "never ending" series'),
  ('recurring_allow_infinite_series', 'true', 'Allow series without UNTIL/COUNT');
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

- `dtstart` stores the first occurrence in **UTC** (`TIMESTAMPTZ`)
- `timezone` stores the IANA timezone for RRULE expansion (e.g., `"America/New_York"`)
- Entity `time_slot` values are always stored as **UTC** (`TIMESTAMPTZ` range)

### Expansion Algorithm

1. Parse RRULE with `dtstart` converted to `timezone`
2. Generate occurrence local times in that timezone (go-rrule default behavior)
3. Convert each occurrence to UTC for storage
4. Apply series `duration` to compute end time

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

---

## Conflict Preview & Resolution

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

### Conflict Resolution UX

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
  p_new_dtstart TIMESTAMPTZ,
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
| **Edit "this and future"** | Split into two versions | Re-linked to new version | Updated |
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
    // Load entities that have is_recurring=true
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

private getPropertyType(val: SchemaPropertyTable): EntityPropertyType {
  if (val.udt_name === 'time_slot') {
    return val.is_recurring
      ? EntityPropertyType.RecurringTimeSlot
      : EntityPropertyType.TimeSlot;
  }
  // ... rest
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
   * Called when loading Detail or Edit pages for entities with is_recurring=true.
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

    // If entity has is_recurring=true property, check membership
    if (this.hasRecurringProperty()) {
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
-- deploy/v0-16-0-add-recurring-timeslot.sql

-- 1. Core tables
CREATE TABLE metadata.time_slot_series_groups ( ... );
CREATE TABLE metadata.time_slot_series ( ... );
CREATE TABLE metadata.time_slot_instances ( ... );

-- 2. Metadata extension
ALTER TABLE metadata.properties ADD COLUMN is_recurring BOOLEAN DEFAULT FALSE;

-- 3. Views
CREATE VIEW metadata.series_groups_summary AS ...;

-- 4. RPCs
CREATE FUNCTION preview_recurring_conflicts(...);
CREATE FUNCTION create_recurring_series(...);
CREATE FUNCTION cancel_series_occurrence(...);
CREATE FUNCTION reschedule_series_occurrence(...);
CREATE FUNCTION split_series_from_date(...);
CREATE FUNCTION delete_series_with_instances(...);
CREATE FUNCTION delete_series_group(...);
CREATE FUNCTION update_series_template(...);

-- 5. Cache invalidation
-- Update schema_cache_versions when is_recurring changes
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
| GIST constraint failures | Failed expansion | Preview conflicts before commit |
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
| Default horizon | 6 months ahead |
| Max infinite horizon | 2 years (configurable) |
| Scheduled refresh | Weekly River job, extends by 3 months |
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
| `SchemaService` | Detect `is_recurring=true` → `RecurringTimeSlot` type |
| `RecurringService` (new) | Junction table lookups, series membership (privileged only) |
| `EditPage` | Scope dialog for privileged users; regular users get auto-exception |
| `DetailPage` | Series badge for privileged users only |
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
-- Trigger on entity tables with is_recurring=true
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
-- 1. Enable recurring for entity property
UPDATE metadata.properties
SET is_recurring = TRUE
WHERE table_name = 'reservations' AND column_name = 'time_slot';

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

## References

- [RFC 5545 - iCalendar](https://datatracker.ietf.org/doc/html/rfc5545) - RRULE specification
- [rrule npm package](https://www.npmjs.com/package/rrule) - JavaScript RRULE library
- [go-rrule](https://github.com/teambition/rrule-go) - Go RRULE library
- [FullCalendar RRule Plugin](https://fullcalendar.io/docs/rrule-plugin) - Calendar integration
- [PostgreSQL Range Types](https://www.postgresql.org/docs/current/rangetypes.html) - tstzrange documentation
