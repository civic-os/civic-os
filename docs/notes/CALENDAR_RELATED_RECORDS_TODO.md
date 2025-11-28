# Calendar in Related Records - UX Issues and TODO

**Status**: Disabled (2025-11-04)
**Location**: `src/app/pages/detail/detail.page.html` (calendar sections template, commented out)

## Problem

The "Calendar Sections" feature on Detail pages automatically displays calendar views for related entities that have TimeSlot properties. While conceptually useful, the current implementation has several UX issues:

### 1. Redundancy in 1:1 Relationships

**Example**: When viewing a Reservation that's linked to a Reservation Request:
- The Reservation Request appears in "Related Records" section (with link)
- The same Reservation Request appears again in a calendar section below
- User sees the same information twice with no clear benefit

**Why it happens**: The system shows calendars for ALL inverse relationships where the source entity has `show_calendar=true`, without considering cardinality.

### 2. No Granular Control

The `show_calendar` entity metadata flag controls:
- Whether the entity's List page shows a calendar view
- Whether the entity appears in calendar sections on related Detail pages

There's no way to say "show calendar on list page but NOT in related records" or vice versa.

### 3. Visual Clutter

For entities with multiple calendar-enabled relationships, Detail pages can become very long with multiple calendar widgets, especially when each only shows 1-2 events.

## Disabled Implementation

The feature is currently commented out but the backend logic (`calendarSections$` observable) is still active. This means:
- No performance impact (observable chain runs but result is ignored)
- Easy to re-enable for testing
- Code preserved for future improvements

## Potential Solutions

### Option 1: Add Separate Metadata Flag

Add `show_calendar_in_related_records` boolean to `metadata.entities`:

```sql
ALTER TABLE metadata.entities
  ADD COLUMN show_calendar_in_related_records BOOLEAN DEFAULT FALSE;
```

**Pros**:
- Gives integrators granular control
- Backward compatible (defaults to false)

**Cons**:
- Adds complexity to entity metadata
- More configuration for integrators to manage

### Option 2: Minimum Threshold

Only show calendar sections when there are 2+ related events:

```typescript
// In detail.page.ts, calendarSections$ pipe
map(sections => sections.filter(s => s.events.length >= 2))
```

**Pros**:
- Simple fix for 1:1 redundancy
- No schema changes

**Cons**:
- Hides useful calendars in some cases (e.g., Room with 1 upcoming Reservation)
- Arbitrary threshold

### Option 3: Integrate with Related Records Section

Instead of a separate calendar section, add a "View Calendar" button to Related Records cards when the entity has `show_calendar=true`. Clicking navigates to the filtered List page with calendar view.

**Pros**:
- Eliminates redundancy
- Uses existing List page calendar (no duplicate code)
- Cleaner UI

**Cons**:
- No inline calendar preview
- More clicks to see calendar

### Option 4: Smart Cardinality Detection

Only show calendar sections for 1:many or many:many relationships, skip 1:1:

```typescript
// Detect if relationship is 1:1 by checking if source column is unique
const calendarRelationships = relationships
  .filter(rel => {
    const sourceEntity = allEntities.find(e => e.table_name === rel.sourceTable);
    const isOneToOne = rel.isUnique; // Would need to add this to schema metadata
    return sourceEntity?.show_calendar &&
           sourceEntity?.calendar_property_name &&
           !isOneToOne;
  });
```

**Pros**:
- Automatically handles the common case
- No configuration needed

**Cons**:
- Requires schema metadata enhancement (unique constraint detection)
- Complex heuristic

## Recommendation

**Short term**: Keep disabled until we have real user feedback on whether inline calendars in Detail pages are valuable.

**Long term**: Implement **Option 3** (integrate with Related Records section). This provides the functionality without the clutter, and leverages existing List page calendar code.

## Related Files

- `src/app/pages/detail/detail.page.ts` - Calendar sections observable (`calendarSections$`)
- `src/app/pages/detail/detail.page.html` - Calendar sections template (commented out)
- `docs/development/CALENDAR_INTEGRATION.md` - Main calendar documentation
- `examples/community-center/` - Example with Reservations and Reservation Requests

## Testing Notes

To re-enable for testing:
1. Uncomment the calendar sections template in `detail.page.html`
2. Navigate to a Detail page where the entity has inverse relationships to calendar-enabled entities
3. Example: `/view/reservations/1` should show calendar for related Reservation Requests (if any)
