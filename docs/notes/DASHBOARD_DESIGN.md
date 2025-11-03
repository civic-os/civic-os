# Custom Dashboards Feature - Design Document (v3 - Revised)

**Status:** 🔵 Design Phase - Not Yet Implemented
**Created:** 2025-01-15
**Updated:** 2025-01-15
**Author:** Design Discussion with Claude

**Version History:**
- v1: Initial design
- v2: Added hybrid storage approach and auto-refresh
- v3: Critical analysis, revised phasing, identified gaps and killer features

## Overview

Add a configurable dashboard system to Civic OS that provides:
1. **Landing page** with markdown content (logo + description)
2. **Widget-based layout** with extensible widget types
3. **Filtered entity lists** (e.g., "Top 5 Issues with Status=New")
4. **Auto-refreshing widgets** with configurable intervals
5. **User preferences** for default dashboard selection
6. **Admin UI** for creating/editing dashboards

## Architecture

### Database Schema (PostgreSQL-first)

**New metadata tables:**

```sql
-- =====================================================
-- Widget Types Registry (Extensible)
-- =====================================================
CREATE TABLE metadata.widget_types (
  widget_type VARCHAR(50) PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  config_schema JSONB,  -- JSON Schema for validation (future)
  icon_name VARCHAR(50),  -- Material icon name for UI
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Populate with initial widget types
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name) VALUES
  ('markdown', 'Markdown Content', 'Display formatted text, images, and links', 'article'),
  ('filtered_list', 'Filtered Entity List', 'Show filtered records from any entity', 'list'),
  ('stat_card', 'Statistic Card', 'Display a single metric or KPI', 'analytics'),
  ('query_result', 'Query Result', 'Show results from a database view', 'table_view');

GRANT SELECT ON metadata.widget_types TO web_anon, authenticated;

-- =====================================================
-- Dashboards
-- =====================================================
CREATE TABLE metadata.dashboards (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,  -- System default dashboard
  is_public BOOLEAN DEFAULT TRUE,    -- Visible to all users
  sort_order INT DEFAULT 0,
  created_by UUID REFERENCES civic_os_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one dashboard can be the system default
CREATE UNIQUE INDEX idx_dashboards_single_default
  ON metadata.dashboards (is_default)
  WHERE is_default = TRUE;

-- Triggers for timestamp management
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.dashboards
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE metadata.dashboards ENABLE ROW LEVEL SECURITY;

-- Everyone can read public dashboards
CREATE POLICY "Everyone can read public dashboards"
  ON metadata.dashboards
  FOR SELECT
  TO PUBLIC
  USING (is_public = TRUE);

-- Users can read their own private dashboards
CREATE POLICY "Users can read own private dashboards"
  ON metadata.dashboards
  FOR SELECT
  TO authenticated
  USING (created_by = public.current_user_id());

-- Admins can create dashboards
CREATE POLICY "Admins can insert dashboards"
  ON metadata.dashboards
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- Admins can update dashboards
CREATE POLICY "Admins can update dashboards"
  ON metadata.dashboards
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Admins can delete dashboards
CREATE POLICY "Admins can delete dashboards"
  ON metadata.dashboards
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

GRANT SELECT ON metadata.dashboards TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.dashboards TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.dashboards_id_seq TO authenticated;

-- =====================================================
-- Dashboard Widgets (Hybrid: Columns + JSONB)
-- =====================================================
CREATE TABLE metadata.dashboard_widgets (
  id SERIAL PRIMARY KEY,
  dashboard_id INT NOT NULL REFERENCES metadata.dashboards(id) ON DELETE CASCADE,
  widget_type VARCHAR(50) NOT NULL REFERENCES metadata.widget_types(widget_type),

  -- Common fields (typed, indexed, queryable)
  title TEXT,
  entity_key NAME,  -- Denormalized for queries (NULL for non-entity widgets)
  refresh_interval_seconds INT DEFAULT 60,  -- NULL = no auto-refresh, 0 = manual only

  -- Layout
  sort_order INT DEFAULT 0,
  width INT DEFAULT 1,  -- Grid columns (1-2)
  height INT DEFAULT 1, -- Grid rows (1-3)

  -- Widget-specific configuration (flexible)
  config JSONB NOT NULL DEFAULT '{}',

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Validation
  CONSTRAINT valid_refresh_interval CHECK (refresh_interval_seconds IS NULL OR refresh_interval_seconds >= 0),
  CONSTRAINT valid_width CHECK (width BETWEEN 1 AND 2),
  CONSTRAINT valid_height CHECK (height BETWEEN 1 AND 3)
);

-- Index for "find widgets using entity X"
CREATE INDEX idx_widgets_entity_key ON metadata.dashboard_widgets(entity_key)
  WHERE entity_key IS NOT NULL;

-- Index for dashboard rendering (fetch all widgets)
CREATE INDEX idx_widgets_dashboard_id ON metadata.dashboard_widgets(dashboard_id, sort_order);

-- GIN index for JSONB queries (if needed later)
CREATE INDEX idx_widgets_config ON metadata.dashboard_widgets USING GIN (config);

-- Triggers
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.dashboard_widgets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE metadata.dashboard_widgets ENABLE ROW LEVEL SECURITY;

-- Everyone can read widgets of public dashboards
CREATE POLICY "Everyone can read public dashboard widgets"
  ON metadata.dashboard_widgets
  FOR SELECT
  TO PUBLIC
  USING (
    dashboard_id IN (
      SELECT id FROM metadata.dashboards WHERE is_public = TRUE
    )
  );

-- Users can read widgets of their private dashboards
CREATE POLICY "Users can read own dashboard widgets"
  ON metadata.dashboard_widgets
  FOR SELECT
  TO authenticated
  USING (
    dashboard_id IN (
      SELECT id FROM metadata.dashboards
      WHERE created_by = public.current_user_id()
    )
  );

-- Admins can manage widgets
CREATE POLICY "Admins can manage widgets"
  ON metadata.dashboard_widgets
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT SELECT ON metadata.dashboard_widgets TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.dashboard_widgets TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.dashboard_widgets_id_seq TO authenticated;

-- =====================================================
-- User Dashboard Preferences
-- =====================================================
CREATE TABLE metadata.user_dashboard_preferences (
  user_id UUID PRIMARY KEY REFERENCES civic_os_users(id) ON DELETE CASCADE,
  default_dashboard_id INT REFERENCES metadata.dashboards(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.user_dashboard_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE metadata.user_dashboard_preferences ENABLE ROW LEVEL SECURITY;

-- Users can only manage their own preferences
CREATE POLICY "Users can manage own preferences"
  ON metadata.user_dashboard_preferences
  FOR ALL
  TO authenticated
  USING (user_id = public.current_user_id())
  WITH CHECK (user_id = public.current_user_id());

GRANT SELECT, INSERT, UPDATE ON metadata.user_dashboard_preferences TO authenticated;

-- =====================================================
-- Helper Functions
-- =====================================================

-- Get user's default dashboard (user preference > system default)
CREATE OR REPLACE FUNCTION public.get_user_default_dashboard()
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_dashboard_id INT;
BEGIN
  v_user_id := public.current_user_id();

  -- Try user preference first
  IF v_user_id IS NOT NULL THEN
    SELECT default_dashboard_id INTO v_dashboard_id
    FROM metadata.user_dashboard_preferences
    WHERE user_id = v_user_id;

    IF v_dashboard_id IS NOT NULL THEN
      RETURN v_dashboard_id;
    END IF;
  END IF;

  -- Fall back to system default
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE is_default = TRUE AND is_public = TRUE
  LIMIT 1;

  RETURN v_dashboard_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_user_default_dashboard() TO web_anon, authenticated;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
```

**Widget Configuration Examples (JSONB):**

```json
// Markdown widget
{
  "content": "# Welcome to Civic OS\n\n![Logo](/assets/logo.png)\n\nTrack and manage community issues...",
  "enableHtml": false
}

// Filtered list widget
{
  "filters": [
    {"column": "status_id", "operator": "eq", "value": 1},
    {"column": "severity", "operator": "gte", "value": 4}
  ],
  "orderBy": "created_at",
  "orderDirection": "desc",
  "limit": 5,
  "showColumns": ["display_name", "severity", "created_at"]
}

// Stat card widget
{
  "metric": "count",
  "entityKey": "issues",
  "filters": [{"column": "status_id", "operator": "eq", "value": 1}],
  "suffix": " open issues",
  "color": "primary"
}

// Query result widget (future - uses DB view)
{
  "viewName": "top_contributors_this_month",
  "displayColumns": ["name", "contributions"]
}
```

---

## Calendar & TimeSlot Widgets (NEW)

**Dependency:** Requires Phase 1 of Calendar Integration (TimeSlot property type) to be completed first.

**Reference:** See `docs/development/CALENDAR_INTEGRATION.md` for TimeSlot type implementation details.

### New Widget Types for Reservations/Scheduling

Add to `metadata.widget_types`:

```sql
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name) VALUES
  ('my_upcoming_reservations', 'My Upcoming Reservations', 'Show user''s approved reservations in timeline view', 'event'),
  ('my_pending_requests', 'My Pending Requests', 'Show user''s requests awaiting approval', 'schedule'),
  ('manager_approval_queue', 'Pending Approval Queue', 'Show requests awaiting manager approval (managers only)', 'approval'),
  ('todays_schedule', 'Today''s Schedule', 'Show all reservations for today across all resources', 'today');
```

### Widget Configuration Schemas

#### My Upcoming Reservations Widget
```json
{
  "entityKey": "reservations",
  "userFieldName": "reserved_by",  // FK to civic_os_users
  "timeSlotField": "time_slot",    // tstzrange column
  "daysAhead": 7,                  // Show next 7 days (default)
  "limit": 10,                     // Max reservations to show
  "showColumns": ["display_name", "resource", "time_slot", "attendee_count"]
}
```

**Behavior:**
- Filters: `reserved_by = current_user_id()` AND `lower(time_slot) >= NOW()`
- Order: `time_slot ASC` (chronological)
- Groups by date using timeline/agenda view
- Only shows approved reservations

**Example output:**
```
Today (Nov 2)
  2:00 PM - 4:00 PM    Birthday Party - Club House (30 attendees)

Tomorrow (Nov 3)
  6:00 PM - 9:00 PM    Book Club - Club House (15 attendees)

Saturday (Nov 6)
  10:00 AM - 1:00 PM   Community Meeting - Club House (25 attendees)
```

#### My Pending Requests Widget
```json
{
  "entityKey": "reservation_requests",
  "userFieldName": "requested_by",
  "timeSlotField": "time_slot",
  "statusField": "status",
  "statusFilter": "pending",
  "limit": 5,
  "showColumns": ["display_name", "resource", "time_slot", "status_color"]
}
```

**Behavior:**
- Filters: `requested_by = current_user_id()` AND `status = 'pending'`
- Order: `created_at DESC` (most recent first)
- Shows status badge with color
- Click to view request detail page

**Example output:**
```
⏳ Community Meeting - Club House
   Requested: Nov 7, 10:00 AM - 1:00 PM
   Status: Pending approval

⏳ Book Club - Club House
   Requested: Nov 3, 6:00 PM - 9:00 PM
   Status: Pending approval
```

#### Manager Approval Queue Widget (Manager Role Only)
```json
{
  "entityKey": "reservation_requests",
  "statusField": "status",
  "statusFilter": "pending",
  "timeSlotField": "time_slot",
  "limit": 10,
  "requiresRole": "manager",
  "showColumns": ["display_name", "requested_by", "resource", "time_slot", "created_at"],
  "showActions": true  // Show approve/deny buttons in widget
}
```

**Behavior:**
- Filters: `status = 'pending'`
- Order: `created_at ASC` (oldest first - FIFO)
- Only visible to managers
- Optional: Quick approve/deny actions inline (Phase 4+)
- Click to view request detail for full approval workflow

**Example output:**
```
Pending Requests (3)

⏳ Birthday Party - Club House
   Requested by: John Doe
   Time: Nov 10, 2:00 PM - 4:00 PM
   Submitted: 2 days ago
   [View Details] [Approve] [Deny]

⏳ Team Meeting - Club House
   Requested by: Jane Smith
   Time: Nov 12, 9:00 AM - 11:00 AM
   Submitted: 1 day ago
   [View Details]
```

#### Today's Schedule Widget (Manager Role Only)
```json
{
  "entityKey": "reservations",
  "timeSlotField": "time_slot",
  "dateFilter": "today",
  "requiresRole": "manager",
  "groupBy": "resource_id",
  "showColumns": ["resource", "display_name", "time_slot", "reserved_by", "attendee_count"]
}
```

**Behavior:**
- Filters: `lower(time_slot)::date = CURRENT_DATE` OR `upper(time_slot)::date = CURRENT_DATE` (overlaps today)
- Order: `time_slot ASC`
- Groups by resource
- Shows all resources' schedules for today

**Example output:**
```
Today's Reservations (Nov 2, 2025)

Club House
  2:00 PM - 4:00 PM    Birthday Party (John Doe, 30 attendees)
  6:00 PM - 9:00 PM    Book Club (Jane Smith, 15 attendees)

Conference Room A
  9:00 AM - 11:00 AM   Team Standup (Sarah Johnson, 10 attendees)
  1:00 PM - 3:00 PM    Client Meeting (Mike Brown, 5 attendees)

(Empty for other resources)
```

### TimelineAgendaWidgetComponent

**Purpose:** Reusable component for rendering time-based data in agenda/timeline style.

**File:** `src/app/components/widgets/timeline-agenda-widget/timeline-agenda-widget.component.ts`

**Features:**
- Groups events by date (Today, Tomorrow, specific dates)
- Formats time slots using `DisplayTimeSlotComponent`
- Responsive layout (stacked on mobile)
- Links to detail pages
- Auto-refresh enabled (default 60 seconds)
- Handles empty state ("No upcoming reservations")

**Usage:** Shared by all calendar widgets (DRY principle)

```typescript
@Component({
  selector: 'app-timeline-agenda-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DisplayTimeSlotComponent, CommonModule]
})
export class TimelineAgendaWidgetComponent {
  widget = input.required<DashboardWidget>();

  // Fetch data with filters from config
  events$ = this.loadEvents();

  // Group events by date
  groupedEvents = computed(() => {
    const events = this.events();
    return this.groupByDate(events);
  });

  private groupByDate(events: any[]): Map<string, any[]> {
    // Group by date, with special handling for "Today", "Tomorrow"
    // Format dates as "Today (Nov 2)", "Tomorrow (Nov 3)", "Saturday (Nov 6)"
  }
}
```

### Implementation Notes

**Dependencies (Must be completed first):**
1. ✅ Phase 1: TimeSlot property type (domain, detection, display components)
2. ✅ DisplayTimeSlotComponent (for formatting time ranges)
3. ✅ Reservations schema (separate tables design with trigger sync)

**Widget Integration Points:**
- Reuses `DisplayTimeSlotComponent` from calendar integration
- Leverages existing `FilteredListWidgetComponent` architecture
- Uses existing permission system (`requiresRole` config)
- Standard auto-refresh with configurable intervals

**Timeline for Calendar Widgets:**
- **After Calendar Phase 1** (TimeSlot type): Can implement basic versions (list view only)
- **After Calendar Phase 2** (Calendar component): Can enhance with mini calendar option
- **After Dashboard Phase 2** (Filtered lists): Widget infrastructure ready
- **Suggested**: Implement as **Dashboard Phase 2.5** or **Phase 3.5**

### Example Dashboard Configuration

**"My Reservations" Dashboard (for community members):**
```sql
INSERT INTO metadata.dashboards (display_name, description, is_default, is_public)
VALUES ('My Reservations', 'View your upcoming reservations and pending requests', FALSE, TRUE);

INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width)
VALUES
  (1, 'my_upcoming_reservations', 'My Upcoming Reservations',
   '{"entityKey": "reservations", "daysAhead": 7, "limit": 10}', 1, 2),
  (1, 'my_pending_requests', 'My Pending Requests',
   '{"entityKey": "reservation_requests", "limit": 5}', 2, 2);
```

**"Manager Dashboard" (for facility managers):**
```sql
INSERT INTO metadata.dashboards (display_name, description, is_default, is_public)
VALUES ('Facility Management', 'Approve requests and view today''s schedule', FALSE, FALSE);

INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width)
VALUES
  (2, 'manager_approval_queue', 'Pending Approvals',
   '{"entityKey": "reservation_requests", "limit": 10, "showActions": true}', 1, 1),
  (2, 'todays_schedule', 'Today''s Schedule',
   '{"entityKey": "reservations", "groupBy": "resource_id"}', 2, 1);
```

---

### Frontend Components

**New Angular components:**

1. **DashboardPage** (`/src/app/pages/dashboard/dashboard.page.ts`)
   - Route: `/` (default) and `/dashboard/:id`
   - Loads dashboard + widgets from DashboardService
   - Renders grid layout with WidgetContainerComponents
   - Signal-based state with OnPush change detection
   - Global pause/resume refresh control

2. **WidgetContainerComponent** (`/src/app/components/widget-container/`)
   - Dynamically loads widget component based on type
   - Handles widget borders, titles, loading states
   - Auto-refresh logic using RxJS interval + switchMap
   - Manual refresh button
   - Pauses refresh when tab hidden (document.hidden)
   - Responsive grid layout using Tailwind/DaisyUI

3. **MarkdownWidgetComponent** (`/src/app/components/widgets/markdown-widget/`)
   - Renders markdown using library (ngx-markdown or marked.js)
   - Sanitizes HTML if enabled (DOMPurify)
   - Responsive text sizing
   - No auto-refresh (static content)

4. **FilteredListWidgetComponent** (`/src/app/components/widgets/filtered-list-widget/`)
   - Fetches data using DataService with filters
   - Renders as card with compact table or badge list
   - Links to entity detail pages
   - Reuses DisplayPropertyComponent for column rendering
   - Auto-refreshes based on widget config

5. **StatCardWidgetComponent** (`/src/app/components/widgets/stat-card-widget/`)
   - Displays single metric (count, sum, avg, etc.)
   - Large number display with optional suffix/prefix
   - Color-coded based on thresholds
   - Auto-refreshes for real-time metrics

6. **DashboardSelectorComponent** (`/src/app/components/dashboard-selector/`)
   - Dropdown in navbar showing available dashboards
   - Highlights current dashboard
   - "Set as default" option
   - Link to dashboard management (admin only)

7. **DashboardManagementPage** (`/src/app/pages/dashboard-management/`)
   - Admin-only page for CRUD on dashboards
   - Lists all dashboards with edit/delete/reorder
   - Toggle is_default and is_public flags
   - Button to create new dashboard

8. **DashboardEditorPage** (`/src/app/pages/dashboard-editor/`)
   - Admin-only page for editing dashboard widgets
   - Drag-and-drop widget reordering (Angular CDK Drag-Drop)
   - Add/remove/configure widgets
   - Widget configuration modal/drawer
   - Live preview panel

### Critical Infrastructure: Widget Component Registry

**CRITICAL:** The design mentions "dynamically loads widget component based on type" but the registry mechanism was missing from v2. This is foundational infrastructure required for Phase 1.

**WidgetComponentRegistry** (`/src/app/services/widget-component-registry.service.ts`):
```typescript
@Injectable({ providedIn: 'root' })
export class WidgetComponentRegistry {
  private registry = new Map<string, Type<any>>();

  /**
   * Register a widget component for a specific widget type.
   * Called during app initialization or lazy loading.
   */
  register(widgetType: string, component: Type<any>): void {
    if (this.registry.has(widgetType)) {
      console.warn(`Widget type "${widgetType}" is already registered. Overwriting.`);
    }
    this.registry.set(widgetType, component);
  }

  /**
   * Get the component class for a widget type.
   * Returns null if not found (allows graceful fallback).
   */
  getComponent(widgetType: string): Type<any> | null {
    return this.registry.get(widgetType) || null;
  }

  /**
   * Check if a widget type has a registered component.
   */
  hasComponent(widgetType: string): boolean {
    return this.registry.has(widgetType);
  }

  /**
   * Get all registered widget types.
   * Useful for debugging and validation.
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.registry.keys());
  }
}
```

**Usage in app initialization:**
```typescript
// app.config.ts or main.ts
import { WidgetComponentRegistry } from './services/widget-component-registry.service';
import { MarkdownWidgetComponent } from './components/widgets/markdown-widget/markdown-widget.component';
import { FilteredListWidgetComponent } from './components/widgets/filtered-list-widget/filtered-list-widget.component';

export function initializeWidgetRegistry(registry: WidgetComponentRegistry) {
  return () => {
    registry.register('markdown', MarkdownWidgetComponent);
    registry.register('filtered_list', FilteredListWidgetComponent);
    // Add more as widgets are developed
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    // ... other providers
    {
      provide: APP_INITIALIZER,
      useFactory: initializeWidgetRegistry,
      deps: [WidgetComponentRegistry],
      multi: true
    }
  ]
};
```

**Usage in WidgetContainerComponent:**
```typescript
export class WidgetContainerComponent implements OnInit {
  widget = input.required<DashboardWidget>();

  widgetComponent = computed<Type<any> | null>(() => {
    const widgetType = this.widget().widget_type;
    const component = this.registry.getComponent(widgetType);

    if (!component) {
      console.error(`No component registered for widget type: ${widgetType}`);
    }

    return component;
  });

  constructor(private registry: WidgetComponentRegistry) {}
}
```

**Why this matters:**
- Without this, Phase 1 cannot dynamically load widgets
- Provides extensibility point for custom widget types
- Allows lazy loading of widget components in future
- Clean separation of concerns (registry vs rendering)

### Services

**DashboardService** (`/src/app/services/dashboard.service.ts`)
```typescript
@Injectable({ providedIn: 'root' })
export class DashboardService {
  // Fetch all visible dashboards (public + user's private)
  getDashboards(): Observable<Dashboard[]>

  // Fetch dashboard with embedded widgets
  // Uses: ?select=*,widgets:dashboard_widgets(*)
  getDashboard(id: number): Observable<Dashboard>

  // Get user's default dashboard (or system default)
  // Uses: POST /rpc/get_user_default_dashboard
  getDefaultDashboard(): Observable<Dashboard>

  // Get available widget types for "Add Widget" menu
  getWidgetTypes(): Observable<WidgetType[]>

  // CRUD operations
  saveDashboard(dashboard: Dashboard): Observable<ApiResponse>
  deleteDashboard(id: number): Observable<ApiResponse>
  saveWidget(widget: DashboardWidget): Observable<ApiResponse>
  deleteWidget(widgetId: number): Observable<ApiResponse>

  // User preferences
  setDefaultDashboard(dashboardId: number): Observable<ApiResponse>
}
```

### Interfaces

**New TypeScript interfaces** (`/src/app/interfaces/dashboard.ts`):
```typescript
export interface Dashboard {
  id: number;
  display_name: string;
  description: string | null;
  is_default: boolean;
  is_public: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  widgets?: DashboardWidget[];
}

export interface DashboardWidget {
  id: number;
  dashboard_id: number;
  widget_type: string;
  title: string | null;
  entity_key: string | null;
  refresh_interval_seconds: number | null;
  sort_order: number;
  width: number;
  height: number;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface WidgetType {
  widget_type: string;
  display_name: string;
  description: string;
  icon_name: string;
  is_active: boolean;
}

export interface MarkdownWidgetConfig {
  content: string;
  enableHtml: boolean;
}

export interface FilteredListWidgetConfig {
  filters: FilterCondition[];
  orderBy: string;
  orderDirection: 'asc' | 'desc';
  limit: number;
  showColumns: string[];
}

export interface StatCardWidgetConfig {
  metric: 'count' | 'sum' | 'avg' | 'min' | 'max';
  entityKey: string;
  filters: FilterCondition[];
  suffix?: string;
  prefix?: string;
  color?: 'primary' | 'secondary' | 'success' | 'warning' | 'error';
}

export interface FilterCondition {
  column: string;
  operator: string;
  value: any;
}
```

### Routing Updates

```typescript
// src/app/app.routes.ts
export const routes: Routes = [
  // Dashboard as home page
  {
    path: '',
    component: DashboardPage,
    canActivate: [schemaVersionGuard]
  },
  {
    path: 'dashboard/:id',
    component: DashboardPage,
    canActivate: [schemaVersionGuard]
  },
  // Admin management pages
  {
    path: 'dashboard-management',
    component: DashboardManagementPage,
    canActivate: [schemaVersionGuard, authGuard]
  },
  {
    path: 'dashboard-editor/:id',
    component: DashboardEditorPage,
    canActivate: [schemaVersionGuard, authGuard]
  },
  // Existing routes
  {
    path: 'schema-erd',
    component: SchemaErdPage,
    canActivate: [schemaVersionGuard]
  },
  // ... rest of existing routes
];
```

### UI/UX Design

**Navbar updates:**
- Add DashboardSelectorComponent dropdown next to entity menu
- Shows list of available dashboards
- Current dashboard highlighted
- "Set as default" option
- Admin link to dashboard management

**Dashboard layout:**
- CSS Grid with responsive columns (1-2 on desktop, 1 on mobile)
- Widget cards with DaisyUI card styling
- Loading skeletons during fetch
- Empty state with "Add Widget" button (admin only)

**Widget chrome:**
- Card header with title (optional)
- Refresh indicator (spinner when loading)
- Manual refresh button
- Last refreshed timestamp (tooltip)
- Edit/delete buttons (admin only)

**Filtered list widget:**
- Compact table or badge list view
- Click row → navigate to detail page
- "View all" link applies filters to entity list page
- Shows "N of M" when limited

**Auto-refresh behavior:**
- Pauses when browser tab hidden
- Respects refresh_interval_seconds (NULL = no refresh)
- Visual indicator shows time until next refresh
- Global pause button stops all widgets

## Critical Gaps Identified

### 1. StatCard Widget Technical Blocker ⚠️
**Problem:** StatCardWidget requires aggregations (COUNT, SUM, AVG) but PostgREST doesn't support aggregation functions on GET requests.

**Impact:** Cannot implement StatCard widget without backend aggregation support.

**Options:**
- **Option A:** Create database views for each metric (rigid, requires migration per metric)
- **Option B:** Create RPC functions for aggregations (flexible, recommended)
- **Option C:** Fetch all records and aggregate client-side (slow, not scalable)

**Decision:** Need to design and implement aggregation RPC functions BEFORE StatCard widget. Moving StatCard to Phase 5 (after backend aggregation infrastructure is built).

**Example RPC needed:**
```sql
CREATE OR REPLACE FUNCTION public.widget_aggregate(
  p_entity_key NAME,
  p_metric VARCHAR(10),  -- 'count', 'sum', 'avg', 'min', 'max'
  p_column_name NAME,
  p_filters JSONB
) RETURNS NUMERIC AS $$
  -- Dynamic SQL to build filtered query with aggregation
  -- Security: validate entity_key, metric, column_name
  -- Return computed metric
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 2. Error Handling Strategy (Missing)
**Problem:** What happens when widgets fail to load or refresh?

**Scenarios not addressed:**
- Entity deleted (filtered list widget breaks)
- User loses permission to entity
- Auto-refresh fails repeatedly (network issues)
- Widget config is malformed (invalid JSONB)
- Backend is down

**Need:** Comprehensive error handling UX with:
- Error state component (shows friendly message)
- Retry button
- Fallback for broken widgets
- Graceful degradation

### 3. Performance at Scale (Not Addressed)
**Problem:** Dashboard with 20 widgets refreshing every 60 seconds = 20 HTTP requests/minute

**Issues:**
- **Thundering herd**: All widgets refresh at same time (T=0)
- **Server load**: 20 concurrent database queries every minute
- **Battery drain**: Mobile devices auto-refreshing in background

**Need:** Performance optimizations:
- **Staggered refresh** with jitter (spread load 0-5 seconds)
- **Max widgets per dashboard** limit (prevent abuse)
- **Debouncing** for rapid filter changes
- **Request batching** (if possible with PostgREST)

**Implementation (staggered refresh):**
```typescript
const jitter = Math.random() * 5000;  // 0-5 second random delay
const staggeredInterval = this.widget().refresh_interval_seconds * 1000 + jitter;
```

### 4. Widget Config Validation (Critical Gap)
**Problem:** No validation prevents admins from creating broken widgets.

**Example invalid config:**
```json
{
  "filters": "not an array",  // Should be array!
  "orderBy": null,
  "limit": "five"  // Should be number!
}
```

**Need:**
- Frontend TypeScript validation (type guards)
- Backend JSON Schema validation (use config_schema column)
- Validation error messages before save
- Migration strategy when widget schema changes

### 5. Data Freshness UX (Incomplete)
**Problem:** Users need to know if data is current or stale.

**Missing UX details:**
- "Updated 2m ago" timestamp on each widget
- "Refreshing..." spinner overlay (not blocking)
- "Failed to refresh - Click to retry" error state
- Countdown timer showing next refresh (optional)
- Visual differentiation for stale data (grayed out?)

### 6. Dashboard Navigation Missing from Phase 1 ⚠️
**Critical issue:** DashboardSelectorComponent is in Phase 3, but without it:
- Can't navigate between dashboards
- Can't access /dashboard/:id routes
- Can't set default dashboard

**Fix:** Move DashboardSelectorComponent to Phase 1 (it's core navigation, not a "nice to have")

## Killer Features (Not in Original Design)

### 1. Global Dashboard Filter Bar 🚀 (HIGH VALUE)
**What:** Filter bar at top of dashboard that applies to ALL widgets simultaneously.

**Example:**
```
[Date Range: Last 7 days ▼] [Status: Open ▼] [Priority: High ▼]
```
All widgets update to show only data matching these filters.

**Why it's killer:**
- Enables true dashboard exploration ("Show me everything from last week")
- Common in BI tools (Tableau, Power BI, Looker)
- Massive UX improvement over static widgets
- Relatively simple to implement

**Implementation:**
```typescript
// DashboardPage provides global filters to all widgets
globalFilters = signal<FilterCondition[]>([]);

// Each widget merges global + widget-specific filters
effectiveFilters = computed(() => [
  ...this.globalFilters(),
  ...this.widget().config.filters || []
]);
```

**Recommendation:** Add to Phase 3-4 (after basic widgets working)

### 2. Dashboard Templates/Presets 🎯
**What:** Pre-built dashboards for common use cases.

**Examples:**
- "311 Issue Tracking Dashboard" (open issues, recent activity, severity breakdown)
- "Community Engagement Metrics" (user activity, response times, satisfaction)
- "Infrastructure Maintenance" (asset status, work orders, budget tracking)

**Why it's killer:**
- Reduces setup time from hours to minutes
- Shows best practices for dashboard design
- Drives adoption (users see value immediately)

**Implementation:**
- SQL file with INSERT statements for sample dashboards
- "Import Template" button in management UI
- Templates stored in metadata.dashboard_templates table

**Recommendation:** Add to Phase 3-4 (after editor is built)

### 3. Embedded Dashboard Links 📊
**What:** Generate shareable URLs with specific filters/date ranges.

**Example:**
```
/dashboard/1?date_from=2024-01-01&status=open&priority=high
```

**Use cases:**
- "Here's the dashboard showing the problem" (collaboration)
- Bookmark specific views
- Email links to team

**Why it's killer:**
- Low implementation cost (URL params → filter state)
- High user value (saves time, improves communication)

**Recommendation:** Add to Phase 2-3 (easy win)

### 4. Smart Alerts/Notifications (Future Phase 6+)
**What:** Notify users when dashboard metrics exceed thresholds.

**Examples:**
- "Alert me when open issues exceed 50"
- "Email when average response time > 24 hours"
- Slack integration for critical metrics

**Why it's valuable:**
- Proactive vs reactive monitoring
- Reduces dashboard "check fatigue"

**Recommendation:** Phase 6+ (requires notification infrastructure)

## Implementation Phases (REVISED)

### Phase 1: Core Infrastructure + Static Dashboard (REVISED)
**Goal: Functional static dashboard with navigation and solid error handling foundation**

**What changed:** Added widget component registry (critical), DashboardSelectorComponent (navigation), error handling framework, config validation, and removed user preferences (defer to Phase 3).

1. **Database schema migration**
   - Create metadata.widget_types table
   - Create metadata.dashboards table
   - Create metadata.dashboard_widgets table
   - Create metadata.user_dashboard_preferences table (defer actual use to Phase 3)
   - Create helper functions
   - Insert initial widget types ('markdown', 'filtered_list')
   - Create default "Welcome" dashboard with markdown widget

2. **TypeScript interfaces**
   - dashboard.ts with all interfaces
   - Widget config interfaces (MarkdownWidgetConfig, FilteredListWidgetConfig)

3. **Widget Component Registry** (NEW - CRITICAL)
   - Create WidgetComponentRegistry service
   - Set up APP_INITIALIZER for widget registration
   - Register markdown and filtered_list components

4. **DashboardService**
   - Basic CRUD methods
   - Cache dashboard list
   - Error handling with ApiResponse pattern
   - Config validation helpers (type guards)

5. **DashboardPage**
   - Route setup (/ and /dashboard/:id)
   - CSS Grid layout (1-2 columns responsive)
   - Load dashboard + widgets with error boundaries
   - Signal-based state
   - Empty state UI (no widgets)

6. **WidgetContainerComponent**
   - Dynamic component loading via registry
   - Error boundaries for widget failures
   - Loading states (skeleton/spinner)
   - Error state UI ("Failed to load - Retry" button)
   - Basic chrome (title, borders, DaisyUI card styling)

7. **MarkdownWidgetComponent**
   - Integrate ngx-markdown (recommended) or marked.js
   - Render markdown safely
   - DOMPurify HTML sanitization (if enableHtml)
   - No auto-refresh (static content)

8. **DashboardSelectorComponent** (NEW - MOVED FROM PHASE 3)
   - Dropdown in navbar (next to entity menu)
   - List available dashboards
   - Navigate between dashboards
   - Highlight current dashboard
   - Simple styling (no default setting yet - Phase 3)

9. **Config validation**
   - JSON Schema validation for widget configs
   - TypeScript type guards for config objects
   - Validation before widget save

10. **Tests**
    - DashboardService unit tests
    - WidgetComponentRegistry tests
    - Component tests for MarkdownWidget
    - Integration test for DashboardPage
    - Error handling tests

**Deliverable:** Static welcome dashboard at `/` with navigation, error handling, and solid foundation for Phase 2

### Phase 2: Dynamic Widgets + Auto-refresh (REVISED)
**Goal: Real-time data with filtered lists and auto-refresh infrastructure**

**What changed:** Added FilteredListWidget (moved from Phase 1), removed StatCard (requires backend - move to Phase 5), added performance optimizations (staggered refresh).

1. **FilteredListWidgetComponent**
   - Fetch filtered data using DataService
   - Render as compact table or badge list
   - Link to entity detail pages
   - Reuse DisplayPropertyComponent for column rendering
   - Support for all entity types

2. **Auto-refresh infrastructure**
   - Add auto-refresh to WidgetContainerComponent
   - RxJS interval with filter/switchMap pattern
   - Pause when tab hidden (document.hidden check)
   - Pause when user clicks pause button
   - **Staggered refresh with jitter** (performance optimization)

3. **Data freshness UX**
   - "Updated Xm ago" timestamp on each widget
   - "Refreshing..." spinner overlay (non-blocking)
   - Manual refresh button
   - Failed refresh error state with retry
   - Countdown to next refresh (optional, nice-to-have)

4. **Global refresh controls**
   - Pause/resume all widgets button
   - Refresh all widgets now button
   - Widget-level refresh state management

5. **Tests**
   - FilteredListWidget component tests
   - Auto-refresh logic tests (interval, pause, resume)
   - Staggered refresh tests (jitter)
   - Memory leak tests (100+ refresh cycles)

**Deliverable:** Auto-updating filtered list widgets with performance-optimized refresh

### Phase 3: Dashboard Management (REVISED)
**Goal: Admin tools for creating/editing dashboards**

**What changed:** Removed DashboardSelectorComponent (moved to Phase 1), added user preferences, added global filter bar (killer feature).

1. **DashboardManagementPage**
   - List all dashboards (table view)
   - Create new dashboard (modal/form)
   - Edit dashboard metadata (name, description)
   - Delete dashboard (confirmation)
   - Reorder dashboards via drag-drop (sort_order)
   - Toggle is_default and is_public flags
   - Admin-only access check

2. **Simple Widget Editor** (no drag-drop yet)
   - Load dashboard with widgets
   - Add widget via form (select type from dropdown)
   - Configure widget via modal
   - Remove widget (confirmation)
   - Save changes (validation before submit)
   - Widget config forms for each type

3. **User Preferences**
   - "Set as default" option in DashboardSelectorComponent
   - Save to user_dashboard_preferences table
   - Load default dashboard on login
   - Reset to system default option

4. **Global Filter Bar** 🚀 (KILLER FEATURE)
   - Filter bar at top of DashboardPage
   - Date range picker
   - Entity field filters (FK dropdowns)
   - Apply to all widgets simultaneously
   - Clear filters button
   - URL state sync for sharing

5. **Tests**
   - DashboardManagementPage tests
   - Widget editor form tests
   - User preference persistence tests
   - Global filter propagation tests

**Deliverable:** Full dashboard management UI with global filter bar

### Phase 4: Polish & Advanced UX (REVISED)
**Goal: Production-ready with great user experience**

**What changed:** Focus on UX polish, defer complex widgets (query/chart/stat) to Phase 5.

1. **Drag-and-Drop Widget Reordering**
   - Integrate Angular CDK Drag-Drop
   - Visual drag handles
   - Live preview while dragging
   - Auto-save on drop
   - Undo/redo support

2. **Dashboard Templates** 🎯 (KILLER FEATURE)
   - Pre-built dashboard templates (311 Tracker, Metrics, etc.)
   - "Import Template" button
   - Template preview before import
   - SQL migration with sample dashboards
   - Template metadata table (optional)

3. **Embedded Dashboard Links** 📊 (KILLER FEATURE)
   - URL params for filters and date ranges
   - Share button (copy link to clipboard)
   - Deep linking support
   - Bookmarkable dashboard states

4. **Widget sizing controls**
   - Implement width/height from database
   - Resize handles (optional)
   - Grid snap behavior

5. **Performance optimizations**
   - Debounced filter changes
   - Request deduplication
   - Optimistic UI updates
   - Performance monitoring (load times, refresh counts)

6. **Mobile optimizations**
   - Longer refresh intervals on mobile
   - Simplified widget chrome
   - Touch-friendly controls
   - Responsive grid (always 1 column on mobile)

7. **Tests**
   - Drag-and-drop tests
   - Template import tests
   - URL state sync tests
   - Performance regression tests

**Deliverable:** Polished, production-ready dashboard system with templates

### Phase 5: Advanced Widgets (Backend Required) (NEW)
**Goal: Stat cards, charts, and query results**

**What changed:** This is a NEW phase for widgets that require backend aggregation support.

**Prerequisites:** Must build backend aggregation infrastructure first!

1. **Backend Aggregation RPC Functions**
   - Create `widget_aggregate()` RPC function
   - Support COUNT, SUM, AVG, MIN, MAX metrics
   - Dynamic filtering via JSONB
   - Security: validate entity_key, column_name
   - Performance: index usage, query optimization

2. **StatCardWidgetComponent**
   - Display single metric (count, sum, avg)
   - Large number display with suffix/prefix
   - Color-coded based on thresholds
   - Auto-refresh enabled
   - Trend indicators (up/down arrows)

3. **QueryResultWidget**
   - Render data from database views
   - Support for read-only materialized views
   - Custom column display
   - Security: whitelist allowed views

4. **ChartWidget**
   - Integrate Chart.js library
   - Bar/line/pie chart types
   - Data from entity queries or views
   - Responsive sizing
   - Theme-aware colors (light/dark mode)
   - Export as image

5. **Tests**
   - Backend RPC function tests (SQL)
   - StatCard metric calculation tests
   - Chart rendering tests
   - Security tests (query injection prevention)

**Deliverable:** Rich widget library with metrics and visualizations

### Phase 6: Advanced Permissions (REVISED)
**Goal: Granular access control**

**What changed:** Renamed from Phase 5, focused on permissions.

1. **Role-based dashboard visibility**
   - Add role_id FK to dashboards
   - Filter dashboards by user roles
   - "Available to roles: [X, Y, Z]" UI

2. **Widget-level permissions**
   - Check entity permissions before rendering
   - Hide widgets user can't access
   - Show "No permission" placeholder

3. **Private dashboards**
   - Fully implement is_public flag
   - Share dashboard with specific users
   - Collaboration features

4. **Dashboard ownership transfer**
   - Transfer created_by to another user
   - Admin override controls

**Deliverable:** Enterprise-grade permissions system

## Technical Decisions & Rationale

### 1. PostgreSQL-first Approach
**All configuration stored in metadata schema**
- RLS policies for security
- RPC functions for complex operations
- Views for aggregating dashboard data
- Aligns with Civic OS architecture

### 2. Hybrid Storage (Columns + JSONB)
**Common fields as typed columns, specifics in JSONB**

**Typed columns** (`entity_key`, `title`, `refresh_interval_seconds`):
- Enable efficient queries ("find all widgets using entity X")
- Support foreign key constraints where needed
- Allow database-level validation
- Improve performance with indexes

**JSONB config** (widget-specific settings):
- Flexibility for new widget types
- No schema migrations for config changes
- Easy prototyping and iteration
- Backward compatibility

**Why hybrid is best:**
```sql
-- Can efficiently query "all widgets using entity X"
SELECT * FROM metadata.dashboard_widgets
WHERE entity_key = 'issues';

-- Widget-specific config remains flexible
{
  "filters": [...],  -- Filtered list specific
  "orderBy": "created_at"
}
```

### 3. Widget Type Registry (VARCHAR + Reference Table)
**NOT PostgreSQL ENUM**

**Why avoid ENUM?**
- ❌ ENUMs are immutable (can't add values in transactions)
- ❌ Hard to extend without migrations
- ❌ Breaks schema portability
- ❌ Difficult to test new widget types

**Why VARCHAR + metadata.widget_types?**
- ✅ Extensible (INSERT new types)
- ✅ Metadata (display names, descriptions, icons)
- ✅ Validation (can reference in FK)
- ✅ Admin UI (query table for "Add Widget" menu)
- ✅ Future: JSON Schema validation for configs

**Example:**
```sql
-- Adding a new widget type is just an INSERT
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name)
VALUES ('heatmap', 'Heat Map', 'Geographic data visualization', 'map');

-- Frontend automatically picks it up
SELECT * FROM metadata.widget_types WHERE is_active = TRUE;
```

### 4. Auto-refresh Architecture
**RxJS-based with pause/resume controls**

**Implementation:**
```typescript
// WidgetContainerComponent
private refreshTrigger$ = interval(this.widget().refresh_interval_seconds * 1000)
  .pipe(
    startWith(0),  // Immediate first load
    filter(() => !document.hidden),  // Pause when tab hidden
    filter(() => !this.isPaused()),  // Pause when user clicks pause
    switchMap(() => this.loadWidgetData())
  );
```

**Benefits:**
- Declarative (no manual setInterval cleanup)
- Memory safe (automatic unsubscription)
- Respects user preferences (pause controls)
- Battery efficient (pauses on hidden tabs)

**Refresh interval semantics:**
- `60` = Refresh every 60 seconds (default)
- `NULL` = Never auto-refresh (static content)
- `0` = Manual refresh only (user clicks button)

### 5. Security Model
**Leverage existing RBAC system**

- Dashboards have RLS policies (public vs private)
- Widget CRUD requires admin role
- Widget rendering checks entity permissions
- User preferences isolated by user_id
- RPC functions use SECURITY DEFINER carefully

**Example:**
```sql
-- Users can only see public dashboards OR their own private ones
CREATE POLICY "Read dashboards"
  ON metadata.dashboards FOR SELECT
  USING (is_public = TRUE OR created_by = current_user_id());

-- Only admins can create/edit dashboards
CREATE POLICY "Manage dashboards"
  ON metadata.dashboards FOR ALL
  USING (is_admin());
```

### 6. Performance Optimization
**Single-query loading with PostgREST embedded resources**

```http
GET /metadata/dashboards?id=eq.1&select=*,widgets:dashboard_widgets(*)
```

**Benefits:**
- Avoids N+1 queries (no separate fetch for widgets)
- Reduces HTTP roundtrips
- PostgREST optimizes joins
- Faster page loads

**Widget data lazy-loaded:**
- Each widget fetches its own data independently
- Enables independent refresh cycles
- Better perceived performance (widgets load progressively)

## Design Decisions: Deep Dive

### Decision 1: Hybrid Storage vs Pure JSONB vs Pure Tables

**Considered approaches:**

#### Option A: Pure JSONB (Flexible but limited queries)
```sql
CREATE TABLE dashboard_widgets (
  config JSONB  -- Everything in here
);
```
**Pros:** Maximum flexibility, no migrations for new widget types
**Cons:** Can't query "find all widgets for entity X", no FKs

#### Option B: Multi-table (Normalized but rigid)
```sql
CREATE TABLE widget_filtered_list (...);
CREATE TABLE widget_markdown (...);
CREATE TABLE widget_stat_card (...);
```
**Pros:** Strong typing, queryable, FKs work
**Cons:** Schema explosion, complex joins, hard to extend

#### Option C: Hybrid (CHOSEN)
```sql
CREATE TABLE dashboard_widgets (
  entity_key NAME,  -- Extracted for queries
  title TEXT,       -- Extracted for display
  config JSONB      -- Rest is flexible
);
```
**Pros:** Best of both worlds - queryable where needed, flexible elsewhere
**Cons:** Slight denormalization (entity_key duplicated in config)

**Decision:** Hybrid approach provides the optimal balance for Civic OS use cases.

### Decision 2: Auto-refresh Default (60 seconds)

**Why 60 seconds?**
- Short enough for "near real-time" feeling
- Long enough to avoid excessive server load
- Aligns with typical dashboard polling intervals
- User can override per widget

**Alternative considered:**
- 30 seconds: Too aggressive for most use cases
- 120 seconds: Feels stale for issue tracking
- No default: Forces configuration burden on admins

### Decision 3: Dashboard as Home Page

**Why make `/` the dashboard?**
- **Better UX**: First-time users see helpful welcome message
- **Contextual**: Existing apps show most recent/important data first
- **Configurable**: Admins can customize landing experience
- **Discoverable**: Users immediately see what the app can do

**Migration path:**
- Currently `/` shows empty page (no route configured)
- Change is non-breaking (entity menu still works)
- Users who bookmarked entity URLs unaffected

## Angular 20 Best Practices

**All components follow modern Angular patterns:**

1. **Signals for state management**
   ```typescript
   dashboard = signal<Dashboard | undefined>(undefined);
   widgets = computed(() => this.dashboard()?.widgets || []);
   isLoading = signal(true);
   ```

2. **input() for component inputs**
   ```typescript
   widget = input.required<DashboardWidget>();
   showChrome = input<boolean>(true);
   ```

3. **@if/@for control flow**
   ```html
   @if (isLoading()) {
     <div class="loading">Loading...</div>
   }
   @for (widget of widgets(); track widget.id) {
     <app-widget-container [widget]="widget" />
   }
   ```

4. **OnPush change detection**
   ```typescript
   @Component({
     changeDetection: ChangeDetectionStrategy.OnPush
   })
   ```

5. **Standalone components**
   - No NgModule
   - Direct imports in component decorator

6. **RxJS with async pipe**
   ```html
   @if (dashboard$ | async; as dashboard) {
     <h1>{{ dashboard.display_name }}</h1>
   }
   ```

## Testing Strategy

### Unit Tests
- **DashboardService**: Mock HttpClient, test CRUD operations
- **Widget config validation**: Test JSONB schema validation helpers
- **Auto-refresh logic**: Test interval/pause/resume behavior
- **Permission checks**: Test RLS policy logic

### Component Tests
- **MarkdownWidgetComponent**: Test markdown rendering, XSS prevention
- **FilteredListWidgetComponent**: Mock DataService, test data fetching
- **StatCardWidgetComponent**: Test metric calculation, color coding
- **DashboardSelectorComponent**: Test navigation, default setting

### Integration Tests
- **DashboardPage**: Test loading workflow (dashboard → widgets → data)
- **Widget creation**: Test full add widget flow
- **Dashboard CRUD**: Test create/update/delete operations
- **Permission enforcement**: Test admin-only features

### E2E Tests (Playwright/Cypress)
- **User creates dashboard**: Full workflow from login to dashboard creation
- **User adds widgets**: Test widget configuration modal
- **User sets default**: Test preference persistence
- **Widgets auto-refresh**: Test refresh behavior with wait times
- **Admin permissions**: Test non-admin cannot access management pages

### Performance Tests
- **Dashboard load time**: Should be <1 second for 10 widgets
- **Widget refresh**: Should not cause memory leaks after 100 refreshes
- **Large JSONB**: Test with 1000+ line markdown content

## Documentation Plan

### Create docs/development/DASHBOARDS.md
**Contents:**
- Architecture overview
- Database schema reference with ER diagram
- Widget type reference with examples
- Configuration schema examples (JSONB structures)
- Guide: Adding custom widget types
- Security model documentation
- Performance best practices
- Troubleshooting common issues

### Update CLAUDE.md
**Add section:**
```markdown
## Custom Dashboards

Civic OS supports configurable dashboards with auto-refreshing widgets.

**Widget Types:**
- **Markdown**: Static content with markdown formatting
- **Filtered List**: Dynamic entity lists with filters
- **Stat Card**: Single metric display (count, sum, etc.)
- **Query Result**: Results from database views

**Database Schema:**
- `metadata.widget_types`: Registry of available widget types
- `metadata.dashboards`: Dashboard metadata and settings
- `metadata.dashboard_widgets`: Widget configurations (hybrid: columns + JSONB)
- `metadata.user_dashboard_preferences`: User default dashboard

**Auto-refresh:**
- Default: 60 seconds
- NULL = no auto-refresh
- 0 = manual only
- Pauses when tab hidden

**Adding New Widget Types:**
1. Insert into `metadata.widget_types`
2. Create Angular component implementing `WidgetComponent` interface
3. Register in widget component registry
4. Define TypeScript interface for config
```

### Update ROADMAP.md
**Mark as completed:**
```markdown
- [x] Customizable dashboards
```

## Future Enhancements (Post-MVP)

### Phase 6+: Advanced Features
- **Dashboard templates** (predefined layouts for common use cases)
  - "Issue Tracker" template
  - "Team Metrics" template
  - "Executive Summary" template

- **Widget library** (community-contributed widgets)
  - Plugin architecture
  - npm package for custom widgets
  - Widget marketplace

- **Dashboard export/import** (JSON format)
  - Backup/restore dashboards
  - Share between installations
  - Version control friendly

- **Dashboard versioning** (audit trail)
  - Track changes over time
  - Revert to previous versions
  - Diff visualization

- **Real-time updates** (WebSocket/SSE)
  - Push updates instead of polling
  - Live data streaming
  - Presence indicators

- **Dashboard embedding** (iframe support)
  - Public dashboard URLs
  - Embed in external sites
  - Read-only mode

- **Widget drilldown** (interactive exploration)
  - Click stat card → filtered list
  - Click list item → detail page
  - Breadcrumb navigation

- **Conditional widgets** (dynamic visibility)
  - Show/hide based on user role
  - Show/hide based on data values
  - Time-based visibility

- **Scheduled reports** (email automation)
  - Daily/weekly dashboard snapshots
  - PDF generation
  - Email distribution lists

- **Dark mode optimizations** (theme-aware)
  - Theme-aware charts
  - Contrast adjustments
  - Custom color schemes

- **Mobile app support** (responsive optimization)
  - Native mobile gestures
  - Offline mode
  - Push notifications

## Migration Strategy

### Initial Setup (New Installations)
1. Schema migrations run automatically on first boot
2. Default "Welcome" dashboard created with sample widgets
3. Dashboard route configured as home page
4. Admin can customize immediately

### Existing Installations
1. Run migration scripts (postgres/XX_dashboards.sql)
2. Default dashboard created automatically
3. No breaking changes (all existing routes work)
4. Default route changes from empty to DashboardPage
5. Users can still access entities via menu (no disruption)

### Rollback Plan
If needed, can revert by:
1. Change default route back to empty/redirect
2. Tables remain (no data loss)
3. Dashboard features hidden but available

## Success Metrics

### MVP Success Criteria
1. ✅ Default dashboard loads in <1 second (on modern hardware)
2. ✅ Auto-refresh works without memory leaks (100+ refresh cycles)
3. ✅ Admin can create/edit dashboards without writing code
4. ✅ Filtered list widget supports all entity types automatically
5. ✅ Mobile responsive (1 column layout on phones)
6. ✅ All tests pass (unit, component, integration, e2e)

### User Experience Goals
- **First-time users**: See helpful welcome message with logo and description
- **Power users**: Build custom dashboards with real-time metrics
- **Admins**: Manage dashboards via UI without database access
- **Developers**: Extend with custom widget types in <1 hour

### Performance Benchmarks
- Dashboard page load: <1 second (with 10 widgets)
- Widget refresh: <500ms per widget
- No memory leaks after 1000 refresh cycles
- No blocking UI during widget updates

## Known Risks (Not Yet Mitigated)

### Risk 1: Widget State Persistence
**Issue:** Should widgets remember state between page loads? (expanded/collapsed, sort order, scroll position)

**Impact:** Better UX if remembered, but adds complexity (localStorage management, state sync).

**Mitigation Strategy:** TBD - Defer to Phase 4 or 6

### Risk 2: Widget Dependencies
**Issue:** What if Widget B depends on Widget A's state? (User selects item in A, B shows details)

**Impact:** Requires event bus or shared state (complex).

**Mitigation Strategy:** TBD - Defer to Phase 6+ (out of scope for MVP)

### Risk 3: Mobile Battery Drain
**Issue:** Auto-refresh on mobile devices = battery drain.

**Impact:** Users may disable dashboards or complain.

**Mitigation Strategy:** TBD - Phase 4 (longer intervals on mobile, disable by default)

### Risk 4: Cache Invalidation
**Issue:** User creates new issue → dashboard should show it immediately, not wait 60 seconds.

**Impact:** Stale data, user frustration.

**Mitigation Strategy:** TBD - Phase 6+ (WebSocket/SSE for real-time updates, or manual refresh after mutations)

### Risk 5: Dashboard Clutter (20+ widgets)
**Issue:** Users create dashboards with too many widgets (slow load, overwhelming).

**Impact:** Poor UX, performance degradation.

**Mitigation Strategy:** TBD - Phase 4 (max widgets limit, pagination, widget search/filter)

### Risk 6: Broken Widget Backwards Compatibility
**Issue:** Widget config schema changes (e.g., add required field). Old widgets break.

**Impact:** Production dashboards stop working after deployment.

**Mitigation Strategy:** TBD - Phase 3-4 (config versioning, migration utilities, graceful fallbacks)

### Risk 7: PostgREST Query Complexity
**Issue:** Complex filtered lists with many filters → slow PostgREST queries.

**Impact:** Widget load times exceed 500ms target.

**Mitigation Strategy:** TBD - Phase 5 (database views, materialized views, query optimization)

## Open Questions & Decisions Needed

### 1. Markdown Library Choice
**Options:**
- **ngx-markdown**: Full-featured, active maintenance, ~50KB
- **marked.js**: Lightweight, minimal, ~20KB
- **showdown**: Middle ground, ~40KB

**Recommendation:** ngx-markdown (most Angular-friendly)

### 2. Chart Library (for ChartWidget in Phase 4)
**Options:**
- **Chart.js**: Most popular, 60KB, good docs
- **ngx-charts**: Angular-native, 100KB, D3-based
- **Apache ECharts**: Feature-rich, 500KB, steep learning curve

**Recommendation:** Chart.js (balance of features vs size)

### 3. Drag-and-Drop Library
**Options:**
- **Angular CDK Drag-Drop**: Built-in, well-integrated, free
- **ngx-dnd**: Third-party, more features, maintenance concerns

**Recommendation:** Angular CDK (official, reliable)

### 4. Markdown HTML Support
**Security concern:** Should enableHtml be allowed?

**Options:**
- A) Never allow HTML (safest)
- B) Allow HTML but sanitize aggressively (DOMPurify)
- C) Allow HTML only for admins (middle ground)

**Recommendation:** Option C (admin-only, with DOMPurify sanitization)

### 5. Widget Refresh Interval Limits
**Should there be minimum/maximum refresh intervals?**

**Options:**
- A) No limits (trust admins)
- B) Minimum 10 seconds (prevent abuse)
- C) Configurable system-wide minimum

**Recommendation:** Option B (10 second minimum in CHECK constraint)

### 6. Dashboard Cloning
**Should users be able to clone dashboards?**

**Use case:** Admin creates template, users clone and customize

**Decision needed:** Yes, add `clone_dashboard()` RPC in Phase 3?

### 7. Widget Search/Filter
**For dashboards with 20+ widgets, should there be search?**

**Options:**
- A) No search (keep it simple)
- B) Search by title (client-side filter)
- C) Search by entity/type (advanced filter)

**Recommendation:** Defer to Phase 4 (YAGNI for MVP)

## Summary

This design provides a **flexible, performant, and extensible** dashboard system that:

✅ Follows Civic OS architecture (PostgreSQL-first, metadata-driven)
✅ Uses modern Angular 20 patterns (signals, standalone components)
✅ Supports auto-refreshing widgets with configurable intervals
✅ Stores config in hybrid model (typed columns + JSONB flexibility)
✅ Leverages existing RBAC system for security
✅ Enables extension without code changes (widget type registry)
✅ Optimizes performance (single-query loading, lazy widget data)
✅ Provides intuitive admin UI for dashboard management

**Key Innovation:** The hybrid storage approach (typed columns + JSONB) gives us the best of both worlds—PostgreSQL referential integrity for common fields, and flexibility for widget-specific configurations.

**Next Steps:**
1. Review this design document
2. Discuss open questions
3. Get approval to proceed
4. Begin Phase 1 implementation
