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
