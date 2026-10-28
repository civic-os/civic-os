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

import { Component, input, computed, inject, ChangeDetectionStrategy } from '@angular/core';

import { RouterLink, Router } from '@angular/router';
import { DashboardWidget, DashboardNavigationWidgetConfig } from '../../../interfaces/dashboard';
import { ContrastTextDirective } from '../../../directives/contrast-text.directive';

// Literal class names so Tailwind's source scan keeps them in the bundle
const SIZE_CLASSES: Record<NonNullable<DashboardNavigationWidgetConfig['size']>, string> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg'
};

/**
 * Dashboard Navigation Widget Component
 *
 * Provides sequential navigation between dashboards with prev/next buttons
 * and progress indicator chips. Uses Angular router for client-side navigation.
 * All buttons and chips share one size (config.size, default 'xs').
 */
@Component({
  selector: 'app-dashboard-navigation-widget',
  imports: [RouterLink, ContrastTextDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-navigation-widget.component.html',
  styleUrl: './dashboard-navigation-widget.component.css'
})
export class DashboardNavigationWidgetComponent {
  // Widget configuration from parent dashboard
  widget = input.required<DashboardWidget>();

  private router = inject(Router);

  // Typed configuration (extract from JSONB config)
  config = computed<DashboardNavigationWidgetConfig>(() => {
    return this.widget().config as DashboardNavigationWidgetConfig;
  });

  // Size class applied to every button and chip; unknown values fall back to 'xs'
  sizeClass = computed<string>(() => {
    const size = this.config().size;
    return size && Object.hasOwn(SIZE_CLASSES, size) ? SIZE_CLASSES[size] : SIZE_CLASSES.xs;
  });

  /**
   * Check if a chip URL matches the current route
   */
  isCurrentRoute(url: string): boolean {
    // Normalize URLs for comparison
    const currentUrl = this.router.url;

    // Handle root dashboard (/) matching
    if (url === '/' && (currentUrl === '/' || currentUrl === '')) {
      return true;
    }

    // Direct match
    return currentUrl === url;
  }
}
