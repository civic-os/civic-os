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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Router, ActivatedRoute, convertToParamMap } from '@angular/router';
import { CommonModule } from '@angular/common';
import { of, throwError, Observable, BehaviorSubject } from 'rxjs';
import { DashboardSelectorComponent } from './dashboard-selector.component';
import { DashboardService } from '../../services/dashboard.service';
import { Dashboard } from '../../interfaces/dashboard';
import { MOCK_DASHBOARDS } from '../../testing';

describe('DashboardSelectorComponent', () => {
  let component: DashboardSelectorComponent;
  let fixture: ComponentFixture<DashboardSelectorComponent>;
  let mockDashboardService: jasmine.SpyObj<DashboardService>;
  let mockRouter: jasmine.SpyObj<Router>;
  let paramMapSubject: BehaviorSubject<any>;

  beforeEach(async () => {
    // Create mock services
    mockDashboardService = jasmine.createSpyObj('DashboardService', ['getDashboards']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);

    // Set default mock return values to prevent "Cannot read properties of undefined"
    // Individual tests can override these as needed
    mockDashboardService.getDashboards.and.returnValue(of([]));

    // Create BehaviorSubject for paramMap to simulate route changes
    // Component subscribes to paramMap observable in constructor
    paramMapSubject = new BehaviorSubject(convertToParamMap({}));

    await TestBed.configureTestingModule({
      imports: [DashboardSelectorComponent, CommonModule],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DashboardService, useValue: mockDashboardService },
        { provide: Router, useValue: mockRouter },
        { provide: ActivatedRoute, useValue: { paramMap: paramMapSubject.asObservable() } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardSelectorComponent);
    component = fixture.componentInstance;
  });

  describe('Basic Component Setup', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });

    it('should have initial signal values when loading', () => {
      // Use a never-emitting observable to keep component in loading state
      const neverEmitting = new Observable<Dashboard[]>(() => {
        // Never emit to keep component in initial loading state
      });

      mockDashboardService.getDashboards.and.returnValue(neverEmitting);

      // Re-create component with never-emitting observable
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      // Now we can check initial values while component is waiting for data
      expect(component.dashboards()).toEqual([]);
      expect(component.currentDashboardId()).toBeUndefined();
      expect(component.loading()).toBe(true);
    });
  });

  describe('Constructor Initialization', () => {
    it('should load dashboards on init', (done) => {
      const mockDashboards: Dashboard[] = [
        MOCK_DASHBOARDS.welcome,
        MOCK_DASHBOARDS.userPrivate
      ];

      mockDashboardService.getDashboards.and.returnValue(of(mockDashboards));

      // Reset spy call counts before re-creating component
      mockDashboardService.getDashboards.calls.reset();

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(mockDashboardService.getDashboards).toHaveBeenCalled();
        expect(component.dashboards()).toEqual(mockDashboards);
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });

    it('should handle error loading dashboards', (done) => {
      spyOn(console, 'error'); // Suppress console error

      mockDashboardService.getDashboards.and.returnValue(
        throwError(() => new Error('Network error'))
      );

      // Re-create component to trigger constructor with error
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        expect(mockDashboardService.getDashboards).toHaveBeenCalled();
        expect(component.dashboards()).toEqual([]);
        expect(component.loading()).toBe(false);
        expect(console.error).toHaveBeenCalled();
        done();
      }, 10);
    });

    it('should update current dashboard ID from route params', () => {
      // Emit new param map with dashboard ID
      paramMapSubject.next(convertToParamMap({ id: '3' }));

      expect(component.currentDashboardId()).toBe(3);
    });

    it('should set current dashboard ID to undefined when no route param', () => {
      // Emit param map without ID
      paramMapSubject.next(convertToParamMap({}));

      expect(component.currentDashboardId()).toBeUndefined();
    });
  });

  describe('loadDashboards()', () => {
    it('should set loading state before fetching', (done) => {
      component.loading.set(false);

      // Use a delayed observable so we can check loading state before it completes
      const delayedObservable = new Observable<Dashboard[]>(observer => {
        setTimeout(() => {
          observer.next([]);
          observer.complete();
        }, 50);
      });

      mockDashboardService.getDashboards.and.returnValue(delayedObservable);

      component['loadDashboards']();

      // Check immediately - loading should be true
      expect(component.loading()).toBe(true);

      // Clean up after test
      setTimeout(() => {
        done();
      }, 100);
    });

    it('should populate dashboards signal on success', (done) => {
      const mockDashboards: Dashboard[] = [
        MOCK_DASHBOARDS.welcome,
        MOCK_DASHBOARDS.multiWidget,
        MOCK_DASHBOARDS.noWidgets
      ];

      mockDashboardService.getDashboards.and.returnValue(of(mockDashboards));

      component['loadDashboards']();

      setTimeout(() => {
        expect(component.dashboards()).toEqual(mockDashboards);
        expect(component.dashboards().length).toBe(3);
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });

    it('should handle empty dashboards array', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([]));

      component['loadDashboards']();

      setTimeout(() => {
        expect(component.dashboards()).toEqual([]);
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });
  });

  describe('Route Parameter Handling', () => {
    it('should set current dashboard ID from route param', () => {
      // Emit route params with dashboard ID
      paramMapSubject.next(convertToParamMap({ id: '5' }));

      expect(component.currentDashboardId()).toBe(5);
    });

    it('should set undefined when no route param', () => {
      // Emit route params without ID
      paramMapSubject.next(convertToParamMap({}));

      expect(component.currentDashboardId()).toBeUndefined();
    });

    it('should parse string ID to integer', () => {
      // Emit route params with string ID
      paramMapSubject.next(convertToParamMap({ id: '42' }));

      expect(component.currentDashboardId()).toBe(42);
    });
  });

  describe('selectDashboard()', () => {
    it('should update current dashboard ID', () => {
      component.selectDashboard(5);

      expect(component.currentDashboardId()).toBe(5);
    });

    it('should navigate to dashboard route', () => {
      component.selectDashboard(3);

      expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard', 3]);
    });

    it('should handle multiple dashboard selections', () => {
      component.selectDashboard(1);
      expect(component.currentDashboardId()).toBe(1);
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard', 1]);

      component.selectDashboard(2);
      expect(component.currentDashboardId()).toBe(2);
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard', 2]);
    });
  });

  describe('selectDefaultDashboard()', () => {
    it('should set current dashboard ID to undefined', () => {
      component.currentDashboardId.set(5);

      component.selectDefaultDashboard();

      expect(component.currentDashboardId()).toBeUndefined();
    });

    it('should navigate to home route', () => {
      component.selectDefaultDashboard();

      expect(mockRouter.navigate).toHaveBeenCalledWith(['/']);
    });

    it('should clear previous dashboard selection', () => {
      component.currentDashboardId.set(3);

      component.selectDefaultDashboard();

      expect(component.currentDashboardId()).toBeUndefined();
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/']);
    });
  });

  describe('getCurrentDashboardName()', () => {
    beforeEach(() => {
      const mockDashboards: Dashboard[] = [
        MOCK_DASHBOARDS.welcome,
        MOCK_DASHBOARDS.userPrivate,
        MOCK_DASHBOARDS.multiWidget
      ];
      component.dashboards.set(mockDashboards);
    });

    it('should return "Default Dashboard" when current ID is undefined', () => {
      component.currentDashboardId.set(undefined);

      expect(component.getCurrentDashboardName()).toBe('Default Dashboard');
    });

    it('should return dashboard display name when ID matches', () => {
      component.currentDashboardId.set(1);

      expect(component.getCurrentDashboardName()).toBe('Welcome');
    });

    it('should return correct name for different dashboards', () => {
      component.currentDashboardId.set(2);
      expect(component.getCurrentDashboardName()).toBe('My Dashboard');

      component.currentDashboardId.set(3);
      expect(component.getCurrentDashboardName()).toBe('Multi-Widget Dashboard');
    });

    it('should return "Dashboard" when ID not found in list', () => {
      component.currentDashboardId.set(999);

      expect(component.getCurrentDashboardName()).toBe('Dashboard');
    });

    it('should handle empty dashboards array', () => {
      component.dashboards.set([]);
      component.currentDashboardId.set(1);

      expect(component.getCurrentDashboardName()).toBe('Dashboard');
    });
  });

  describe('Template Rendering', () => {
    beforeEach(() => {
      // Ensure getDashboards is mocked for all template tests
      if (!mockDashboardService.getDashboards.calls) {
        mockDashboardService.getDashboards.and.returnValue(of([]));
      }
    });

    it('should render dropdown button with dashboard icon', () => {
      mockDashboardService.getDashboards.and.returnValue(of([]));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const dropdownButton = compiled.querySelector('.dropdown button, .dropdown div[role="button"]');
      const icon = dropdownButton?.querySelector('.material-symbols-outlined');

      expect(dropdownButton).toBeTruthy();
      expect(icon?.textContent).toContain('dashboard');
    });

    it('should display current dashboard name in button', () => {
      component.dashboards.set([MOCK_DASHBOARDS.welcome]);
      component.currentDashboardId.set(1);
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome]));

      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.textContent).toContain('Welcome');
    });

    it('should show loading state in dropdown', (done) => {
      // Don't let the HTTP request complete - keep loading state
      let resolveRequest: Function;
      const delayedObservable = new Observable<Dashboard[]>(observer => {
        resolveRequest = () => {
          observer.next([]);
          observer.complete();
        };
      });

      mockDashboardService.getDashboards.and.returnValue(delayedObservable);

      // Re-create component to pick up the delayed observable
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();

      // Give it a moment to start loading
      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const loadingSpinner = compiled.querySelector('.loading-spinner');

        expect(loadingSpinner).toBeTruthy();
        expect(compiled.textContent).toContain('Loading dashboards...');
        done();
      }, 10);
    });

    it('should render dashboard list when loaded', (done) => {
      const mockDashboards: Dashboard[] = [
        MOCK_DASHBOARDS.welcome,
        MOCK_DASHBOARDS.userPrivate,
        MOCK_DASHBOARDS.multiWidget
      ];

      mockDashboardService.getDashboards.and.returnValue(of(mockDashboards));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const menuItems = compiled.querySelectorAll('.dropdown-content li a');

        // +1 for "Default Dashboard" item
        expect(menuItems.length).toBe(mockDashboards.length + 1);
        done();
      }, 10);
    });

    it('should render default dashboard option', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const defaultOption = Array.from(compiled.querySelectorAll('.dropdown-content li a'))
          .find(el => el.textContent?.includes('Default Dashboard'));

        expect(defaultOption).toBeTruthy();
        done();
      }, 10);
    });

    it('should highlight current dashboard with checkmark', (done) => {
      component.dashboards.set([MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.multiWidget]);
      component.currentDashboardId.set(1);

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const activeItems = compiled.querySelectorAll('.dropdown-content li a.menu-active');

        expect(activeItems.length).toBeGreaterThan(0);
        done();
      }, 10);
    });

    it('should show public/private icon for dashboards', (done) => {
      const dashboards = [MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.userPrivate];
      mockDashboardService.getDashboards.and.returnValue(of(dashboards));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const menuItems = compiled.querySelectorAll('.dropdown-content li a');

        // Check for public icon (skip first item which is "Default Dashboard")
        const publicItem = menuItems[1]; // First actual dashboard
        expect(publicItem.textContent).toContain('public');

        // Check for private icon
        const privateItem = menuItems[2]; // Second actual dashboard
        expect(privateItem.textContent).toContain('lock');
        done();
      }, 10);
    });

    it('should show dashboard description when present', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        expect(compiled.textContent).toContain('Welcome to Civic OS');
        done();
      }, 10);
    });

    it('should trigger selectDashboard when clicking dashboard item', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;
      spyOn(component, 'selectDashboard');

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const dashboardItems = compiled.querySelectorAll('.dropdown-content li a');
        const firstDashboard = dashboardItems[1] as HTMLElement; // Skip "Default Dashboard"

        firstDashboard.click();

        expect(component.selectDashboard).toHaveBeenCalledWith(1);
        done();
      }, 10);
    });

    it('should trigger selectDefaultDashboard when clicking default option', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;
      spyOn(component, 'selectDefaultDashboard');

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const defaultOption = Array.from(compiled.querySelectorAll('.dropdown-content li a'))
          .find(el => el.textContent?.includes('Default Dashboard')) as HTMLElement;

        defaultOption?.click();

        expect(component.selectDefaultDashboard).toHaveBeenCalled();
        done();
      }, 10);
    });
  });

  describe('Change Detection with OnPush', () => {
    it('should update view when dashboards signal changes', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        let menuItems = compiled.querySelectorAll('.dropdown-content li a');
        expect(menuItems.length).toBe(2); // Default + 1 dashboard

        // Update dashboards
        component.dashboards.set([MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.userPrivate]);
        fixture.detectChanges();

        menuItems = compiled.querySelectorAll('.dropdown-content li a');
        expect(menuItems.length).toBe(3); // Default + 2 dashboards
        done();
      }, 10);
    });

    it('should update button text when current dashboard changes', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.multiWidget]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        component.currentDashboardId.set(1);
        fixture.detectChanges();
        expect(component.getCurrentDashboardName()).toBe('Welcome');

        component.currentDashboardId.set(3);
        fixture.detectChanges();
        expect(component.getCurrentDashboardName()).toBe('Multi-Widget Dashboard');
        done();
      }, 10);
    });
  });

  describe('Pre-configured Mock Dashboards', () => {
    it('should display MOCK_DASHBOARDS.welcome correctly', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.welcome]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        expect(component.dashboards()[0].display_name).toBe('Welcome');
        expect(component.dashboards()[0].is_default).toBe(true);
        expect(component.dashboards()[0].is_public).toBe(true);
        done();
      }, 10);
    });

    it('should display MOCK_DASHBOARDS.userPrivate correctly', (done) => {
      mockDashboardService.getDashboards.and.returnValue(of([MOCK_DASHBOARDS.userPrivate]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        expect(component.dashboards()[0].display_name).toBe('My Dashboard');
        expect(component.dashboards()[0].is_public).toBe(false);
        done();
      }, 10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle dashboards with null description', (done) => {
      const dashboardNoDesc = { ...MOCK_DASHBOARDS.welcome, description: null };
      mockDashboardService.getDashboards.and.returnValue(of([dashboardNoDesc]));

      // Re-create component to pick up new mock
      fixture = TestBed.createComponent(DashboardSelectorComponent);
      component = fixture.componentInstance;

      setTimeout(() => {
        fixture.detectChanges();
        // Should not throw error rendering description
        expect(fixture.nativeElement).toBeTruthy();
        done();
      }, 10);
    });

    it('should handle rapid dashboard selections', () => {
      component.selectDashboard(1);
      component.selectDashboard(2);
      component.selectDashboard(3);
      component.selectDefaultDashboard();

      expect(mockRouter.navigate).toHaveBeenCalledTimes(4);
      expect(component.currentDashboardId()).toBeUndefined();
    });

    it('should not break when selecting dashboard with ID 0', () => {
      component.selectDashboard(0);

      expect(component.currentDashboardId()).toBe(0);
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard', 0]);
    });
  });
});
