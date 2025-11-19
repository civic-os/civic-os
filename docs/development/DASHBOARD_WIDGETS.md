# Dashboard Widget Development Guide

This guide documents the configuration and development patterns for Civic OS dashboard widgets.

## Overview

Dashboard widgets display filtered entity data in various formats (tables, maps, etc.). They use a configuration-driven approach where widget behavior is defined via JSONB config in the database.

**Key Architecture:**
1. Widget config stored in `metadata.dashboard_widgets.config` (JSONB)
2. Angular component reads config and builds PostgREST queries
3. DataService executes query with proper filter formatting
4. Component renders results using display components

## Filter Operators Reference

Filters are the core mechanism for selecting which records to display. Each filter has three parts:

```typescript
interface WidgetFilter {
  column: string;    // Database column name
  operator: string;  // PostgREST operator
  value: any;        // Filter value (type depends on operator)
}
```

### Available Operators

| Operator | Description | Value Type | PostgREST Output | Example |
|----------|-------------|------------|------------------|---------|
| `eq` | Equal to | `string \| number \| boolean` | `column=eq.value` | `status_id=eq.1` |
| `neq` | Not equal to | `string \| number \| boolean` | `column=neq.value` | `status=neq.closed` |
| `lt` | Less than | `string \| number` | `column=lt.value` | `enrolled_date=lt.2019-01-01` |
| `lte` | Less than or equal | `string \| number` | `column=lte.value` | `amount=lte.1000` |
| `gt` | Greater than | `string \| number` | `column=gt.value` | `created_at=gt.2024-01-01` |
| `gte` | Greater than or equal | `string \| number` | `column=gte.value` | `priority=gte.3` |
| `in` | In list | `string[]` | `column=in.(val1,val2)` | `status=in.(Active,Alumni)` |
| `is` | Is (for NULL/boolean) | `null \| true \| false` | `column=is.value` | `deleted_at=is.null` |
| `like` | Pattern match (case-sensitive) | `string` | `column=like.*pattern*` | `name=like.*smith*` |
| `ilike` | Pattern match (case-insensitive) | `string` | `column=ilike.*pattern*` | `email=ilike.*@gmail.com` |

### The `in` Operator (Important!)

The `in` operator requires an **array** value. The DataService automatically wraps array values in parentheses for PostgREST:

**Correct:**
```sql
jsonb_build_object(
  'column', 'status',
  'operator', 'in',
  'value', jsonb_build_array('Active', 'Alumni')
)
```

**Incorrect (will cause 400 error):**
```sql
-- DON'T DO THIS - string values don't get parentheses
jsonb_build_object(
  'column', 'status',
  'operator', 'in',
  'value', 'Active,Alumni'
)
```

## FilteredListWidgetConfig

Displays entity records in a compact table format.

### Complete Configuration Reference

```typescript
interface FilteredListWidgetConfig {
  // Filtering (optional)
  filters?: WidgetFilter[];     // Array of filter objects

  // Sorting (optional)
  orderBy?: string;             // Column to sort by (default: 'id')
  orderDirection?: 'asc' | 'desc';  // Sort direction (default: 'desc')

  // Pagination (optional)
  limit?: number;               // Max records to display (default: 10)

  // Display columns (required)
  showColumns: string[];        // Column names to display in table
}
```

### SQL Example

```sql
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
) VALUES (
  v_dashboard_id,
  'filtered_list',
  '2025 Season Teams',
  'teams',
  jsonb_build_object(
    'filters', jsonb_build_array(
      jsonb_build_object('column', 'season_year', 'operator', 'eq', 'value', 2025)
    ),
    'orderBy', 'age_group',
    'orderDirection', 'asc',
    'limit', 20,
    'showColumns', jsonb_build_array('display_name', 'age_group')
  ),
  1, 1, 1
);
```

### How It Works

1. **Config parsing**: Component extracts typed config from JSONB
2. **Property fetching**: Gets schema properties for the entity
3. **Select string building**: Uses `SchemaService.propertyToSelectString()` for foreign key expansion
4. **Query execution**: DataService builds PostgREST URL with filters
5. **Rendering**: Table uses `DisplayPropertyComponent` to render each cell value

**Important**: The template passes `record[column]` (not the whole record) to `DisplayPropertyComponent`. This extracts the specific column value, which for foreign keys is a nested object like `{ id: 1, display_name: 'Open' }`.

## MapWidgetConfig

Displays entity records with geography columns on an interactive map.

### Complete Configuration Reference

```typescript
interface MapWidgetConfig {
  // Data source (required)
  entityKey: string;            // Entity to display (e.g., 'participants')
  mapPropertyName: string;      // Geography column name (e.g., 'home_location')

  // Filtering (optional)
  filters?: WidgetFilter[];     // Same filter format as filtered_list

  // Display options (optional)
  showColumns?: string[];       // Columns to include in marker popup (default: ['display_name'])

  // Clustering (optional)
  enableClustering?: boolean;   // Group nearby markers (default: false)
  clusterRadius?: number;       // Cluster radius in pixels (default: 50)

  // Performance (optional)
  maxMarkers?: number;          // Limit total markers (default: 500)
}
```

### SQL Example

```sql
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
) VALUES (
  v_dashboard_id,
  'map',
  'Our Full Community',
  'participants',
  jsonb_build_object(
    'entityKey', 'participants',
    'mapPropertyName', 'home_location',
    'filters', jsonb_build_array(
      jsonb_build_object(
        'column', 'status',
        'operator', 'in',
        'value', jsonb_build_array('Active', 'Alumni')
      )
    ),
    'showColumns', jsonb_build_array('display_name', 'enrolled_date', 'status'),
    'enableClustering', true,
    'clusterRadius', 50,
    'maxMarkers', 500
  ),
  2, 1, 2
);
```

### Geography Data Requirements

Your entity must have:
1. A `geography(Point, 4326)` column (e.g., `home_location`)
2. A computed text function: `home_location_text` returning `ST_AsText(home_location)`

The widget automatically fetches the `_text` field to get WKT format coordinates.

### How It Works

1. **Config parsing**: Extracts typed MapWidgetConfig
2. **Property fetching**: Gets schema properties
3. **Select string building**: Includes geography `_text` field
4. **Query execution**: Fetches records with filters
5. **Marker transformation**: Converts `{ id, display_name, home_location_text }` to `{ id, name, wkt }`
6. **Map rendering**: GeoPointMapComponent displays markers with optional clustering

## DashboardNavigationWidgetConfig

Provides client-side navigation between dashboards using Angular's `routerLink` directive. This widget is ideal for storymap-style sequential dashboards.

### Complete Configuration Reference

```typescript
interface DashboardNavigationWidgetConfig {
  // Navigation buttons (optional)
  backward?: {
    url: string;    // Route URL (e.g., '/dashboard/3')
    text: string;   // Button label
  };
  forward?: {
    url: string;    // Route URL
    text: string;   // Button label
  };

  // Progress chips (required)
  chips: Array<{
    text: string;   // Chip label (e.g., '2018')
    url: string;    // Route URL (e.g., '/')
  }>;
}
```

### SQL Example

```sql
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, config, sort_order, width, height
) VALUES (
  v_dashboard_id,
  'dashboard_navigation',
  NULL,  -- Navigation widgets typically have no title
  jsonb_build_object(
    'backward', jsonb_build_object('url', '/dashboard/3', 'text', '2020: Building Momentum'),
    'forward', jsonb_build_object('url', '/dashboard/5', 'text', '2025: Impact at Scale'),
    'chips', jsonb_build_array(
      jsonb_build_object('text', '2018', 'url', '/'),
      jsonb_build_object('text', '2020', 'url', '/dashboard/3'),
      jsonb_build_object('text', '2022', 'url', '/dashboard/4'),
      jsonb_build_object('text', '2025', 'url', '/dashboard/5')
    )
  ),
  100,  -- High sort_order places at bottom
  2,    -- Full width
  1     -- Minimal height
);
```

### Features

- **Client-side navigation**: Uses Angular `routerLink` for instant transitions without page reload
- **Active chip highlighting**: Current dashboard chip displays as `badge-primary`
- **Invisible placeholders**: When `backward` or `forward` is omitted, an invisible placeholder maintains layout alignment
- **DaisyUI styling**: Uses `btn`, `badge`, and flex utilities

### Layout Patterns

**First dashboard (no backward):**
```sql
jsonb_build_object(
  'forward', jsonb_build_object('url', '/dashboard/3', 'text', 'Next Chapter'),
  'chips', jsonb_build_array(...)
)
```

**Middle dashboards (both directions):**
```sql
jsonb_build_object(
  'backward', jsonb_build_object('url', '/dashboard/3', 'text', 'Previous'),
  'forward', jsonb_build_object('url', '/dashboard/5', 'text', 'Next'),
  'chips', jsonb_build_array(...)
)
```

**Last dashboard (loop back):**
```sql
jsonb_build_object(
  'backward', jsonb_build_object('url', '/dashboard/4', 'text', '2022: Acceleration'),
  'forward', jsonb_build_object('url', '/', 'text', '↺ Back to Start'),
  'chips', jsonb_build_array(...)
)
```

### Why Not Markdown with HTML?

Previous implementations used markdown widgets with HTML links (`<a href="...">`). While functional, this approach causes full page reloads because standard HTML links bypass Angular's router. The `dashboard_navigation` widget solves this by using `routerLink` for client-side navigation, providing:

- Instant transitions (no white flash)
- Preserved application state
- Better user experience for narrative flows

## Widget Grid Layout

Widgets use a 2-column grid system:

- **width**: 1 = half-width, 2 = full-width
- **height**: 1-3 grid rows
- **sort_order**: Determines layout order (lower = earlier)

### Layout Patterns

**Side-by-side (text left, map right):**
```sql
-- Markdown: sort_order=1, width=1
-- Map: sort_order=2, width=1
```

**Full-width list:**
```sql
-- List: sort_order=3, width=2
```

**Two lists side-by-side:**
```sql
-- List 1: sort_order=3, width=1
-- List 2: sort_order=4, width=1
```

## Common Errors and Troubleshooting

### Error: `failed to parse filter (in.Active,Alumni)`

**Cause**: The `in` operator value is a string instead of an array.

**Fix**: Use `jsonb_build_array()` for array values:
```sql
-- Correct
jsonb_build_object('column', 'status', 'operator', 'in',
  'value', jsonb_build_array('Active', 'Alumni'))

-- Wrong
jsonb_build_object('column', 'status', 'operator', 'in',
  'value', 'Active,Alumni')
```

### Error: `[Object object]` displayed in table

**Cause**: Passing whole record instead of column value to DisplayPropertyComponent.

**Fix**: In template, use `record[column]` not `record`:
```html
<app-display-property [datum]="record[column]" />
```

### Error: Map shows no markers

**Possible causes:**
1. **Missing geography data**: Check that records have non-NULL geography values
2. **Filter mismatch**: Verify filter dates/values match your data
3. **Missing _text field**: Entity needs computed `column_name_text` returning `ST_AsText()`

**Debug steps:**
1. Check browser DevTools Network tab for the API response
2. Verify the response contains records with `mapPropertyName_text` values
3. Check console for "Map widget error" messages

### Error: No data loaded (empty response)

**Possible causes:**
1. **Filter too restrictive**: Check filter values match actual data
2. **Date range mismatch**: Historical dates vs recent data
3. **Entity key mismatch**: `entity_key` must match table name

**Debug**: Query the entity directly via PostgREST to verify data exists:
```bash
curl "http://localhost:3000/participants?limit=5"
```

## Development Patterns

### Signal-First Architecture

Widgets use Angular's signal-first pattern with computed signals and effects:

```typescript
// Computed signal derives from input
config = computed<MapWidgetConfig>(() => this.widget().config as MapWidgetConfig);

// Effect reacts to computed signal changes
constructor() {
  effect(() => {
    const cfg = this.config();
    // Fetch data when config changes...
  });
}
```

**Why this pattern?**
- Inputs may not be available during class construction
- Computed signals only run when dependencies change
- Effects provide side-effect handling (HTTP calls) outside the reactive graph

### Property Select String Building

Always use `SchemaService.propertyToSelectString()` to build column selects:

```typescript
const propsToSelect = entityProps.filter(p => columnNames.includes(p.column_name));
const columns = propsToSelect.map(p => SchemaService.propertyToSelectString(p));
```

This handles:
- Foreign key expansion: `status_id:statuses(id,display_name)`
- User references: `assigned_user_id:civic_os_users(id,display_name,full_name,email)`
- Simple columns: `display_name`

### Adding New Widget Types

1. Create component in `src/app/components/widgets/`
2. Define TypeScript interface for config
3. Register in `WidgetComponentRegistry` (app.config.ts)
4. Add widget_type to `metadata.widget_types` table
5. Document config properties in this guide

See `docs/INTEGRATOR_GUIDE.md` for complete widget registration example.

## See Also

- `docs/INTEGRATOR_GUIDE.md` - Dashboard creation examples
- `docs/notes/DASHBOARD_DESIGN.md` - Architecture and design decisions
- `examples/storymap/` - Complete working example with all widget types
