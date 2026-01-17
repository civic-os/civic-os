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

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { AppComponent } from './app.component';
import { AuthService } from './services/auth.service';
import { ThemeService } from './services/theme.service';
import { AnalyticsService } from './services/analytics.service';
import { ImpersonationService } from './services/impersonation.service';
import { Location } from '@angular/common';

describe('AppComponent', () => {
  let mockAuthService: jasmine.SpyObj<AuthService>;
  let mockThemeService: jasmine.SpyObj<ThemeService>;
  let mockAnalyticsService: jasmine.SpyObj<AnalyticsService>;
  let mockImpersonationService: jasmine.SpyObj<ImpersonationService>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    mockAuthService = jasmine.createSpyObj('AuthService', ['isAdmin', 'hasRole', 'authenticated', 'hasPermission', 'isRealAdmin'], {
      userRoles: []
    });
    mockAuthService.authenticated.and.returnValue(false);
    // Default hasPermission to return false (as Observable)
    mockAuthService.hasPermission.and.returnValue(of(false));
    // Default isRealAdmin to return false
    mockAuthService.isRealAdmin.and.returnValue(false);

    // Mock ThemeService with signal
    const themeSignal = signal('corporate');
    mockThemeService = jasmine.createSpyObj('ThemeService', ['setTheme', 'getMapTileConfig'], {
      theme: themeSignal,
      isDark: signal(false)
    });

    // Mock AnalyticsService
    mockAnalyticsService = jasmine.createSpyObj('AnalyticsService', ['trackPageView', 'trackEvent', 'getUserPreference']);
    mockAnalyticsService.getUserPreference.and.returnValue(true);

    // Mock ImpersonationService with signal
    mockImpersonationService = jasmine.createSpyObj('ImpersonationService', ['startImpersonation', 'stopImpersonation'], {
      isActive: signal(false),
      impersonatedRoles: signal<string[]>([])
    });

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: mockAuthService },
        { provide: ThemeService, useValue: mockThemeService },
        { provide: AnalyticsService, useValue: mockAnalyticsService },
        { provide: ImpersonationService, useValue: mockImpersonationService }
      ]
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    // Clean up data-theme attribute to prevent test pollution
    document.documentElement.removeAttribute('data-theme');
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    // Handle HTTP requests made during component initialization (may be multiple)
    const schemaEntitiesReqs = httpMock.match(req => req.url.includes('schema_entities'));
    schemaEntitiesReqs.forEach(req => req.flush([]));

    // Handle version check request (VersionService.init())
    const versionReqs = httpMock.match(req => req.url.includes('schema_cache_versions'));
    versionReqs.forEach(req => req.flush([
      { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
      { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
      { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
    ]));

    // Handle dashboard requests from DashboardSelectorComponent
    const dashboardReqs = httpMock.match(req => req.url.includes('rpc/get_dashboards'));
    dashboardReqs.forEach(req => req.flush([]));

    // Handle constraint messages request (SchemaService.init())
    const constraintMsgsReqs = httpMock.match(req => req.url.includes('constraint_messages'));
    constraintMsgsReqs.forEach(req => req.flush([]));

    expect(app).toBeTruthy();
  });

  it(`should have the 'frontend' title`, () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    // Handle HTTP requests made during component initialization (may be multiple)
    const schemaEntitiesReqs = httpMock.match(req => req.url.includes('schema_entities'));
    schemaEntitiesReqs.forEach(req => req.flush([]));

    // Handle version check request (VersionService.init())
    const versionReqs = httpMock.match(req => req.url.includes('schema_cache_versions'));
    versionReqs.forEach(req => req.flush([
      { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
      { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
      { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
    ]));

    // Handle dashboard requests from DashboardSelectorComponent
    const dashboardReqs = httpMock.match(req => req.url.includes('rpc/get_dashboards'));
    dashboardReqs.forEach(req => req.flush([]));

    // Handle constraint messages request (SchemaService.init())
    const constraintMsgsReqs = httpMock.match(req => req.url.includes('constraint_messages'));
    constraintMsgsReqs.forEach(req => req.flush([]));

    expect(app.title).toEqual('frontend');
  });

  describe('Theme Integration', () => {
    it('should inject ThemeService', () => {
      const fixture = TestBed.createComponent(AppComponent);
      const app = fixture.componentInstance;

      // Handle HTTP requests
      const schemaEntitiesReqs = httpMock.match(req => req.url.includes('schema_entities'));
      schemaEntitiesReqs.forEach(req => req.flush([]));
      const versionReqs = httpMock.match(req => req.url.includes('schema_cache_versions'));
      versionReqs.forEach(req => req.flush([
        { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
        { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
      ]));
      const dashboardReqs = httpMock.match(req => req.url.includes('rpc/get_dashboards'));
      dashboardReqs.forEach(req => req.flush([]));
      const constraintMsgsReqs = httpMock.match(req => req.url.includes('constraint_messages'));
      constraintMsgsReqs.forEach(req => req.flush([]));

      expect(app.themeService).toBe(mockThemeService);
    });

    it('should render theme dropdown with bindings', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      const compiled = fixture.nativeElement as HTMLElement;
      const themeInputs = compiled.querySelectorAll('.theme-controller');

      // Should have 5 theme options (corporate, light, dark, nord, emerald)
      expect(themeInputs.length).toBe(5);
    });

    it('should mark corporate theme as checked by default', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      const compiled = fixture.nativeElement as HTMLElement;
      const corporateInput = compiled.querySelector('input[value="corporate"]') as HTMLInputElement;

      expect(corporateInput).toBeTruthy();
      expect(corporateInput.checked).toBe(true);
    });

    it('should call themeService.setTheme when theme radio button changes', () => {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      const compiled = fixture.nativeElement as HTMLElement;
      const darkInput = compiled.querySelector('input[value="dark"]') as HTMLInputElement;

      // Simulate clicking the dark theme radio button
      darkInput.click();

      // Verify setTheme was called with 'dark'
      expect(mockThemeService.setTheme).toHaveBeenCalledWith('dark');
    });
  });

  /**
   * Helper to create component with specific initial router URL
   */
  function createComponentWithUrl(url: string) {
    const router = TestBed.inject(Router);
    spyOnProperty(router, 'url', 'get').and.returnValue(url);

    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    // Handle HTTP requests
    const schemaEntitiesReqs = httpMock.match(req => req.url.includes('schema_entities'));
    schemaEntitiesReqs.forEach(req => req.flush([]));
    const versionReqs = httpMock.match(req => req.url.includes('schema_cache_versions'));
    versionReqs.forEach(req => req.flush([
      { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
      { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
      { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
    ]));
    const dashboardReqs = httpMock.match(req => req.url.includes('rpc/get_dashboards'));
    dashboardReqs.forEach(req => req.flush([]));
    const constraintMsgsReqs = httpMock.match(req => req.url.includes('constraint_messages'));
    constraintMsgsReqs.forEach(req => req.flush([]));

    return { fixture, app };
  }

  describe('isDashboardRoute detection', () => {

    it('should set isDashboardRoute to true when on home page', () => {
      const { app } = createComponentWithUrl('/');
      expect(app.isDashboardRoute()).toBe(true);
    });

    it('should set isDashboardRoute to true when on dashboard page', () => {
      const { app } = createComponentWithUrl('/dashboard/42');
      expect(app.isDashboardRoute()).toBe(true);
    });

    it('should set isDashboardRoute to false when on entity list page', () => {
      const { app } = createComponentWithUrl('/view/issues');
      expect(app.isDashboardRoute()).toBe(false);
    });

    it('should set isDashboardRoute to false when on management page', () => {
      const { app } = createComponentWithUrl('/entity-management');
      expect(app.isDashboardRoute()).toBe(false);
    });

    it('should set isDashboardRoute to false when on detail page', () => {
      const { app } = createComponentWithUrl('/view/issues/123');
      expect(app.isDashboardRoute()).toBe(false);
    });

    it('should set isDashboardRoute to false when on edit page', () => {
      const { app } = createComponentWithUrl('/edit/issues/123');
      expect(app.isDashboardRoute()).toBe(false);
    });
  });

  describe('isRouteActive', () => {
    describe('Home route', () => {
      it('should match home page', () => {
        const { app } = createComponentWithUrl('/');
        expect(app.isRouteActive('/')).toBe(true);
      });

      it('should match dashboard pages', () => {
        const { app } = createComponentWithUrl('/dashboard/42');
        expect(app.isRouteActive('/')).toBe(true);
      });

      it('should not match other routes', () => {
        const { app } = createComponentWithUrl('/view/issues');
        expect(app.isRouteActive('/')).toBe(false);
      });
    });

    describe('Entity routes', () => {
      it('should match list page (exact)', () => {
        const { app } = createComponentWithUrl('/view/issues');
        expect(app.isRouteActive('/view/issues')).toBe(true);
      });

      it('should match detail page (with ID)', () => {
        const { app } = createComponentWithUrl('/view/issues/123');
        expect(app.isRouteActive('/view/issues')).toBe(true);
      });

      it('should match create page for same entity', () => {
        const { app } = createComponentWithUrl('/create/issues');
        expect(app.isRouteActive('/view/issues')).toBe(true);
      });

      it('should match edit page for same entity', () => {
        const { app } = createComponentWithUrl('/edit/issues/123');
        expect(app.isRouteActive('/view/issues')).toBe(true);
      });

      it('should not match different entity', () => {
        const { app } = createComponentWithUrl('/view/users');
        expect(app.isRouteActive('/view/issues')).toBe(false);
      });

      it('should not match different entity create page', () => {
        const { app } = createComponentWithUrl('/create/users');
        expect(app.isRouteActive('/view/issues')).toBe(false);
      });

      it('should not match different entity edit page', () => {
        const { app } = createComponentWithUrl('/edit/users/456');
        expect(app.isRouteActive('/view/issues')).toBe(false);
      });
    });

    describe('Admin routes', () => {
      it('should match schema-erd page', () => {
        const { app } = createComponentWithUrl('/schema-erd');
        expect(app.isRouteActive('/schema-erd')).toBe(true);
      });

      it('should match entity-management page', () => {
        const { app } = createComponentWithUrl('/entity-management');
        expect(app.isRouteActive('/entity-management')).toBe(true);
      });

      it('should match property-management page', () => {
        const { app } = createComponentWithUrl('/property-management');
        expect(app.isRouteActive('/property-management')).toBe(true);
      });

      it('should match permissions page', () => {
        const { app } = createComponentWithUrl('/permissions');
        expect(app.isRouteActive('/permissions')).toBe(true);
      });

      it('should not match partial admin route names', () => {
        const { app } = createComponentWithUrl('/permissions');
        expect(app.isRouteActive('/entity-management')).toBe(false);
      });
    });
  });

  describe('Profile Menu Integration', () => {
    it('should expose getKeycloakAccountUrl helper to template', () => {
      const fixture = TestBed.createComponent(AppComponent);
      const app = fixture.componentInstance;

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      expect(app.getKeycloakAccountUrl).toBeDefined();
      expect(typeof app.getKeycloakAccountUrl).toBe('function');
    });

    it('should render Account Settings link when authenticated', () => {
      // Set authenticated to true
      mockAuthService.authenticated.and.returnValue(true);

      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      const compiled = fixture.nativeElement as HTMLElement;
      const accountLink = compiled.querySelector('a[href*="/account"]') as HTMLAnchorElement;

      expect(accountLink).toBeTruthy();
      expect(accountLink.textContent).toContain('Account Settings');
    });

    it('should include referrer_uri parameter in Account Settings link', () => {
      mockAuthService.authenticated.and.returnValue(true);

      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      const compiled = fixture.nativeElement as HTMLElement;
      const accountLink = compiled.querySelector('a[href*="/account"]') as HTMLAnchorElement;

      expect(accountLink).toBeTruthy();
      expect(accountLink.href).toContain('referrer_uri=');
    });

    it('should NOT render Account Settings link when not authenticated', () => {
      mockAuthService.authenticated.and.returnValue(false);

      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      const compiled = fixture.nativeElement as HTMLElement;
      const accountLink = compiled.querySelector('a[href*="/account"]') as HTMLAnchorElement;

      // Should not find Account Settings link for unauthenticated users
      expect(accountLink).toBeNull();
    });

    it('should show Login link when not authenticated', () => {
      mockAuthService.authenticated.and.returnValue(false);

      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      // Handle HTTP requests
      const allReqs = httpMock.match(() => true);
      allReqs.forEach(req => {
        if (req.request.url.includes('schema_entities')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_properties')) {
          req.flush([]);
        } else if (req.request.url.includes('schema_cache_versions')) {
          req.flush([
            { cache_name: 'entities', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'properties', version: '2025-01-01T00:00:00Z' },
            { cache_name: 'constraint_messages', version: '2025-01-01T00:00:00Z' }
          ]);
        } else if (req.request.url.includes('rpc/get_dashboards')) {
          req.flush([]);
        }
      });

      const compiled = fixture.nativeElement as HTMLElement;
      // Look for the dropdown menu content
      const menuItems = compiled.querySelectorAll('.menu a');
      const loginLink = Array.from(menuItems).find(link => link.textContent?.includes('Log In'));

      expect(loginLink).toBeTruthy();
    });
  });
});
