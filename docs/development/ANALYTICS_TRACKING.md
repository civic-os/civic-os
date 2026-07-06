# Analytics Tracking Implementation Guide

This document provides patterns for adding Matomo analytics tracking to Civic OS components and services.

## Completed

- ✅ Configuration infrastructure (runtime.ts, environment.ts, docker-entrypoint.sh)
- ✅ AnalyticsService with comprehensive API
- ✅ Matomo tracker provider in app.config.ts
- ✅ SettingsModalComponent for user opt-out preference
- ✅ Settings menu integration in app.component
- ✅ AuthService tracking (login/logout)
- ✅ HTTP error tracking interceptor (all failed HTTP requests logged to Matomo)

## HTTP Error Tracking Interceptor

The `errorTrackingInterceptor` (`src/app/interceptors/error-tracking.interceptor.ts`) automatically logs all failed HTTP requests to Matomo. It covers every service (DataService, SchemaService, and 20+ others) without requiring any per-service changes.

### How It Works

- Registered **last** in the interceptor chain in `app.config.ts`
- Uses `tap({ error })` to observe errors — does NOT swallow them, so existing error handling (toasts, redirects) is unaffected
- Categorizes requests by URL prefix:
  - **`API`** — PostgREST URLs (`getPostgrestUrl()`)
  - **`Auth`** — Keycloak URLs (`getKeycloakConfig().url`)
  - **`External`** — Everything else (S3, third-party APIs)
- Skips Matomo's own URLs to prevent feedback loops
- Includes PostgreSQL error codes when PostgREST returns them (e.g., `API 409 (PG 23505)`)

### Event Format

All events use category `Error`, action `Application`:

| Scenario | Event Name (label) | Value |
|---|---|---|
| PostgREST 404 | `API 404` | `404` |
| PostgREST unique violation | `API 409 (PG 23505)` | `409` |
| PostgREST permission denied | `API 403 (PG 42501)` | `403` |
| Keycloak token error | `Auth 401` | `401` |
| S3 upload failure | `External 500` | `500` |

### Matomo Dashboard Queries

To analyze HTTP errors in Matomo:
- **Events → Category = "Error"** shows all application errors
- **Events → Name contains "API"** filters to PostgREST errors only
- **Events → Name contains "PG 23505"** finds all unique constraint violations

## Tracking Patterns

### 1. List Page (src/app/pages/list/list.page.ts)

A unified `Entity/List` event fires in the `data$` pipeline's `tap()` callback after real API data arrives. The label encodes the full view state: entity key, active filter columns, search presence, and page number. Deduplication via `lastListTrackingKey` prevents duplicate events when `data$` re-emits for the same state.

| Scenario | Category | Action | Name | Value |
|---|---|---|---|---|
| Unfiltered list, page 1 | `Entity` | `List` | `issues` | `47` |
| Unfiltered list, page 2 | `Entity` | `List` | `issues:p2` | `47` |
| Filtered by status | `Entity` | `List` | `issues:status` | `12` |
| Filtered + page 3 | `Entity` | `List` | `issues:status:p3` | `12` |
| Search only | `Entity` | `List` | `issues:search` | `8` |
| Filter + search + page 2 | `Entity` | `List` | `issues:status:search:p2` | `2` |

**Label format**: `entityKey[:filterColumns][:search][:pN]` — page indicator omitted for page 1.

**Privacy**: Tracks filter *column names* (not values) and search *presence* (not content). Value is PostgREST `totalCount`.

### 2. Detail Page

Detail page views are automatically tracked by Matomo's `withRouter()` integration — the URL includes the entity key and record ID (e.g., `/view/issues/42`), so no custom tracking code is needed.

### 3. Create Page (src/app/pages/create-page/create-page.component.ts)

```typescript
import { AnalyticsService } from '../../services/analytics.service';

export class CreatePageComponent {
  private analytics = inject(AnalyticsService);

  save() {
    // ... existing save logic ...
    this.dataService.create(this.table(), transformedValues).subscribe({
      next: (result) => {
        // Track successful creation
        this.analytics.trackEvent('Entity', 'Create', this.table());

        // ... existing navigation logic ...
      },
      error: (err) => {
        // Error tracking handled by ErrorService
      }
    });
  }
}
```

### 4. Edit Page (src/app/pages/edit-page/edit-page.component.ts)

```typescript
import { AnalyticsService } from '../../services/analytics.service';

export class EditPageComponent {
  private analytics = inject(AnalyticsService);

  save() {
    // ... existing save logic ...
    this.dataService.update(this.table(), this.id(), transformedValues).subscribe({
      next: (result) => {
        // Track successful edit
        this.analytics.trackEvent('Entity', 'Edit', this.table());

        // ... existing navigation logic ...
      },
      error: (err) => {
        // Error tracking handled by ErrorService
      }
    });
  }
}
```

### 5. Data Service (src/app/services/data.service.ts)

```typescript
import { AnalyticsService } from './analytics.service';

export class DataService {
  private analytics = inject(AnalyticsService);

  delete(table: string, id: string): Observable<void> {
    return this.http.delete<void>(`${getPostgrestUrl()}${table}?id=eq.${id}`).pipe(
      tap(() => {
        // Track successful deletion
        this.analytics.trackEvent('Entity', 'Delete', table);
      }),
      catchError(error => {
        // Error tracking handled by ErrorService
        return throwError(() => error);
      })
    );
  }
}
```

### 6. Filter Bar Component (src/app/components/filter-bar/filter-bar.component.ts)

```typescript
import { AnalyticsService } from '../../services/analytics.service';

export class FilterBarComponent {
  private analytics = inject(AnalyticsService);

  onSearchSubmit() {
    const query = this.searchQuery();
    if (query) {
      // Track search usage (query length only, not content for privacy)
      this.analytics.trackEvent('Search', 'Query', this.tableName(), query.length);
    }

    // ... existing search logic ...
  }
}
```

### 7. Error Service — Superseded

Error tracking in `ErrorService` was replaced by the `errorTrackingInterceptor` (see HTTP Error Tracking Interceptor section above). The interceptor provides broader coverage — it catches every failed HTTP request across all services without per-service code changes.

## Event Naming Conventions

### Categories
- `Entity` - CRUD operations on database entities
- `Search` - Search and filter operations
- `Error` - Application errors and failures
- `Auth` - Authentication events (login/logout)
- `Dashboard` - Dashboard interactions

### Actions
- `List` - Viewing entity list page (label encodes filters, search, and page)
- `Detail` - Viewing entity detail page (automatic via `withRouter()`)
- `Create` - Creating new record
- `Edit` - Editing existing record
- `Delete` - Deleting record
- `Query` - Performing search (per-keystroke, debounced)
- `HTTP` - HTTP error occurred
- `Application` - Application error occurred
- `Login` - User logged in
- `Logout` - User logged out

### Name
- Entity table name (e.g., `issues`, `users`)
- Entity with filter columns (e.g., `issues:status,priority`)
- Entity with search indicator (e.g., `issues:search` or `issues:status:search`)
- Error message or code
- Dashboard ID

### Value (optional numeric)
- Result count (List events)
- Search query length (Query events)
- HTTP status code
- Error code

## Privacy Guidelines

1. **DO NOT** track:
   - User input text (search queries, form data)
   - Sensitive data (passwords, tokens)
   - Personal information (emails, phone numbers)

2. **DO** track:
   - Page views
   - Feature usage (which entities are most viewed/edited)
   - Search frequency (length, not content)
   - Error rates and types
   - User flows and navigation patterns

## Testing

### Manual Testing
1. Enable analytics in development: Set `MATOMO_URL` and `MATOMO_SITE_ID` in `.env`
2. Open browser dev tools → Network tab
3. Filter by "matomo" to see tracking requests
4. Verify events appear in Matomo Real-time view

### Unit Testing
Mock AnalyticsService in component tests:

```typescript
beforeEach(async () => {
  await TestBed.configureTestingModule({
    imports: [MyComponent],
    providers: [
      {
        provide: AnalyticsService,
        useValue: {
          trackEvent: jest.fn(),
          trackPageView: jest.fn(),
          trackError: jest.fn(),
          isEnabled: jest.fn().mockReturnValue(true)
        }
      }
    ]
  }).compileComponents();
});

it('should track entity creation', () => {
  const analytics = TestBed.inject(AnalyticsService);

  component.save();

  expect(analytics.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'issues');
});
```

## Remaining Implementation Tasks

- [x] ~~Add tracking to ErrorService (Error/* events)~~ — Replaced by HTTP error tracking interceptor (broader coverage)
- [x] ~~Add tracking to ListPage (Entity/List page view events)~~ — `list.page.ts` tracks unified Entity/List with deduplication
- [x] ~~Add tracking to DetailPage (Entity/Detail page view events)~~ — Covered by Matomo `withRouter()` automatic page view tracking
- [x] ~~Add tracking to CreatePage (Entity/Create events)~~ — `create.page.ts` tracks on successful creation
- [x] ~~Add tracking to EditPage (Entity/Edit events)~~ — `edit.page.ts` tracks on successful edit
- [x] ~~Add tracking to DataService delete method (Entity/Delete events)~~ — `data.service.ts` tracks on successful deletion
- [x] ~~Add tracking to FilterBarComponent (Search/Query events)~~ — `list.page.ts` tracks search query length
- [x] ~~Update nginx CSP headers to allow Matomo domain~~ — `MATOMO_URL_PLACEHOLDER` already in nginx.conf CSP
- [x] ~~Update CLAUDE.md with analytics section~~ — Index entry added
- [x] ~~Update ROADMAP.md to check off "Application Analytics"~~ — Already marked complete
- [x] ~~Test with real Matomo instance~~ — Verified E2E via Playwright: Entity/List events (unfiltered, filtered, search) confirmed in network requests and Matomo Event Names dashboard

## See Also

- [AnalyticsService API](../../src/app/services/analytics.service.ts)
- [Matomo JavaScript Tracking Client](https://developer.matomo.org/api-reference/tracking-javascript)
- [@ngx-matomo/tracker Documentation](https://www.npmjs.com/package/@ngx-matomo/tracker)
