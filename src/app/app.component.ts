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

import { Component, inject, signal, computed, ElementRef, HostListener } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { SchemaService } from './services/schema.service';
import { VersionService } from './services/version.service';
import { ThemeService } from './services/theme.service';
import { Observable } from 'rxjs';
import { OpenAPIV2 } from 'openapi-types';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SchemaEntityTable } from './interfaces/entity';
import { AuthService } from './services/auth.service';
import { DashboardSelectorComponent } from './components/dashboard-selector/dashboard-selector.component';
import { SettingsModalComponent } from './components/settings-modal/settings-modal.component';
import { AboutModalComponent } from './components/about-modal/about-modal.component';
import { getKeycloakAccountUrl } from './config/runtime';

@Component({
    selector: 'app-root',
    imports: [
    RouterOutlet,
    CommonModule,
    FormsModule,
    DashboardSelectorComponent,
    SettingsModalComponent,
    AboutModalComponent
],
    templateUrl: './app.component.html',
    styleUrl: './app.component.css'
})
export class AppComponent {
  private schema = inject(SchemaService);
  private version = inject(VersionService);
  private router = inject(Router);
  private elementRef = inject(ElementRef);
  public auth = inject(AuthService);
  public themeService = inject(ThemeService);

  public drawerOpen: boolean = false;
  title = 'frontend';

  // Track if current route is a dashboard page (home or /dashboard/:id)
  isDashboardRoute = signal(false);

  // Control settings modal visibility
  showSettingsModal = signal(false);

  // Control about modal visibility
  showAboutModal = signal(false);

  // Expose Keycloak account URL helper to template
  public getKeycloakAccountUrl = getKeycloakAccountUrl;

  // Initialize schema and version tracking on app startup
  private _schemaInit = this.schema.init();
  private _versionInit = this.version.init().subscribe();

  // Menu items exclude detected junction tables (accessible via direct URL)
  public menuItems$: Observable<SchemaEntityTable[] | undefined> = this.schema.getEntitiesForMenu();

  // Convert entities to signal for computed checks
  private entities = toSignal(this.schema.getEntities());

  // Check if any entity supports recurring schedules
  public hasRecurringEntities = computed(() => {
    const entities = this.entities();
    return entities?.some(e => e.supports_recurring) ?? false;
  });

  // Check if any entity has payments enabled
  public hasPaymentEntities = computed(() => {
    const entities = this.entities();
    return entities?.some(e => e.payment_initiation_rpc) ?? false;
  });

  constructor() {
    // Check initial route
    this.checkIfDashboardRoute(this.router.url);

    // Listen for navigation events to update dashboard route status
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe((event: NavigationEnd) => {
      this.checkIfDashboardRoute(event.urlAfterRedirects);
    });
  }

  /**
   * Check if the given URL is a dashboard route (home or /dashboard/:id)
   */
  private checkIfDashboardRoute(url: string): void {
    this.isDashboardRoute.set(
      url === '/' || url.startsWith('/dashboard')
    );
  }

  /**
   * Close profile dropdown when clicking outside of it
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const profileDropdown = this.elementRef.nativeElement.querySelector('#profile-dropdown');
    if (profileDropdown) {
      const clickedInside = profileDropdown.contains(event.target as Node);
      if (!clickedInside && profileDropdown.open) {
        profileDropdown.open = false;
      }
    }
  }

  public navigateToHome() {
    this.router.navigate(['/']);
    this.drawerOpen = false;
  }

  public navigate(key: string) {
    this.router.navigate(['view', key]);
    this.drawerOpen = false;
  }

  public navigateToPermissions() {
    this.router.navigate(['permissions']);
    this.drawerOpen = false;
  }

  public navigateToEntityManagement() {
    this.router.navigate(['entity-management']);
    this.drawerOpen = false;
  }

  public navigateToPropertyManagement() {
    this.router.navigate(['property-management']);
    this.drawerOpen = false;
  }

  public navigateToSchemaEditor() {
    this.router.navigate(['schema-editor']);
    this.drawerOpen = false;
  }

  public navigateToNotificationTemplates() {
    this.router.navigate(['notifications', 'templates']);
    this.drawerOpen = false;
  }

  public navigateToPaymentsAdmin() {
    this.router.navigate(['admin', 'payments']);
    this.drawerOpen = false;
  }

  public navigateToRecurringSchedules() {
    this.router.navigate(['admin', 'recurring-schedules']);
    this.drawerOpen = false;
  }

  /**
   * Open the settings modal
   */
  public openSettings() {
    this.showSettingsModal.set(true);
  }

  /**
   * Open the about modal
   */
  public openAbout() {
    this.showAboutModal.set(true);
  }

  /**
   * Check if a route is currently active
   * For entity routes, also matches create/edit pages for the same table
   */
  public isRouteActive(route: string): boolean {
    // Special case for home route - exact match only
    if (route === '/') {
      return this.router.url === '/' || this.router.url.startsWith('/dashboard');
    }

    // For entity view routes, also match create/edit for same table
    if (route.startsWith('/view/')) {
      const tableName = route.replace('/view/', '');
      return this.router.url === route ||
             this.router.url.startsWith(route + '/') ||
             this.router.url.startsWith('/create/' + tableName) ||
             this.router.url.startsWith('/edit/' + tableName + '/');
    }

    // For other routes, match exact or with trailing path
    return this.router.url === route || this.router.url.startsWith(route + '/');
  }

  public getMenuKeys(menuItems: OpenAPIV2.DefinitionsObject | undefined) : string[] {
    if(menuItems) {
      return Object.keys(menuItems).sort();
    } else {
      return [];
    }
  }
}
