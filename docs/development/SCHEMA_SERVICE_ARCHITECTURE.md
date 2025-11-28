# SchemaService Architecture

This document explains the internal architecture of `SchemaService` (`src/app/services/schema.service.ts`), focusing on its hybrid signal + observable pattern for efficient data caching and change detection.

## Overview

The SchemaService uses a hybrid approach combining Angular signals for reactive state with RxJS observables for async HTTP operations. This pattern prevents duplicate HTTP requests while maintaining proper change detection.

**Performance Impact:**
- Without in-flight tracking: ~12 duplicate requests per page load (~444 KB wasted)
- With in-flight tracking: 1-2 requests per page load (~74 KB total, 83% reduction)

## Key Design Patterns

### 1. Signal-to-Observable Conversion

Uses `toObservable()` to create observable streams from signals:

```typescript
// Created once in injection context (class field initializer)
private tables$ = toObservable(this.tables).pipe(
  filter(tables => tables !== undefined),
  map(tables => tables!)
);
```

**Why**: `toObservable()` must be called in injection context, so it's created as a class field. This single observable is shared across all subscribers.

### 2. In-Flight Request Tracking

Boolean flags prevent concurrent duplicate HTTP requests:

```typescript
private loadingEntities = false;
private loadingProperties = false;

public getEntities(): Observable<SchemaEntityTable[]> {
  // Only trigger fetch if not already loaded AND not currently loading
  if (!this.tables() && !this.loadingEntities) {
    this.loadingEntities = true;
    this.getSchema().subscribe();
  }
  return this.tables$;
}
```

**Why**: Without this pattern, multiple components calling `getEntities()` simultaneously would trigger multiple HTTP requests before the first completes. The flag is reset in `finalize()` when HTTP completes.

### 3. HTTP Observable Caching with shareReplay()

Caches HTTP observables to prevent repeat requests:

```typescript
private getSchema() {
  if (!this.schemaCache$) {
    this.schemaCache$ = this.http.get<SchemaEntityTable[]>(url)
      .pipe(
        tap(tables => this.tables.set(tables)),
        finalize(() => this.loadingEntities = false),
        shareReplay({ bufferSize: 1, refCount: false })
      );
  }
  return this.schemaCache$;
}
```

**Why**: `shareReplay({ bufferSize: 1, refCount: false })` ensures the HTTP call executes once and all subscribers receive the cached result. `refCount: false` keeps the cache alive even when all subscribers unsubscribe.

### 4. Selective Cache Invalidation

Separate caches for entities and properties enable targeted refresh:

```typescript
public refreshEntitiesCache() {
  this.schemaCache$ = null;
  this.loadingEntities = false;
  this.tables.set(undefined);
}
```

**Why**: When RBAC permissions change, only affected caches need refresh. The `schemaVersionGuard` determines which caches to invalidate based on version checks.

## Authentication Integration

The AuthService does NOT call `refreshCache()` on Keycloak's `Ready` event. Schema cache is loaded on-demand when components first request it. This prevents duplicate HTTP requests during app initialization.

**When schema cache IS refreshed:**
- User logout (`AuthService` logout handler) - Clear all cached data when user changes
- Schema version change (`schemaVersionGuard`) - Selective refresh when database metadata updates
- Manual refresh via `refreshCache()` method

**When schema cache is NOT refreshed:**
- Keycloak SSO check complete (Ready event) - Schema loads on-demand instead
- User login - Schema loads naturally when user navigates to first page

## Related Documentation

- Main documentation: `CLAUDE.md` - Property Type System section
- Service implementation: `src/app/services/schema.service.ts`
- Service tests: `src/app/services/schema.service.spec.ts`
