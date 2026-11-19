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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { Router, NavigationEnd, convertToParamMap } from '@angular/router';
import { CommonModule } from '@angular/common';
import { of, throwError, Observable, Subject, tap } from 'rxjs';
import { DashboardSelectorComponent } from './dashboard-selector.component';
import { DashboardService } from '../../services/dashboard.service';
import { Dashboard } from '../../interfaces/dashboard';
import { MOCK_DASHBOARDS } from '../../testing';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';
import { TranslationService } from '../../services/translation.service';
import { EN_TRANSLATIONS } from '../../i18n/en.translations';

describe('DashboardSelectorComponent', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: DashboardSelectorComponent;
    let fixture: ComponentFixture<DashboardSelectorComponent>;
    let mockDashboardService: any;
    let mockRouter: any;
    // The service's dashboards signal, which the selector reads
    let dashboardsSignal: ReturnType<typeof signal<Dashboard[] | undefined>>;
    // Like the real service: a fetch that lands fills the signal
    const givenDashboards = (source: Observable<Dashboard[]>) =>
        mockDashboardService.getDashboards.mockReturnValue(source.pipe(tap(d => dashboardsSignal.set(d))));
    let routerEvents: Subject<unknown>;
    // Like the real router: the navbar reads the deepest route of the router state after a navigation
    const setRoute = (path: string, params: Record<string, string> = {}) => {
        const leaf = { routeConfig: { path }, paramMap: convertToParamMap(params), firstChild: null };
        mockRouter.routerState = { snapshot: { root: { routeConfig: null, paramMap: convertToParamMap({}), firstChild: leaf } } };
        routerEvents.next(new NavigationEnd(1, '/', '/'));
    };
    const goToDashboard = (id?: string) => (id === undefined ? setRoute('') : setRoute('dashboard/:id', { id }));
    // Like the real TranslationService: the locale's text, else the bundled English, else the key.
    // Switching the locale bumps the version, as a translation load does.
    const SPANISH: Record<string, string> = {
        'a11y.select_dashboard': 'Seleccionar tablero',
        'dashboard.default': 'Tablero Predeterminado',
        'dashboard.all': 'Todos los tableros',
        'dashboard.loading_list': 'Cargando tableros...',
        'dashboard.unnamed': 'Tablero'
    };
    let locale: ReturnType<typeof signal<string>>;
    let translationVersion: ReturnType<typeof signal<number>>;
    const setLocale = (code: string) => {
        locale.set(code);
        translationVersion.update(v => v + 1);
    };

    beforeEach(async () => {
        // Create mock services
        dashboardsSignal = signal<Dashboard[] | undefined>(undefined);
        mockDashboardService = {
            getDashboards: vi.fn().mockName("DashboardService.getDashboards"),
            dashboards: dashboardsSignal.asReadonly()
        };
        routerEvents = new Subject<unknown>();
        mockRouter = {
            navigate: vi.fn().mockName("Router.navigate"),
            events: routerEvents.asObservable(),
            routerState: { snapshot: { root: { routeConfig: null, paramMap: convertToParamMap({}), firstChild: null } } }
        };

        locale = signal('en');
        translationVersion = signal(1);
        const mockTranslationService = {
            version: translationVersion.asReadonly(),
            loading: signal(false),
            get: (key: string) => (locale() === 'es' ? SPANISH[key] : undefined) ?? EN_TRANSLATIONS[key] ?? key,
            clearCache: () => {}
        };

        // Set default mock return values to prevent "Cannot read properties of undefined"
        // Individual tests can override these as needed
        givenDashboards(of([]));


        await TestBed.configureTestingModule({
            imports: [DashboardSelectorComponent, CommonModule],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                { provide: DashboardService, useValue: mockDashboardService },
                { provide: Router, useValue: mockRouter },
                { provide: TranslationService, useValue: mockTranslationService }
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

            givenDashboards(neverEmitting);

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
        it('should load dashboards on init', async () => {
            const mockDashboards: Dashboard[] = [
                MOCK_DASHBOARDS.welcome,
                MOCK_DASHBOARDS.userPrivate
            ];

            givenDashboards(of(mockDashboards));

            // Reset spy call counts before re-creating component
            mockDashboardService.getDashboards.mockClear();

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            fixture.detectChanges();

            await advanceTime(10);
            expect(mockDashboardService.getDashboards).toHaveBeenCalled();
            expect(component.dashboards()).toEqual(mockDashboards);
            expect(component.loading()).toBe(false);
        });

        it('should handle error loading dashboards', async () => {
            vi.spyOn(console, 'error').mockReturnValue(undefined); // Suppress console error

            givenDashboards(throwError(() => new Error('Network error')));

            // Re-create component to trigger constructor with error
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            expect(mockDashboardService.getDashboards).toHaveBeenCalled();
            expect(component.dashboards()).toEqual([]);
            expect(component.loading()).toBe(false);
            expect(console.error).toHaveBeenCalled();
        });

        it('should update current dashboard ID from route params', () => {
            // Emit new param map with dashboard ID
            goToDashboard('3');

            expect(component.currentDashboardId()).toBe(3);
        });

        it('should set current dashboard ID to undefined when no route param', () => {
            // Emit param map without ID
            goToDashboard();

            expect(component.currentDashboardId()).toBeUndefined();
        });
    });

    describe('loadDashboards()', () => {
        it('should set loading state before fetching', async () => {
            component.loading.set(false);

            // Use a delayed observable so we can check loading state before it completes
            const delayedObservable = new Observable<Dashboard[]>(observer => {
                setTimeout(() => {
                    observer.next([]);
                    observer.complete();
                }, 50);
            });

            givenDashboards(delayedObservable);

            component['loadDashboards']();

            // Check immediately - loading should be true
            expect(component.loading()).toBe(true);

            // Clean up after test
            await advanceTime(100);
        });

        it('should populate dashboards signal on success', async () => {
            const mockDashboards: Dashboard[] = [
                MOCK_DASHBOARDS.welcome,
                MOCK_DASHBOARDS.multiWidget,
                MOCK_DASHBOARDS.noWidgets
            ];

            givenDashboards(of(mockDashboards));

            component['loadDashboards']();

            await advanceTime(10);
            expect(component.dashboards()).toEqual(mockDashboards);
            expect(component.dashboards().length).toBe(3);
            expect(component.loading()).toBe(false);
        });

        it('should handle empty dashboards array', async () => {
            givenDashboards(of([]));

            component['loadDashboards']();

            await advanceTime(10);
            expect(component.dashboards()).toEqual([]);
            expect(component.loading()).toBe(false);
        });
    });

    describe('Route Parameter Handling', () => {
        it('should set current dashboard ID from route param', () => {
            // Emit route params with dashboard ID
            goToDashboard('5');

            expect(component.currentDashboardId()).toBe(5);
        });

        it('should set undefined when no route param', () => {
            // Emit route params without ID
            goToDashboard();

            expect(component.currentDashboardId()).toBeUndefined();
        });

        it('should parse string ID to integer', () => {
            // Emit route params with string ID
            goToDashboard('42');

            expect(component.currentDashboardId()).toBe(42);
        });

        it('should ignore an :id on a route that is not a dashboard', () => {
            goToDashboard('5');
            // A Detail page also has :id; it must not mark dashboard 7 as open
            setRoute('view/:entityKey/:id', { entityKey: 'issues', id: '7' });

            expect(component.currentDashboardId()).toBeUndefined();
        });

        it('should read a dashboard that is already open when the navbar is created', () => {
            const leaf = { routeConfig: { path: 'dashboard/:id' }, paramMap: convertToParamMap({ id: '9' }), firstChild: null };
            mockRouter.routerState = { snapshot: { root: { routeConfig: null, paramMap: convertToParamMap({}), firstChild: { routeConfig: { path: '' }, paramMap: convertToParamMap({}), firstChild: leaf } } } };

            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            expect(component.currentDashboardId()).toBe(9);
        });

        it('should ignore an id that is not a number', () => {
            goToDashboard('abc');

            expect(component.currentDashboardId()).toBeUndefined();
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
            dashboardsSignal.set(mockDashboards);
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
            dashboardsSignal.set([]);
            component.currentDashboardId.set(1);

            expect(component.getCurrentDashboardName()).toBe('Dashboard');
        });
    });

    describe('Template Rendering', () => {
        beforeEach(() => {
            // Ensure getDashboards is mocked for all template tests
            if (!mockDashboardService.getDashboards.mock?.calls?.length) {
                givenDashboards(of([]));
            }
        });

        it('should render dropdown button with dashboard icon', () => {
            givenDashboards(of([]));
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const dropdownButton = compiled.querySelector('.dropdown button, .dropdown div[role="button"]');
            const icon = dropdownButton?.querySelector('.material-symbols-outlined');

            expect(dropdownButton).toBeTruthy();
            expect(icon?.textContent).toContain('dashboard');
        });

        it('should display current dashboard name in button', () => {
            dashboardsSignal.set([MOCK_DASHBOARDS.welcome]);
            component.currentDashboardId.set(1);
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));

            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            expect(compiled.textContent).toContain('Welcome');
        });

        it('should show loading state in dropdown', async () => {
            // Don't let the HTTP request complete - keep loading state
            let resolveRequest: Function;
            const delayedObservable = new Observable<Dashboard[]>(observer => {
                resolveRequest = () => {
                    observer.next([]);
                    observer.complete();
                };
            });

            givenDashboards(delayedObservable);

            // Re-create component to pick up the delayed observable
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            fixture.detectChanges();

            // Give it a moment to start loading
            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const loadingSpinner = compiled.querySelector('.loading-spinner');

            expect(loadingSpinner).toBeTruthy();
            expect(compiled.textContent).toContain('Loading dashboards...');
        });

        it('should render dashboard list when loaded', async () => {
            const mockDashboards: Dashboard[] = [
                MOCK_DASHBOARDS.welcome,
                MOCK_DASHBOARDS.userPrivate,
                MOCK_DASHBOARDS.multiWidget
            ];

            givenDashboards(of(mockDashboards));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const menuItems = compiled.querySelectorAll('.dropdown-content li button');

            // +1 for "Default Dashboard" item
            expect(menuItems.length).toBe(mockDashboards.length + 1);
        });

        // #120: below sm the wrapper must not be the menu's containing block, so the
        // menu is placed against the screen's end edge and capped to the viewport.
        // Physical left/right classes would break RTL, so only logical ones are allowed.
        const expectPhonePlacement = (compiled: HTMLElement) => {
            const wrapper = compiled.querySelector('.dropdown') as HTMLElement;
            const menu = compiled.querySelector('.dropdown-content') as HTMLElement;
            expect(wrapper.classList).toContain('dropdown-end');
            expect(wrapper.classList).toContain('max-sm:static');
            expect(menu.classList).toContain('w-72');
            expect(menu.classList).toContain('max-sm:end-2');
            expect(menu.classList).toContain('max-sm:max-w-[calc(100vw-1rem)]');
            const physical = [...wrapper.classList, ...menu.classList]
                .filter(c => /(^|:)-?(left|right|ml|mr|pl|pr)-/.test(c));
            expect(physical).toEqual([]);
        };

        it('should place the menu against the screen edge below sm', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            await advanceTime(10);
            fixture.detectChanges();

            expectPhonePlacement(fixture.nativeElement as HTMLElement);
        });

        it('should place the loading menu the same way below sm', async () => {
            givenDashboards(new Observable<Dashboard[]>(() => {}));
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            expect(compiled.querySelector('.loading-spinner')).toBeTruthy();
            expectPhonePlacement(compiled);
        });

        it('should render default dashboard option', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const defaultOption = Array.from(compiled.querySelectorAll('.dropdown-content li button'))
                .find(el => el.textContent?.includes('Default Dashboard'));

            expect(defaultOption).toBeTruthy();
        });

        it('should highlight current dashboard with checkmark', async () => {
            dashboardsSignal.set([MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.multiWidget]);
            component.currentDashboardId.set(1);

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const activeItems = compiled.querySelectorAll('.dropdown-content li button.menu-active');

            expect(activeItems.length).toBeGreaterThan(0);
        });

        it('should show public/private icon for dashboards', async () => {
            const dashboards = [MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.userPrivate];
            givenDashboards(of(dashboards));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const menuItems = compiled.querySelectorAll('.dropdown-content li button');

            // Check for public icon (skip first item which is "Default Dashboard")
            const publicItem = menuItems[1]; // First actual dashboard
            expect(publicItem.textContent).toContain('public');

            // Check for private icon
            const privateItem = menuItems[2]; // Second actual dashboard
            expect(privateItem.textContent).toContain('lock');
        });

        it('should show dashboard description when present', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            expect(compiled.textContent).toContain('Welcome to Civic OS');
        });

        it('should trigger selectDashboard when clicking dashboard item', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            vi.spyOn(component, 'selectDashboard').mockReturnValue(undefined);

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const dashboardItems = compiled.querySelectorAll('.dropdown-content li button');
            const firstDashboard = dashboardItems[1] as HTMLElement; // Skip "Default Dashboard"

            firstDashboard.click();

            expect(component.selectDashboard).toHaveBeenCalledWith(1);
        });

        it('should trigger selectDefaultDashboard when clicking default option', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            vi.spyOn(component, 'selectDefaultDashboard').mockReturnValue(undefined);

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const defaultOption = Array.from(compiled.querySelectorAll('.dropdown-content li button'))
                .find(el => el.textContent?.includes('Default Dashboard')) as HTMLElement;

            defaultOption?.click();

            expect(component.selectDefaultDashboard).toHaveBeenCalled();
        });
    });

    describe('Change Detection with OnPush', () => {
        it('should update view when dashboards signal changes', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            let menuItems = compiled.querySelectorAll('.dropdown-content li button');
            expect(menuItems.length).toBe(2); // Default + 1 dashboard

            // Update dashboards
            dashboardsSignal.set([MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.userPrivate]);
            fixture.detectChanges();

            menuItems = compiled.querySelectorAll('.dropdown-content li button');
            expect(menuItems.length).toBe(3); // Default + 2 dashboards
        });

        it('should update button text when current dashboard changes', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome, MOCK_DASHBOARDS.multiWidget]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            component.currentDashboardId.set(1);
            fixture.detectChanges();
            expect(component.getCurrentDashboardName()).toBe('Welcome');

            component.currentDashboardId.set(3);
            fixture.detectChanges();
            expect(component.getCurrentDashboardName()).toBe('Multi-Widget Dashboard');
        });
    });

    describe('Pre-configured Mock Dashboards', () => {
        it('should display MOCK_DASHBOARDS.welcome correctly', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            expect(component.dashboards()[0].display_name).toBe('Welcome');
            expect(component.dashboards()[0].is_default).toBe(true);
            expect(component.dashboards()[0].is_public).toBe(true);
        });

        it('should display MOCK_DASHBOARDS.userPrivate correctly', async () => {
            givenDashboards(of([MOCK_DASHBOARDS.userPrivate]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            expect(component.dashboards()[0].display_name).toBe('My Dashboard');
            expect(component.dashboards()[0].is_public).toBe(false);
        });
    });

    describe('Edge Cases', () => {
        it('should handle dashboards with null description', async () => {
            const dashboardNoDesc = { ...MOCK_DASHBOARDS.welcome, description: null };
            givenDashboards(of([dashboardNoDesc]));

            // Re-create component to pick up new mock
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;

            await advanceTime(10);
            fixture.detectChanges();
            // Should not throw error rendering description
            expect(fixture.nativeElement).toBeTruthy();
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

    describe('Refreshed list', () => {
        it('should show the list the service refreshes after the first load', () => {
            givenDashboards(of([MOCK_DASHBOARDS.welcome]));
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            expect(component.dashboards()).toEqual([MOCK_DASHBOARDS.welcome]);

            // A role change refetches in the service; the selector must not keep its first list
            dashboardsSignal.set([MOCK_DASHBOARDS.userPrivate]);
            expect(component.dashboards()).toEqual([MOCK_DASHBOARDS.userPrivate]);

            dashboardsSignal.set(undefined);
            expect(component.dashboards()).toEqual([]);
        });
    });

    describe('Unlisted dashboards (show_in_selector = false)', () => {
        const listed: Dashboard = { ...MOCK_DASHBOARDS.welcome, show_in_selector: true };
        const unlisted: Dashboard = { ...MOCK_DASHBOARDS.multiWidget, show_in_selector: false };

        const render = async (dashboards: Dashboard[], currentId?: number) => {
            givenDashboards(of(dashboards));
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            if (currentId !== undefined) {
                goToDashboard(String(currentId));
            }
            await advanceTime(10);
            fixture.detectChanges();
            return fixture.nativeElement as HTMLElement;
        };
        const menuLabels = (el: HTMLElement) =>
            Array.from(el.querySelectorAll('.dropdown-content li button')).map(b => b.textContent ?? '');

        it('should leave unlisted dashboards out of the menu', async () => {
            const el = await render([listed, unlisted]);

            const labels = menuLabels(el);
            expect(labels.length).toBe(2); // Default Dashboard + the listed one
            expect(labels.some(l => l.includes(listed.display_name))).toBe(true);
            expect(labels.some(l => l.includes(unlisted.display_name))).toBe(false);
            expect(component.listedDashboards()).toEqual([listed]);
        });

        it('should still name an unlisted dashboard that is open', async () => {
            const el = await render([listed, unlisted], unlisted.id);

            expect(component.getCurrentDashboardName()).toBe(unlisted.display_name);
            const button = el.querySelector('button.btn') as HTMLButtonElement;
            expect(button.getAttribute('aria-label')).toContain(unlisted.display_name);
            // Nothing in the menu is marked current
            expect(el.querySelectorAll('.dropdown-content li button.menu-active').length).toBe(0);
        });

        it('should still offer Default Dashboard when every dashboard is unlisted', async () => {
            const el = await render([unlisted]);

            const labels = menuLabels(el);
            expect(labels.length).toBe(1);
            expect(labels[0]).toContain('Default Dashboard');
            expect(el.querySelector('.dropdown-content .menu-title')).toBeNull();
        });

        it('should treat a response without the flag as listed (old get_dashboards() during a deploy)', async () => {
            // The type requires the field, but a browser can load the new frontend while PostgREST still
            // serves the pre-v0.82.0 function for a few seconds; the selector then lists everything.
            const { show_in_selector: _omitted, ...legacy } = MOCK_DASHBOARDS.welcome;
            const el = await render([legacy as Dashboard]);

            expect(menuLabels(el).some(l => l.includes(legacy.display_name))).toBe(true);
            expect(el.querySelector('.dropdown-content .menu-title')).not.toBeNull();
        });
    });

    describe('Translated labels', () => {
        const render = async (dashboards: Dashboard[]) => {
            givenDashboards(of(dashboards));
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            component = fixture.componentInstance;
            await advanceTime(10);
            fixture.detectChanges();
            return fixture.nativeElement as HTMLElement;
        };
        const button = (el: HTMLElement) => el.querySelector('button.btn') as HTMLButtonElement;

        it('should show the menu and button labels in the user\'s language', async () => {
            setLocale('es');
            const el = await render([MOCK_DASHBOARDS.welcome]);

            expect(component.getCurrentDashboardName()).toBe('Tablero Predeterminado');
            expect(button(el).getAttribute('aria-label')).toBe('Seleccionar tablero: Tablero Predeterminado');
            const menu = el.querySelector('.dropdown-content') as HTMLElement;
            expect(menu.querySelector('li button')?.textContent).toContain('Tablero Predeterminado');
            expect(menu.querySelector('.menu-title')?.textContent?.trim()).toBe('Todos los tableros');
            expect(el.textContent).not.toContain('Default Dashboard');
            expect(el.textContent).not.toContain('All Dashboards');
        });

        it('should translate the fallback name of a dashboard missing from the list', async () => {
            setLocale('es');
            await render([MOCK_DASHBOARDS.welcome]);
            goToDashboard('999');

            expect(component.getCurrentDashboardName()).toBe('Tablero');
        });

        it('should translate the loading state', async () => {
            setLocale('es');
            // A fetch that never lands keeps the selector loading
            givenDashboards(new Observable<Dashboard[]>(() => {}));
            fixture = TestBed.createComponent(DashboardSelectorComponent);
            fixture.detectChanges();
            const el = fixture.nativeElement as HTMLElement;

            expect(el.querySelector('.loading-spinner')).toBeTruthy();
            expect(el.textContent).toContain('Cargando tableros...');
        });

        it('should follow a locale switch without reloading the dashboards', async () => {
            const el = await render([MOCK_DASHBOARDS.welcome]);
            expect(button(el).textContent).toContain('Default Dashboard');
            const loads = mockDashboardService.getDashboards.mock.calls.length;

            setLocale('es');
            await advanceTime(10);
            fixture.detectChanges();

            expect(button(el).textContent).toContain('Tablero Predeterminado');
            expect(el.querySelector('.menu-title')?.textContent?.trim()).toBe('Todos los tableros');
            expect(mockDashboardService.getDashboards.mock.calls.length).toBe(loads);
        });
    });
});
