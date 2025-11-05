# Calendar & Appointment Integration Guide

## Overview

This document outlines the design and implementation plan for adding native `tstzrange` (timestamp range) support to Civic OS with calendar visualization capabilities. The system follows the GeoPoint pattern: display mode for viewing, interactive mode for editing, and dual integration (List page toggle + Detail page section).

---

## Table of Contents

1. [Key Concepts](#key-concepts)
2. [Phase 0: Query Param Pre-fill](#phase-0-query-param-pre-fill-foundation)
3. [Phase 1: Core TimeSlot Property Type](#phase-1-core-timeslot-property-type)
4. [Phase 2: Calendar Visualization Component](#phase-2-calendar-visualization-component)
5. [Phase 3: List Page Calendar Toggle](#phase-3-list-page-calendar-toggle)
6. [Phase 4: Detail Page Calendar Section](#phase-4-detail-page-calendar-section)
7. [Phase 5: Overlap Validation System](#phase-5-overlap-validation-system)
8. [Example Schema](#example-schema-resource-management)
9. [Implementation Checklist](#implementation-checklist)

---

## Key Concepts

### Calendar vs Map Views (Mutually Exclusive)

**Important**: An entity can have `show_calendar=true` OR `show_map=true`, but NOT both. The UI toggle switches between List and Calendar (or List and Map), not a three-way toggle.

**Rationale**: Avoids UI complexity and unclear user expectations. If an entity needs both time-based and location-based views, create a separate entity or use Detail page sections.

**Example**: Food trucks with location + time slot → Use location map on List page, show time slot calendar on Detail page as related reservations section.

### Timezone Handling Strategy

**Database Storage**: `tstzrange` (timestamp with time zone range) stores absolute UTC timestamps.

**Display Formatting**: Two approaches depending on context:

1. **PostgreSQL Function (Server-side)**:
   - Used for: List page columns, readonly displays
   - Limitation: PostgREST executes functions in database timezone (UTC)
   - Format returned: ISO strings, frontend must convert to browser timezone for display

2. **Browser Formatting (Client-side)**:
   - Used for: Edit forms, calendar components, anywhere user interacts
   - Process:
     - Parse UTC timestamps from database
     - Convert to browser's local timezone using JavaScript Date API
     - Display using `toLocaleString()` or format with date libraries
   - User sees times in their local timezone

**Best Practice**: For TimeSlot display, use client-side formatting to respect user's timezone.

### Multi-Day Range Formatting

Format logic should handle same-day vs multi-day ranges differently:

```
Same-day:     "Mar 15, 2025 2:00 PM - 4:00 PM"
Multi-day:    "Mar 15, 2025 2:00 PM - Mar 17, 2025 11:00 AM"
All-day:      "Mar 15-17, 2025"  (if times are midnight to midnight)
```

Implementation: See `DisplayTimeSlotComponent` in Phase 1.

### Calendar Date Range Filtering (Not Pagination)

**Important**: Calendar views do NOT use traditional pagination. Instead, they filter by the visible date range.

**Approach**:
1. Calendar component determines visible date range (e.g., month view shows March 1-31)
2. Frontend builds PostgREST query with range filter:
   ```
   ?time_slot=ov.[2025-03-01T00:00:00Z,2025-04-01T00:00:00Z)&order=time_slot.asc
   ```
3. ALL items in that range are displayed (no limit parameter)
4. As user navigates calendar (prev/next month), new range is fetched

**Performance**: GiST indexes on `time_slot` columns make range queries fast. Month views typically show 50-200 events max.

**Edge Case**: If 10,000+ events in a single month, consider:
- Limiting to specific resource filter (Detail page context)
- Adding UI warning/prompt to narrow date range
- Server-side limit as safety valve (configurable in metadata?)

---

## Phase 0: Query Param Pre-fill (Foundation)

**Purpose**: Enable creating related records with pre-filled fields from any context.

**Use Cases**:
- "Add Appointment" from Resource detail page → pre-fill `resource_id`
- Calendar date selection → pre-fill `time_slot` range
- "Add Issue for User" → pre-fill `assigned_user_id`

### Implementation

#### 1. CreatePage Enhancement

**File**: `src/app/pages/create/create.page.ts`

**Changes**:
```typescript
ngOnInit() {
  // Existing: Load entity metadata and build form
  combineLatest([this.entity$, this.properties$])
    .pipe(take(1))
    .subscribe(([entity, properties]) => {
      this.buildForm(properties);

      // NEW: Apply query param defaults after form is ready
      this.route.queryParams.pipe(take(1)).subscribe(params => {
        this.applyQueryParamDefaults(params);
      });
    });
}

private applyQueryParamDefaults(params: Params): void {
  Object.keys(params).forEach(paramKey => {
    const control = this.entityForm.get(paramKey);
    if (control && !control.value) {
      // Only set if field is currently empty
      control.setValue(params[paramKey]);
      control.markAsTouched(); // Trigger validation
    }
  });
}
```

**Behavior**:
- ✅ Fields remain editable (normal inputs with default values)
- ✅ No special UI indicators (breadcrumbs, badges, etc.)
- ✅ Supports multiple fields: `?resource_id=5&status=confirmed&user_id=abc`
- ✅ Invalid values caught by standard form validation

#### 2. Navigation Pattern (Detail Page Example)

**File**: `src/app/pages/detail/detail.page.ts`

**Add button with query params**:
```typescript
navigateToCreateRelated(tableName: string, fkColumn: string, additionalParams?: Record<string, any>) {
  this.router.navigate(['/create', tableName], {
    queryParams: {
      [fkColumn]: this.currentId(),
      ...additionalParams
    }
  });
}

// Usage in template:
// <button (click)="navigateToCreateRelated('appointments', 'resource_id')">
//   Add Appointment
// </button>
```

**Calendar date selection**:
```typescript
onCalendarDateSelect(selection: {start: Date, end: Date}) {
  const tstzrange = `[${selection.start.toISOString()},${selection.end.toISOString()})`;
  this.navigateToCreateRelated('appointments', 'resource_id', {
    time_slot: tstzrange
  });
}
```

#### 3. Testing Considerations

- Test empty form (no params) → works normally
- Test single param → field pre-filled
- Test multiple params → all fields pre-filled
- Test invalid param names → silently ignored
- Test invalid param values → caught by validation on submit

**Status**: ⬜ Not started

---

## Phase 1: Core TimeSlot Property Type

### Database Layer

#### 1. Custom Domain (Core Migration)

**File**: `postgres/migrations/deploy/vX-Y-Z-add_time_slot_domain.sql` (NEW MIGRATION)

**Important**: The `time_slot` domain should be part of core Civic OS migrations, not example-specific. This allows any Civic OS application to use time-based scheduling.

```sql
-- Time slot domain for appointment/booking ranges
-- Deploy: v0.X.0 (determine version during implementation)

CREATE DOMAIN time_slot AS TSTZRANGE;

COMMENT ON DOMAIN time_slot IS
  'Timestamp range (with timezone) for appointments, bookings, and scheduling. Stores UTC, displays in user timezone. Format: [start,end) with inclusive start, exclusive end.';
```

**Revert script** (`revert/vX-Y-Z-add_time_slot_domain.sql`):
```sql
DROP DOMAIN time_slot;
```

**Verify script** (`verify/vX-Y-Z-add_time_slot_domain.sql`):
```sql
SELECT 1/COUNT(*) FROM pg_type WHERE typname = 'time_slot';
```

#### 2. btree_gist Extension (Core Migration - Same as time_slot domain)

**Purpose**: Enable exclusion constraints that mix scalar types (integers, UUIDs) with range types (time_slot).

**Migration**: Added in the same migration as `time_slot` domain (v0.9.0).

```sql
-- Enable btree_gist for exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

COMMENT ON EXTENSION btree_gist IS
  'Provides GiST index operator classes for B-tree data types, enabling exclusion constraints that mix scalar types (integer, UUID) with range types (time_slot). Essential for preventing overlapping bookings, reservations, and appointments.';
```

**Use Case**: Preventing overlapping time slots for the same resource:

```sql
-- Example: Prevent double-booking in reservations table
ALTER TABLE reservations
  ADD CONSTRAINT no_overlapping_reservations
  EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&);
```

This constraint ensures:
- Same `resource_id` cannot have overlapping `time_slot` ranges
- Database-level enforcement (atomic, no race conditions)
- Automatic error on conflict: `ERROR: conflicting key value violates exclusion constraint`
- Requires GiST index operators for BOTH integer (`resource_id`) and tstzrange (`time_slot`)

**Why btree_gist is needed**: By default, GiST only supports geometric types, range types, and full-text search. The `btree_gist` extension adds GiST operator classes for all B-tree-indexable types (integers, text, UUIDs, etc.), allowing them to be used in exclusion constraints alongside range types.

**Performance**: GiST indexes on `time_slot` columns enable efficient range queries:
```sql
-- This query uses the GiST index
SELECT * FROM reservations
WHERE time_slot && '[2025-03-01,2025-04-01)'::tstzrange;
```

**Verify**:
```sql
SELECT 1/COUNT(*) FROM pg_extension WHERE extname = 'btree_gist';
```

#### 3. Helper Function (Optional - Client-side preferred)

**Note**: This function executes in database timezone (UTC). Frontend should format in browser timezone instead.

```sql
-- For rare cases where server-side formatting is needed
CREATE OR REPLACE FUNCTION format_time_slot(slot time_slot) RETURNS TEXT AS $$
  SELECT
    CASE
      -- Same day
      WHEN date_trunc('day', lower(slot)) = date_trunc('day', upper(slot)) THEN
        to_char(lower(slot), 'Mon DD, YYYY HH12:MI AM') || ' - ' ||
        to_char(upper(slot), 'HH12:MI AM')

      -- Multi-day (show both full timestamps)
      ELSE
        to_char(lower(slot), 'Mon DD, YYYY HH12:MI AM') || ' - ' ||
        to_char(upper(slot), 'Mon DD, YYYY HH12:MI AM')
    END;
$$ LANGUAGE SQL IMMUTABLE;
```

**Status**: ⬜ Not started

### TypeScript Layer

#### 3. Add TimeSlot to Property Type Enum

**File**: `src/app/interfaces/entity.ts`

**Add to `EntityPropertyType` enum** (around line 98):

```typescript
export enum EntityPropertyType {
  // ... existing types
  GeoPoint,
  Color,
  Email,
  Telephone,
  TimeSlot,  // NEW
  // ...
}
```

**Status**: ⬜ Not started

#### 4. Detect TimeSlot in SchemaService

**File**: `src/app/services/schema.service.ts`

**Update `getPropertyType()` method** (around line 217):

```typescript
private getPropertyType(val: SchemaPropertyTable): EntityPropertyType {
  // ... existing type detection logic

  // Add before the final "else"
  ['time_slot'].includes(val.udt_name) ? EntityPropertyType.TimeSlot :

  // ... rest of logic
}
```

**Status**: ⬜ Not started

### Component Implementation

#### 5. DisplayTimeSlotComponent

**File**: `src/app/components/display-time-slot/display-time-slot.component.ts`

**Purpose**: Display formatted time range in user's local timezone.

**Key Features**:
- Parse `tstzrange` string: `"[2025-03-15 14:00:00+00,2025-03-15 16:00:00+00)"`
- Convert UTC to browser timezone
- Format based on same-day vs multi-day
- Responsive to `ThemeService` for consistent styling

**Implementation**:
```typescript
import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-display-time-slot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="time-slot-display">{{ formattedValue() }}</span>
  `,
  styles: [`
    .time-slot-display {
      @apply text-base-content;
    }
  `]
})
export class DisplayTimeSlotComponent {
  datum = input<string>(); // tstzrange string

  formattedValue = computed(() => {
    const raw = this.datum();
    if (!raw) return '';

    const { start, end } = this.parseRange(raw);
    if (!start || !end) return raw; // Fallback to raw if parse fails

    return this.formatRange(start, end);
  });

  private parseRange(tstzrange: string): { start: Date | null, end: Date | null } {
    // Parse: "[2025-03-15 14:00:00+00,2025-03-15 16:00:00+00)"
    const match = tstzrange.match(/\[(.+?),(.+?)\)/);
    if (!match) return { start: null, end: null };

    return {
      start: new Date(match[1]),
      end: new Date(match[2])
    };
  }

  private formatRange(start: Date, end: Date): string {
    const sameDay = start.toDateString() === end.toDateString();

    const dateFormat: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    };
    const timeFormat: Intl.DateTimeFormatOptions = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    };

    if (sameDay) {
      // "Mar 15, 2025 2:00 PM - 4:00 PM"
      const dateStr = start.toLocaleDateString('en-US', dateFormat);
      const startTime = start.toLocaleTimeString('en-US', timeFormat);
      const endTime = end.toLocaleTimeString('en-US', timeFormat);
      return `${dateStr} ${startTime} - ${endTime}`;
    } else {
      // "Mar 15, 2025 2:00 PM - Mar 17, 2025 11:00 AM"
      const startFull = start.toLocaleString('en-US', { ...dateFormat, ...timeFormat });
      const endFull = end.toLocaleString('en-US', { ...dateFormat, ...timeFormat });
      return `${startFull} - ${endFull}`;
    }
  }
}
```

**Generate component**:
```bash
ng generate component components/display-time-slot --skip-tests
```

**Status**: ⬜ Not started

#### 6. EditTimeSlotComponent

**File**: `src/app/components/edit-time-slot/edit-time-slot.component.ts`

**Purpose**: Edit time range with two datetime-local inputs.

**Key Features**:
- Controlled component (ControlValueAccessor)
- Two inputs: start datetime, end datetime
- Validation: end must be after start
- Output: tstzrange string in PostgreSQL format
- OnPush + signals

**Implementation**:
```typescript
import { Component, forwardRef, signal, effect, ChangeDetectionStrategy } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-edit-time-slot',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => EditTimeSlotComponent),
      multi: true
    }
  ],
  template: `
    <div class="time-slot-editor grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="form-control">
        <label class="label">
          <span class="label-text">Start</span>
        </label>
        <input
          type="datetime-local"
          class="input input-bordered w-full"
          [value]="startLocal()"
          (input)="onStartChange($event)"
          [disabled]="disabled()"
        />
      </div>

      <div class="form-control">
        <label class="label">
          <span class="label-text">End</span>
        </label>
        <input
          type="datetime-local"
          class="input input-bordered w-full"
          [value]="endLocal()"
          (input)="onEndChange($event)"
          [disabled]="disabled()"
        />
      </div>

      @if (errorMessage()) {
        <div class="col-span-1 md:col-span-2">
          <p class="text-error text-sm">{{ errorMessage() }}</p>
        </div>
      }
    </div>
  `
})
export class EditTimeSlotComponent implements ControlValueAccessor {
  startLocal = signal<string>('');
  endLocal = signal<string>('');
  disabled = signal(false);
  errorMessage = signal<string>('');

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  // Emit combined value when either input changes
  constructor() {
    effect(() => {
      const start = this.startLocal();
      const end = this.endLocal();

      if (!start || !end) {
        this.errorMessage.set('');
        return;
      }

      const startDate = new Date(start);
      const endDate = new Date(end);

      if (endDate <= startDate) {
        this.errorMessage.set('End time must be after start time');
        return;
      }

      this.errorMessage.set('');
      const tstzrange = this.buildTstzrange(startDate, endDate);
      this.onChange(tstzrange);
    });
  }

  writeValue(value: string): void {
    if (!value) {
      this.startLocal.set('');
      this.endLocal.set('');
      return;
    }

    const { start, end } = this.parseRange(value);
    if (start && end) {
      this.startLocal.set(this.toDatetimeLocal(start));
      this.endLocal.set(this.toDatetimeLocal(end));
    }
  }

  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  onStartChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.startLocal.set(input.value);
    this.onTouched();
  }

  onEndChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.endLocal.set(input.value);
    this.onTouched();
  }

  private parseRange(tstzrange: string): { start: Date | null, end: Date | null } {
    const match = tstzrange.match(/\[(.+?),(.+?)\)/);
    if (!match) return { start: null, end: null };
    return {
      start: new Date(match[1]),
      end: new Date(match[2])
    };
  }

  private toDatetimeLocal(date: Date): string {
    // Convert UTC date to local datetime-local format: "YYYY-MM-DDTHH:MM"
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private buildTstzrange(start: Date, end: Date): string {
    // PostgreSQL tstzrange format: "[2025-03-15T14:00:00.000Z,2025-03-15T16:00:00.000Z)"
    return `[${start.toISOString()},${end.toISOString()})`;
  }
}
```

**Generate component**:
```bash
ng generate component components/edit-time-slot --skip-tests
```

**Status**: ⬜ Not started

#### 7. Integrate into DisplayPropertyComponent

**File**: `src/app/components/display-property/display-property.component.ts`

**Add import**:
```typescript
import { DisplayTimeSlotComponent } from '../display-time-slot/display-time-slot.component';
```

**Add to imports array**:
```typescript
imports: [
  // ... existing
  DisplayTimeSlotComponent
]
```

**Add template case** (around line 40):
```typescript
@if (propType() === EntityPropertyType.TimeSlot) {
  <app-display-time-slot [datum]="datum()" />
}
```

**Status**: ⬜ Not started

#### 8. Integrate into EditPropertyComponent

**File**: `src/app/components/edit-property/edit-property.component.ts`

**Add import**:
```typescript
import { EditTimeSlotComponent } from '../edit-time-slot/edit-time-slot.component';
```

**Add to imports array**.

**Add template case** (in the form control section):
```typescript
@if (propType() === EntityPropertyType.TimeSlot) {
  <app-edit-time-slot [formControl]="control()" />
}
```

**Status**: ⬜ Not started

---

## Phase 2: Calendar Visualization Component

### Library Installation

**Install FullCalendar**:
```bash
npm install @fullcalendar/core @fullcalendar/angular @fullcalendar/daygrid @fullcalendar/timegrid @fullcalendar/interaction
```

**Licenses**: MIT (FullCalendar Core, DayGrid, TimeGrid, Interaction)

**Status**: ⬜ Not started

### TimeSlotCalendarComponent

**Purpose**: Calendar view component with three modes (display, edit, list).

**File**: `src/app/components/time-slot-calendar/time-slot-calendar.component.ts`

**Modes**:
1. **Display**: Read-only calendar, click events for navigation
2. **Edit**: Interactive (drag, resize) for single event editing
3. **List**: Multi-event timeline with date range filters

**Component Interface**:
```typescript
@Input() mode: 'display' | 'edit' | 'list' = 'display';
@Input() value?: string; // tstzrange for edit mode
@Input() events?: CalendarEvent[]; // For list/display modes
@Input() color?: string; // Default event color

@Output() valueChange = new EventEmitter<string>(); // tstzrange
@Output() eventClick = new EventEmitter<CalendarEvent>();
@Output() dateSelect = new EventEmitter<{start: Date, end: Date}>();
```

**Theme Integration**: Subscribe to `ThemeService.isDark$` and swap event colors.

**TODO**: Full implementation pending Phase 1 completion.

**Status**: ⬜ Not started

---

## Phase 3: List Page Calendar Toggle

### Database Metadata Schema

**Migration**: Create a new Sqitch migration (or modify `postgres/migrations/deploy/v0-9-0-add-time-slot-domain.sql`)

**Extend `metadata.entities` table**:
```sql
ALTER TABLE metadata.entities
  ADD COLUMN show_calendar BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN calendar_property_name VARCHAR(63),
  ADD COLUMN calendar_color_property VARCHAR(63);

COMMENT ON COLUMN metadata.entities.show_calendar IS
  'Enable calendar view toggle on list page (like show_map for geography)';

COMMENT ON COLUMN metadata.entities.calendar_property_name IS
  'Name of the time_slot column to use for calendar events';

COMMENT ON COLUMN metadata.entities.calendar_color_property IS
  'Optional column name for event color (hex_color type). If null, uses default color.';
```

**Status**: ⬜ Not started

### Frontend Integration (ListPage)

**File**: `src/app/pages/list/list.page.ts`

**Add computed signal**:
```typescript
showCalendar = computed(() =>
  this.entity()?.show_calendar &&
  this.entity()?.calendar_property_name
);
```

**Transform data to calendar events**:
```typescript
calendarEvents = computed(() => {
  const entity = this.entity();
  if (!entity?.calendar_property_name) return [];

  const dateProp = entity.calendar_property_name;
  const colorProp = entity.calendar_color_property;

  return this.currentPageData().map(row => {
    const { start, end } = this.parseTimeSlot(row[dateProp]);
    return {
      id: row.id,
      title: row.display_name || `Event ${row.id}`,
      start: start,
      end: end,
      color: colorProp ? row[colorProp] : '#3B82F6',
      extendedProps: { data: row }
    };
  });
});

private parseTimeSlot(tstzrange: string): { start: Date, end: Date } {
  const match = tstzrange.match(/\[(.+?),(.+?)\)/);
  return {
    start: new Date(match![1]),
    end: new Date(match![2])
  };
}
```

**Template (list.page.html)**:
```html
<!-- View toggle (if calendar enabled) -->
@if (showCalendar()) {
  <div class="tabs tabs-boxed mb-4">
    <a class="tab" [class.tab-active]="viewMode() === 'list'" (click)="setViewMode('list')">
      List
    </a>
    <a class="tab" [class.tab-active]="viewMode() === 'calendar'" (click)="setViewMode('calendar')">
      Calendar
    </a>
  </div>
}

<!-- Calendar view -->
@if (viewMode() === 'calendar' && showCalendar()) {
  <app-time-slot-calendar
    mode="list"
    [events]="calendarEvents()"
    (eventClick)="navigateToDetail($event.id)"
  />
}

<!-- List view (existing table) -->
@if (viewMode() === 'list') {
  <!-- existing table markup -->
}
```

**Auto-include calendar property**: Ensure `calendar_property_name` is added to PostgREST select query even if hidden from list columns (like map does with geography).

**Status**: ⬜ Not started

---

## Phase 4: Detail Page Calendar Section

### Pattern: Inverse Relationship Detection

**Concept**: When viewing a Resource detail page, show a calendar section with all Appointments for that resource (inverse FK relationship).

**File**: `src/app/pages/detail/detail.page.ts`

**Detect calendar relationships**:
```typescript
calendarSections = computed(() => {
  // Find entities that:
  // 1. Have show_calendar=true
  // 2. Have FK pointing to current entity
  // 3. Calendar property is a time_slot type

  // Example: On resources/123, show appointments where resource_id=123
});
```

**Load related calendar data**:
```typescript
loadCalendarSection(section: CalendarSection): Observable<CalendarEvent[]> {
  const fkFilter = `${section.fkColumn}=eq.${this.currentId()}`;
  return this.dataService.getData(
    section.tableName,
    `id,display_name,${section.calendarProperty},${section.colorProperty || ''}`,
    fkFilter
  ).pipe(
    map(rows => rows.map(row => this.transformToCalendarEvent(row, section)))
  );
}
```

**Template (detail.page.html)**:
```html
@if (calendarSections().length > 0) {
  @for (section of calendarSections(); track section.table) {
    <div class="card bg-base-200 mt-6">
      <div class="card-body">
        <h3 class="card-title">{{ section.entityDisplayName }}</h3>

        <div class="card-actions justify-end mb-4">
          <button
            class="btn btn-primary btn-sm"
            (click)="navigateToCreateRelated(section.tableName, section.fkColumn)">
            Add {{ section.entityDisplayName }}
          </button>
        </div>

        <app-time-slot-calendar
          mode="display"
          [events]="section.events$ | async"
          (eventClick)="router.navigate(['/detail', section.tableName, $event.id])"
          (dateSelect)="createAppointmentWithTimeSlot(section, $event)"
        />
      </div>
    </div>
  }
}
```

**Create with pre-filled time slot**:
```typescript
createAppointmentWithTimeSlot(section: CalendarSection, dates: {start: Date, end: Date}) {
  const tstzrange = `[${dates.start.toISOString()},${dates.end.toISOString()})`;
  this.router.navigate(['/create', section.tableName], {
    queryParams: {
      [section.fkColumn]: this.currentId(),
      [section.calendarProperty]: tstzrange
    }
  });
}
```

**Status**: ⬜ Not started

---

## Phase 5: Overlap Validation System

### Metadata Schema

**Add validation type**:
```sql
INSERT INTO metadata.validation_types (name, description) VALUES
('no_overlap', 'Prevents overlapping time ranges within a scope (e.g., same resource, same user)');
```

**Example validation record**:
```sql
-- Prevent resource double-booking
INSERT INTO metadata.validations (
  table_name,
  column_name,
  validation_type,
  validation_value,
  error_message,
  sort_order
) VALUES (
  'appointments',
  'time_slot',
  'no_overlap',
  '{"scope_column": "resource_id"}',  -- JSONB config
  'This resource is already booked during the selected time',
  1
);
```

**Status**: ⬜ Not started

### Backend RPC Function

**Migration**: Create a new Sqitch migration for overlap validation

**Overlap checker**:
```sql
CREATE OR REPLACE FUNCTION check_time_slot_overlap(
  p_table_name TEXT,
  p_column_name TEXT,
  p_time_slot TSTZRANGE,
  p_scope_column TEXT,
  p_scope_value TEXT,
  p_exclude_id BIGINT DEFAULT NULL
) RETURNS TABLE(has_overlap BOOLEAN, conflicting_ids BIGINT[], conflict_details JSONB)
LANGUAGE plpgsql
AS $$
DECLARE
  v_query TEXT;
  v_result RECORD;
BEGIN
  -- Build dynamic query to check for overlaps
  v_query := format(
    'SELECT
       COUNT(*) > 0 AS has_overlap,
       ARRAY_AGG(id) AS conflicting_ids,
       JSONB_AGG(JSONB_BUILD_OBJECT(''id'', id, ''display_name'', display_name, ''time_slot'', %I::TEXT)) AS details
     FROM %I
     WHERE %I && $1
       AND %I = $2
       AND ($3 IS NULL OR id != $3)',
    p_column_name,
    p_table_name,
    p_column_name,
    p_scope_column
  );

  EXECUTE v_query INTO v_result
    USING p_time_slot, p_scope_value, p_exclude_id;

  RETURN QUERY SELECT v_result.has_overlap, v_result.conflicting_ids, v_result.details;
END;
$$;

-- Grant execute permission so frontend async validators can call it
GRANT EXECUTE ON FUNCTION check_time_slot_overlap TO authenticated;

COMMENT ON FUNCTION check_time_slot_overlap IS
  'Checks if a time slot overlaps with existing records in a table. Used by frontend async validators to prevent double-booking.';
```

**Status**: ⬜ Not started

### Frontend AsyncValidator

**File**: `src/app/services/schema.service.ts`

**Add method**:
```typescript
getOverlapValidator(
  tableName: string,
  columnName: string,
  config: { scope_column: string },
  currentId?: number | string
): AsyncValidatorFn {
  return (control: AbstractControl): Observable<ValidationErrors | null> => {
    const timeSlot = control.value;
    if (!timeSlot) return of(null);

    // Get scope value from sibling form control
    const scopeControl = control.parent?.get(config.scope_column);
    const scopeValue = scopeControl?.value;
    if (!scopeValue) return of(null); // Can't validate without scope

    return this.dataService.rpc('check_time_slot_overlap', {
      p_table_name: tableName,
      p_column_name: columnName,
      p_time_slot: timeSlot,
      p_scope_column: config.scope_column,
      p_scope_value: scopeValue,
      p_exclude_id: currentId || null
    }).pipe(
      map(result => {
        if (result[0]?.has_overlap) {
          return {
            overlap: {
              message: `Time slot conflicts with existing appointments`,
              conflictingIds: result[0].conflicting_ids,
              details: result[0].conflict_details
            }
          };
        }
        return null;
      }),
      catchError(() => of(null)) // Fail open if RPC errors
    );
  };
}
```

**Apply in form building** (CreatePage/EditPage):
```typescript
if (property.validations?.some(v => v.validation_type === 'no_overlap')) {
  const config = JSON.parse(property.validations.find(v => v.validation_type === 'no_overlap')!.validation_value);
  const asyncValidator = this.schemaService.getOverlapValidator(
    this.tableName,
    property.column_name,
    config,
    this.currentId // undefined for CreatePage
  );
  control.addAsyncValidators(asyncValidator);
}
```

**Status**: ⬜ Not started

### Error Display

**File**: `src/app/components/edit-time-slot/edit-time-slot.component.ts`

**Show overlap error**:
```html
@if (control().hasError('overlap')) {
  <div class="alert alert-error mt-2">
    <span>{{ control().getError('overlap').message }}</span>
    @if (control().getError('overlap').details; as conflicts) {
      <ul class="text-sm mt-1">
        @for (conflict of conflicts; track conflict.id) {
          <li>{{ conflict.display_name }}: {{ conflict.time_slot }}</li>
        }
      </ul>
    }
  </div>
}
```

**Status**: ⬜ Not started

---

## Example: Community Center Reservations

**Purpose**: Dogfooding and testing calendar features during development. This example demonstrates request/approval workflows with calendar visualization.

**Directory**: `examples/community-center/`

**Use Case**: Community center with reservable facilities. Members request reservations, managers approve/deny requests.

**Future Enhancements** (not in initial scope):
- Additional resources (tool shed, meeting rooms)
- Payment processing integration
- Recurring reservations

---

### Schema File

**File**: `examples/community-center/init-scripts/01_reservations_schema.sql`

```sql
-- ============================================================================
-- COMMUNITY CENTER RESERVATIONS EXAMPLE
-- Demonstrates: TimeSlot property type, calendar views, approval workflows
-- ============================================================================

-- Resources table (facilities available for reservation)
CREATE TABLE resources (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  color hex_color NOT NULL DEFAULT '#3B82F6',
  capacity INT,  -- Maximum occupancy
  hourly_rate MONEY,  -- Future: payment processing
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reservations table (official approved bookings - CALENDAR VIEW)
-- This table is automatically managed by triggers on reservation_requests
CREATE TABLE reservations (
  id BIGSERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  reserved_by UUID NOT NULL REFERENCES civic_os_users(id) ON DELETE CASCADE,
  time_slot time_slot NOT NULL,
  purpose TEXT NOT NULL,
  attendee_count INT NOT NULL,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- When first approved
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- When last modified

  -- Computed display name (clean, no status emoji)
  display_name VARCHAR(255) GENERATED ALWAYS AS (
    'Reservation #' || id || ' - ' || purpose
  ) STORED,

  -- CONSTRAINT: Prevent overlapping reservations for same resource
  -- Requires btree_gist extension (included in Civic OS v0.9.0+)
  CONSTRAINT no_overlapping_reservations
    EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&)
);

COMMENT ON CONSTRAINT no_overlapping_reservations ON reservations IS
  'Prevents double-booking: ensures same resource cannot have overlapping time slots. Uses btree_gist extension for mixed scalar/range type exclusion.';

-- Reservation Requests table (SOURCE OF TRUTH for approval workflow)
-- Changes to status automatically sync to reservations table via triggers
CREATE TABLE reservation_requests (
  id BIGSERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES civic_os_users(id) ON DELETE CASCADE,
  time_slot time_slot NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  purpose TEXT NOT NULL,  -- What the reservation is for (REQUIRED for requests)
  attendee_count INT NOT NULL,
  notes TEXT,  -- Additional details or special requests

  -- Approval tracking
  reviewed_by UUID REFERENCES civic_os_users(id),  -- Manager who approved/denied
  reviewed_at TIMESTAMPTZ,
  denial_reason TEXT,  -- If denied, why?

  -- Back-link to reservation (set by trigger when approved)
  reservation_id BIGINT UNIQUE REFERENCES reservations(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Computed display name
  display_name VARCHAR(255) GENERATED ALWAYS AS (
    CASE status
      WHEN 'pending' THEN '⏳ '
      WHEN 'approved' THEN '✓ '
      WHEN 'denied' THEN '✗ '
      WHEN 'cancelled' THEN '🚫 '
    END ||
    'Request #' || id || ' - ' || purpose
  ) STORED,

  -- Status-based color
  status_color hex_color GENERATED ALWAYS AS (
    CASE status
      WHEN 'pending' THEN '#F59E0B'::hex_color    -- Amber/Orange
      WHEN 'approved' THEN '#22C55E'::hex_color   -- Green
      WHEN 'denied' THEN '#EF4444'::hex_color     -- Red
      WHEN 'cancelled' THEN '#6B7280'::hex_color  -- Gray
    END
  ) STORED
);

-- CRITICAL: Index foreign keys for performance
CREATE INDEX idx_reservation_requests_resource_id ON reservation_requests(resource_id);
CREATE INDEX idx_reservation_requests_requested_by ON reservation_requests(requested_by);
CREATE INDEX idx_reservation_requests_reservation_id ON reservation_requests(reservation_id);
CREATE INDEX idx_reservation_requests_status ON reservation_requests(status);
CREATE INDEX idx_reservation_requests_time_slot ON reservation_requests USING GIST(time_slot);

CREATE INDEX idx_reservations_resource_id ON reservations(resource_id);
CREATE INDEX idx_reservations_reserved_by ON reservations(reserved_by);
CREATE INDEX idx_reservations_time_slot ON reservations USING GIST(time_slot);

-- ============================================================================
-- PERMISSIONS & ROW-LEVEL SECURITY
-- ============================================================================

-- Resources: Everyone can view, admins can modify
GRANT SELECT ON resources TO authenticated;
GRANT INSERT, UPDATE, DELETE ON resources TO admin;
GRANT USAGE, SELECT ON SEQUENCE resources_id_seq TO admin;

-- Reservation Requests:
-- - Users: Can CREATE, can SELECT their own
-- - Managers: Can CREATE and UPDATE any
-- - Admins: Full access
GRANT SELECT, INSERT ON reservation_requests TO authenticated;
GRANT UPDATE ON reservation_requests TO manager;
GRANT DELETE ON reservation_requests TO admin;
GRANT USAGE, SELECT ON SEQUENCE reservation_requests_id_seq TO authenticated;

-- Reservations: Everyone can view (public availability), ONLY ADMINS can modify directly
-- (Most changes happen via reservation_requests table which triggers sync)
GRANT SELECT ON reservations TO authenticated;
GRANT INSERT, UPDATE, DELETE ON reservations TO admin;
GRANT USAGE, SELECT ON SEQUENCE reservations_id_seq TO admin;

-- Enable RLS on reservation_requests
ALTER TABLE reservation_requests ENABLE ROW LEVEL SECURITY;

-- Policy: Users can SELECT their own requests
CREATE POLICY select_own_requests ON reservation_requests
  FOR SELECT
  USING (requested_by = auth.uid() OR has_permission('reservation_requests', 'read'));

-- Policy: Users can INSERT requests
CREATE POLICY insert_own_requests ON reservation_requests
  FOR INSERT
  WITH CHECK (requested_by = auth.uid());

-- Policy: Users CANNOT UPDATE their own requests (must ask manager)
-- Managers can UPDATE any request
CREATE POLICY update_requests_managers_only ON reservation_requests
  FOR UPDATE
  USING (has_permission('reservation_requests', 'update'));

COMMENT ON POLICY select_own_requests ON reservation_requests IS
  'Users can see their own requests. Managers with read permission see all.';

COMMENT ON POLICY update_requests_managers_only ON reservation_requests IS
  'Only managers can update requests (including approving/denying). Users cannot edit their own requests.';

-- ============================================================================
-- DATABASE CONSTRAINTS (Critical for Data Integrity)
-- ============================================================================

-- EXCLUSION CONSTRAINT: Prevent overlapping reservations for same resource
-- This is the ultimate source of truth - frontend validation can be bypassed, this cannot
ALTER TABLE reservations
  ADD CONSTRAINT no_overlapping_reservations
  EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&);

COMMENT ON CONSTRAINT no_overlapping_reservations ON reservations IS
  'Ensures a resource cannot have two overlapping approved reservations. Uses GiST index for efficient range overlap detection (&&operator).';

-- CHECK CONSTRAINT: Ensure time slot is well-formed [start, end) with start < end
ALTER TABLE reservations
  ADD CONSTRAINT valid_time_slot_bounds
  CHECK (NOT isempty(time_slot) AND lower(time_slot) < upper(time_slot));

ALTER TABLE reservation_requests
  ADD CONSTRAINT valid_time_slot_bounds
  CHECK (NOT isempty(time_slot) AND lower(time_slot) < upper(time_slot));

COMMENT ON CONSTRAINT valid_time_slot_bounds ON reservations IS
  'Ensures time slot is not empty and start time is before end time.';

-- ============================================================================
-- METADATA CONFIGURATION
-- ============================================================================

-- Configure resources entity
UPDATE metadata.entities SET
  description = 'Community center facilities available for reservation'
WHERE table_name = 'resources';

-- Configure reservation requests entity (no calendar - just list view)
UPDATE metadata.entities SET
  description = 'Pending and historical reservation requests (approval workflow)'
WHERE table_name = 'reservation_requests';

-- Enable calendar view on RESERVATIONS (official bookings - availability calendar)
UPDATE metadata.entities SET
  show_calendar = TRUE,
  calendar_property_name = 'time_slot',
  calendar_color_property = NULL,  -- All approved reservations same color
  description = 'Approved facility reservations (availability calendar)'
WHERE table_name = 'reservations';

-- ============================================================================
-- VALIDATION RULES
-- ============================================================================

-- Prevent double-booking in reservation REQUESTS (check against approved reservations)
-- This validation runs when users create requests, checking if time conflicts with existing bookings
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES (
  'reservation_requests',
  'time_slot',
  'no_overlap',
  '{"scope_column": "resource_id", "check_table": "reservations"}',
  'This facility is already booked during the selected time. Please choose a different time or check the calendar for availability.',
  1
);

-- Prevent double-booking in RESERVATIONS table (managers creating direct bookings)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES (
  'reservations',
  'time_slot',
  'no_overlap',
  '{"scope_column": "resource_id"}',
  'This facility is already booked during the selected time.',
  1
);

-- Attendee count validation (basic range check)
-- Note: Resource capacity is informational only, not enforced by validation
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('reservation_requests', 'attendee_count', 'min', '1', 'At least 1 attendee is required', 1);

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('reservations', 'attendee_count', 'min', '1', 'At least 1 attendee is required', 1);

-- ============================================================================
-- AUTOMATIC SYNC TRIGGERS (Request → Reservation)
-- ============================================================================

-- Trigger function to sync reservation_requests changes to reservations table
CREATE OR REPLACE FUNCTION sync_reservation_request_to_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_reservation_id BIGINT;
BEGIN
  -- CASE 1: Status changed TO 'approved' (create reservation)
  IF NEW.status = 'approved' AND (OLD IS NULL OR OLD.status != 'approved') THEN
    -- Create the reservation if it doesn't exist
    IF NEW.reservation_id IS NULL THEN
      INSERT INTO reservations (
        resource_id,
        reserved_by,
        time_slot,
        purpose,
        attendee_count,
        notes
      ) VALUES (
        NEW.resource_id,
        NEW.requested_by,
        NEW.time_slot,
        NEW.purpose,
        NEW.attendee_count,
        NEW.notes
      ) RETURNING id INTO v_reservation_id;

      -- Link the reservation back to the request
      NEW.reservation_id := v_reservation_id;
    END IF;

  -- CASE 2: Status changed FROM 'approved' to something else (delete reservation)
  ELSIF OLD IS NOT NULL AND OLD.status = 'approved' AND NEW.status != 'approved' THEN
    IF NEW.reservation_id IS NOT NULL THEN
      DELETE FROM reservations WHERE id = NEW.reservation_id;
      NEW.reservation_id := NULL;
    END IF;

  -- CASE 3: Request is approved AND data changed (update reservation)
  ELSIF NEW.status = 'approved' AND NEW.reservation_id IS NOT NULL AND OLD IS NOT NULL THEN
    -- Check if any relevant fields changed
    IF NEW.resource_id != OLD.resource_id OR
       NEW.requested_by != OLD.requested_by OR
       NEW.time_slot != OLD.time_slot OR
       NEW.purpose != OLD.purpose OR
       NEW.attendee_count != OLD.attendee_count OR
       (NEW.notes IS DISTINCT FROM OLD.notes) THEN

      UPDATE reservations
      SET
        resource_id = NEW.resource_id,
        reserved_by = NEW.requested_by,
        time_slot = NEW.time_slot,
        purpose = NEW.purpose,
        attendee_count = NEW.attendee_count,
        notes = NEW.notes,
        updated_at = NOW()
      WHERE id = NEW.reservation_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger to reservation_requests
CREATE TRIGGER trg_sync_reservation
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION sync_reservation_request_to_reservation();

-- Trigger to automatically set reviewed_at when status changes
CREATE OR REPLACE FUNCTION set_reviewed_at_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- If status changed from pending to approved/denied
  IF (OLD IS NULL OR OLD.status = 'pending') AND
     NEW.status IN ('approved', 'denied') AND
     NEW.reviewed_at IS NULL THEN
    NEW.reviewed_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_reviewed_at
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION set_reviewed_at_timestamp();

COMMENT ON FUNCTION sync_reservation_request_to_reservation IS
  'Automatically creates/updates/deletes reservations based on reservation_request status changes.
   When status → approved: creates reservation.
   When status → denied/cancelled: deletes reservation.
   When approved request data changes: updates reservation.';

COMMENT ON FUNCTION set_reviewed_at_timestamp IS
  'Automatically sets reviewed_at timestamp when status changes from pending to approved/denied.';

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION sync_reservation_request_to_reservation TO authenticated;
GRANT EXECUTE ON FUNCTION set_reviewed_at_timestamp TO authenticated;

-- ============================================================================
-- SAMPLE DATA
-- ============================================================================

-- Initial resource: Club House
INSERT INTO resources (display_name, description, color, capacity, hourly_rate, active)
VALUES (
  'Club House',
  'Main community gathering space with kitchen, tables, and seating for 75. Perfect for parties, meetings, and events.',
  '#3B82F6',  -- Blue
  75,
  25.00,  -- $25/hour
  TRUE
);

-- Sample data (using first user in civic_os_users)
-- NOTE: The trigger automatically creates reservations when status='approved'
DO $$
DECLARE
  v_user_id UUID;
  v_resource_id INT;
BEGIN
  -- Get first user
  SELECT id INTO v_user_id FROM civic_os_users LIMIT 1;

  -- Get Club House ID
  SELECT id INTO v_resource_id FROM resources WHERE display_name = 'Club House';

  IF v_user_id IS NOT NULL AND v_resource_id IS NOT NULL THEN

    -- ===== APPROVED REQUEST (trigger creates reservation automatically) =====
    -- Saturday afternoon birthday party
    INSERT INTO reservation_requests (
      resource_id,
      requested_by,
      time_slot,
      purpose,
      attendee_count,
      status,
      reviewed_by,
      reviewed_at
    ) VALUES (
      v_resource_id,
      v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '6 days')::timestamp + TIME '14:00',  -- Next Saturday 2pm
        (CURRENT_DATE + INTERVAL '6 days')::timestamp + TIME '18:00'   -- Until 6pm
      ),
      'Birthday Party',
      30,
      'approved',  -- Trigger will create reservation
      v_user_id,   -- Self-approved for demo
      NOW() - INTERVAL '2 days'
    );

    -- ===== PENDING REQUESTS (awaiting manager approval) =====

    -- Sunday morning community meeting
    INSERT INTO reservation_requests (resource_id, requested_by, time_slot, purpose, attendee_count, notes)
    VALUES (
      v_resource_id,
      v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '7 days')::timestamp + TIME '10:00',  -- Next Sunday 10am
        (CURRENT_DATE + INTERVAL '7 days')::timestamp + TIME '13:00'   -- Until 1pm
      ),
      'Community Meeting',
      25,
      'Need tables arranged in circle, please'
    );

    -- Weekday evening book club
    INSERT INTO reservation_requests (resource_id, requested_by, time_slot, purpose, attendee_count)
    VALUES (
      v_resource_id,
      v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '3 days')::timestamp + TIME '18:00',  -- Three days from now, 6pm
        (CURRENT_DATE + INTERVAL '3 days')::timestamp + TIME '21:00'   -- Until 9pm
      ),
      'Book Club',
      15
    );

    -- ===== DENIED REQUEST (for testing workflow) =====
    INSERT INTO reservation_requests (
      resource_id,
      requested_by,
      time_slot,
      purpose,
      attendee_count,
      status,
      reviewed_by,
      reviewed_at,
      denial_reason
    ) VALUES (
      v_resource_id,
      v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '10 days')::timestamp + TIME '22:00',  -- Too late at night
        (CURRENT_DATE + INTERVAL '11 days')::timestamp + TIME '02:00'
      ),
      'Late Night Event',
      50,
      'denied',
      v_user_id,
      NOW() - INTERVAL '1 day',
      'Club House closes at 10 PM. Please select an earlier time.'
    );

  END IF;
END $$;
```

---

### Testing Workflow

1. **Setup**:
   ```bash
   cd examples/community-center
   cp .env.example .env
   # Edit .env with database credentials
   ./fetch-keycloak-jwk.sh
   docker-compose up -d
   ```

2. **Test Availability Calendar** (public view):
   - Navigate to `/view/reservations` → See list/calendar toggle
   - Switch to calendar view → See approved reservations (clean availability view)
   - Only approved reservations appear (Birthday Party on Saturday)
   - Click event → Navigate to reservation detail page

3. **Test Resource Detail Page**:
   - Navigate to `/detail/resources/1` (Club House)
   - See calendar section showing all reservations for this resource
   - Click "Add Reservation Request" → Create request page with `resource_id=1` pre-filled

4. **Test Request Creation** (community member flow):
   - Navigate to `/create/reservation_requests`
   - Fill form: Select Club House, choose time slot, add purpose
   - Try overlapping with existing reservation → See validation error
   - Choose available time → Submit successfully
   - Navigate to `/view/reservation_requests` → See your pending request (orange)

5. **Test Approval Workflow** (requires `manager` role):
   - Navigate to `/view/reservation_requests`
   - Filter by status="pending"
   - Click pending request → Edit page
   - Change status from "pending" to "approved"
   - Fill `reviewed_by` field with your user ID
   - Submit form → **Trigger automatically creates reservation**
   - Navigate to `/view/reservations` → See new reservation in calendar

6. **Test Denial Workflow** (requires `manager` role):
   - Navigate to pending request → Edit page
   - Change status to "denied"
   - Fill `reviewed_by` and `denial_reason` fields
   - Submit form → Request status updated, no reservation created
   - Request appears as denied (red) in requests list

7. **Test Trigger Reversal** (advanced):
   - Find approved request with reservation
   - Edit request → Change status from "approved" to "cancelled"
   - Submit → **Trigger automatically deletes reservation**
   - Check `/view/reservations` → Reservation removed from calendar

8. **Test Overlap Validation**:
   - Try to create request that overlaps with approved reservation → Validation error
   - See error message with conflict details

---

### Known Limitations

**Documented Constraints** (by design for v1):

1. **No Recurring Events**: Each reservation is a one-time event. For weekly meetings, create separate reservations. Future: Add `recurrence_rule` TEXT column with RRULE support.

2. **No Multi-Resource Bookings**: One reservation = one resource. For events needing multiple resources (clubhouse + projector + tables), use boolean accessory fields on the request:
   ```sql
   ALTER TABLE reservation_requests
     ADD COLUMN needs_projector BOOLEAN DEFAULT FALSE,
     ADD COLUMN needs_tables BOOLEAN DEFAULT FALSE;
   ```

3. **Capacity is Informational Only**: The `resources.capacity` field is displayed to users but NOT enforced by validation. Multiple overlapping requests could exceed capacity - managers must check manually during approval.

4. **No Automated Notifications**: Approvals/denials don't trigger emails or notifications. Future system will handle this.

5. **Users Cannot Edit Own Requests**: Once submitted, users must contact a manager to change request details. This prevents gaming the approval system but may frustrate legitimate changes. Future: Add "pending" state editing window.

6. **Calendar OR Map, Not Both**: Entities must choose between `show_calendar` or `show_map` for List view toggle. For use cases needing both (food trucks with location + time), use Detail page sections or create separate entities.

7. **Browser Timezone Assumed**: System assumes user's browser timezone matches their actual timezone. Traveling users or VPN users may see incorrect times. Future: Add user timezone preference setting.

8. **No Conflict Resolution UI**: When overlap detected, system shows error but doesn't suggest available time slots. Future: Add "Find Available Times" feature.

---

### Future Enhancements

**Phase 2 (Tool Shed)**:
- Add second resource: "Community Tool Shed"
- Different calendar color
- Equipment checkout workflow (hourly/daily rentals)

**Phase 3 (Payment Processing)**:
- Integrate payment gateway (Stripe?)
- Calculate fees based on `hourly_rate` and time_slot duration
- Payment status tracking (paid, pending, refunded)
- Invoice generation

**Phase 4 (Notifications & Alerts)**:
- Email/SMS notifications on approval/denial
- Reminder notifications (1 day before, 1 hour before)
- Manager notification queue for pending requests
- Digest emails (daily summary of pending requests for managers)

**Phase 5 (Advanced Features)**:
- Recurring reservations (every Monday, monthly, RRULE support)
- Reservation templates (save common setups for repeat events)
- Conflict resolution UI (show available time slots when overlap detected)
- Public calendar view (read-only, no auth required, embed widget)
- Waitlist system (auto-approve when cancellation opens slot)

**Status**: ⬜ Not started

---

## Implementation Checklist

### Phase 0: Query Param Pre-fill ✅ COMPLETE
- [x] Update CreatePage.ngOnInit() to read query params
- [x] Add applyQueryParamDefaults() method
- [x] Add navigateToCreateRelated() helper to DetailPage
- [x] Test with single/multiple params (requires manual testing)
- [x] Update CLAUDE.md with pattern

### Phase 1: Core TimeSlot Type ✅ COMPLETE
- [x] Create time_slot domain in database (v0-9-0 migration)
- [x] Add TimeSlot to EntityPropertyType enum
- [x] Update SchemaService.getPropertyType()
- [x] Generate DisplayTimeSlotComponent
- [x] Generate EditTimeSlotComponent
- [x] Integrate into DisplayPropertyComponent
- [x] Integrate into EditPropertyComponent
- [x] Test timezone conversion (UTC ↔ local) - needs manual testing
- [x] Test multi-day range formatting - needs manual testing

### Phase 2: Calendar Component ✅ COMPLETE
- [x] Install FullCalendar packages (@fullcalendar/angular, etc.)
- [x] Generate TimeSlotCalendarComponent
- [x] Implement display mode
- [x] Implement edit mode (drag/resize)
- [x] Implement list mode
- [x] Theme integration (light/dark via ThemeService)
- [x] Test event rendering - needs manual testing
- [x] Test interactions - needs manual testing

### Phase 3: List Page Toggle ✅ COMPLETE
- [x] Add calendar columns to metadata.entities (v0-9-0 migration)
- [x] Add showCalendar computed signal to ListPage
- [x] Add calendarEvents computed signal
- [x] Add calendar view rendering (no tabs - displays below list like map)
- [x] Auto-include calendar property in query
- [x] Test with example schema - ready for testing with community-center

### Phase 4: Detail Page Section ⏸️ DISABLED (UX Issues)
**Status**: Implemented but disabled due to UX problems (2025-11-04)

- [x] Detect inverse calendar relationships (calendarSections$ observable)
- [x] Load related calendar data
- [x] Render calendar section(s)
- [x] Implement "Add" button with FK pre-fill
- [x] Implement date selection → Create with prefill
- [x] Test navigation flow - ready for manual testing

**Current Status**: Feature is implemented but commented out in `detail.page.html` due to:
- Redundancy in 1:1 relationships (same record shown in Related Records + calendar section)
- No way to control whether calendars show on List page vs Detail page
- Visual clutter with multiple calendar sections

**See**: `docs/notes/CALENDAR_RELATED_RECORDS_TODO.md` for detailed problem analysis and potential solutions.

### Phase 5: Overlap Validation ⏸️ DEFERRED
**Status**: Not implemented - can be added in future release

This phase involves:
- [ ] Add no_overlap validation type to metadata
- [ ] Create check_time_slot_overlap RPC function
- [ ] Implement getOverlapValidator in SchemaService
- [ ] Apply validator in CreatePage/EditPage
- [ ] Display overlap errors with conflict details

**Current Behavior**: Overlap prevention is enforced by database EXCLUSION constraint. Users discover conflicts on submit with PostgreSQL error.

**Future Enhancement**: Add frontend async validation to check overlaps before submit and show available time slots.

### Phase 6: Documentation & Polish ✅ COMPLETE
- [x] Complete this document with final implementation notes
- [x] Create example schema (examples/community-center/)
- [x] Add Community Center README with testing guide
- [ ] Add unit tests for components - needs manual work
- [ ] Add integration tests - needs manual work
- [ ] Update main README if needed - optional

---

## Open Questions

1. **All-day events**: Should we support a special case for midnight-to-midnight ranges?
   - Display as "Mar 15-17, 2025" instead of timestamps
   - Edit UI could have checkbox for "All day"

2. **Recurring appointments**: Out of scope for initial implementation, but consider architecture that could support it later (RRULE strings, parent/child relationships).

3. **Calendar views**: Should we support month/week/day views, or just timeline?

4. **Permission checks**: Should calendar sections on Detail page check CREATE permission on related table before showing "Add" button?

5. **Conflict resolution**: When overlap detected, should we show available time slots as a suggestion?

---

## Implementation Notes

**Last Updated**: 2025-11-02
**Status**: ✅ Phases 0-4 Complete, Phase 5 Deferred
**Actual Effort**: ~6 hours (implementation)

### What Was Built

**Core Infrastructure (Phases 0-2)**:
- `time_slot` PostgreSQL domain for tstzrange values
- `DisplayTimeSlotComponent` - timezone-aware formatting (same-day vs multi-day)
- `EditTimeSlotComponent` - dual datetime-local inputs with validation
- `TimeSlotCalendarComponent` - FullCalendar integration with 3 modes (display/edit/list)
- Query param pre-fill system for contextual record creation

**UI Integration (Phases 3-4)**:
- ListPage: Calendar view for entities with `show_calendar=true`
- DetailPage: Automatic calendar sections for inverse relationships
- Metadata schema: `show_calendar`, `calendar_property_name`, `calendar_color_property` columns
- Database constraint: `calendar_or_map_not_both` ensures entities choose one view type

**Example Application**:
- `examples/community-center/` - Full reservation system with:
  - Resources table (facilities)
  - Reservation requests (pending/approved/denied/cancelled)
  - Reservations table (calendar-enabled, auto-synced via triggers)
  - Sample data with 4 requests demonstrating workflow

### Key Design Decisions

1. **Calendar OR Map, Not Both**: Entities have either `show_calendar` or `show_map` enabled, enforced by database constraint. Rationale: Avoids UI complexity and unclear expectations.

2. **No Tabs on List Page**: Unlike the original design doc proposal, calendar view renders below the table (similar to map pattern) rather than as a toggle. This allows both views to be visible simultaneously.

3. **Client-Side Timezone Formatting**: All timezone conversions happen in the browser using JavaScript `Date` API and `toLocaleString()`. This respects the user's local timezone automatically.

4. **Phase 5 Deferred**: Overlap validation is enforced at database level via EXCLUSION constraints. Frontend async validation would improve UX but is not critical for v1.

### File Changes Summary

**Migrations**:
- `postgres/migrations/deploy/v0-9-0-add-time-slot-domain.sql` - domain + metadata columns
- `postgres/migrations/revert/v0-9-0-add-time-slot-domain.sql`
- `postgres/migrations/verify/v0-9-0-add-time-slot-domain.sql`

**Components Created**:
- `src/app/components/display-time-slot/` - display component
- `src/app/components/edit-time-slot/` - edit component (ControlValueAccessor)
- `src/app/components/time-slot-calendar/` - FullCalendar wrapper

**Core Integrations**:
- `src/app/interfaces/entity.ts` - added calendar fields to `SchemaEntityTable`
- `src/app/services/schema.service.ts` - TimeSlot type detection
- `src/app/components/display-property/` - TimeSlot case
- `src/app/components/edit-property/` - TimeSlot case
- `src/app/pages/list/` - calendar view support
- `src/app/pages/detail/` - calendar sections for inverse relationships
- `src/app/pages/create/` - query param pre-fill

**Example Application**:
- `examples/community-center/` - complete reservation system
- `examples/community-center/init-scripts/01_reservations_schema.sql`
- `examples/community-center/README.md`
- `examples/community-center/.env.hosted`

### Testing Guide

1. **Apply Migration**:
   ```bash
   sqitch deploy dev --verify
   ```

2. **Set Up Example**:
   ```bash
   cd examples/community-center
   cp .env.hosted .env
   # Edit .env with database credentials
   # Run init script manually or via docker-compose
   ```

3. **Test Features**:
   - Navigate to `/view/reservations` - verify calendar renders
   - Click event - verify navigation to detail page
   - Navigate to `/view/resources/1` - verify calendar section shows related reservations
   - Click "Add Reservation Request" - verify resource_id pre-filled
   - Click date range on calendar - verify time_slot pre-filled
   - Submit overlapping reservation - verify EXCLUSION constraint error

### Future Work

**Phase 5 - Overlap Validation** (when needed):
1. Add `no_overlap` to `metadata.validation_types`
2. Create `check_time_slot_overlap()` RPC function with scope support
3. Add `getOverlapValidator()` to SchemaService (async validator)
4. Apply to CreatePage/EditPage form building
5. Update EditTimeSlotComponent to show conflict details

**Additional Enhancements**:
- Recurring events (RRULE support)
- All-day event detection (midnight-to-midnight)
- Multi-resource bookings
- Capacity enforcement
- Email/SMS notifications on approval/denial

---

## References

- FullCalendar Docs: https://fullcalendar.io/docs
- PostgreSQL Range Types: https://www.postgresql.org/docs/current/rangetypes.html
- Angular ControlValueAccessor: https://angular.dev/api/forms/ControlValueAccessor
- DaisyUI Tabs: https://daisyui.com/components/tab/
