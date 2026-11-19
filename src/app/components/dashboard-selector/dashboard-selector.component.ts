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

import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router, NavigationEnd, ActivatedRouteSnapshot } from '@angular/router';
import { filter } from 'rxjs';

import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Dashboard } from '../../interfaces/dashboard';
import { DashboardService } from '../../services/dashboard.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslationService } from '../../services/translation.service';

/**
 * Dashboard Selector Component
 *
 * Dropdown menu for navigating between dashboards.
 * Displays in navbar (app.component.html).
 *
 * Features:
 * - Lists the visible dashboards, except unlisted ones (show_in_selector = false)
 * - Names the current dashboard in the button, listed or not
 * - Highlights current dashboard
 * - Navigates to selected dashboard
 * - Signal-based state with OnPush change detection
 */
@Component({
  selector: 'app-dashboard-selector',
  imports: [TranslatePipe],
  templateUrl: './dashboard-selector.component.html',
  styleUrl: './dashboard-selector.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardSelectorComponent {
  private dashboardService = inject(DashboardService);
  private router = inject(Router);
  private translationService = inject(TranslationService);

  // Component state (signals)
  // Read from the service's signal so a refresh (locale or role change) updates the menu
  dashboards = computed<Dashboard[]>(() => this.dashboardService.dashboards() ?? []);
  // The menu lists only these; the button label reads the full list, so an unlisted dashboard opened by
  // link is still named. A missing flag counts as listed: for a few seconds of a deploy the new frontend
  // can meet the old get_dashboards().
  listedDashboards = computed<Dashboard[]>(() => this.dashboards().filter((d) => d.show_in_selector !== false));
  currentDashboardId = signal<number | undefined>(undefined);
  loading = signal(true);

  constructor() {
    // Load all available dashboards
    this.loadDashboards();

    // Track the open dashboard from the router. The selector lives in the navbar, outside the routed
    // outlet, so its own ActivatedRoute is the root and never carries the :id of /dashboard/:id. Reading
    // the deepest route after each navigation names a dashboard reached by link, the only way to reach an unlisted one.
    this.currentDashboardId.set(this.dashboardIdFromRouter());
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntilDestroyed()
    ).subscribe(() => this.currentDashboardId.set(this.dashboardIdFromRouter()));
  }

  /** The id in /dashboard/:id, or undefined on any other route (including the default dashboard at /). */
  private dashboardIdFromRouter(): number | undefined {
    let route: ActivatedRouteSnapshot | undefined = this.router.routerState?.snapshot?.root;
    while (route?.firstChild) {
      route = route.firstChild;
    }
    if (route?.routeConfig?.path !== 'dashboard/:id') {
      return undefined;
    }
    const id = Number(route.paramMap.get('id'));
    return Number.isInteger(id) ? id : undefined;
  }

  /**
   * Load all available dashboards (public + user's private)
   */
  private loadDashboards(): void {
    this.loading.set(true);

    this.dashboardService.getDashboards().subscribe({
      next: () => {
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
   * Get display name of current dashboard, in the user's language when it is a framework label.
   * Reads the translation version, like the translate pipe, so the label follows a locale switch.
   */
  getCurrentDashboardName(): string {
    this.translationService.version();
    const currentId = this.currentDashboardId();
    if (currentId === undefined) {
      return this.translationService.get('dashboard.default');
    }

    const dashboard = this.dashboards().find((d) => d.id === currentId);
    return dashboard?.display_name || this.translationService.get('dashboard.unnamed');
  }
}
