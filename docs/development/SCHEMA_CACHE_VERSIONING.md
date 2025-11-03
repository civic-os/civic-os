# Schema Cache Versioning System

## Overview

The schema cache versioning system enables automatic detection and refresh of frontend schema caches when database metadata changes, **without requiring a page refresh**. This provides a seamless experience for administrators making schema configuration changes.

## Architecture

### Two-Cache Strategy

The system tracks two independent caches:

1. **Entities Cache** - Depends on:
   - `metadata.entities` (table display names, sort order, descriptions)
   - `metadata.permissions` (table-level permissions)
   - `metadata.roles` (role definitions)
   - `metadata.permission_roles` (permission-role mappings)

2. **Properties Cache** - Depends on:
   - `metadata.properties` (column labels, visibility, sorting)
   - `metadata.validations` (validation rules)

### Components

#### Database Layer

**Civic OS Baseline Migration** (`postgres/migrations/deploy/v0-4-0-baseline.sql`)
- Adds `updated_at TIMESTAMPTZ` columns to all metadata tables
- Creates triggers using `set_updated_at()` function to auto-update timestamps
- Defines `schema_cache_versions` view that returns latest version for each cache

**View Output:**
```sql
SELECT * FROM schema_cache_versions;

 cache_name |            version
------------+-------------------------------
 entities   | 2025-10-13 23:25:34.865997+00
 properties | 2025-10-13 23:25:56.720367+00
```

#### Frontend Layer

**`VersionService`** (`src/app/services/version.service.ts`)
- Fetches current versions from `schema_cache_versions` view
- Compares database versions with locally cached versions
- Returns flags indicating which caches need refresh
- Provides `init()`, `checkForUpdates()`, and `reset()` methods

**`SchemaService` Updates** (`src/app/services/schema.service.ts`)
- New `refreshEntitiesCache()` - Refreshes only entities cache
- New `refreshPropertiesCache()` - Clears and refreshes only properties cache
- Existing `refreshCache()` - Refreshes both caches (backwards compatible)

**`schemaVersionGuard`** (`src/app/guards/schema-version.guard.ts`)
- Navigation guard that runs before each route activation
- Checks for version updates via `VersionService`
- Selectively refreshes only changed caches
- Logs updates to console for debugging

**App Initialization** (`src/app/app.component.ts`)
- Initializes `VersionService` on app startup
- Establishes baseline versions for comparison

**Route Configuration** (`src/app/app.routes.ts`)
- Applies `schemaVersionGuard` to all routes
- Ensures version check happens on every navigation

## How It Works

### Initialization Flow

1. App starts → `VersionService.init()` fetches baseline versions
2. User navigates → Guard checks for version changes
3. If no changes → Allow navigation immediately
4. If changes detected → Refresh affected cache(s), then allow navigation

### Update Detection Flow

```
Admin updates metadata
  ↓
Database trigger updates `updated_at` column
  ↓
`schema_cache_versions` view reflects new max timestamp
  ↓
User navigates to new route
  ↓
Guard calls `VersionService.checkForUpdates()`
  ↓
Compares DB versions with local cached versions
  ↓
If entities changed → `SchemaService.refreshEntitiesCache()`
If properties changed → `SchemaService.refreshPropertiesCache()`
  ↓
Navigation proceeds (cache refresh happens in background)
```

## Benefits

### Performance
- **Reduced network traffic**: Only refresh changed cache (not both)
- **Efficient polling**: Only checks on navigation (not timer-based)
- **Lightweight queries**: Single view query returns 2 rows

### User Experience
- **No page refresh needed**: Changes appear on next navigation
- **Transparent operation**: Users don't see intrusive notifications
- **Instant updates**: Admins see their changes take effect immediately

### Developer Experience
- **Simple integration**: Just add guard to routes
- **Console logging**: Debug messages show when refreshes occur
- **Type-safe**: TypeScript interfaces for all version data

## Example Scenarios

### Scenario 1: Admin updates entity display name
```
1. Admin visits /entity-management
2. Changes "Issues" → "Support Tickets"
3. Navigates to /view/Issue
4. Guard detects entities cache change
5. Console: "[SchemaVersion] Entities cache updated, refreshing..."
6. List page loads with new name "Support Tickets"
```

### Scenario 2: Admin updates property visibility
```
1. Admin visits /property-management
2. Hides "created_at" column from list view
3. Navigates to /view/Issue
4. Guard detects properties cache change
5. Console: "[SchemaVersion] Properties cache updated, refreshing..."
6. List page loads without "created_at" column
```

### Scenario 3: Admin updates both
```
1. Admin updates entity AND property metadata
2. Navigates to any route
3. Guard refreshes BOTH caches
4. Console logs both refresh messages
5. Page loads with all changes applied
```

## Testing

### Database-Level Test

```sql
-- Check initial versions
SELECT * FROM schema_cache_versions;

-- Update entity metadata
UPDATE metadata.entities SET display_name = 'New Name' WHERE table_name = 'Issue';

-- Verify version changed
SELECT * FROM schema_cache_versions WHERE cache_name = 'entities';
```

### Frontend Test

1. Open browser console
2. Navigate to any page
3. Update metadata via admin pages
4. Navigate to another page
5. Check console for refresh messages:
   - `[SchemaVersion] Entities cache updated, refreshing...`
   - `[SchemaVersion] Properties cache updated, refreshing...`

### Verification

The system is working correctly if:
- ✅ Versions in database update when metadata changes
- ✅ Console logs appear on navigation after metadata changes
- ✅ UI reflects changes without page refresh
- ✅ No errors in browser console or network tab

## Maintenance

### Adding New Metadata Tables

If you add new metadata tables that affect schema cache:

1. **Add `updated_at` column:**
   ```sql
   ALTER TABLE metadata.new_table
     ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
   ```

2. **Add trigger:**
   ```sql
   CREATE TRIGGER set_updated_at_trigger
     BEFORE INSERT OR UPDATE ON metadata.new_table
     FOR EACH ROW
     EXECUTE FUNCTION public.set_updated_at();
   ```

3. **Update view** (`schema_cache_versions`):
   ```sql
   -- Add to appropriate cache (entities or properties)
   GREATEST(
     ...,
     (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
      FROM metadata.new_table)
   )
   ```

### Debugging Tips

**Version not updating?**
- Check if trigger exists: `\d+ metadata.table_name`
- Verify row was actually updated: `SELECT * FROM metadata.table_name;`
- Check view definition: `\d+ schema_cache_versions`

**Cache not refreshing?**
- Check browser console for guard messages
- Verify guard is applied to route
- Check `VersionService.getCurrentVersions()` in console

**Performance concerns?**
- Monitor query time: `EXPLAIN ANALYZE SELECT * FROM schema_cache_versions;`
- Check for slow MAX() queries on large tables
- Consider materialized view if tables grow very large

## Future Enhancements

Possible improvements (not currently implemented):

1. **Per-table granularity**: Track versions per entity table instead of cache-wide
2. **WebSocket push**: Real-time updates instead of polling on navigation
3. **Visual indicator**: Small badge showing "Schema updated" instead of silent refresh
4. **LocalStorage persistence**: Survive page refresh without re-fetching baseline
5. **Conditional refresh**: Only refresh if user has been idle (avoid mid-edit disruption)

## Related Documentation

- See `CLAUDE.md` for overall schema metadata architecture
- See `AUTHENTICATION.md` for RBAC system that affects entities cache
- See form validation docs for how properties cache affects UI

## License

Copyright (C) 2023-2025 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
