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
import { Router, ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Dashboard } from '../../interfaces/dashboard';
import { DashboardService } from '../../services/dashboard.service';

/**
 * Dashboard Selector Component
 *
 * Dropdown menu for navigating between dashboards.
 * Displays in navbar (app.component.html).
 *
 * Features:
 * - Lists all available dashboards (public + user's private)
 * - Highlights current dashboard
 * - Navigates to selected dashboard
 * - Signal-based state with OnPush change detection
 */
@Component({
  selector: 'app-dashboard-selector',
  imports: [CommonModule],
  templateUrl: './dashboard-selector.component.html',
  styleUrl: './dashboard-selector.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardSelectorComponent {
  private dashboardService = inject(DashboardService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  // Component state (signals)
  dashboards = signal<Dashboard[]>([]);
  currentDashboardId = signal<number | undefined>(undefined);
  loading = signal(true);

  constructor() {
    // Load all available dashboards
    this.loadDashboards();

    // Subscribe to route parameter changes to update current dashboard highlight
    this.route.paramMap.pipe(
      takeUntilDestroyed()
    ).subscribe(params => {
      const dashboardId = params.get('id');
      if (dashboardId) {
        this.currentDashboardId.set(parseInt(dashboardId, 10));
      } else {
        this.currentDashboardId.set(undefined);
      }
    });
  }

  /**
   * Load all available dashboards (public + user's private)
   */
  private loadDashboards(): void {
    this.loading.set(true);

    this.dashboardService.getDashboards().subscribe({
      next: (dashboards: Dashboard[]) => {
        this.dashboards.set(dashboards);
        this.loading.set(false);
      },
      error: (err: any) => {
        console.error('[DashboardSelectorComponent] Error loading dashboards:', err);
        this.loading.set(false);
      }
    });
  }

  /**
   * Navigate to selected dashboard
   */
  selectDashboard(dashboardId: number): void {
    this.currentDashboardId.set(dashboardId);
    this.router.navigate(['/dashboard', dashboardId]);
  }

  /**
   * Navigate to default dashboard (home page)
   */
  selectDefaultDashboard(): void {
    this.currentDashboardId.set(undefined);
    this.router.navigate(['/']);
  }

  /**
   * Get display name of current dashboard
   */
  getCurrentDashboardName(): string {
    const currentId = this.currentDashboardId();
    if (currentId === undefined) {
      return 'Default Dashboard';
    }

    const dashboard = this.dashboards().find((d) => d.id === currentId);
    return dashboard?.display_name || 'Dashboard';
  }
}
