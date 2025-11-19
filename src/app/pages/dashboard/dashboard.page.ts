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

import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Dashboard, DashboardWidget } from '../../interfaces/dashboard';
import { DashboardService } from '../../services/dashboard.service';
import { WidgetContainerComponent } from '../../components/widget-container/widget-container.component';

/**
 * Dashboard Page Component
 *
 * Main page for displaying customizable dashboards.
 * - Route: / (default) and /dashboard/:id
 * - Loads dashboard + widgets from DashboardService
 * - Renders widgets in responsive CSS Grid layout
 * - Signal-based state with OnPush change detection
 * - Error handling and loading states
 *
 * Phase 1: Static dashboard with markdown widgets
 * Phase 2: Auto-refreshing widgets
 * Phase 3: Global filter bar
 */
@Component({
  selector: 'app-dashboard-page',
  imports: [CommonModule, WidgetContainerComponent],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardPage {
  private dashboardService = inject(DashboardService);
  private route = inject(ActivatedRoute);

  // Component state (signals for reactivity)
  dashboard = signal<Dashboard | undefined>(undefined);
  widgets = signal<DashboardWidget[]>([]);
  loading = signal(true);
  error = signal<string | undefined>(undefined);

  constructor() {
    // Subscribe to route parameter changes to reload dashboard
    // This ensures the component reacts when navigating between different dashboards
    this.route.paramMap.pipe(
      takeUntilDestroyed()  // Auto-cleanup on component destruction
    ).subscribe(params => {
      const dashboardId = params.get('id');

      if (dashboardId) {
        // Load specific dashboard by ID
        this.loadDashboard(parseInt(dashboardId, 10));
      } else {
        // Load default dashboard (for / route)
        this.loadDefaultDashboard();
      }
    });
  }

  /**
   * Load dashboard by ID
   */
  private loadDashboard(id: number): void {
    this.loading.set(true);
    this.error.set(undefined);

    this.dashboardService.getDashboard(id).subscribe({
      next: (dashboard) => {
        if (dashboard) {
          this.dashboard.set(dashboard);
          this.widgets.set(dashboard.widgets || []);
          this.loading.set(false);
        } else {
          this.error.set('Dashboard not found');
          this.loading.set(false);
        }
      },
      error: (err) => {
        console.error('[DashboardPage] Error loading dashboard:', err);
        this.error.set('Failed to load dashboard');
        this.loading.set(false);
      }
    });
  }

  /**
   * Load default dashboard (system default or user preference)
   */
  private loadDefaultDashboard(): void {
    this.loading.set(true);
    this.error.set(undefined);

    // Get default dashboard ID first
    this.dashboardService.getDefaultDashboard().subscribe({
      next: (dashboardId) => {
        if (dashboardId) {
          // Fetch the actual dashboard
          this.loadDashboard(dashboardId);
        } else {
          this.error.set('No default dashboard found. Please contact an administrator.');
          this.loading.set(false);
        }
      },
      error: (err) => {
        console.error('[DashboardPage] Error loading default dashboard:', err);
        this.error.set('Failed to load default dashboard');
        this.loading.set(false);
      }
    });
  }

  /**
   * Retry loading dashboard
   */
  retry(): void {
    const currentDashboard = this.dashboard();
    if (currentDashboard) {
      this.loadDashboard(currentDashboard.id);
    } else {
      this.loadDefaultDashboard();
    }
  }
}
