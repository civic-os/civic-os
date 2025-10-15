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
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { CommonModule } from '@angular/common';
import { of, throwError, Observable } from 'rxjs';
import { DashboardPage } from './dashboard.page';
import { DashboardService } from '../../services/dashboard.service';
import { WidgetContainerComponent } from '../../components/widget-container/widget-container.component';
import { Dashboard } from '../../interfaces/dashboard';
import { createMockDashboard, MOCK_DASHBOARDS } from '../../testing';

describe('DashboardPage', () => {
  let component: DashboardPage;
  let fixture: ComponentFixture<DashboardPage>;
  let mockDashboardService: jasmine.SpyObj<DashboardService>;
  let mockActivatedRoute: any;

  beforeEach(async () => {
    // Create mock DashboardService
    mockDashboardService = jasmine.createSpyObj('DashboardService', [
      'getDashboard',
      'getDefaultDashboard'
    ]);

    // Set default mock return values to prevent "Cannot read properties of undefined"
    // Individual tests can override these as needed
    mockDashboardService.getDashboard.and.returnValue(of(MOCK_DASHBOARDS.welcome));
    mockDashboardService.getDefaultDashboard.and.returnValue(of(1));

    // Create mock ActivatedRoute with default (no ID)
    mockActivatedRoute = {
      snapshot: {
        paramMap: convertToParamMap({})
      }
    };

    await TestBed.configureTestingModule({
      imports: [DashboardPage, CommonModule, WidgetContainerComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DashboardService, useValue: mockDashboardService },
        { provide: ActivatedRoute, useValue: mockActivatedRoute }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardPage);
    component = fixture.componentInstance;
  });

  describe('Basic Component Setup', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });

    it('should have initial signal values', () => {
      expect(component.dashboard()).toBeUndefined();
      expect(component.widgets()).toEqual([]);
      expect(component.loading()).toBe(true);
      expect(component.error()).toBeUndefined();
    });
  });

  describe('ngOnInit() - Loading Default Dashboard', () => {
    it('should load default dashboard when no ID in route', (done) => {
      const dashboardId = 1;
      const mockDashboard = MOCK_DASHBOARDS.welcome;

      mockDashboardService.getDefaultDashboard.and.returnValue(of(dashboardId));
      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));

      component.ngOnInit();

      setTimeout(() => {
        expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
        expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(dashboardId);
        expect(component.dashboard()).toEqual(mockDashboard);
        expect(component.widgets()).toEqual(mockDashboard.widgets || []);
        expect(component.loading()).toBe(false);
        expect(component.error()).toBeUndefined();
        done();
      }, 10);
    });

    it('should set error when no default dashboard exists', (done) => {
      mockDashboardService.getDefaultDashboard.and.returnValue(of(undefined));

      component.ngOnInit();

      setTimeout(() => {
        expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
        expect(mockDashboardService.getDashboard).not.toHaveBeenCalled();
        expect(component.loading()).toBe(false);
        expect(component.error()).toBe('No default dashboard found. Please contact an administrator.');
        done();
      }, 10);
    });

    it('should handle error loading default dashboard', (done) => {
      spyOn(console, 'error'); // Suppress console error

      mockDashboardService.getDefaultDashboard.and.returnValue(
        throwError(() => new Error('Network error'))
      );

      component.ngOnInit();

      setTimeout(() => {
        expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
        expect(component.loading()).toBe(false);
        expect(component.error()).toBe('Failed to load default dashboard');
        expect(console.error).toHaveBeenCalled();
        done();
      }, 10);
    });
  });

  describe('ngOnInit() - Loading Specific Dashboard', () => {
    beforeEach(() => {
      // Set route param to dashboard ID
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '3' });
    });

    it('should load specific dashboard when ID in route', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.multiWidget;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));

      component.ngOnInit();

      setTimeout(() => {
        expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
        expect(mockDashboardService.getDefaultDashboard).not.toHaveBeenCalled();
        expect(component.dashboard()).toEqual(mockDashboard);
        expect(component.widgets()).toEqual(mockDashboard.widgets || []);
        expect(component.widgets().length).toBe(2);
        expect(component.loading()).toBe(false);
        expect(component.error()).toBeUndefined();
        done();
      }, 10);
    });

    it('should handle dashboard not found (undefined response)', (done) => {
      mockDashboardService.getDashboard.and.returnValue(of(undefined));

      component.ngOnInit();

      setTimeout(() => {
        expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
        expect(component.loading()).toBe(false);
        expect(component.error()).toBe('Dashboard not found');
        expect(component.dashboard()).toBeUndefined();
        done();
      }, 10);
    });

    it('should handle error loading dashboard', (done) => {
      spyOn(console, 'error'); // Suppress console error

      mockDashboardService.getDashboard.and.returnValue(
        throwError(() => new Error('Server error'))
      );

      component.ngOnInit();

      setTimeout(() => {
        expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
        expect(component.loading()).toBe(false);
        expect(component.error()).toBe('Failed to load dashboard');
        expect(console.error).toHaveBeenCalled();
        done();
      }, 10);
    });
  });

  describe('loadDashboard()', () => {
    it('should set loading state before fetching', () => {
      // Use delayed observable to test loading state
      const delayedObservable = new Observable<Dashboard>((observer) => {
        setTimeout(() => {
          observer.next(MOCK_DASHBOARDS.welcome);
          observer.complete();
        }, 50);
      });

      mockDashboardService.getDashboard.and.returnValue(delayedObservable);

      component['loadDashboard'](1);

      // Check immediately - should be in loading state
      expect(component.loading()).toBe(true);
      expect(component.error()).toBeUndefined();
    });

    it('should load dashboard with widgets', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.multiWidget;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));

      component['loadDashboard'](3);

      setTimeout(() => {
        expect(component.dashboard()).toEqual(mockDashboard);
        expect(component.widgets()).toEqual(mockDashboard.widgets || []);
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });

    it('should handle dashboard with no widgets', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.noWidgets;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));

      component['loadDashboard'](4);

      setTimeout(() => {
        expect(component.dashboard()).toEqual(mockDashboard);
        expect(component.widgets()).toEqual([]);
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });

    it('should handle dashboard with undefined widgets array', (done) => {
      const dashboardWithoutWidgets = createMockDashboard({
        id: 5,
        widgets: undefined as any
      });

      mockDashboardService.getDashboard.and.returnValue(of(dashboardWithoutWidgets));

      component['loadDashboard'](5);

      setTimeout(() => {
        expect(component.dashboard()).toEqual(dashboardWithoutWidgets);
        expect(component.widgets()).toEqual([]);
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });
  });

  describe('loadDefaultDashboard()', () => {
    it('should fetch default dashboard ID then load dashboard', (done) => {
      const dashboardId = 1;
      const mockDashboard = MOCK_DASHBOARDS.welcome;

      mockDashboardService.getDefaultDashboard.and.returnValue(of(dashboardId));
      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));

      component['loadDefaultDashboard']();

      setTimeout(() => {
        expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
        expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(dashboardId);
        expect(component.dashboard()).toEqual(mockDashboard);
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });

    it('should handle null default dashboard ID', (done) => {
      mockDashboardService.getDefaultDashboard.and.returnValue(of(undefined));

      component['loadDefaultDashboard']();

      setTimeout(() => {
        expect(component.error()).toBe('No default dashboard found. Please contact an administrator.');
        expect(component.loading()).toBe(false);
        expect(mockDashboardService.getDashboard).not.toHaveBeenCalled();
        done();
      }, 10);
    });
  });

  describe('retry()', () => {
    it('should retry loading default dashboard when no route ID', () => {
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({});
      mockDashboardService.getDefaultDashboard.and.returnValue(of(1));
      mockDashboardService.getDashboard.and.returnValue(of(MOCK_DASHBOARDS.welcome));

      component.retry();

      expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
    });

    it('should retry loading specific dashboard when route ID present', () => {
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '3' });
      mockDashboardService.getDashboard.and.returnValue(of(MOCK_DASHBOARDS.multiWidget));

      component.retry();

      expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
      expect(mockDashboardService.getDefaultDashboard).not.toHaveBeenCalled();
    });

    it('should reset loading state when retrying', () => {
      component.loading.set(false);
      component.error.set('Previous error');

      // Use delayed observable to test loading state
      const delayedObservable = new Observable<Dashboard>((observer) => {
        setTimeout(() => {
          observer.next(MOCK_DASHBOARDS.welcome);
          observer.complete();
        }, 50);
      });

      mockDashboardService.getDashboard.and.returnValue(delayedObservable);
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '1' });

      component.retry();

      // Check immediately - should be in loading state
      expect(component.loading()).toBe(true);
      expect(component.error()).toBeUndefined();
    });
  });

  describe('Template Rendering', () => {
    it('should show loading state initially', () => {
      // Use delayed observable to keep component in loading state
      const delayedObservable = new Observable<number>((observer) => {
        // Never complete to keep component in loading state for this test
        // (don't call observer.next() or observer.complete())
      });

      mockDashboardService.getDefaultDashboard.and.returnValue(delayedObservable);

      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const loadingSpinner = compiled.querySelector('.loading-spinner');
      const loadingText = compiled.textContent;

      expect(loadingSpinner).toBeTruthy();
      expect(loadingText).toContain('Loading dashboard...');
    });

    it('should show error state with retry button', (done) => {
      mockDashboardService.getDashboard.and.returnValue(of(undefined));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '999' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const errorAlert = compiled.querySelector('.alert-error');
        const retryButton = compiled.querySelector('button');

        expect(errorAlert).toBeTruthy();
        expect(compiled.textContent).toContain('Failed to Load Dashboard');
        expect(compiled.textContent).toContain('Dashboard not found');
        expect(retryButton?.textContent).toContain('Retry');
        done();
      }, 10);
    });

    it('should render dashboard header with title and description', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.welcome;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '1' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const header = compiled.querySelector('.dashboard-header h1');
        const description = compiled.querySelector('.dashboard-header p');

        expect(header?.textContent).toContain(mockDashboard.display_name);
        expect(description?.textContent).toContain(mockDashboard.description!);
        done();
      }, 10);
    });

    it('should render widgets grid when widgets exist', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.multiWidget;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '3' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const widgetsGrid = compiled.querySelector('.widgets-grid');
        const widgetCells = compiled.querySelectorAll('.widget-cell');

        expect(widgetsGrid).toBeTruthy();
        expect(widgetCells.length).toBe(2);
        done();
      }, 10);
    });

    it('should apply grid layout styles to widgets', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.multiWidget;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '3' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const firstWidget = compiled.querySelector('.widget-cell') as HTMLElement;

        expect(firstWidget.style.gridColumn).toContain('span');
        expect(firstWidget.style.gridRow).toContain('span');
        done();
      }, 10);
    });

    it('should show empty state when dashboard has no widgets', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.noWidgets;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '4' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const emptyState = compiled.querySelector('.empty-state');
        const widgetsGrid = compiled.querySelector('.widgets-grid');

        expect(emptyState).toBeTruthy();
        expect(widgetsGrid).toBeNull();
        expect(compiled.textContent).toContain('No Widgets');
        expect(compiled.textContent).toContain("This dashboard doesn't have any widgets yet");
        done();
      }, 10);
    });

    it('should not render loading or error when dashboard loaded', (done) => {
      const mockDashboard = MOCK_DASHBOARDS.welcome;

      mockDashboardService.getDashboard.and.returnValue(of(mockDashboard));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '1' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const loading = compiled.querySelector('.loading-container');
        const error = compiled.querySelector('.error-container');
        const dashboard = compiled.querySelector('.dashboard-container');

        expect(loading).toBeNull();
        expect(error).toBeNull();
        expect(dashboard).toBeTruthy();
        done();
      }, 10);
    });

    it('should call retry when retry button clicked', (done) => {
      spyOn(component, 'retry');
      mockDashboardService.getDashboard.and.returnValue(of(undefined));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '999' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const retryButton = compiled.querySelector('button') as HTMLButtonElement;

        retryButton.click();

        expect(component.retry).toHaveBeenCalled();
        done();
      }, 10);
    });
  });

  describe('Pre-configured Mock Dashboards', () => {
    it('should render MOCK_DASHBOARDS.welcome correctly', (done) => {
      mockDashboardService.getDashboard.and.returnValue(of(MOCK_DASHBOARDS.welcome));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '1' });

      component.ngOnInit();

      setTimeout(() => {
        expect(component.dashboard()?.display_name).toBe('Welcome');
        expect(component.widgets().length).toBe(1);
        expect(component.dashboard()?.is_default).toBe(true);
        done();
      }, 10);
    });

    it('should render MOCK_DASHBOARDS.userPrivate correctly', (done) => {
      mockDashboardService.getDashboard.and.returnValue(of(MOCK_DASHBOARDS.userPrivate));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '2' });

      component.ngOnInit();

      setTimeout(() => {
        expect(component.dashboard()?.display_name).toBe('My Dashboard');
        expect(component.dashboard()?.is_public).toBe(false);
        expect(component.widgets().length).toBe(0);
        done();
      }, 10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle dashboard with description as null', (done) => {
      const dashboardNoDesc = createMockDashboard({
        display_name: 'Test Dashboard',
        description: null as any
      });

      mockDashboardService.getDashboard.and.returnValue(of(dashboardNoDesc));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '1' });

      component.ngOnInit();

      setTimeout(() => {
        fixture.detectChanges();

        const compiled = fixture.nativeElement as HTMLElement;
        const header = compiled.querySelector('.dashboard-header');
        const description = header?.querySelector('p');

        expect(header).toBeTruthy();
        expect(description).toBeNull(); // No description paragraph rendered
        done();
      }, 10);
    });

    it('should handle rapid retry attempts', () => {
      mockDashboardService.getDashboard.and.returnValue(of(MOCK_DASHBOARDS.welcome));
      mockActivatedRoute.snapshot.paramMap = convertToParamMap({ id: '1' });

      component.retry();
      component.retry();
      component.retry();

      expect(mockDashboardService.getDashboard).toHaveBeenCalledTimes(3);
    });
  });
});
