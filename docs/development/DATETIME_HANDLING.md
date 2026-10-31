# DateTime vs DateTimeLocal - Timezone Handling

## Overview

Civic OS has two distinct timestamp property types with fundamentally different timezone behaviors. Choosing the wrong one causes data integrity issues.

## Type Comparison

| Aspect | DateTime | DateTimeLocal |
|--------|----------|---------------|
| PostgreSQL type | `timestamp without time zone` | `timestamptz` |
| Stores | "Wall clock" time (no timezone) | Absolute point in time (UTC) |
| Timezone conversion | None | Frontend converts local <-> UTC |
| Database value | Exactly what user enters | UTC equivalent of user's local time |

## When to Use Which

### DateTime (`timestamp without time zone`)

Use for times where **timezone doesn't matter** - the value is the same regardless of where you read it:

- Scheduled events and appointments
- Business hours
- Meeting slot definitions
- "Doors open at 7:00 PM" (always 7 PM local)

**Behavior**: User enters "10:30 AM" -> Database stores "10:30 AM" -> Everyone sees "10:30 AM"

### DateTimeLocal (`timestamptz`)

Use for **absolute moments in time** that need correct display across timezones:

- Created/updated timestamps
- Audit trail entries
- Events tied to specific real-world moments
- "The server went down at exactly this time"

**Behavior**: User in EST enters "5:30 PM" -> Database stores "10:30 PM UTC" -> User in PST sees "2:30 PM"

## Frontend Transformation Logic

**CRITICAL**: The transformation logic in the following functions handles timezone conversions. Modifying this code can cause data integrity issues (e.g., timestamps shifting by timezone offset on every save):

- `transformValueForControl()` and `transformValuesForApi()` in `@civic-os/core` (`packages/core/src/transform/`) hold the conversions. They take the browser time zone as an option, and `npm run test:packages:tz` runs them under UTC, America/New_York, Asia/Kolkata and Australia/Lord_Howe.
- `recordEditor` (`packages/core/src/facades/`) is how the generic app reaches them. Create mode calls `transformValuesForApi` with `{ mode: 'create', timeZone }`; edit mode calls `transformValueForControl` when it loads the record and `transformValuesForApi` with `{ mode: 'edit', timeZone }` on save. The pages pass the browser zone; core never reads the ambient zone. There are no page-level wrappers.

### How It Works

**DateTime (no conversion)**:
- Load: Database value passes through unchanged to `datetime-local` input
- Save: Form value passes through unchanged to API

**DateTimeLocal (UTC conversion)**:
- Load: UTC value from database is converted to user's local timezone for display in `datetime-local` input
- Save: Local timezone value from form is converted to UTC before sending to API

See the TSDoc and tests of the core transforms (`packages/core/src/transform/values.ts`, `values.test.ts`), the editor specs (`packages/core/src/facades/record-editor.test.ts` and `record-editor-edit.test.ts`), `series-schedule.test.ts`, and the data-integrity suite (`tests/e2e/integrity*.spec.ts`, `npm run e2e:integrity`) for implementation details.

### Recurring Series `dtstart` (Series Split)

Recurring series store `dtstart` as a `timestamp without time zone` holding wall-clock time **in the series' `timezone` column** (v0.38.5+). Entity `time_slot` values are `tstzrange` instants. The two must never be mixed:

- `buildSplitSchedule()` (`packages/core/src/transform/series-schedule.ts`, private to core) builds `p_new_dtstart` (and the edited length, as the new duration) for `split_series_from_date()` ("this and following"). `recordEditor`'s `saveWithScope('this_and_future')` calls it. It parses the edited `time_slot` as an instant range (`parseTstzrange()`, which accepts both the editor's `[…Z,…Z)` shape and PostgREST's quoted `["… +00",…)` shape) and formats the start as wall-clock time in the series timezone (`toWallClockInTimeZone()`; `isIanaTimeZone()` decides whether the series timezone is usable). Without a time slot in the edit, it keeps the series' original time of day on the split date.
- **Never send a UTC ISO string (`…Z`) to a `timestamp` parameter.** PostgreSQL drops the zone and stores the UTC clock reading, shifting the series by the UTC offset. Before v0.76.7 the split did exactly this, moving every following occurrence by the offset (5 hours in New York winter time), and an untouched time slot passed PostgREST's quotes through, so the split RPC failed silently.
- Use the series timezone, not the browser's: an admin editing from another timezone must still produce the series' own wall clock. A series with no (or an invalid) timezone is expanded in UTC by the worker, so UTC is the fallback, never the browser timezone.
- The editor reads the series' `time_slot_property` (not a hard-coded `time_slot`) and sends the edited occurrence's length as the new duration. It reads the series schedule first, then calls `split_series_from_date` once with `p_edited_entity_id` and `p_edited_values`, so the RPC splits the series and saves the edited occurrence in the same transaction; the editor sends no separate PATCH. When the series schedule cannot be read or the split fails it resolves `series_split_failed` (saving nothing), which the page shows as `error.series_split_failed`.

### Calendar Dates (`DATE`) such as `occurrence_date`

A PostgreSQL `DATE` is a calendar day, not an instant. `new Date('2026-12-07')` parses it as UTC midnight, which displays as Dec 6 anywhere west of UTC, and `new Date().toISOString().split('T')[0]` is tomorrow's date in the evening there. Use `parseDateOnly()` to display one and `dateInTimeZone(tz)` to compare against one (`src/app/utils/date.utils.ts`). Recurring `occurrence_date` is the local date in the series timezone (v0.76.9+), so "today" must be taken in that timezone (UTC when the series has none), not the browser's.

## Testing

When testing timestamp handling:
- DateTime values should round-trip without any transformation
- DateTimeLocal values should shift by the test environment's timezone offset
- See `packages/core/src/transform/values.test.ts` and `edit.page.spec.ts` for timestamp transformation test examples
- End to end, `tests/e2e/run-integrity.sh` types both types through the UI in America/New_York and Asia/Kolkata (including the DST gap and overlap), checks the stored values with `psql`, and checks the edit page shows them again. A local time inside the spring-forward gap (e.g. 02:30 on 2026-03-08 in New York) is stored as the instant of the pre-transition offset and re-displayed as 03:30. See `tests/e2e/README.md` (Data-integrity suite).
- Series split specs (`edit.page.spec.ts`, "Series split") and `date.utils.spec.ts` assert machine-timezone-independent values; run them under several zones, e.g. `TZ=America/New_York npm test -- --no-watch --include='**/edit.page.spec.ts'` and again with `TZ=Asia/Kolkata`

---

**Last Updated**: 2026-10-21
