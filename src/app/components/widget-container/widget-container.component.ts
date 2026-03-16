/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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

import { Component, input, computed, inject, ChangeDetectionStrategy, Type } from '@angular/core';
import { NgComponentOutlet, CommonModule } from '@angular/common';
import { DashboardWidget } from '../../interfaces/dashboard';
import { WidgetComponentRegistry } from '../../services/widget-component-registry.service';

/**
 * Widget Container Component
 *
 * Wrapper component that dynamically loads the correct widget component
 * based on the widget type.
 *
 * Responsibilities:
 * - Query WidgetComponentRegistry to get component class
 * - Render widget using NgComponentOutlet
 * - Display loading/error states
 * - Provide widget chrome (title, borders, DaisyUI card styling)
 * - Handle widget failures gracefully (Phase 1)
 * - Auto-refresh logic (Phase 2)
 */
@Component({
  selector: 'app-widget-container',
  imports: [CommonModule, NgComponentOutlet],
  templateUrl: './widget-container.component.html',
  styleUrl: './widget-container.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class WidgetContainerComponent {
  private registry = inject(WidgetComponentRegistry);

  // Widget configuration from parent
  widget = input.required<DashboardWidget>();

  // Get component class from registry
  widgetComponent = computed<Type<any> | null>(() => {
    const widgetType = this.widget().widget_type;
    const component = this.registry.getComponent(widgetType);

    if (!component) {
      console.error(`[WidgetContainerComponent] No component registered for widget type: ${widgetType}`);
    }

    return component;
  });

  // Error state (when widget component not found)
  hasError = computed(() => {
    return this.widgetComponent() === null;
  });

  // Widget title (optional)
  title = computed(() => {
    return this.widget().title;
  });

  // Visual-only widgets (image) don't need card chrome
  borderless = computed(() => {
    return this.widget().widget_type === 'image';
  });

  // Inputs to pass to dynamic widget component
  widgetInputs = computed(() => {
    return {
      widget: this.widget()
    };
  });

  /**
   * Retry loading widget (Phase 1: just reload page, Phase 2: re-fetch data)
   */
  retry(): void {
    // TODO: Phase 2 - trigger widget data refresh
  }
}
