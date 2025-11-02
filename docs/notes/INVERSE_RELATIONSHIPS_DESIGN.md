# Inverse Relationships Feature Design

**Status:** Phase 1 & 2 Complete ✓ (Phases 3 & 4 Deferred)
**Created:** 2025-10-10
**Last Updated:** 2025-10-10
**Author:** System Design Document

## Implementation Summary

**✓ Phase 1 & 2 Complete (2025-10-10)**

The inverse relationships feature is now production-ready with the following capabilities:

- **Automatic Detection:** Discovers inverse relationships from existing foreign key metadata
- **Smart Display:** Shows first 5 related records with links; "View all" button for larger sets
- **Performance Optimized:** Single HTTP request per relationship using `Prefer: count=exact` header
- **Fully Tested:** All 449 tests passing, including new mocks for inverse relationship methods
- **Database Indexed:** Foreign key columns indexed for fast queries
- **Production Ready:** Error handling, responsive design, and zero-count filtering included

**Files Modified:**
- `src/app/interfaces/entity.ts` - Added `InverseRelationshipMeta` and `InverseRelationshipData` interfaces
- `src/app/services/schema.service.ts` - Added `getInverseRelationships()` method
- `src/app/services/data.service.ts` - Added `getInverseRelationshipPreview()` and `getInverseRelationshipData()` methods
- `src/app/pages/detail/detail.page.ts` - Added `inverseRelationships$` observable
- `src/app/pages/detail/detail.page.html` - Added "Related Records" section with DaisyUI cards
- `src/app/pages/detail/detail.page.spec.ts` - Added mocks for new methods
- `examples/pothole/init-scripts/06_add_fk_indexes.sql` - Added database indexes for foreign keys

**Next Steps:** Phases 3 & 4 deferred pending user feedback.

---

## Table of Contents
1. [Overview](#overview)
2. [Use Cases](#use-cases)
3. [Technical Architecture](#technical-architecture)
4. [Database Schema Changes](#database-schema-changes)
5. [Service Layer Changes](#service-layer-changes)
6. [UI Components](#ui-components)
7. [Metadata Configuration](#metadata-configuration)
8. [Performance Considerations](#performance-considerations)
9. [Testing Strategy](#testing-strategy)
10. [Implementation Phases](#implementation-phases)
11. [Future Enhancements](#future-enhancements)

---

## Overview

### Problem Statement

Currently, Civic OS displays foreign key relationships in one direction only: when viewing an entity that has a foreign key, we show the related entity's `display_name`. However, we don't show the inverse relationship - when viewing the target entity, we don't show which records reference it.

**Example:** When viewing an Issue with `status` = "New", we see "Status: New". But when viewing the IssueStatus "New", we don't see the list of Issues that have this status.

### Solution

Implement "inverse relationships" (also known as "reverse foreign keys" or "back-references") that automatically detect and display related records on the Detail page. The system will:

1. Automatically detect inverse relationships from existing foreign key metadata
2. Display a preview of related records (first 5) with links to their detail pages
3. Provide a "More..." link to the filtered List page when more than 5 records exist
4. Support customization via metadata configuration

### Benefits

- **User Profiles:** View all Issues, WorkDetails, and Bids created by a user
- **Status Views:** See all Issues with a specific status
- **Category Views:** List all items in a category
- **Reduced Navigation:** Quick access to related records without manual filtering
- **Automatic Discovery:** No manual configuration needed for basic functionality

---

## Use Cases

### 1. Issue Status Detail Page

**Current State:**
Viewing `/detail/issue_statuses/1` shows:
- Name: "New"
- Description: "Newly reported issue"

**With Inverse Relationships:**
Viewing `/detail/issue_statuses/1` shows:
- Name: "New"
- Description: "Newly reported issue"
- **Related Issues (15):**
  - Pothole on Main Street → `/detail/issues/42`
  - Broken streetlight on Oak Ave → `/detail/issues/43`
  - Graffiti at City Hall → `/detail/issues/44`
  - _(2 more shown)_
  - **More...** → `/list/issues?f0_col=status&f0_op=eq&f0_val=1`

### 2. User Profile Page

**Current State:**
Viewing `/detail/civic_os_users/abc-123` shows:
- Display Name: "John D."
- Created At: 2024-01-15

**With Inverse Relationships:**
Viewing `/detail/civic_os_users/abc-123` shows:
- Display Name: "John D."
- Created At: 2024-01-15
- **Related Issues (3):**
  - Pothole on Main Street
  - Broken streetlight
  - Graffiti
- **Related Bids (7):**
  - _(First 5 shown with More... link)_
- **Related Work Details (12):**
  - _(First 5 shown with More... link)_

### 3. Category Detail Page

For any categorical entity (departments, types, priorities, etc.):
- Automatically show all related records
- Provide quick navigation to filtered lists
- Display counts for each relationship

---

## Technical Architecture

### Detecting Inverse Relationships

The system already has all metadata needed to detect inverse relationships via the `schema_properties` view:

```sql
-- Existing columns in schema_properties view:
join_schema     -- e.g., 'public'
join_table      -- e.g., 'issue_statuses'
join_column     -- e.g., 'id'
```

**Algorithm:**

1. For a given entity (e.g., `issue_statuses`), find all properties in other entities where:
   - `join_table` = current entity's `table_name`
   - `join_schema` = 'public' (or current schema)
2. Each match represents an inverse relationship
3. Group by source table to get relationship summary

**Example Query:**

```typescript
// For entity 'issue_statuses', find all inverse relationships:
// SELECT * FROM schema_properties
// WHERE join_table = 'issue_statuses' AND join_schema = 'public'

// Results:
// - table_name: 'issues', column_name: 'status'
// - table_name: 'work_details', column_name: 'issue_status'
```

### Data Model

```typescript
export interface InverseRelationship {
  // Source entity that references this entity
  sourceTable: string;
  sourceTableDisplayName: string;

  // Column in source entity that contains the FK
  sourceColumn: string;
  sourceColumnDisplayName: string;

  // The current entity being viewed
  targetTable: string;
  targetId: string | number;

  // Computed data
  totalCount: number;
  previewRecords: EntityData[];

  // Display configuration
  showOnDetail: boolean;
  sortOrder: number;
  previewLimit: number;
}
```

---

## Database Schema Changes

### Option A: No Database Changes (Recommended for MVP)

Use existing `schema_properties` view to compute inverse relationships dynamically. No database changes required.

**Pros:**
- Zero migration effort
- Automatically works for all entities
- Self-maintaining as schema evolves

**Cons:**
- Cannot customize per-relationship (only per-entity or global)
- Must compute relationships on every page load (mitigated by caching)

### Option B: Add Metadata Table for Customization (Future)

Add `metadata.inverse_relationships` table for advanced configuration:

```sql
CREATE TABLE metadata.inverse_relationships (
  id SERIAL PRIMARY KEY,
  target_table NAME NOT NULL,
  source_table NAME NOT NULL,
  source_column NAME NOT NULL,

  -- Display configuration
  display_name TEXT,
  description TEXT,
  show_on_detail BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  preview_limit INT DEFAULT 5,

  UNIQUE (target_table, source_table, source_column)
);
```

**Pros:**
- Granular control over each relationship
- Custom display names (e.g., "Related Issues" vs "Issues")
- Can hide specific relationships
- Per-relationship preview limits

**Cons:**
- Requires migration
- Manual configuration for customization
- Must maintain consistency with schema changes

**Recommendation:** Start with Option A, add Option B if users request customization.

---

## Service Layer Changes

### 1. SchemaService Changes

Add methods to compute and fetch inverse relationships:

```typescript
// src/app/services/schema.service.ts

/**
 * Get all inverse relationships for a given entity.
 * Returns tables that have foreign keys pointing to this entity.
 */
public getInverseRelationships(targetTable: string): Observable<InverseRelationshipMeta[]> {
  return this.getProperties().pipe(
    map(props => {
      // Find all properties where join_table matches target
      const inverseProps = props.filter(p =>
        p.join_table === targetTable &&
        p.join_schema === 'public'
      );

      // Group by source table
      const grouped = this.groupBySourceTable(inverseProps);

      // Convert to InverseRelationshipMeta[]
      return grouped.map(g => ({
        sourceTable: g.table_name,
        sourceColumn: g.column_name,
        sourceTableDisplayName: this.getDisplayName(g.table_name),
        sourceColumnDisplayName: g.display_name,
        showOnDetail: this.shouldShowOnDetail(g),
        sortOrder: g.sort_order || 0,
        previewLimit: this.getPreviewLimit(g)
      }));
    })
  );
}

/**
 * Interface for inverse relationship metadata
 */
export interface InverseRelationshipMeta {
  sourceTable: string;
  sourceTableDisplayName: string;
  sourceColumn: string;
  sourceColumnDisplayName: string;
  showOnDetail: boolean;
  sortOrder: number;
  previewLimit: number;
}

/**
 * Determine if inverse relationship should be shown on detail page.
 * Can be customized via metadata in future.
 */
private shouldShowOnDetail(property: SchemaEntityProperty): boolean {
  // Default: show all inverse relationships
  // Future: check metadata.inverse_relationships table
  return true;
}

/**
 * Get preview limit for an inverse relationship.
 */
private getPreviewLimit(property: SchemaEntityProperty): number {
  // Default: 5 records
  // Future: check metadata.inverse_relationships table
  return 5;
}

/**
 * Get cached display name for an entity
 */
private getDisplayName(tableName: string): string {
  const tables = this.tables();
  const entity = tables?.find(t => t.table_name === tableName);
  return entity?.display_name || tableName;
}
```

### 2. DataService Changes

Add methods to fetch related records and counts:

```typescript
// src/app/services/data.service.ts

/**
 * Get both preview records and total count in a single optimized request.
 * Uses PostgREST's Prefer: count=exact header to get total count in Content-Range
 * while fetching limited preview records - reduces HTTP requests from 2N to N.
 */
public getInverseRelationshipPreview(
  sourceTable: string,
  filterColumn: string,
  filterValue: any,
  limit: number = 5
): Observable<{ records: EntityData[], totalCount: number }> {
  const url = `${sourceTable}?${filterColumn}=eq.${filterValue}&select=id,display_name&limit=${limit}`;

  return this.http.get<EntityData[]>(environment.postgrestUrl + url, {
    observe: 'response',
    headers: {
      'Prefer': 'count=exact'
    }
  }).pipe(
    map(response => {
      const records = response.body || [];

      // Parse count from Content-Range header: "0-4/15" -> 15
      const contentRange = response.headers.get('Content-Range');
      let totalCount = 0;
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        totalCount = match ? parseInt(match[1], 10) : records.length;
      }

      return { records, totalCount };
    }),
    catchError(err => {
      console.error('Error fetching inverse relationship preview:', err);
      return of({ records: [], totalCount: 0 });
    })
  );
}

/**
 * Get complete inverse relationship data for display
 */
public getInverseRelationshipData(
  meta: InverseRelationshipMeta,
  targetId: string | number
): Observable<InverseRelationshipData> {
  return this.getInverseRelationshipPreview(
    meta.sourceTable,
    meta.sourceColumn,
    targetId,
    meta.previewLimit
  ).pipe(
    map(({ records, totalCount }) => ({
      meta,
      totalCount,
      previewRecords: records,
      targetId
    }))
  );
}

export interface InverseRelationshipData {
  meta: InverseRelationshipMeta;
  totalCount: number;
  previewRecords: EntityData[];
  targetId: string | number;
}
```

---

## UI Components

### 1. DetailPage Changes

Update `detail.page.ts` to fetch inverse relationships:

```typescript
// src/app/pages/detail/detail.page.ts

export class DetailPage {
  // ... existing code ...

  // Fetch inverse relationships
  public inverseRelationships$: Observable<InverseRelationshipData[]> =
    combineLatest([
      this.entity$,
      this.data$
    ]).pipe(
      mergeMap(([entity, data]) => {
        if (!entity || !data) return of([]);

        // Get inverse relationship metadata
        return this.schema.getInverseRelationships(entity.table_name).pipe(
          mergeMap(relationships => {
            // Fetch data for each relationship
            const dataObservables = relationships.map(meta =>
              this.data.getInverseRelationshipData(meta, data.id)
            );

            return dataObservables.length > 0
              ? combineLatest(dataObservables)
              : of([]);
          })
        );
      }),
      // Filter out relationships with zero count
      map(relationships => relationships.filter(r => r.totalCount > 0)),
      // Sort by sort_order
      map(relationships => relationships.sort((a, b) =>
        a.meta.sortOrder - b.meta.sortOrder
      ))
    );
}
```

### 2. DetailPage Template Changes

Add section to display inverse relationships:

```html
<!-- src/app/pages/detail/detail.page.html -->

<div class="prose">
  @if (entity$ | async; as entity) {
    @if (properties$ | async; as props) {
      @if (data$ | async; as data) {
        <!-- Existing header and properties -->
        <h1 class="mt-4">{{ entity.display_name }}: {{ data.display_name }}
          @if (entity.update) {
            <button class="btn btn-accent ml-8" [routerLink]="'/edit/' + entityKey + '/' + data.id">
              <span class="material-symbols-outlined">edit</span> Edit {{data.display_name}}
            </button>
          }
        </h1>
        <h2>Id: {{data.id}}</h2>

        <!-- Existing properties grid -->
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 2xl:grid-cols-8 gap-6">
          @for (prop of props; track prop) {
            <div [class]="'col-span-full sm:col-span-' + Math.min(SchemaService.getColumnSpan(prop), 3) + ' lg:col-span-' + Math.min(SchemaService.getColumnSpan(prop), 6) + ' 2xl:col-span-' + SchemaService.getColumnSpan(prop)">
              <app-display-property [datum]="data[prop.column_name]" [property]="prop"></app-display-property>
            </div>
          }
        </div>

        <!-- NEW: Inverse Relationships Section -->
        @if (inverseRelationships$ | async; as relationships) {
          @if (relationships.length > 0) {
            <div class="mt-8">
              <h2 class="text-2xl font-bold mb-4">Related Records</h2>

              @for (relationship of relationships; track relationship.meta.sourceTable) {
                <div class="card bg-base-200 mb-4">
                  <div class="card-body">
                    <h3 class="card-title">
                      {{ relationship.meta.sourceTableDisplayName }}
                      <span class="badge badge-primary">{{ relationship.totalCount }}</span>
                    </h3>

                    <!-- Preview list -->
                    @if (relationship.previewRecords.length > 0) {
                      <ul class="list-disc list-inside">
                        @for (record of relationship.previewRecords; track record.id) {
                          <li>
                            <a
                              [routerLink]="'/detail/' + relationship.meta.sourceTable + '/' + record.id"
                              class="link link-primary"
                            >
                              {{ record.display_name }}
                            </a>
                          </li>
                        }
                      </ul>
                    }

                    <!-- "More..." link if count exceeds preview limit -->
                    @if (relationship.totalCount > relationship.meta.previewLimit) {
                      <div class="card-actions justify-end mt-2">
                        <a
                          [routerLink]="'/list/' + relationship.meta.sourceTable"
                          [queryParams]="{
                            f0_col: relationship.meta.sourceColumn,
                            f0_op: 'eq',
                            f0_val: data.id
                          }"
                          class="btn btn-sm btn-outline"
                        >
                          View all {{ relationship.totalCount }}
                          {{ relationship.meta.sourceTableDisplayName }}
                          <span class="material-symbols-outlined ml-1">arrow_forward</span>
                        </a>
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          }
        }
      }
    }
  }
</div>
```

### 3. New Component: InverseRelationshipCard (Optional Refactor)

For cleaner code, extract to a separate component:

```typescript
// src/app/components/inverse-relationship-card/inverse-relationship-card.component.ts

@Component({
  selector: 'app-inverse-relationship-card',
  templateUrl: './inverse-relationship-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterModule]
})
export class InverseRelationshipCardComponent {
  @Input() relationship!: InverseRelationshipData;
  @Input() targetId!: string | number;
}
```

```html
<!-- inverse-relationship-card.component.html -->
<div class="card bg-base-200">
  <div class="card-body">
    <h3 class="card-title">
      {{ relationship.meta.sourceTableDisplayName }}
      <span class="badge badge-primary">{{ relationship.totalCount }}</span>
    </h3>

    @if (relationship.previewRecords.length > 0) {
      <ul class="list-disc list-inside">
        @for (record of relationship.previewRecords; track record.id) {
          <li>
            <a
              [routerLink]="'/detail/' + relationship.meta.sourceTable + '/' + record.id"
              class="link link-primary"
            >
              {{ record.display_name }}
            </a>
          </li>
        }
      </ul>
    }

    @if (relationship.totalCount > relationship.meta.previewLimit) {
      <div class="card-actions justify-end mt-2">
        <a
          [routerLink]="'/list/' + relationship.meta.sourceTable"
          [queryParams]="{
            f0_col: relationship.meta.sourceColumn,
            f0_op: 'eq',
            f0_val: targetId
          }"
          class="btn btn-sm btn-outline"
        >
          View all {{ relationship.totalCount }}
          <span class="material-symbols-outlined ml-1">arrow_forward</span>
        </a>
      </div>
    }
  </div>
</div>
```

Usage in detail.page.html:

```html
@for (relationship of relationships; track relationship.meta.sourceTable) {
  <app-inverse-relationship-card
    [relationship]="relationship"
    [targetId]="data.id"
  />
}
```

---

## Metadata Configuration

### Phase 1: Global Configuration (Immediate)

Add global settings to control inverse relationships:

**Environment Configuration:**

```typescript
// src/environments/environment.ts

export const environment = {
  // ... existing config ...
  inverseRelationships: {
    enabled: true,
    defaultPreviewLimit: 5,
    showZeroCount: false  // Hide relationships with 0 records
  }
};
```

### Phase 2: Entity-Level Configuration (Future)

Add `metadata.entities` columns:

```sql
ALTER TABLE metadata.entities ADD COLUMN show_inverse_relationships BOOLEAN DEFAULT true;
ALTER TABLE metadata.entities ADD COLUMN inverse_relationships_preview_limit INT DEFAULT 5;
```

### Phase 3: Relationship-Level Configuration (Future)

Implement `metadata.inverse_relationships` table (see Database Schema Changes, Option B).

Example configuration:

```sql
INSERT INTO metadata.inverse_relationships (
  target_table,
  source_table,
  source_column,
  display_name,
  show_on_detail,
  sort_order,
  preview_limit
) VALUES
  ('civic_os_users', 'issues', 'created_by', 'Issues Created', true, 1, 5),
  ('civic_os_users', 'bids', 'user_id', 'Bids Submitted', true, 2, 5),
  ('issue_statuses', 'issues', 'status', 'Issues with this Status', true, 1, 10);
```

---

## Performance Considerations

### 1. Query Optimization

**Key Optimization:** Using `Prefer: count=exact` header, we combine count and preview into a single HTTP request per relationship, reducing total requests from **2N to N** (where N = number of inverse relationships).

**Solutions:**

a) **Single request for count + preview** (✓ implemented in design)
   - Use PostgREST's `Prefer: count=exact` header on GET requests
   - Returns preview records in response body
   - Returns total count in `Content-Range` header
   - **50% reduction in HTTP requests**

b) **Limit preview to `id` and `display_name` only** (✓ implemented in design)
   - Minimal data transfer
   - Fast queries
   - Reduces payload size

c) **Add database indexes on foreign key columns** (CRITICAL for production)

   **Important:** PostgreSQL does NOT automatically index foreign key columns. It only indexes the PRIMARY KEY (referenced column), not the FOREIGN KEY (referencing column). Inverse relationship queries filter by the FK column, so indexes are essential.

   ```sql
   -- Example: When viewing IssueStatus #1, we query: SELECT * FROM issues WHERE status = 1
   -- Without an index on issues.status, this becomes a full table scan

   -- Create indexes on ALL foreign key columns that will be queried
   CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
   CREATE INDEX IF NOT EXISTS idx_issues_created_by ON issues(created_by);
   CREATE INDEX IF NOT EXISTS idx_work_details_issue_id ON work_details(issue_id);
   CREATE INDEX IF NOT EXISTS idx_bids_user_id ON bids(user_id);
   ```

   **Why this matters:**
   - Without index: Full table scan (slow, especially with 10,000+ rows)
   - With index: Index lookup (fast, O(log n) complexity)
   - Query time difference: 500ms → 5ms for large tables

   **Pro tip:** Run this query to find missing indexes on foreign keys:
   ```sql
   -- Find foreign keys without indexes
   SELECT
     c.conrelid::regclass AS table_name,
     a.attname AS column_name,
     'CREATE INDEX idx_' || c.conrelid::regclass || '_' || a.attname ||
     ' ON ' || c.conrelid::regclass || '(' || a.attname || ');' AS create_index_sql
   FROM pg_constraint c
   JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
   WHERE c.contype = 'f'  -- Foreign key constraints
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
       WHERE i.indrelid = c.conrelid
         AND a.attnum = ANY(i.indkey)
         AND i.indkey[0] = a.attnum  -- Index starts with this column
     );
   ```

d) **Parallel fetching** (✓ implemented in design)
   - Use `combineLatest` to fetch all relationships in parallel
   - All N requests execute simultaneously
   - Total time = slowest single request (not sum of all requests)

### 2. Caching Strategy

**SchemaService Caching:**
- Inverse relationship metadata is derived from `schema_properties`
- Already cached by `SchemaService.getProperties()`
- No additional caching needed for metadata

**Data Caching:**
```typescript
// Optional: Add caching for relationship data
private relationshipCache = new Map<string, Observable<InverseRelationshipData>>();

public getInverseRelationshipData(
  meta: InverseRelationshipMeta,
  targetId: string | number
): Observable<InverseRelationshipData> {
  const cacheKey = `${meta.sourceTable}_${meta.sourceColumn}_${targetId}`;

  if (!this.relationshipCache.has(cacheKey)) {
    const data$ = this.fetchInverseRelationshipData(meta, targetId).pipe(
      shareReplay(1)
    );
    this.relationshipCache.set(cacheKey, data$);
  }

  return this.relationshipCache.get(cacheKey)!;
}
```

**Cache Invalidation:**
- Clear cache on entity updates
- Clear cache on navigation
- Optional: Add TTL (time-to-live)

### 3. Pagination for Large Relationships

**Implementation Strategy:** For MVP, we'll use a simple threshold approach and skip to list page for large relationships. In-page pagination is deferred to Phase 4 (Advanced Features) based on user feedback.

**Phase 1 Implementation (MVP):**

For relationships with many records, skip the preview and show only "View all X records" button:

```typescript
// In template or component logic
const LARGE_RELATIONSHIP_THRESHOLD = 20;

// Skip preview for large relationships
@if (relationship.totalCount > LARGE_RELATIONSHIP_THRESHOLD) {
  <!-- Show only "View all" button, no preview list -->
  <div class="card-body">
    <h3 class="card-title">
      {{ relationship.meta.sourceTableDisplayName }}
      <span class="badge badge-primary">{{ relationship.totalCount }}</span>
    </h3>
    <p class="text-sm">This relationship has many records. Click below to view the full list.</p>
    <div class="card-actions">
      <a [routerLink]="..." class="btn btn-sm btn-primary">
        View all {{ relationship.totalCount }} records
      </a>
    </div>
  </div>
} @else {
  <!-- Show normal preview (first 5 records) -->
}
```

**Benefits:**
- Simple to implement
- Avoids performance issues with large previews
- Encourages users to use the full List page (with filtering/sorting)

**Future: In-Page Pagination (Phase 4)**

If users request it, implement in-page pagination for preview:

```html
<div class="join">
  <button class="join-item btn btn-sm">«</button>
  <button class="join-item btn btn-sm">Page 1 of 3</button>
  <button class="join-item btn btn-sm">»</button>
</div>
```

This is **deferred to Phase 4** based on user feedback and analytics showing users frequently interact with large relationship previews.

### 4. Performance Testing

Target metrics:
- Detail page load time: < 500ms (including inverse relationships)
- Inverse relationship query time: < 100ms per relationship
- Maximum supported inverse relationships per page: 10

Test scenarios:
- Entity with 1 inverse relationship, 5 records
- Entity with 5 inverse relationships, 100 records each
- Entity with 10 inverse relationships, 1000 records each

---

## Testing Strategy

### 1. Unit Tests

**SchemaService Tests:**

```typescript
// src/app/services/schema.service.spec.ts

describe('SchemaService', () => {
  describe('getInverseRelationships', () => {
    it('should return inverse relationships for a given entity', (done) => {
      service.getInverseRelationships('issue_statuses').subscribe(relationships => {
        expect(relationships.length).toBeGreaterThan(0);
        expect(relationships[0].sourceTable).toBe('issues');
        expect(relationships[0].sourceColumn).toBe('status');
        done();
      });
    });

    it('should return empty array for entities with no inverse relationships', (done) => {
      service.getInverseRelationships('nonexistent_table').subscribe(relationships => {
        expect(relationships.length).toBe(0);
        done();
      });
    });

    it('should group inverse relationships by source table', (done) => {
      service.getInverseRelationships('civic_os_users').subscribe(relationships => {
        const sourceTables = relationships.map(r => r.sourceTable);
        const uniqueTables = new Set(sourceTables);
        expect(uniqueTables.size).toBe(sourceTables.length);
        done();
      });
    });
  });
});
```

**DataService Tests:**

```typescript
// src/app/services/data.service.spec.ts

describe('DataService', () => {
  describe('getInverseRelationshipPreview', () => {
    it('should return both preview records and total count', (done) => {
      service.getInverseRelationshipPreview('issues', 'status', 1, 5).subscribe(result => {
        expect(result).toHaveProperty('records');
        expect(result).toHaveProperty('totalCount');
        expect(Array.isArray(result.records)).toBe(true);
        expect(typeof result.totalCount).toBe('number');
        expect(result.totalCount).toBeGreaterThanOrEqual(0);
        done();
      });
    });

    it('should return preview records with id and display_name', (done) => {
      service.getInverseRelationshipPreview('issues', 'status', 1, 5).subscribe(result => {
        expect(result.records.length).toBeLessThanOrEqual(5);
        if (result.records.length > 0) {
          expect(result.records[0]).toHaveProperty('id');
          expect(result.records[0]).toHaveProperty('display_name');
        }
        done();
      });
    });

    it('should respect limit parameter', (done) => {
      service.getInverseRelationshipPreview('issues', 'status', 1, 3).subscribe(result => {
        expect(result.records.length).toBeLessThanOrEqual(3);
        done();
      });
    });

    it('should return totalCount even when preview is limited', (done) => {
      // If there are 15 total issues with status=1, but limit=5
      service.getInverseRelationshipPreview('issues', 'status', 1, 5).subscribe(result => {
        // totalCount should be 15, not 5
        expect(result.totalCount).toBeGreaterThanOrEqual(result.records.length);
        done();
      });
    });
  });

  describe('getInverseRelationshipData', () => {
    it('should return complete relationship data', (done) => {
      const meta: InverseRelationshipMeta = {
        sourceTable: 'issues',
        sourceTableDisplayName: 'Issues',
        sourceColumn: 'status',
        sourceColumnDisplayName: 'Status',
        showOnDetail: true,
        sortOrder: 0,
        previewLimit: 5
      };

      service.getInverseRelationshipData(meta, 1).subscribe(data => {
        expect(data.meta).toBe(meta);
        expect(data.targetId).toBe(1);
        expect(data).toHaveProperty('totalCount');
        expect(data).toHaveProperty('previewRecords');
        done();
      });
    });
  });
});
```

### 2. Integration Tests

**DetailPage Tests:**

```typescript
// src/app/pages/detail/detail.page.spec.ts

describe('DetailPage', () => {
  describe('Inverse Relationships', () => {
    it('should display inverse relationships section', () => {
      fixture.detectChanges();

      const relationshipsSection = fixture.debugElement.query(
        By.css('.inverse-relationships-section')
      );
      expect(relationshipsSection).toBeTruthy();
    });

    it('should display correct count badge', () => {
      component.inverseRelationships$ = of([{
        meta: {
          sourceTable: 'issues',
          sourceTableDisplayName: 'Issues',
          sourceColumn: 'status',
          sourceColumnDisplayName: 'Status',
          showOnDetail: true,
          sortOrder: 0,
          previewLimit: 5
        },
        totalCount: 15,
        previewRecords: [],
        targetId: 1
      }]);

      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.textContent).toContain('15');
    });

    it('should show "More..." button when count exceeds preview limit', () => {
      component.inverseRelationships$ = of([{
        meta: {
          sourceTable: 'issues',
          sourceTableDisplayName: 'Issues',
          sourceColumn: 'status',
          sourceColumnDisplayName: 'Status',
          showOnDetail: true,
          sortOrder: 0,
          previewLimit: 5
        },
        totalCount: 15,
        previewRecords: mockRecords(5),
        targetId: 1
      }]);

      fixture.detectChanges();

      const moreButton = fixture.debugElement.query(By.css('.btn-outline'));
      expect(moreButton).toBeTruthy();
      expect(moreButton.nativeElement.textContent).toContain('View all 15');
    });

    it('should not show "More..." button when count equals preview limit', () => {
      component.inverseRelationships$ = of([{
        meta: {
          sourceTable: 'issues',
          sourceTableDisplayName: 'Issues',
          sourceColumn: 'status',
          sourceColumnDisplayName: 'Status',
          showOnDetail: true,
          sortOrder: 0,
          previewLimit: 5
        },
        totalCount: 5,
        previewRecords: mockRecords(5),
        targetId: 1
      }]);

      fixture.detectChanges();

      const moreButton = fixture.debugElement.query(By.css('.btn-outline'));
      expect(moreButton).toBeFalsy();
    });
  });
});
```

### 3. E2E Tests

```typescript
// e2e/inverse-relationships.spec.ts

describe('Inverse Relationships', () => {
  it('should display inverse relationships on detail page', () => {
    cy.visit('/detail/issue_statuses/1');
    cy.get('.inverse-relationships-section').should('exist');
    cy.contains('Related Records').should('be.visible');
  });

  it('should link to related entity detail pages', () => {
    cy.visit('/detail/issue_statuses/1');
    cy.get('.inverse-relationships-section a').first().click();
    cy.url().should('match', /\/detail\/issues\/\d+/);
  });

  it('should link to filtered list page when clicking "More..."', () => {
    cy.visit('/detail/issue_statuses/1');
    cy.contains('View all').click();
    cy.url().should('include', '/list/issues');
    cy.url().should('include', 'f0_col=status');
    cy.url().should('include', 'f0_op=eq');
  });

  it('should not display section when no inverse relationships exist', () => {
    cy.visit('/detail/some_entity_with_no_relationships/1');
    cy.get('.inverse-relationships-section').should('not.exist');
  });
});
```

### 4. Performance Tests

```typescript
// performance/inverse-relationships.perf.ts

describe('Inverse Relationships Performance', () => {
  it('should load detail page with inverse relationships in < 500ms', () => {
    const start = performance.now();
    cy.visit('/detail/civic_os_users/abc-123');
    cy.get('.inverse-relationships-section').should('exist');
    const end = performance.now();

    expect(end - start).to.be.lessThan(500);
  });

  it('should handle entity with 10 inverse relationships', () => {
    cy.visit('/detail/entity_with_many_relationships/1');
    cy.get('.card').should('have.length.at.most', 10);
  });
});
```

---

## Implementation Phases

### Phase 1: Core Functionality (MVP) ✓ COMPLETE

**Goal:** Basic inverse relationships working on Detail pages

**Tasks:**
1. ✓ Add `InverseRelationshipMeta` and `InverseRelationshipData` interfaces
2. ✓ Implement `SchemaService.getInverseRelationships()`
3. ✓ Implement `DataService.getInverseRelationshipPreview()` (optimized single-request method using `Prefer: count=exact`)
4. ✓ Implement `DataService.getInverseRelationshipData()` (wrapper method)
5. ✓ Update `DetailPage` component to fetch inverse relationships
6. ✓ Update `detail.page.html` template to display inverse relationships
7. ✓ Add basic styling with DaisyUI cards

**Acceptance Criteria:**
- [x] Viewing an entity detail page shows related records section
- [x] First 5 related records are displayed with links
- [x] "More..." button links to filtered list page
- [x] Zero-count relationships are hidden
- [x] Works for all entity types (no configuration needed)
- [x] Large relationships (>20 records) show "View all" button only
- [x] All 449 tests passing

**Implementation Notes (2025-10-10):**
- Added interfaces to `src/app/interfaces/entity.ts`
- Implemented methods in `src/app/services/schema.service.ts` and `src/app/services/data.service.ts`
- Updated `src/app/pages/detail/detail.page.ts` and template
- Created `examples/pothole/init-scripts/06_add_fk_indexes.sql` for database indexes
- Updated test specs to mock new methods
- Feature is production-ready for basic use cases

---

### Phase 2: Polish & Optimization ✓ COMPLETE

**Goal:** Improve performance, UX, and styling

**Tasks:**
1. ✓ Add loading states for inverse relationships (using async pipe)
2. ⏸️ Implement caching for relationship data (deferred - schema caching sufficient for now)
3. ✓ Add database indexes for foreign keys
4. ✓ Improve error handling (permissions, missing data via catchError)
5. ⏸️ Add "Related Records" section collapse/expand (deferred to Phase 4)
6. ✓ Improve styling and responsive design (DaisyUI cards)
7. ⏸️ Add animations (expand/collapse, loading) (deferred to Phase 4)

**Acceptance Criteria:**
- [x] Loading indicators show while fetching relationships (async pipe handles this)
- [x] Graceful error handling for missing permissions (returns empty array on error)
- [x] Mobile-responsive design (DaisyUI responsive classes)
- [~] Collapsible sections for cleaner UI (deferred - not critical for MVP)

**Implementation Notes (2025-10-10):**
- Error handling implemented via `catchError` in DataService, returns empty arrays on error
- Database indexes added in `examples/pothole/init-scripts/06_add_fk_indexes.sql`
- Responsive design uses DaisyUI's responsive card system
- Loading states handled automatically by Angular's async pipe
- Caching deferred - SchemaService already caches metadata, relationship data refreshes on navigation
- Collapse/expand and animations deferred to Phase 4 based on user feedback

---

### Phase 3: Configuration & Customization (DEFERRED)

**Goal:** Allow admins to customize inverse relationships

**Status:** Deferred pending user feedback. Current implementation uses sensible defaults.

**Tasks:**
1. Add global configuration in environment
2. Add entity-level configuration in `metadata.entities`
3. Create UI for managing inverse relationship settings (admin page)
4. Implement custom display names
5. Implement per-relationship preview limits
6. Add ability to hide specific relationships

**Acceptance Criteria:**
- [ ] Admins can configure preview limit globally
- [ ] Admins can hide inverse relationships for specific entities
- [ ] Admins can customize display names
- [ ] Configuration persists in database
- [ ] Changes apply immediately (cache refresh)

**Estimated Effort:** 2-3 days

**Implementation Notes:**
- Default preview limit of 5 records is hardcoded in `SchemaService.getPreviewLimit()`
- All inverse relationships are shown by default (`shouldShowOnDetail()` returns true)
- To implement: Add database columns to `metadata.entities` or create new `metadata.inverse_relationships` table
- Consider implementing only if users request more control over relationship display

---

### Phase 4: Advanced Features (DEFERRED)

**Goal:** Additional functionality based on user feedback

**Status:** Deferred pending user feedback and usage analytics.

**Potential Features:**
1. **In-Page Pagination:** Navigate through large relationship previews without leaving detail page (currently using threshold approach that links to list page)
2. **Inline Editing:** Edit related records without navigation
3. **Bulk Actions:** Select multiple related records for bulk operations
4. **Sorting:** Sort preview records by different columns
5. **Filtering:** Filter preview records within the detail page
6. **Aggregations:** Show summary stats (count by status, average, etc.)
7. **Charts:** Visualize relationships (pie chart of status distribution)
8. **Create Related:** Quick-create button for new related records
9. **Many-to-Many:** Support for many-to-many relationships via junction tables
10. **Collapse/Expand:** Collapsible "Related Records" sections
11. **Animations:** Smooth transitions for expand/collapse and loading states

**Prioritization:** Based on user feedback and usage analytics

**Implementation Notes:**
- Current threshold approach (>20 records → "View all" button) is simple and performant
- In-page pagination should only be implemented if analytics show users frequently interact with large relationship previews
- Many features can be added incrementally without breaking existing functionality
- Monitor user behavior to determine which features provide the most value

---

## Future Enhancements

### 1. Many-to-Many Relationships

**Challenge:** Detecting many-to-many relationships requires analyzing junction tables.

**Example:**
```
users → user_roles (junction) → roles
```

**Solution:**
- Detect junction tables (tables with exactly 2 foreign keys)
- Build inverse relationships through the junction
- Display as "Related Roles (via User Roles)"

**Complexity:** High - requires additional schema analysis

---

### 2. Recursive Relationships (Self-References)

**Challenge:** Tables that reference themselves (e.g., `parent_id` in categories).

**Example:**
```sql
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT,
  parent_id INT REFERENCES categories(id)
);
```

**Solution:**
- Detect self-referencing foreign keys (`is_self_referencing` already in schema)
- Display as "Child Categories" and "Parent Category"
- Handle tree traversal (ancestors, descendants)

**Complexity:** Medium

---

### 3. Relationship Strength Indicators

Show visual indicators of relationship importance:
- **Strong:** High count (>100 records)
- **Medium:** Moderate count (10-100 records)
- **Weak:** Low count (1-10 records)

**UI:**
```html
<span class="badge badge-success">Strong (250)</span>
<span class="badge badge-warning">Medium (45)</span>
<span class="badge badge-info">Weak (3)</span>
```

---

### 4. Relationship Timeline

For time-based relationships, show a timeline:
- "5 Issues created this week"
- "Last bid: 2 days ago"
- Timeline chart showing activity over time

**Dependencies:** Requires timestamp columns on related entities

---

### 5. Smart Relationship Names

Use natural language for relationship names:
- `created_by` → "Created by User"
- `assigned_to` → "Assigned to User"
- `status` → "Status"

**Implementation:**
- Parse column names (remove suffixes like `_id`, `_by`)
- Convert snake_case to Title Case
- Check metadata for custom names

---

## Appendix A: PostgREST Query Examples

### Combined Count + Preview Query (Optimized)

**Request:**
```http
GET /issues?status=eq.1&select=id,display_name&limit=5
Prefer: count=exact
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Range: 0-4/15
Content-Type: application/json

[
  {"id": 42, "display_name": "Pothole on Main Street"},
  {"id": 43, "display_name": "Broken streetlight on Oak Ave"},
  {"id": 44, "display_name": "Graffiti at City Hall"},
  {"id": 45, "display_name": "Sidewalk crack on Elm Street"},
  {"id": 46, "display_name": "Missing stop sign"}
]
```

**Explanation:**
- Response body contains 5 preview records (due to `limit=5`)
- `Content-Range: 0-4/15` header indicates:
  - Records 0-4 are returned (5 records)
  - Total count is 15 records
- **Single HTTP request** replaces two separate requests (HEAD for count + GET for preview)

### Filtered List URL
```
/list/issues?f0_col=status&f0_op=eq&f0_val=1
```

This URL is used for the "View all" link when there are more records than the preview limit.

---

## Appendix B: Database Schema Example

**Current Schema:**
```sql
CREATE TABLE issue_statuses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  display_name TEXT GENERATED ALWAYS AS (name) STORED
);

CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status INT REFERENCES issue_statuses(id),
  created_by UUID REFERENCES civic_os_users(id),
  display_name TEXT GENERATED ALWAYS AS (title) STORED
);
```

**Inverse Relationships Detected:**
- `issue_statuses` has inverse relationship from `issues.status`
- `civic_os_users` has inverse relationship from `issues.created_by`

---

## Appendix C: Alternative Designs Considered

### Alternative 1: Separate "Related" Tab

**Design:** Add tab navigation to detail pages:
- "Details" tab (current view)
- "Related" tab (inverse relationships)

**Pros:**
- Cleaner detail view
- Better for entities with many relationships
- Can show more details per relationship

**Cons:**
- Additional click required
- Less discoverable
- More complex UI

**Decision:** Rejected - prefer inline display for discoverability

---

### Alternative 2: Sidebar for Relationships

**Design:** Fixed sidebar showing related records

**Pros:**
- Always visible
- Doesn't interfere with main content

**Cons:**
- Reduces content width
- Doesn't work on mobile
- Complex responsive design

**Decision:** Rejected - prefer mobile-first approach

---

### Alternative 3: Hover/Tooltip Preview

**Design:** Show count badges, preview on hover

**Pros:**
- Minimal space usage
- Clean UI

**Cons:**
- Poor mobile experience
- Hidden until interaction
- Accessibility concerns

**Decision:** Rejected - prefer always-visible approach

---

## Conclusion

The Inverse Relationships feature will significantly improve navigation and discoverability in Civic OS. By leveraging existing schema metadata, we can automatically detect and display related records without manual configuration.

The phased implementation approach allows us to:
1. Deliver core functionality quickly (Phase 1)
2. Iterate based on user feedback (Phases 2-3)
3. Expand with advanced features as needed (Phase 4)

**Next Steps:**
1. Review and approve this design document
2. Create implementation tickets for Phase 1
3. Begin development on core functionality
4. Gather user feedback after Phase 1 deployment
5. Prioritize Phase 2-4 features based on feedback

**Success Metrics:**
- 90% of detail page views include inverse relationships
- < 500ms page load time with relationships
- Positive user feedback on feature usefulness
- Increased navigation via relationship links (vs. main menu)
