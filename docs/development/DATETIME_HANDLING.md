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

- `EditPage.transformValueForControl()` - Converts database values to form control values on load
- `EditPage.transformValuesForApi()` - Converts form values back to API format on save
- `CreatePage.transformValuesForApi()` - Converts form values for new record creation

### How It Works

**DateTime (no conversion)**:
- Load: Database value passes through unchanged to `datetime-local` input
- Save: Form value passes through unchanged to API

**DateTimeLocal (UTC conversion)**:
- Load: UTC value from database is converted to user's local timezone for display in `datetime-local` input
- Save: Local timezone value from form is converted to UTC before sending to API

See the extensive inline comments and tests in `edit.page.ts` and `create.page.ts` for implementation details.

## Testing

When testing timestamp handling:
- DateTime values should round-trip without any transformation
- DateTimeLocal values should shift by the test environment's timezone offset
- See `edit.page.spec.ts` for timestamp transformation test examples

---

**Last Updated**: 2026-03-11
