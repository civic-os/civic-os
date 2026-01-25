/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Dashboard metadata and configuration.
 * Represents a collection of widgets displayed together.
 */
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
  widgets?: DashboardWidget[];  // Embedded widgets from PostgREST
}

/**
 * Widget configuration and metadata.
 * Uses hybrid storage: common fields as columns, widget-specific config in JSONB.
 */
export interface DashboardWidget {
  id: number;
  dashboard_id: number;
  widget_type: string;
  title: string | null;
  entity_key: string | null;
  refresh_interval_seconds: number | null;
  sort_order: number;
  width: number;  // 1-2 grid columns
  height: number; // 1-3 grid rows
  config: Record<string, any>;  // Widget-specific configuration (JSONB)
  created_at: string;
  updated_at: string;
}

/**
 * Widget type metadata from metadata.widget_types table.
 * Defines available widget types and their properties.
 */
export interface WidgetType {
  widget_type: string;
  display_name: string;
  description: string;
  icon_name: string;
  is_active: boolean;
  config_schema?: any;  // JSON Schema for validation (Phase 3)
}

/**
 * Configuration for markdown widget.
 * Stored in dashboard_widgets.config as JSONB.
 */
export interface MarkdownWidgetConfig {
  content: string;
  enableHtml: boolean;
}

/**
 * Base configuration for widgets that display filtered entity data.
 * Used by FilteredListWidget, MapWidget, and future data-driven widgets (charts, stats, etc.).
 *
 * This establishes the common pattern: fetch entity records → apply filters → display subset of columns.
 */
export interface FilteredEntityWidgetBase {
  filters?: FilterCondition[];  // Optional pre-filters applied to entity query
  showColumns?: string[];       // Properties to display (default: ['display_name'])
}

/**
 * Configuration for filtered list widget (Phase 2).
 * Extends the base filtered entity pattern with table-specific display options.
 * Stored in dashboard_widgets.config as JSONB.
 */
export interface FilteredListWidgetConfig extends FilteredEntityWidgetBase {
  orderBy: string;              // Column to sort by
  orderDirection: 'asc' | 'desc'; // Sort direction
  limit: number;                // Maximum records to display
}

/**
 * Configuration for map widget (Phase 2).
 * Extends the base filtered entity pattern with geography-specific options.
 * Stored in dashboard_widgets.config as JSONB.
 *
 * Displays filtered entity records with geography columns on an interactive map.
 */
export interface MapWidgetConfig extends FilteredEntityWidgetBase {
  // Data source (required)
  entityKey: string;           // Which entity to show (e.g., 'participants', 'sponsors')
  mapPropertyName: string;     // Which geography column (e.g., 'home_location', 'location')

  // Result limiting (optional)
  maxMarkers?: number;         // Default 500 (performance safety limit)

  // Display (optional - inherited showColumns from base)
  popupTemplate?: string;      // Custom popup HTML template (Phase 3+)

  // Map behavior (optional)
  defaultZoom?: number;        // Override auto-fit zoom level
  defaultCenter?: [number, number]; // [lng, lat] - override auto-fit center

  // Clustering (optional)
  enableClustering?: boolean;  // Group nearby markers (default: false)
  clusterRadius?: number;      // Pixels for clustering (default: 50)

  // Future enhancements (Phase 4+)
  colorProperty?: string;      // hex_color column for marker colors
}

/**
 * Configuration for calendar widget (Phase 2).
 * Extends the base filtered entity pattern with time_slot-specific options.
 * Stored in dashboard_widgets.config as JSONB.
 *
 * Displays filtered entity records with time_slot columns on an interactive calendar
 * with month/week/day views.
 */
export interface CalendarWidgetConfig extends FilteredEntityWidgetBase {
  // Data source (required)
  entityKey: string;              // Which entity to show (e.g., 'reservations', 'appointments')
  timeSlotPropertyName: string;   // Which time_slot column (e.g., 'time_slot', 'scheduled_time')

  // Display options (optional)
  colorProperty?: string;         // hex_color column for event colors
  defaultColor?: string;          // Fallback event color (default: '#3B82F6')
  initialView?: 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay'; // Default: 'timeGridWeek'
  initialDate?: string;           // YYYY-MM-DD format (default: today)

  // Month view options (optional)
  dayMaxEvents?: number | boolean; // Events per day before "+more" link (default: 2, true = auto-calc)
  eventDisplay?: 'auto' | 'block' | 'list-item' | 'background'; // Event rendering style (default: 'block')
  moreLinkClick?: 'popover' | 'day' | 'week'; // "+more" click behavior (default: 'day')

  // Performance (optional)
  maxEvents?: number;             // Maximum events to display (default: 1000)

  // Interaction (optional)
  showCreateButton?: boolean;     // Show "Create {Entity}" button (default: false)

  // Future enhancements (Phase 3+)
  // showColumns inherited from base - will be used for event tooltips
}

/**
 * Configuration for dashboard navigation widget (Phase 2).
 * Provides sequential navigation between dashboards with prev/next buttons
 * and progress indicator chips.
 * Stored in dashboard_widgets.config as JSONB.
 */
export interface DashboardNavigationWidgetConfig {
  // Previous button (optional - hidden placeholder shown if not provided)
  backward?: {
    url: string;   // Route URL (e.g., '/', '/dashboard/3')
    text: string;  // Button text (e.g., '2018: Foundation Year')
  };

  // Next button (optional - hidden placeholder shown if not provided)
  forward?: {
    url: string;
    text: string;
  };

  // Progress chips (required) - current route auto-highlighted
  chips: Array<{
    text: string;  // Chip label (e.g., '2018', '2020')
    url: string;   // Route URL
  }>;
}

/**
 * Configuration for stat card widget (Phase 5).
 * Extends the base filtered entity pattern with aggregation-specific options.
 * Stored in dashboard_widgets.config as JSONB.
 *
 * Note: Requires backend aggregation RPC functions to be implemented.
 */
export interface StatCardWidgetConfig extends FilteredEntityWidgetBase {
  metric: 'count' | 'sum' | 'avg' | 'min' | 'max';
  entityKey: string;
  column?: string;  // Column to aggregate (required for sum/avg/min/max)
  suffix?: string;  // e.g., " open issues"
  prefix?: string;  // e.g., "$"
  color?: 'primary' | 'secondary' | 'success' | 'warning' | 'error';
}

/**
 * Filter condition for widgets.
 * Used in filtered list and stat card widgets.
 */
export interface FilterCondition {
  column: string;
  operator: string;  // 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in'
  value: any;
}

/**
 * Configuration for navigation buttons widget.
 * Displays a flexible set of navigation buttons with optional header and description.
 * Stored in dashboard_widgets.config as JSONB.
 */
export interface NavButtonsWidgetConfig {
  // Optional header text displayed above the buttons
  header?: string;

  // Optional description/instructions text
  description?: string;

  // Array of navigation buttons (required)
  buttons: Array<{
    text: string;      // Button label (required)
    url: string;       // Internal route URL (required)
    icon?: string;     // Material Symbol name (optional, e.g., 'home', 'settings')
    variant?: 'primary' | 'secondary' | 'accent' | 'outline' | 'ghost' | 'link';  // Button style (default: 'outline')
  }>;
}
