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

import { Dashboard, DashboardWidget, WidgetType, MarkdownWidgetConfig } from '../interfaces/dashboard';
import { deepFreeze } from './mock-schema';

/**
 * Creates a mock Dashboard with sensible defaults.
 * Override any properties as needed for specific test cases.
 */
export function createMockDashboard(overrides?: Partial<Dashboard>): Dashboard {
  return {
    id: 1,
    display_name: 'Test Dashboard',
    description: 'A test dashboard for unit tests',
    is_default: false,
    is_public: true,
    sort_order: 0,
    created_by: null,
    created_at: '2025-10-15T00:00:00Z',
    updated_at: '2025-10-15T00:00:00Z',
    widgets: [],
    ...overrides
  };
}

/**
 * Creates a mock DashboardWidget with sensible defaults.
 * Override any properties as needed for specific test cases.
 */
export function createMockWidget(overrides?: Partial<DashboardWidget>): DashboardWidget {
  return {
    id: 1,
    dashboard_id: 1,
    widget_type: 'markdown',
    title: 'Test Widget',
    entity_key: null,
    refresh_interval_seconds: null,
    sort_order: 0,
    width: 1,
    height: 1,
    config: {
      content: '# Test Content',
      enableHtml: false
    },
    created_at: '2025-10-15T00:00:00Z',
    updated_at: '2025-10-15T00:00:00Z',
    ...overrides
  };
}

/**
 * Creates a mock WidgetType with sensible defaults.
 * Override any properties as needed for specific test cases.
 */
export function createMockWidgetType(overrides?: Partial<WidgetType>): WidgetType {
  return {
    widget_type: 'markdown',
    display_name: 'Markdown Content',
    description: 'Display formatted text',
    config_schema: null,
    icon_name: 'article',
    is_active: true,
    ...overrides
  };
}

/**
 * Pre-configured dashboard samples for common test scenarios.
 */
export const MOCK_DASHBOARDS = deepFreeze({
  welcome: createMockDashboard({
    id: 1,
    display_name: 'Welcome',
    description: 'Welcome to Civic OS',
    is_default: true,
    is_public: true,
    sort_order: 0,
    widgets: [
      createMockWidget({
        id: 1,
        dashboard_id: 1,
        widget_type: 'markdown',
        title: null,
        sort_order: 0,
        width: 2,
        height: 1,
        config: {
          content: '# Welcome to Civic OS\n\nThis is a test dashboard.',
          enableHtml: false
        }
      })
    ]
  }),

  userPrivate: createMockDashboard({
    id: 2,
    display_name: 'My Dashboard',
    description: 'User-specific private dashboard',
    is_default: false,
    is_public: false,
    sort_order: 1,
    created_by: '00000000-0000-0000-0000-000000000001',
    widgets: []
  }),

  multiWidget: createMockDashboard({
    id: 3,
    display_name: 'Multi-Widget Dashboard',
    description: 'Dashboard with multiple widgets',
    is_default: false,
    is_public: true,
    sort_order: 2,
    widgets: [
      createMockWidget({
        id: 3,
        dashboard_id: 3,
        widget_type: 'markdown',
        title: 'First Widget',
        sort_order: 0,
        width: 1,
        height: 1
      }),
      createMockWidget({
        id: 4,
        dashboard_id: 3,
        widget_type: 'markdown',
        title: 'Second Widget',
        sort_order: 1,
        width: 1,
        height: 1
      })
    ]
  }),

  noWidgets: createMockDashboard({
    id: 4,
    display_name: 'Empty Dashboard',
    description: 'Dashboard with no widgets',
    is_default: false,
    is_public: true,
    sort_order: 3,
    widgets: []
  })
});

/**
 * Pre-configured widget samples for common test scenarios.
 */
export const MOCK_WIDGETS = deepFreeze({
  markdown: createMockWidget({
    id: 1,
    dashboard_id: 1,
    widget_type: 'markdown',
    title: 'Markdown Widget',
    sort_order: 0,
    width: 2,
    height: 1,
    config: {
      content: '# Test Markdown\n\nThis is **bold** text.',
      enableHtml: false
    } as MarkdownWidgetConfig
  }),

  markdownNoTitle: createMockWidget({
    id: 2,
    dashboard_id: 1,
    widget_type: 'markdown',
    title: null,
    sort_order: 1,
    width: 1,
    height: 1,
    config: {
      content: 'Simple content without title',
      enableHtml: false
    } as MarkdownWidgetConfig
  }),

  filteredList: createMockWidget({
    id: 3,
    dashboard_id: 1,
    widget_type: 'filtered_list',
    title: 'Recent Issues',
    entity_key: 'Issue',
    refresh_interval_seconds: 60,
    sort_order: 2,
    width: 2,
    height: 2,
    config: {
      entity_key: 'Issue',
      filters: { status: 'Open' },
      limit: 10
    }
  }),

  unknownType: createMockWidget({
    id: 4,
    dashboard_id: 1,
    widget_type: 'unknown_widget_type',
    title: 'Unknown Widget',
    sort_order: 3,
    width: 1,
    height: 1,
    config: {}
  })
});

/**
 * Pre-configured widget type samples for common test scenarios.
 */
export const MOCK_WIDGET_TYPES: WidgetType[] = deepFreeze([
  createMockWidgetType({
    widget_type: 'markdown',
    display_name: 'Markdown Content',
    description: 'Display formatted text, images, and links',
    icon_name: 'article',
    is_active: true
  }),
  createMockWidgetType({
    widget_type: 'filtered_list',
    display_name: 'Filtered Entity List',
    description: 'Show filtered records from any entity',
    icon_name: 'list',
    is_active: true
  }),
  createMockWidgetType({
    widget_type: 'stat_card',
    display_name: 'Statistic Card',
    description: 'Display a single metric or KPI',
    icon_name: 'analytics',
    is_active: true
  }),
  createMockWidgetType({
    widget_type: 'query_result',
    display_name: 'Query Result',
    description: 'Show results from a database view',
    icon_name: 'table_view',
    is_active: false // Inactive widget type for testing
  })
]);
