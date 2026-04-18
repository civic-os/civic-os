# System Timezone Unification

**Status:** Planned for v1.0
**Date:** 2026-04-18
**Supersedes:** Per-component timezone handling (browser-local on frontend, `NOTIFICATION_TIMEZONE` on backend)

## Problem

Civic OS currently handles timezones inconsistently across its three layers:

| Layer | Current Behavior |
|-------|-----------------|
| **Angular frontend** | Uses browser's local timezone for all `DateTimeLocal` and `TimeSlot` display/edit |
| **PostgREST API** | Returns `timestamptz` values in UTC (PostgreSQL default) |
| **Go consolidated worker** | Uses `NOTIFICATION_TIMEZONE` env var for notification formatting only |

This causes problems:
1. A user traveling sees timestamps shift because their laptop changed timezone
2. Exported spreadsheets contain unlabeled local times — importing in a different timezone silently corrupts data
3. Notifications show the system timezone, but the browser shows the browser timezone — they can disagree
4. There is no single "system timezone" concept — each layer makes its own assumptions

## Design Decision

Unify all layers around a single `SYSTEM_TIMEZONE` environment variable (IANA format, e.g., `America/New_York`). The frontend reads it via runtime config and passes it to PostgREST via the `Prefer: timezone` header. The Go worker reads it as a renamed env var.

This design prioritizes Civic OS's primary use case: **single-timezone organizations** (municipal governments, community centers, local nonprofits) where all users operate in one timezone.

### Why Not Per-User Timezone?

Per-user timezone is a v2.0 enhancement. The `Prefer: timezone` header approach is chosen specifically because it makes per-user upgrade trivial — swap the config value for a user preference signal. See "Future: Per-User Timezone" section below.

## Architecture

### Configuration Flow

```
.env
  SYSTEM_TIMEZONE=America/New_York
    │
    ├─→ docker-entrypoint.sh → window.civicOsConfig.timezone
    │     └─→ getSystemTimezone() in runtime.ts
    │           ├─→ DataService: Prefer: timezone=America/New_York (every request)
    │           ├─→ DATE_PIPE_DEFAULT_OPTIONS provider (all | date pipes)
    │           ├─→ toLocaleString({ timeZone }) calls (~15 sites)
    │           ├─→ parseDatetimeInSystemTz() utility (edit/create pages)
    │           └─→ Import worker: receives timezone via postMessage
    │
    ├─→ PostgREST: PGRST_DB_ALLOW_TIMEZONE=true
    │     └─→ Honors Prefer: timezone header
    │         └─→ SET LOCAL timezone = 'America/New_York' per transaction
    │             └─→ timestamptz JSON responses in system timezone
    │
    └─→ Go worker: SYSTEM_TIMEZONE env var (replaces NOTIFICATION_TIMEZONE)
          └─→ Renderer.timezone for formatTimeSlot() / formatDateTime()
```

### Key Design Choices

**PostgREST `Prefer` header over `db-pre-request`:** The `Prefer: timezone` header is a built-in PostgREST feature (`PGRST_DB_ALLOW_TIMEZONE=true`). It executes `SET LOCAL timezone` per transaction — safe with connection pooling. Choosing this over hardcoding timezone in `check_jwt()` because:
- The frontend controls the timezone, enabling future per-user override
- No `db-pre-request` changes needed
- PostgREST handles validation (returns 406 for invalid timezone names)

**Angular `DATE_PIPE_DEFAULT_OPTIONS`:** A single root-level provider makes all `| date` pipes use the system timezone without modifying any templates.

**`Intl.DateTimeFormat` for display:** All `toLocaleString()`, `toLocaleDateString()`, `toLocaleTimeString()` calls gain a `{ timeZone: systemTz }` option. This is the standard web API for formatting dates in arbitrary IANA timezones.

**Input parsing:** When a user types `2025-11-30T14:00` into a `datetime-local` input, that must be interpreted as the system timezone, not the browser timezone. Two approaches:

1. **Let PostgREST handle it:** With `SET LOCAL timezone` active, PostgreSQL interprets ambiguous timestamps in the session timezone. The frontend can send the wall-clock string directly (without converting to UTC via `.toISOString()`). This simplifies the frontend significantly.
2. **Convert client-side:** Use `Intl.DateTimeFormat.formatToParts()` to determine the UTC offset for the system timezone at the given moment, then construct a UTC `Date`. This is more complex but doesn't depend on PostgREST session state.

**Recommendation:** Approach 1 (let PostgREST handle it) for `DateTimeLocal` saves. The frontend sends the form value as-is; PostgreSQL with the session timezone set interprets it correctly. This eliminates the need for `parseDatetimeLocal()` → `.toISOString()` conversion entirely for API submissions.

## Implementation Plan

### Phase 1: Configuration Pipeline (Low effort)

**1a. Frontend runtime config**

Add `timezone` to `window.civicOsConfig` interface and create `getSystemTimezone()`:

```typescript
// runtime.ts
export function getSystemTimezone(): string {
  return window.civicOsConfig?.timezone || environment.timezone || 'America/New_York';
}
```

Files to modify:
- `src/app/config/runtime.ts` — add function + interface field
- `src/app/interfaces/environment.ts` — add `timezone?: string`
- `src/environments/environment.ts` — add dev default
- `docker/frontend/docker-entrypoint.sh` — inject `timezone` from `$SYSTEM_TIMEZONE`

**1b. PostgREST configuration**

Add to all docker-compose files:
```yaml
postgrest:
  environment:
    PGRST_DB_ALLOW_TIMEZONE: "true"
```

No `check_jwt()` changes needed.

**1c. Go worker rename**

```go
// main.go — backwards compatible
systemTimezone := getEnv("SYSTEM_TIMEZONE", getEnv("NOTIFICATION_TIMEZONE", "America/New_York"))
```

Update all `.env` and `.env.example` files. Document the rename in release notes.

### Phase 2: Angular Display (Medium effort, mechanical)

**2a. `DATE_PIPE_DEFAULT_OPTIONS` provider**

```typescript
// app.config.ts
import { DATE_PIPE_DEFAULT_OPTIONS } from '@angular/common';
import { getSystemTimezone } from './config/runtime';

providers: [
  {
    provide: DATE_PIPE_DEFAULT_OPTIONS,
    useValue: { timezone: getSystemTimezone() }
  }
]
```

This fixes all `| date` pipe usages (6 call sites) without template changes.

**2b. `toLocaleString()` calls**

Add `{ timeZone: getSystemTimezone() }` option to ~15 call sites:

| File | Lines | Current | Change |
|------|-------|---------|--------|
| `display-time-slot.component.ts` | 74-81 | `toLocaleDateString('en-US', opts)` | Add `timeZone` to opts |
| `conflict-preview.component.ts` | 189-194 | `toLocaleDateString(undefined, opts)` | Add `timeZone` to opts |
| `exception-editor.component.ts` | 228 | `toLocaleDateString(undefined, opts)` | Add `timeZone` to opts |
| `series-version-timeline.component.ts` | 151 | `toLocaleDateString(undefined, opts)` | Add `timeZone` to opts |
| `series-editor-modal.component.ts` | 382 | `toLocaleString(undefined, opts)` | Add `timeZone` to opts |
| `create-series-wizard.component.ts` | 631 | `toLocaleDateString(undefined, opts)` | Add `timeZone` to opts |
| `series-group-detail.component.ts` | 868,875,950,981 | `toLocaleDateString/toLocaleString` | Add `timeZone` to opts |
| `entity-notes.component.ts` | 322 | `toLocaleDateString()` | Add opts with `timeZone` |
| `import-export.service.ts` | 322 | `toLocaleString('sv-SE', opts)` | Add `timeZone` to opts |
| `import-export.service.ts` | 854 | `toLocaleString('en-US', opts)` | Add `timeZone` to opts |
| `recurring.service.ts` | 645 | `toLocaleDateString()` | Add opts with `timeZone` |
| `series-group-management.page.ts` | 504 | `toLocaleDateString()` | Add opts with `timeZone` |
| `static-assets.page.ts` | 540 | `toLocaleDateString('en-US', opts)` | Add `timeZone` to opts |
| `template-management.page.ts` | 139 | `toLocaleDateString('en-US', opts)` | Add `timeZone` to opts |

Consider extracting a helper: `formatInSystemTz(date, opts)` to avoid repeating the timezone option.

**2c. Create Series Wizard — use system timezone**

```typescript
// Before (line 600):
timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

// After:
timezone: getSystemTimezone(),
```

### Phase 3: PostgREST Integration (Medium effort)

**3a. DataService `Prefer` header**

Add the timezone header to all PostgREST requests:

```typescript
// data.service.ts
private getHeaders(): HttpHeaders {
  return new HttpHeaders({
    'Prefer': `timezone=${getSystemTimezone()}`
  });
}
```

Note: PostgREST `Prefer` header supports multiple preferences comma-separated (e.g., `Prefer: return=representation, timezone=America/New_York`). Ensure existing `Prefer` headers (like `return=representation` on POST/PATCH) are merged, not replaced.

**3b. Simplify Edit/Create page transforms**

With PostgREST returning `timestamptz` values in the system timezone (not UTC), the `DateTimeLocal` load transform simplifies:

```typescript
// Before (edit.page.ts, lines 527-534):
// Parse UTC, extract local components via getFullYear()/getHours()/etc.
const date = new Date(rawValue);
const year = date.getFullYear();
// ...builds "YYYY-MM-DDTHH:MM" from local getters

// After:
// PostgREST returns "2025-11-30T14:00:00-05:00" (already in system tz)
// Just truncate to datetime-local format
value = rawValue.substring(0, 16);
```

The save transform may also simplify — if PostgREST's session timezone is set, sending the wall-clock string without a Z suffix lets PostgreSQL interpret it in the session timezone. **This needs careful testing** to confirm PostgREST passes the value through correctly.

### Phase 4: Import/Export (Low-Medium effort)

**4a. Export timezone labeling**

Add a timezone indicator to exported spreadsheets:
- TimeSlot columns: append system timezone abbreviation to header (e.g., "Time Slot (EST)")
- Or add a metadata row/sheet with the export timezone

**4b. Import worker timezone**

Pass system timezone to the web worker via `postMessage`:

```typescript
worker.postMessage({ data, schema, systemTimezone: getSystemTimezone() });
```

The worker uses it when parsing ambiguous date strings via `chrono-node` (which supports a `timezone` option in its reference date).

### Phase 5: Calendar Components (Low effort)

Calendar range construction in `list.page.ts` and `time-slot-calendar.component.ts` uses `new Date()` + local getters to build filter ranges. These should use `Intl.DateTimeFormat.formatToParts()` with the system timezone to determine "today" and week/month boundaries in the system timezone.

## Files Changed Summary

| Category | Files | Effort |
|----------|-------|--------|
| Runtime config | `runtime.ts`, `environment.ts`, `docker-entrypoint.sh` | Low |
| Docker config | ~10 docker-compose files, ~8 .env files | Low (mechanical) |
| Angular provider | `app.config.ts` | Low (1 line) |
| PostgREST config | docker-compose files | Low |
| DataService header | `data.service.ts` | Low |
| Display formatting | ~15 component/service files | Medium (mechanical) |
| Edit/Create transforms | `edit.page.ts`, `create.page.ts`, `detail.page.ts` | Medium |
| Date utilities | `date.utils.ts` | Medium |
| Import worker | `import-validation.worker.ts`, `import-export.service.ts` | Medium |
| Calendar components | `list.page.ts`, `time-slot-calendar.component.ts` | Low |
| Create Series Wizard | `create-series-wizard.component.ts` | Low (1 line) |
| Go worker | `main.go` | Low (1 line) |
| Go worker docs | `NOTIFICATIONS.md`, `PRODUCTION.md` | Low |

## What Does NOT Change

| Subsystem | Why |
|-----------|-----|
| **Scheduled jobs worker** | Already uses per-job `timezone` column from DB — independent of system timezone |
| **Recurring series worker** | Already uses per-series `timezone` column from DB — independent of system timezone |
| **`DateTime` property type** | Wall-clock time by design — no timezone conversion ever |
| **`Date` property type** | Date-only, no timezone semantics |
| **File/thumbnail workers** | No timezone involvement |
| **User provisioning** | No timezone involvement |
| **Payment processing** | No timezone involvement |
| **SMTP Date header** | RFC-compliant, uses process timezone (UTC in Docker) |

## Testing Strategy

1. **Unit tests**: Mock `getSystemTimezone()` to return a timezone different from the test runner's browser timezone (e.g., `Pacific/Auckland`). Verify that display formatting and input parsing use the mocked timezone, not the browser's.
2. **Integration tests**: Deploy with `SYSTEM_TIMEZONE=Pacific/Honolulu` and verify:
   - PostgREST responses contain Hawaii time offsets
   - Angular displays match PostgREST values
   - Edit → save round-trip preserves the correct UTC instant
   - Export spreadsheet times match displayed times
   - Import of exported spreadsheet produces identical records
3. **DST edge cases**: Test with a timezone that observes DST (e.g., `America/New_York`) at a DST boundary to verify correct offset selection.

## Future: Per-User Timezone (v2.0)

The `Prefer: timezone` header approach makes per-user timezone a signal swap:

### Database
```sql
ALTER TABLE metadata.civic_os_users_private
  ADD COLUMN timezone VARCHAR(100);
-- No default — null means "use system timezone"
```

### Frontend
```typescript
// TimezoneService or AuthService
activeTimezone = computed(() =>
  this.userProfile()?.timezone ?? getSystemTimezone()
);
```

All consumers of `getSystemTimezone()` would switch to reading from this signal. The `Prefer` header, `DATE_PIPE_DEFAULT_OPTIONS`, and all `toLocaleString()` calls automatically use the user's preference.

### Go Worker
```go
// Notification worker: per-recipient timezone
recipientTz := notification.RecipientTimezone // from JOIN with users
if recipientTz == "" {
    recipientTz = systemTimezone
}
loc, _ := time.LoadLocation(recipientTz)
rendered, err := renderer.RenderTemplateWithTimezone(template, data, loc)
```

### Settings UI
Add a timezone dropdown to the Settings modal (populated from `Intl.supportedValuesOf('timeZone')`). Auto-detect on first login via `Intl.DateTimeFormat().resolvedOptions().timeZone`.

## Migration Notes

### Breaking Changes
- `NOTIFICATION_TIMEZONE` env var is deprecated in favor of `SYSTEM_TIMEZONE` (backwards compatible via fallback)
- Frontend timestamp display will use system timezone instead of browser timezone — users whose browser timezone matches the system timezone see no change; others see corrected times

### Deployment Steps
1. Add `SYSTEM_TIMEZONE` to `.env` (can coexist with `NOTIFICATION_TIMEZONE` during transition)
2. Add `PGRST_DB_ALLOW_TIMEZONE: "true"` to PostgREST config
3. Deploy updated frontend, worker, and PostgREST
4. Remove `NOTIFICATION_TIMEZONE` from `.env` in a future release

---

**References:**
- `docs/development/DATETIME_HANDLING.md` — DateTime vs DateTimeLocal type semantics
- `docs/development/NOTIFICATIONS.md` — Current `NOTIFICATION_TIMEZONE` documentation
- [PostgREST Prefer: timezone](https://docs.postgrest.org/en/v14/references/api/preferences.html) — Built-in timezone header support
- [IANA Time Zone Database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) — Valid timezone identifiers
