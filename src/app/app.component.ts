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

import { Component, inject, signal, computed, ElementRef, HostListener } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { Router, RouterOutlet, RouterLink, NavigationEnd, ActivatedRouteSnapshot } from '@angular/router';
import { filter } from 'rxjs';
import { SchemaService } from './services/schema.service';
import { VersionService } from './services/version.service';
import { ThemeService } from './services/theme.service';
import { ImpersonationService } from './services/impersonation.service';
import { Observable } from 'rxjs';
import { OpenAPIV2 } from 'openapi-types';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SchemaEntityTable } from './interfaces/entity';
import { AuthService } from './services/auth.service';
import { UserManagementService } from './services/user-management.service';
import { StaticAssetsService } from './services/static-assets.service';
import { DashboardSelectorComponent } from './components/dashboard-selector/dashboard-selector.component';
import { SettingsModalComponent } from './components/settings-modal/settings-modal.component';
import { AboutModalComponent } from './components/about-modal/about-modal.component';
import { getKeycloakAccountUrl, getAppTitle, getFaviconUrl } from './config/runtime';
import { LocaleService } from './services/locale.service';
import { ProfileService } from './services/profile.service';
import { CosModalComponent } from './components/cos-modal/cos-modal.component';
import { TranslatePipe } from './pipes/translate.pipe';
import { TranslationService } from './services/translation.service';

@Component({
    selector: 'app-root',
    imports: [
    RouterOutlet,
    RouterLink,
    CommonModule,
    FormsModule,
    DashboardSelectorComponent,
    SettingsModalComponent,
    AboutModalComponent,
    CosModalComponent,
    TranslatePipe
],
    templateUrl: './app.component.html',
    styleUrl: './app.component.css'
})
export class AppComponent {
  private schema = inject(SchemaService);
  private version = inject(VersionService);
  private router = inject(Router);
  private elementRef = inject(ElementRef);
  private titleService = inject(Title);
  private translation = inject(TranslationService);
  public auth = inject(AuthService);
  public themeService = inject(ThemeService);
  private localeService = inject(LocaleService);
  public profileService = inject(ProfileService);
  public impersonation = inject(ImpersonationService);
  private userManagement = inject(UserManagementService);
  private staticAssets = inject(StaticAssetsService);

  public drawerOpen: boolean = false;
  appTitle = getAppTitle();

  // Track the first NavigationEnd so we don't steal focus / re-set the title on initial load
  private firstNavigation = true;

  // Track if current route is a dashboard page (home or /dashboard/:id)
  isDashboardRoute = signal(false);

  // Control settings modal visibility
  showSettingsModal = signal(false);

  // Which tab the settings modal opens to ('preferences' or 'colors')
  settingsInitialTab = signal('preferences');

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

  // Permission signals for feature access (v0.25.1)
  // These check if the user has read permission on the underlying tables
  public hasRecurringSchedulePermission = computed(() => this.auth.hasPermission('time_slot_series', 'read'));

  public hasPaymentPermission = computed(() => this.auth.hasPermission('payment_transactions', 'read'));

  public hasUserManagementPermission = computed(() => this.userManagement.hasUserManagementAccess());

  public hasStaticAssetPermission = computed(() => this.staticAssets.hasStaticAssetAccess());

  public hasFilePermission = computed(() => this.auth.hasPermission('files', 'read'));

  public hasGalleryAdminPermission = computed(() => this.auth.isAdmin());

  public hasStatusAdminPermission = computed(() => this.auth.hasPermission('metadata.statuses', 'update'));

  public hasCategoryAdminPermission = computed(() => this.auth.hasPermission('metadata.categories', 'update'));

  // Show Translations link when user has translation permissions AND multiple locales are configured
  public hasTranslationAdminPermission = computed(() =>
    this.auth.hasPermission('metadata.translations', 'update') && this.localeService.supportedLocales.length > 1
  );

  // Show Admin section if user is admin OR has access to feature-specific pages
  public showAdminSection = computed(() => {
    // Admin always sees the section
    if (this.auth.isAdmin()) return true;
    // Non-admins see it if they have user management access
    if (this.hasUserManagementPermission()) return true;
    // Non-admins see it if they have static asset access
    if (this.hasStaticAssetPermission()) return true;
    // Non-admins see it if they have recurring schedule access
    if (this.hasRecurringEntities() && this.hasRecurringSchedulePermission()) return true;
    // Non-admins see it if they have payment access
    if (this.hasPaymentEntities() && this.hasPaymentPermission()) return true;
    // Non-admins see it if they have file admin access
    if (this.hasFilePermission()) return true;
    // Non-admins see it if they have gallery admin access
    if (this.hasGalleryAdminPermission()) return true;
    // Non-admins see it if they have status/category admin access
    if (this.hasStatusAdminPermission()) return true;
    if (this.hasCategoryAdminPermission()) return true;
    // Non-admins see it if they have translation admin access
    if (this.hasTranslationAdminPermission()) return true;
    return false;
  });

  constructor() {
    // Set page title and favicon from runtime config
    document.title = this.appTitle;
    const faviconUrl = getFaviconUrl();
    if (faviconUrl) {
      const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
      if (link) {
        link.href = faviconUrl;
      }
    }

    // Check initial route
    this.checkIfDashboardRoute(this.router.url);

    // Listen for navigation events to update dashboard route status,
    // set the per-route page title, and move focus to the main content region.
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe((event: NavigationEnd) => {
      this.checkIfDashboardRoute(event.urlAfterRedirects);

      // Static routes carry a `titleKey` in their route data. Dynamic pages
      // (list/detail/create/edit) set their own title once entity metadata resolves.
      // Runs on the initial navigation too, so direct loads get a page title (WCAG 2.4.2).
      const titleKey = this.getDeepestRouteData()['titleKey'] as string | undefined;
      if (titleKey) {
        this.titleService.setTitle(`${this.translation.get(titleKey)} – ${this.appTitle}`);
      }

      // Skip focus management on the initial navigation: stealing focus on
      // first paint would be disorienting.
      if (this.firstNavigation) {
        this.firstNavigation = false;
        return;
      }

      // Move focus to the main landmark so screen-reader/keyboard users land on the
      // freshly rendered content instead of silently swapped page content.
      const main = this.elementRef.nativeElement.querySelector('#main-content') as HTMLElement | null;
      main?.focus();
    });
  }

  /**
   * Walk the activated route snapshot tree to the deepest child and return its
   * merged route `data`. Used to read the static `titleKey` for the current page.
   */
  private getDeepestRouteData(): Record<string, unknown> {
    let route: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    while (route.firstChild) {
      route = route.firstChild;
    }
    return route.data;
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

  /**
   * Close the profile dropdown (used when a menu item navigates via routerLink).
   */
  public closeProfileDropdown() {
    const profileDropdown = this.elementRef.nativeElement.querySelector('#profile-dropdown');
    if (profileDropdown) profileDropdown.open = false;
  }

  /**
   * Open the settings modal on the Preferences tab
   */
  public openSettings() {
    this.settingsInitialTab.set('preferences');
    this.showSettingsModal.set(true);
  }

  /**
   * Open the settings modal on the Colors tab
   */
  public openSettingsOnColors() {
    this.settingsInitialTab.set('colors');
    this.showSettingsModal.set(true);
  }

  /**
   * Open the about modal
   */
  public openAbout() {
    this.showAboutModal.set(true);
  }

  /**
   * Open the profile page in a new tab and dismiss the incomplete prompt.
   */
  public openProfileInNewTab() {
    window.open('/profile', '_blank');
    this.profileService.incompleteRequired.set([]);
  }

  /**
   * Dismiss the incomplete profile prompt without opening profile.
   */
  public dismissIncompletePrompt() {
    this.profileService.incompleteRequired.set([]);
  }

  /**
   * Stop impersonation from navbar dropdown
   */
  public stopImpersonation() {
    this.impersonation.stopImpersonation().subscribe();
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
