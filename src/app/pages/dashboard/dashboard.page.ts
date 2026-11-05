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

import { Component, inject, signal, ChangeDetectionStrategy, DestroyRef, effect, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';

import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Dashboard, DashboardWidget } from '../../interfaces/dashboard';
import { DashboardService } from '../../services/dashboard.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
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
  imports: [WidgetContainerComponent, TranslatePipe],
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
  /** Translation key of the current error (rendered through the translate pipe), or undefined. */
  error = signal<string | undefined>(undefined);

  // The load in flight. Starting another load (route change, retry) or leaving the page cancels
  // it, so a slow response for the previous dashboard cannot replace the current one.
  private load: Subscription | null = null;

  // The dashboard id in the route (undefined on /), kept so a role change can reload the same view
  private routeDashboardId: number | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.load?.unsubscribe());

    // A role change (impersonation, login, logout) changes what the caller may see: reload this view.
    // On / that re-resolves the default dashboard; on /dashboard/:id it re-runs get_dashboard, so a
    // dashboard the new roles cannot see shows "not found".
    let initialRoles = true;
    effect(() => {
      this.dashboardService.roleChange();
      if (initialRoles) {
        initialRoles = false;
        return;
      }
      untracked(() => this.reloadForRoleChange());
    });

    // Subscribe to route parameter changes to reload dashboard
    // This ensures the component reacts when navigating between different dashboards
    this.route.paramMap.pipe(
      takeUntilDestroyed()  // Auto-cleanup on component destruction
    ).subscribe(params => {
      const dashboardId = params.get('id');

      this.routeDashboardId = dashboardId ? parseInt(dashboardId, 10) : undefined;

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

    this.load?.unsubscribe();
    this.load = this.dashboardService.getDashboard(id).subscribe({
      next: (dashboard) => {
        if (dashboard) {
          this.dashboard.set(dashboard);
          this.widgets.set(dashboard.widgets || []);
          this.loading.set(false);
        } else {
          this.error.set('dashboard.error.not_found');
          this.loading.set(false);
        }
      },
      error: (err) => {
        console.error('[DashboardPage] Error loading dashboard:', err);
        this.error.set('dashboard.error.load_failed');
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
    // Hold the slot before subscribing: a synchronous emit calls loadDashboard(),
    // which replaces this.load, and assigning the returned subscription afterwards
    // would overwrite that handle with a closed one.
    this.load?.unsubscribe();
    const load = new Subscription();
    this.load = load;
    load.add(this.dashboardService.getDefaultDashboard().subscribe({
      next: (dashboardId) => {
        if (dashboardId) {
          // Fetch the actual dashboard
          this.loadDashboard(dashboardId);
        } else {
          this.error.set('dashboard.error.no_default');
          this.loading.set(false);
        }
      },
      error: (err) => {
        console.error('[DashboardPage] Error loading default dashboard:', err);
        this.error.set('dashboard.error.load_default_failed');
        this.loading.set(false);
      }
    }));
  }

  private reloadForRoleChange(): void {
    if (this.routeDashboardId !== undefined) {
      this.loadDashboard(this.routeDashboardId);
    } else {
      this.loadDefaultDashboard();
    }
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
