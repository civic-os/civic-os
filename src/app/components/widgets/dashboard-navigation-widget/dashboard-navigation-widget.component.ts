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

import { Component, input, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, Router } from '@angular/router';
import { DashboardWidget, DashboardNavigationWidgetConfig } from '../../../interfaces/dashboard';

/**
 * Dashboard Navigation Widget Component
 *
 * Provides sequential navigation between dashboards with prev/next buttons
 * and progress indicator chips. Uses Angular router for client-side navigation.
 */
@Component({
  selector: 'app-dashboard-navigation-widget',
  imports: [CommonModule, RouterLink],
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
