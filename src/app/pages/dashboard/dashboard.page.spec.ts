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
import { of, throwError, Observable, BehaviorSubject } from 'rxjs';
import { DashboardPage } from './dashboard.page';
import { DashboardService } from '../../services/dashboard.service';
import { WidgetContainerComponent } from '../../components/widget-container/widget-container.component';
import { Dashboard } from '../../interfaces/dashboard';
import { createMockDashboard, MOCK_DASHBOARDS } from '../../testing';

describe('DashboardPage', () => {
    let component: DashboardPage;
    let fixture: ComponentFixture<DashboardPage>;
    let mockDashboardService: any;
    let paramMapSubject: BehaviorSubject<any>;

    beforeEach(async () => {
        // Create mock DashboardService
        mockDashboardService = {
            getDashboard: vi.fn().mockName("DashboardService.getDashboard"),
            getDefaultDashboard: vi.fn().mockName("DashboardService.getDefaultDashboard")
        };

        // Set default mock return values to prevent "Cannot read properties of undefined"
        // Individual tests can override these as needed
        mockDashboardService.getDashboard.mockReturnValue(of(MOCK_DASHBOARDS.welcome));
        mockDashboardService.getDefaultDashboard.mockReturnValue(of(1));

        // Create BehaviorSubject for paramMap to simulate route changes
        // Component subscribes to paramMap observable in constructor
        paramMapSubject = new BehaviorSubject(convertToParamMap({}));

        await TestBed.configureTestingModule({
            imports: [DashboardPage, CommonModule, WidgetContainerComponent],
            providers: [
                provideZonelessChangeDetection(),
                { provide: DashboardService, useValue: mockDashboardService },
                { provide: ActivatedRoute, useValue: { paramMap: paramMapSubject.asObservable() } }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(DashboardPage);
        component = fixture.componentInstance;
    });

    describe('Basic Component Setup', () => {
        it('should create', () => {
            expect(component).toBeTruthy();
        });

        it('should have initial signal values when loading', () => {
            // Use a never-emitting observable to keep component in loading state
            const neverEmitting = new Observable<number>(() => {
                // Never emit to keep component in initial loading state
            });

            mockDashboardService.getDefaultDashboard.mockReturnValue(neverEmitting);

            // Re-create component with never-emitting observable
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            // Now we can check initial values while component is waiting for data
            expect(component.dashboard()).toBeUndefined();
            expect(component.widgets()).toEqual([]);
            expect(component.loading()).toBe(true);
            expect(component.error()).toBeUndefined();
        });
    });

    describe('Constructor Initialization - Loading Default Dashboard', () => {
        it('should load default dashboard when no ID in route', async () => {
            const dashboardId = 1;
            const mockDashboard = MOCK_DASHBOARDS.welcome;

            mockDashboardService.getDefaultDashboard.mockReturnValue(of(dashboardId));
            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Reset spy call counts and paramMap before re-creating component
            mockDashboardService.getDefaultDashboard.mockClear();
            mockDashboardService.getDashboard.mockClear();
            paramMapSubject.next(convertToParamMap({})); // Ensure no ID in route

            // Re-create component to pick up new mocks (constructor initializes on creation)
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
                expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(dashboardId);
                expect(component.dashboard()).toEqual(mockDashboard);
                expect(component.widgets()).toEqual(mockDashboard.widgets || []);
                expect(component.loading()).toBe(false);
                expect(component.error()).toBeUndefined();
                ;
            }, 10);
        });

        it('should set error when no default dashboard exists', async () => {
            mockDashboardService.getDefaultDashboard.mockReturnValue(of(undefined));

            // Reset spy call counts before re-creating component
            mockDashboardService.getDefaultDashboard.mockClear();
            mockDashboardService.getDashboard.mockClear();

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
                expect(mockDashboardService.getDashboard).not.toHaveBeenCalled();
                expect(component.loading()).toBe(false);
                expect(component.error()).toBe('No default dashboard found. Please contact an administrator.');
                ;
            }, 10);
        });

        it('should handle error loading default dashboard', async () => {
            vi.spyOn(console, 'error').mockReturnValue(undefined); // Suppress console error

            mockDashboardService.getDefaultDashboard.mockReturnValue(throwError(() => new Error('Network error')));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
                expect(component.loading()).toBe(false);
                expect(component.error()).toBe('Failed to load default dashboard');
                expect(console.error).toHaveBeenCalled();
                ;
            }, 10);
        });
    });

    describe('Constructor Initialization - Loading Specific Dashboard', () => {
        it('should load specific dashboard when ID in route', async () => {
            const mockDashboard = MOCK_DASHBOARDS.multiWidget;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Reset spy call counts before re-creating component
            mockDashboardService.getDefaultDashboard.mockClear();
            mockDashboardService.getDashboard.mockClear();

            // Emit route params with dashboard ID before creating component
            paramMapSubject.next(convertToParamMap({ id: '3' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
                expect(mockDashboardService.getDefaultDashboard).not.toHaveBeenCalled();
                expect(component.dashboard()).toEqual(mockDashboard);
                expect(component.widgets()).toEqual(mockDashboard.widgets || []);
                expect(component.widgets().length).toBe(2);
                expect(component.loading()).toBe(false);
                expect(component.error()).toBeUndefined();
                ;
            }, 10);
        });

        it('should handle dashboard not found (undefined response)', async () => {
            mockDashboardService.getDashboard.mockReturnValue(of(undefined));

            // Reset spy call counts before re-creating component
            mockDashboardService.getDashboard.mockClear();

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '3' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
                expect(component.loading()).toBe(false);
                expect(component.error()).toBe('Dashboard not found');
                expect(component.dashboard()).toBeUndefined();
                ;
            }, 10);
        });

        it('should handle error loading dashboard', async () => {
            vi.spyOn(console, 'error').mockReturnValue(undefined); // Suppress console error

            mockDashboardService.getDashboard.mockReturnValue(throwError(() => new Error('Server error')));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '3' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
                expect(component.loading()).toBe(false);
                expect(component.error()).toBe('Failed to load dashboard');
                expect(console.error).toHaveBeenCalled();
                ;
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

            mockDashboardService.getDashboard.mockReturnValue(delayedObservable);

            component['loadDashboard'](1);

            // Check immediately - should be in loading state
            expect(component.loading()).toBe(true);
            expect(component.error()).toBeUndefined();
        });

        it('should load dashboard with widgets', async () => {
            const mockDashboard = MOCK_DASHBOARDS.multiWidget;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            component['loadDashboard'](3);

            setTimeout(() => {
                expect(component.dashboard()).toEqual(mockDashboard);
                expect(component.widgets()).toEqual(mockDashboard.widgets || []);
                expect(component.loading()).toBe(false);
                ;
            }, 10);
        });

        it('should handle dashboard with no widgets', async () => {
            const mockDashboard = MOCK_DASHBOARDS.noWidgets;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            component['loadDashboard'](4);

            setTimeout(() => {
                expect(component.dashboard()).toEqual(mockDashboard);
                expect(component.widgets()).toEqual([]);
                expect(component.loading()).toBe(false);
                ;
            }, 10);
        });

        it('should handle dashboard with undefined widgets array', async () => {
            const dashboardWithoutWidgets = createMockDashboard({
                id: 5,
                widgets: undefined as any
            });

            mockDashboardService.getDashboard.mockReturnValue(of(dashboardWithoutWidgets));

            component['loadDashboard'](5);

            setTimeout(() => {
                expect(component.dashboard()).toEqual(dashboardWithoutWidgets);
                expect(component.widgets()).toEqual([]);
                expect(component.loading()).toBe(false);
                ;
            }, 10);
        });
    });

    describe('loadDefaultDashboard()', () => {
        it('should fetch default dashboard ID then load dashboard', async () => {
            const dashboardId = 1;
            const mockDashboard = MOCK_DASHBOARDS.welcome;

            mockDashboardService.getDefaultDashboard.mockReturnValue(of(dashboardId));
            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Reset spy call counts before testing this method
            mockDashboardService.getDefaultDashboard.mockClear();
            mockDashboardService.getDashboard.mockClear();

            component['loadDefaultDashboard']();

            setTimeout(() => {
                expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
                expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(dashboardId);
                expect(component.dashboard()).toEqual(mockDashboard);
                expect(component.loading()).toBe(false);
                ;
            }, 10);
        });

        it('should handle null default dashboard ID', async () => {
            mockDashboardService.getDefaultDashboard.mockReturnValue(of(undefined));

            // Reset spy call counts before testing this method
            mockDashboardService.getDefaultDashboard.mockClear();
            mockDashboardService.getDashboard.mockClear();

            component['loadDefaultDashboard']();

            setTimeout(() => {
                expect(component.error()).toBe('No default dashboard found. Please contact an administrator.');
                expect(component.loading()).toBe(false);
                expect(mockDashboardService.getDashboard).not.toHaveBeenCalled();
                ;
            }, 10);
        });
    });

    describe('retry()', () => {
        it('should retry loading default dashboard when no current dashboard', () => {
            mockDashboardService.getDefaultDashboard.mockReturnValue(of(1));
            mockDashboardService.getDashboard.mockReturnValue(of(MOCK_DASHBOARDS.welcome));

            // Ensure no current dashboard is set
            component.dashboard.set(undefined);

            // Reset spy call counts before testing retry
            mockDashboardService.getDefaultDashboard.mockClear();

            component.retry();

            expect(mockDashboardService.getDefaultDashboard).toHaveBeenCalled();
        });

        it('should retry loading specific dashboard when current dashboard exists', async () => {
            mockDashboardService.getDashboard.mockReturnValue(of(MOCK_DASHBOARDS.multiWidget));

            // Set a current dashboard first
            component.dashboard.set(MOCK_DASHBOARDS.multiWidget);

            // Reset spy call counts before testing retry
            mockDashboardService.getDashboard.mockClear();

            component.retry();

            setTimeout(() => {
                expect(mockDashboardService.getDashboard).toHaveBeenCalledWith(3);
                ;
            }, 10);
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

            mockDashboardService.getDashboard.mockReturnValue(delayedObservable);

            // Set a current dashboard so retry() will call loadDashboard()
            component.dashboard.set(MOCK_DASHBOARDS.welcome);

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

            mockDashboardService.getDefaultDashboard.mockReturnValue(delayedObservable);

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const loadingSpinner = compiled.querySelector('.loading-spinner');
            const loadingText = compiled.textContent;

            expect(loadingSpinner).toBeTruthy();
            expect(loadingText).toContain('Loading dashboard...');
        });

        it('should show error state with retry button', async () => {
            mockDashboardService.getDashboard.mockReturnValue(of(undefined));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '999' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const errorAlert = compiled.querySelector('.alert-error');
                const retryButton = compiled.querySelector('button');

                expect(errorAlert).toBeTruthy();
                expect(compiled.textContent).toContain('Failed to Load Dashboard');
                expect(compiled.textContent).toContain('Dashboard not found');
                expect(retryButton?.textContent).toContain('Retry');
                ;
            }, 10);
        });

        it('should render dashboard header with title and description', async () => {
            const mockDashboard = MOCK_DASHBOARDS.welcome;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '1' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const header = compiled.querySelector('.dashboard-header h1');
                const description = compiled.querySelector('.dashboard-header p');

                expect(header?.textContent).toContain(mockDashboard.display_name);
                expect(description?.textContent).toContain(mockDashboard.description!);
                ;
            }, 10);
        });

        it('should render widgets grid when widgets exist', async () => {
            const mockDashboard = MOCK_DASHBOARDS.multiWidget;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '3' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const widgetsGrid = compiled.querySelector('.widgets-grid');
                const widgetCells = compiled.querySelectorAll('.widget-cell');

                expect(widgetsGrid).toBeTruthy();
                expect(widgetCells.length).toBe(2);
                ;
            }, 10);
        });

        it('should apply grid layout styles to widgets', async () => {
            const mockDashboard = MOCK_DASHBOARDS.multiWidget;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '3' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const firstWidget = compiled.querySelector('.widget-cell') as HTMLElement;

                expect(firstWidget.style.gridColumn).toContain('span');
                expect(firstWidget.style.gridRow).toContain('span');
                ;
            }, 10);
        });

        it('should show empty state when dashboard has no widgets', async () => {
            const mockDashboard = MOCK_DASHBOARDS.noWidgets;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '4' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const emptyState = compiled.querySelector('.empty-state');
                const widgetsGrid = compiled.querySelector('.widgets-grid');

                expect(emptyState).toBeTruthy();
                expect(widgetsGrid).toBeNull();
                expect(compiled.textContent).toContain('No Widgets');
                expect(compiled.textContent).toContain("This dashboard doesn't have any widgets yet");
                ;
            }, 10);
        });

        it('should not render loading or error when dashboard loaded', async () => {
            const mockDashboard = MOCK_DASHBOARDS.welcome;

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '1' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const loading = compiled.querySelector('.loading-container');
                const error = compiled.querySelector('.error-container');
                const dashboard = compiled.querySelector('.dashboard-container');

                expect(loading).toBeNull();
                expect(error).toBeNull();
                expect(dashboard).toBeTruthy();
                ;
            }, 10);
        });

        it('should call retry when retry button clicked', async () => {
            mockDashboardService.getDashboard.mockReturnValue(of(undefined));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '999' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;
            vi.spyOn(component, 'retry').mockReturnValue(undefined);

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const retryButton = compiled.querySelector('button') as HTMLButtonElement;

                retryButton.click();

                expect(component.retry).toHaveBeenCalled();
                ;
            }, 10);
        });
    });

    describe('Pre-configured Mock Dashboards', () => {
        it('should render MOCK_DASHBOARDS.welcome correctly', async () => {
            mockDashboardService.getDashboard.mockReturnValue(of(MOCK_DASHBOARDS.welcome));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '1' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(component.dashboard()?.display_name).toBe('Welcome');
                expect(component.widgets().length).toBe(1);
                expect(component.dashboard()?.is_default).toBe(true);
                ;
            }, 10);
        });

        it('should render MOCK_DASHBOARDS.userPrivate correctly', async () => {
            mockDashboardService.getDashboard.mockReturnValue(of(MOCK_DASHBOARDS.userPrivate));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '2' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                expect(component.dashboard()?.display_name).toBe('My Dashboard');
                expect(component.dashboard()?.is_public).toBe(false);
                expect(component.widgets().length).toBe(0);
                ;
            }, 10);
        });
    });

    describe('Edge Cases', () => {
        it('should hide dashboard header when show_title is false', async () => {
            const mockDashboard = createMockDashboard({
                id: 1,
                display_name: 'Hidden Title Dashboard',
                description: 'Should not be visible',
                show_title: false,
                widgets: [
                    {
                        id: 1, dashboard_id: 1, widget_type: 'markdown', title: 'Widget',
                        entity_key: null, refresh_interval_seconds: null, sort_order: 0,
                        width: 2, height: 1, config: { content: 'Test' },
                        created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z'
                    }
                ]
            });

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            paramMapSubject.next(convertToParamMap({ id: '1' }));

            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const header = compiled.querySelector('.dashboard-header');

                expect(header).toBeNull();
                // Widgets should still render
                expect(compiled.querySelector('.widgets-grid')).toBeTruthy();
                ;
            }, 10);
        });

        it('should show dashboard header when show_title is true', async () => {
            const mockDashboard = createMockDashboard({
                id: 1,
                display_name: 'Visible Title Dashboard',
                show_title: true,
                widgets: []
            });

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            paramMapSubject.next(convertToParamMap({ id: '1' }));

            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const header = compiled.querySelector('.dashboard-header');

                expect(header).toBeTruthy();
                expect(header?.textContent).toContain('Visible Title Dashboard');
                ;
            }, 10);
        });

        it('should show dashboard header when show_title is undefined (default)', async () => {
            const mockDashboard = createMockDashboard({
                id: 1,
                display_name: 'Default Title Dashboard',
                // show_title not set — should default to showing
                widgets: []
            });

            mockDashboardService.getDashboard.mockReturnValue(of(mockDashboard));

            paramMapSubject.next(convertToParamMap({ id: '1' }));

            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const header = compiled.querySelector('.dashboard-header');

                expect(header).toBeTruthy();
                expect(header?.textContent).toContain('Default Title Dashboard');
                ;
            }, 10);
        });

        it('should handle dashboard with description as null', async () => {
            const dashboardNoDesc = createMockDashboard({
                display_name: 'Test Dashboard',
                description: null as any
            });

            mockDashboardService.getDashboard.mockReturnValue(of(dashboardNoDesc));

            // Emit route params with dashboard ID
            paramMapSubject.next(convertToParamMap({ id: '1' }));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardPage);
            component = fixture.componentInstance;

            setTimeout(() => {
                fixture.detectChanges();

                const compiled = fixture.nativeElement as HTMLElement;
                const header = compiled.querySelector('.dashboard-header');
                const description = header?.querySelector('p');

                expect(header).toBeTruthy();
                expect(description).toBeNull(); // No description paragraph rendered
                ;
            }, 10);
        });

        it('should handle rapid retry attempts', () => {
            mockDashboardService.getDashboard.mockReturnValue(of(MOCK_DASHBOARDS.welcome));

            // Set a current dashboard so retry() will call loadDashboard()
            component.dashboard.set(MOCK_DASHBOARDS.welcome);

            // Reset spy call counts before testing retry
            mockDashboardService.getDashboard.mockClear();

            component.retry();
            component.retry();
            component.retry();

            expect(mockDashboardService.getDashboard).toHaveBeenCalledTimes(3);
        });
    });
});
