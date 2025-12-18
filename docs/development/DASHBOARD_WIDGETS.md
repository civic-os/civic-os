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
| `ov` | Overlaps (for ranges) | `string` (range format) | `column=ov.[start,end)` | `time_slot=ov.[2025-03-10,2025-03-17)` |

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

## CalendarWidgetConfig

Displays entity records with time_slot columns on an interactive calendar with month/week/day views.

### Complete Configuration Reference

```typescript
interface CalendarWidgetConfig {
  // Data source (required)
  entityKey: string;              // Entity to display (e.g., 'reservations', 'appointments')
  timeSlotPropertyName: string;   // time_slot column name (e.g., 'time_slot', 'scheduled_time')

  // Filtering (optional)
  filters?: WidgetFilter[];       // Same filter format as filtered_list

  // Display options (optional)
  colorProperty?: string;         // hex_color column for event colors
  defaultColor?: string;          // Fallback event color (default: '#3B82F6')
  initialView?: string;           // 'dayGridMonth', 'timeGridWeek', 'timeGridDay' (default: 'timeGridWeek')
  initialDate?: string;           // YYYY-MM-DD format (default: today)

  // Interaction (optional)
  showCreateButton?: boolean;     // Display "Create {Entity}" button (default: false)

  // Performance (optional)
  maxEvents?: number;             // Limit total events (default: 1000)

  // Display columns (optional)
  showColumns?: string[];         // Columns for future tooltip display (Phase 3+)
}
```

### SQL Example

```sql
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
) VALUES (
  v_dashboard_id,
  'calendar',
  'Upcoming Reservations',
  'reservations',
  jsonb_build_object(
    'entityKey', 'reservations',
    'timeSlotPropertyName', 'time_slot',
    'colorProperty', 'status_color',
    'defaultColor', '#3B82F6',
    'initialView', 'timeGridWeek',
    'initialDate', '2025-03-15',
    'showCreateButton', true,
    'maxEvents', 500,
    'filters', jsonb_build_array(
      jsonb_build_object(
        'column', 'status',
        'operator', 'neq',
        'value', 'cancelled'
      )
    ),
    'showColumns', jsonb_build_array('display_name', 'resource_id', 'status')
  ),
  1, 2, 2  -- sort_order, width (full width), height (medium)
);
```

### TimeSlot Data Requirements

Your entity must have:
1. A `time_slot` column using the `time_slot` domain (PostgreSQL `tstzrange`)
2. BTREE_GIST extension installed: `CREATE EXTENSION IF NOT EXISTS btree_gist;`
3. (Optional) A `hex_color` column for per-event coloring

The `time_slot` domain stores timestamp ranges with timezone. Data format:
- **Storage**: `["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")`
- **Display**: "Mar 15, 2025 2:00 PM - 4:00 PM" (in user's local timezone)

### The `ov` (Overlaps) Operator

The calendar widget uses the `ov` operator to filter events based on the visible date range:

```sql
-- Automatically applied when user navigates calendar
WHERE time_slot && '[2025-03-10T00:00:00Z,2025-03-17T00:00:00Z)'
```

This operator finds all events that overlap with the specified date range.

### How It Works

1. **Config parsing**: Extracts typed CalendarWidgetConfig
2. **Property fetching**: Gets schema properties including time_slot and color fields
3. **Initial load**: Displays calendar without date range filter
4. **Date navigation**: User changes calendar view/date → `dateRangeChange` event fires
5. **Dynamic filtering**: Combines static filters + date range filter (ov operator)
6. **Query execution**: Fetches records matching filters
7. **Event transformation**: Converts `{ id, display_name, time_slot, color }` to `{ id, title, start, end, color }`
8. **Calendar rendering**: TimeSlotCalendarComponent displays events with FullCalendar
9. **Event interaction**: Click opens detail page in new tab
10. **Auto-refresh**: If `refresh_interval_seconds` is set, automatically refetches events

### Common Use Cases

**Resource Scheduling**:
```sql
-- Display room/equipment reservations with color-coded status
config := jsonb_build_object(
  'entityKey', 'reservations',
  'timeSlotPropertyName', 'time_slot',
  'colorProperty', 'status_color',
  'showCreateButton', true,
  'filters', jsonb_build_array(
    jsonb_build_object('column', 'resource_id', 'operator', 'eq', 'value', 5)
  )
);
```

**Appointment Calendar**:
```sql
-- Show appointments for specific user with week view
config := jsonb_build_object(
  'entityKey', 'appointments',
  'timeSlotPropertyName', 'scheduled_time',
  'initialView', 'timeGridWeek',
  'showCreateButton', true,
  'filters', jsonb_build_array(
    jsonb_build_object('column', 'assigned_user_id', 'operator', 'eq', 'value', current_user_id())
  )
);
```

**Event Calendar**:
```sql
-- Display all upcoming events in month view
config := jsonb_build_object(
  'entityKey', 'events',
  'timeSlotPropertyName', 'event_time',
  'initialView', 'dayGridMonth',
  'defaultColor', '#10B981'
);
```

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

## NavButtonsWidgetConfig

Displays a flexible set of navigation buttons with optional header and description. More general-purpose than the sequential `dashboard_navigation` widget—ideal for quick action panels, link collections, or navigation hubs.

### Complete Configuration Reference

```typescript
interface NavButtonsWidgetConfig {
  // Optional header text displayed above the buttons
  header?: string;

  // Optional description/instructions text
  description?: string;

  // Array of navigation buttons (required)
  buttons: Array<{
    text: string;      // Button label (required)
    url: string;       // Internal route URL (required)
    icon?: string;     // Material Symbol name (optional, e.g., 'home', 'settings')
    variant?: 'primary' | 'secondary' | 'accent' | 'outline' | 'ghost' | 'link';  // Default: 'outline'
  }>;
}
```

### SQL Example

```sql
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, config, sort_order, width, height
) VALUES (
  v_dashboard_id,
  'nav_buttons',
  NULL,  -- Header is in config, title usually not needed
  jsonb_build_object(
    'header', 'Quick Actions',
    'description', 'Navigate to commonly used areas',
    'buttons', jsonb_build_array(
      jsonb_build_object('text', 'View Issues', 'url', '/view/issues', 'icon', 'bug_report', 'variant', 'primary'),
      jsonb_build_object('text', 'Add User', 'url', '/create/users', 'icon', 'person_add', 'variant', 'outline'),
      jsonb_build_object('text', 'Reports', 'url', '/dashboard/5', 'icon', 'bar_chart'),
      jsonb_build_object('text', 'Settings', 'url', '/settings', 'icon', 'settings', 'variant', 'ghost')
    )
  ),
  1,    -- sort_order
  2,    -- Full width
  1     -- Minimal height
);
```

### Features

- **Flexible button array**: Add as many navigation buttons as needed
- **Optional header/description**: Provide context for the navigation options
- **Icon support**: Uses Material Symbols Outlined (same as rest of Civic OS)
- **Style variants**: Match button importance with DaisyUI button styles
- **Client-side navigation**: Uses Angular `routerLink` for instant transitions
- **Responsive layout**: Buttons wrap on smaller screens using flexbox

### Button Variants

| Variant | DaisyUI Class | Use Case |
|---------|---------------|----------|
| `primary` | `btn-primary` | Main action, call-to-action |
| `secondary` | `btn-secondary` | Important but not primary |
| `accent` | `btn-accent` | Highlight or special action |
| `outline` | `btn-outline` | Default, subtle buttons |
| `ghost` | `btn-ghost` | Minimal, text-like buttons |
| `link` | `btn-link` | Link-style, underlined on hover |

### Common Icon Names

Use Material Symbols Outlined names:
- Navigation: `home`, `arrow_back`, `arrow_forward`, `menu`
- Actions: `add_circle`, `edit`, `delete`, `settings`
- Content: `bug_report`, `bar_chart`, `person`, `group`
- Files: `folder`, `description`, `upload`, `download`

Browse all icons at: https://fonts.google.com/icons

### Use Cases

**Quick Actions Panel:**
```sql
jsonb_build_object(
  'header', 'Quick Actions',
  'buttons', jsonb_build_array(
    jsonb_build_object('text', 'New Issue', 'url', '/create/issues', 'icon', 'add_circle', 'variant', 'primary'),
    jsonb_build_object('text', 'My Tasks', 'url', '/view/tasks?assigned_to=me', 'icon', 'task_alt')
  )
)
```

**Admin Navigation Hub:**
```sql
jsonb_build_object(
  'header', 'Administration',
  'description', 'System configuration and management',
  'buttons', jsonb_build_array(
    jsonb_build_object('text', 'Users', 'url', '/view/users', 'icon', 'group'),
    jsonb_build_object('text', 'Roles', 'url', '/permissions', 'icon', 'admin_panel_settings'),
    jsonb_build_object('text', 'Entities', 'url', '/entity-management', 'icon', 'table_chart'),
    jsonb_build_object('text', 'Properties', 'url', '/property-management', 'icon', 'list')
  )
)
```

**Dashboard Switcher (without sequential prev/next):**
```sql
jsonb_build_object(
  'header', 'View By',
  'buttons', jsonb_build_array(
    jsonb_build_object('text', 'Overview', 'url', '/', 'variant', 'primary'),
    jsonb_build_object('text', 'By Region', 'url', '/dashboard/2'),
    jsonb_build_object('text', 'By Status', 'url', '/dashboard/3'),
    jsonb_build_object('text', 'Timeline', 'url', '/dashboard/4')
  )
)
```

### nav_buttons vs dashboard_navigation

| Feature | `nav_buttons` | `dashboard_navigation` |
|---------|---------------|------------------------|
| Layout | Horizontal button row | Prev/Next with progress chips |
| Icons | Yes | No |
| Button styles | Configurable per-button | Fixed (outline/primary) |
| Header/Description | Yes | No |
| Best for | Quick actions, link hubs | Sequential storymap flows |

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
