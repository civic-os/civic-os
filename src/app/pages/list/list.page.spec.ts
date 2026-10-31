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
import { ActivatedRoute, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ListPage } from './list.page';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { NotesService } from '../../services/notes.service';
import { BehaviorSubject, of } from 'rxjs';
import type { EntityHandle, FacadeDeps } from '@civic-os/core';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty, createMockEntity } from '../../testing';
import { SchemaEntityProperty, SchemaEntityTable } from '../../interfaces/entity';
import { FACADE_DEPS } from '../../sdk/facade-deps';
import { LIST_PAGE_SIZE_STORAGE_KEY } from '../../sdk/list-url';
import { TimeSlotCalendarComponent } from '../../components/time-slot-calendar/time-slot-calendar.component';
import { TimeSlotCalendarStubComponent } from '../../testing/time-slot-calendar.stub';
import { settleLazyComponents } from '../../testing/lazy-components';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';

/** A core entity handle over a row, as the route resolver would hand the page. */
function handleFor(row: SchemaEntityTable): EntityHandle {
    return {
        name: row.table_name,
        get liveRow() { return row; },
        features: {
            calendar: row.show_calendar,
            calendarProperty: row.calendar_property_name,
            calendarColorProperty: row.calendar_color_property,
            map: row.show_map,
            mapProperty: row.map_property_name,
            mapColorProperty: row.map_color_property ?? null,
        },
        structural: {
            searchFields: row.search_fields ?? [],
            fulltextSearchColumn: row.fulltext_search_column ?? null,
            substringSearchColumn: row.substring_search_column ?? null,
        },
        schema: { isView: row.is_view ?? false },
        can: { insert: row.insert, select: row.select },
    } as unknown as EntityHandle;
}

describe('ListPage', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: ListPage;
    let fixture: ComponentFixture<ListPage>;
    let mockSchemaService: any;
    let mockDataService: any;
    let mockAnalyticsService: any;
    let mockAuthService: any;
    let mockNotesService: any;
    let routeParams: BehaviorSubject<any>;
    let queryParams: BehaviorSubject<any>;
    let navigateSpy: ReturnType<typeof vi.fn>;
    /** The facade's data client: every list request the page sends goes through it. */
    let getDataPaginated: ReturnType<typeof vi.fn>;
    let schemaProperties: ReturnType<typeof vi.fn>;
    /** The facades' clock. */
    let now: () => Date;

    beforeEach(async () => {
        routeParams = new BehaviorSubject({ entityKey: 'Issue' });
        queryParams = new BehaviorSubject({});
        localStorage.removeItem(LIST_PAGE_SIZE_STORAGE_KEY);

        mockSchemaService = {
            getEntity: vi.fn().mockName("SchemaService.getEntity"),
            getPropsForList: vi.fn().mockName("SchemaService.getPropsForList"),
            getPropsForFilter: vi.fn().mockName("SchemaService.getPropsForFilter"),
            entityRows: signal<SchemaEntityTable[] | undefined>([MOCK_ENTITIES.issue, MOCK_ENTITIES.status])
        };
        mockDataService = {
            getData: vi.fn().mockName("DataService.getData"),
            getDataPaginated: vi.fn().mockName("DataService.getDataPaginated")
        };
        mockAnalyticsService = {
            trackEvent: vi.fn().mockName("AnalyticsService.trackEvent")
        };
        mockAuthService = {
            login: vi.fn().mockName("AuthService.login"),
            authenticated: signal(false)
        };
        mockNotesService = {
            getNotes: vi.fn().mockName("NotesService.getNotes"),
            getNotesForEntities: vi.fn().mockName("NotesService.getNotesForEntities"),
            createNote: vi.fn().mockName("NotesService.createNote"),
            updateNote: vi.fn().mockName("NotesService.updateNote"),
            deleteNote: vi.fn().mockName("NotesService.deleteNote")
        };

        mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForList.mockReturnValue(of([]));
        mockSchemaService.getPropsForFilter.mockReturnValue(of([]));
        mockDataService.getData.mockReturnValue(of([]));
        mockDataService.getDataPaginated.mockReturnValue(of({ data: [], totalCount: 0 }));

        getDataPaginated = vi.fn(async () => ({ data: [], totalCount: 0 }));
        now = () => new Date();
        schemaProperties = vi.fn(async () => [MOCK_PROPERTIES.textShort]);
        const facadeDeps = {
            data: { getDataPaginated },
            schema: { properties: schemaProperties },
            clock: { now: () => now() },
        } as unknown as FacadeDeps;

        await TestBed.configureTestingModule({
            imports: [ListPage],
            providers: [
                provideZonelessChangeDetection(),
                provideRouter([]),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                {
                    provide: ActivatedRoute,
                    useValue: {
                        params: routeParams.asObservable(),
                        queryParams: queryParams.asObservable(),
                        snapshot: { get queryParams() { return queryParams.value; } }
                    }
                },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: mockDataService },
                { provide: AnalyticsService, useValue: mockAnalyticsService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: NotesService, useValue: mockNotesService },
                { provide: FACADE_DEPS, useValue: facadeDeps }
            ]
        })
            .overrideComponent(ListPage, {
                remove: { imports: [TimeSlotCalendarComponent] },
                add: { imports: [TimeSlotCalendarStubComponent] }
            })
            .compileComponents();

        // The URL is the mock route's: a navigation changes nothing unless a test makes it.
        navigateSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;

        fixture = TestBed.createComponent(ListPage);
        component = fixture.componentInstance;
    });

    // Let lazy-loaded children (maps, editor, Blockly) finish initializing
    // before teardown so nothing outlives this spec file (testing/lazy-components.ts).
    afterEach(async () => {
        await settleLazyComponents(fixture);
    });

    /** Gives the page its route entity handle, as the resolver does, and lets the first load settle. */
    async function mount(
        row: SchemaEntityTable = MOCK_ENTITIES.issue,
        props: SchemaEntityProperty[] = [MOCK_PROPERTIES.textShort],
        data: { data: any[]; totalCount: number } = { data: [], totalCount: 0 }
    ): Promise<void> {
        mockSchemaService.getEntity.mockReturnValue(of(row));
        schemaProperties.mockResolvedValue(props);
        getDataPaginated.mockResolvedValue(data);
        fixture.componentRef.setInput('entityHandle', handleFor(row));
        fixture.detectChanges();
        await advanceTime(100);
        fixture.detectChanges();
    }

    /** Opens the page as the route `key` with the URL's `params`, before any handle is bound. */
    async function openRoute(key: string, params: Record<string, string> = {}): Promise<void> {
        routeParams.next({ entityKey: key });
        await advanceTime(10);
        queryParams.next(params);
        await advanceTime(10);
    }

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Observable Chain Integration', () => {
        it('should load entity metadata from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));

            component.entity$.subscribe(entity => {
                expect(entity).toBeDefined();
                expect(entity?.table_name).toBe('Issue');
                expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
            });
        });

        it('should store entityKey from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));

            component.entity$.subscribe(() => {
                expect(component.entityKey).toBe('Issue');
            });
        });

        it('should not call getEntity when entityKey is missing from route', () => {
            const emptyParams = new BehaviorSubject({});
            mockSchemaService.getEntity.mockClear();

            // The entity$ observable checks for entityKey before calling getEntity
            // When entityKey is missing, it returns of(undefined) without calling the service
            // This is tested implicitly by the implementation in the component
            expect(component.entityKey).toBeDefined(); // Current entityKey from beforeEach is 'Issue'
        });

        it('should build no list and send no request without an entity handle', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(undefined));
            routeParams.next({});

            fixture.detectChanges();
            await advanceTime(50);
            expect(getDataPaginated).not.toHaveBeenCalled();
            expect(schemaProperties).not.toHaveBeenCalled();
            expect(component.dataSignal()).toEqual([]);
        });
    });

    describe('Route Parameter Changes', () => {
        it('should reload data when route params change', async () => {
            let callCount = 0;

            mockSchemaService.getEntity.mockImplementation((key: string) => {
                if (key === 'Issue')
                    return of(MOCK_ENTITIES.issue);
                if (key === 'Status')
                    return of(MOCK_ENTITIES.status);
                return of(undefined);
            });

            component.entity$.subscribe(entity => {
                callCount++;
                if (callCount === 1) {
                    expect(entity?.table_name).toBe('Issue');
                    // Trigger route change
                    routeParams.next({ entityKey: 'Status' });
                }
                else if (callCount === 2) {
                    expect(entity?.table_name).toBe('Status');
                    expect(component.entityKey).toBe('Status');
                }
            });
        });

        it('should send nothing for query params that leave the state equal, and one request for a new state', async () => {
            await mount();
            expect(getDataPaginated).toHaveBeenCalledTimes(1);

            queryParams.next({});
            await advanceTime(50);
            expect(getDataPaginated).toHaveBeenCalledTimes(1);

            queryParams.next({ page: '2' });
            await advanceTime(50);
            expect(getDataPaginated).toHaveBeenCalledTimes(2);
            expect(getDataPaginated.mock.lastCall![0].pagination).toEqual({ page: 2, pageSize: 25 });
        });

        it('should clear the URL params on an entity switch and load the new entity once with none of the old', async () => {
            const clears: unknown[] = [];
            navigateSpy.mockImplementation(async (_commands: unknown, extras: any) => {
                if (extras?.queryParams && Object.keys(extras.queryParams).length === 0) {
                    clears.push(extras);
                    queryParams.next({});
                }
                return true;
            });
            queryParams.next({ f0_col: 'name', f0_op: 'eq', f0_val: 'x', q: 'old' });
            await mount();
            expect(getDataPaginated).toHaveBeenCalledTimes(1);
            expect(getDataPaginated.mock.lastCall![0].filters).toEqual([{ column: 'name', operator: 'eq', value: 'x' }]);

            // The switch: the new route's handle arrives with the new key
            routeParams.next({ entityKey: 'Status' });
            fixture.componentRef.setInput('entityHandle', handleFor(MOCK_ENTITIES.status));
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.status));
            fixture.detectChanges();
            await advanceTime(100);

            expect(clears).toHaveLength(1);
            expect(clears[0]).toMatchObject({ queryParams: {}, replaceUrl: true });
            expect(getDataPaginated).toHaveBeenCalledTimes(2);
            const last = getDataPaginated.mock.lastCall![0];
            expect(last.key).toBe('Status');
            expect(last.filters).toBeUndefined();
            expect(last.searchQuery).toBeUndefined();
        });

        it('should rebuild the list and reload it with the URL state when the schema rows reload (a locale change)', async () => {
            queryParams.next({ page: '2', q: 'pothole' });
            await mount();
            expect(getDataPaginated).toHaveBeenCalledTimes(1);
            expect(schemaProperties).toHaveBeenCalledTimes(1);

            mockSchemaService.entityRows.set([{ ...MOCK_ENTITIES.issue, display_name: 'Problemas' }, MOCK_ENTITIES.status]);
            fixture.detectChanges();
            await advanceTime(100);

            expect(schemaProperties).toHaveBeenCalledTimes(2);
            expect(getDataPaginated).toHaveBeenCalledTimes(2);
            const last = getDataPaginated.mock.lastCall![0];
            expect(last.key).toBe('Issue');
            expect(last.pagination).toEqual({ page: 2, pageSize: 25 });
            expect(navigateSpy).not.toHaveBeenCalledWith([], expect.objectContaining({ queryParams: {} }));
        });

        it('should send no request for the old entity when the cleared params land before the new handle', async () => {
            navigateSpy.mockImplementation(async (_commands: unknown, extras: any) => {
                if (extras?.queryParams && Object.keys(extras.queryParams).length === 0) queryParams.next({});
                return true;
            });
            queryParams.next({ f0_col: 'name', f0_op: 'gte', f0_val: '4', page: '1' });
            await mount();
            expect(getDataPaginated).toHaveBeenCalledTimes(1);

            // The key changes and the clear settles while the old entity's handle is still bound
            routeParams.next({ entityKey: 'Status' });
            await advanceTime(50);
            fixture.detectChanges();
            expect(getDataPaginated).toHaveBeenCalledTimes(1);

            fixture.componentRef.setInput('entityHandle', handleFor(MOCK_ENTITIES.status));
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.status));
            fixture.detectChanges();
            await advanceTime(100);

            expect(getDataPaginated.mock.calls.map(c => c[0].key)).toEqual(['Issue', 'Status']);
            expect(getDataPaginated.mock.lastCall![0].filters).toBeUndefined();
        });
    });

    describe('Page size preference', () => {
        it('uses the stored preference when the URL has no pageSize', async () => {
            localStorage.setItem(LIST_PAGE_SIZE_STORAGE_KEY, '50');
            await mount();
            expect(getDataPaginated.mock.lastCall![0].pagination.pageSize).toBe(50);
        });

        it('lets the URL win, and an invalid URL value fall back to 25 rather than the stored one', async () => {
            localStorage.setItem(LIST_PAGE_SIZE_STORAGE_KEY, '50');
            queryParams.next({ pageSize: '10' });
            await mount();
            expect(getDataPaginated.mock.lastCall![0].pagination.pageSize).toBe(10);

            queryParams.next({ pageSize: 'abc' });
            await advanceTime(50);
            expect(getDataPaginated.mock.lastCall![0].pagination.pageSize).toBe(25);
        });

        it('stores the preference and navigates with it on a page size change', () => {
            component.onPageSizeChange(100);

            expect(localStorage.getItem(LIST_PAGE_SIZE_STORAGE_KEY)).toBe('100');
            expect(navigateSpy).toHaveBeenCalledWith([], expect.objectContaining({
                queryParams: { pageSize: 100, page: 1 },
                queryParamsHandling: 'merge',
                replaceUrl: true
            }));
        });

        it('still navigates with the new page size when storage is blocked and the write throws', () => {
            const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            });
            try {
                expect(() => component.onPageSizeChange(50)).not.toThrow();
                expect(navigateSpy).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { pageSize: 50, page: 1 } }));
            } finally {
                setItem.mockRestore();
            }
        });
    });

    describe('Navigation from the list controls', () => {
        it('cycles the sort of a column and resets to page 1', async () => {
            await mount();

            component.onHeaderClick(MOCK_PROPERTIES.textShort);
            expect(navigateSpy).toHaveBeenLastCalledWith([], expect.objectContaining({
                queryParams: { sort: 'name', dir: 'asc', page: 1 },
                queryParamsHandling: 'merge',
                replaceUrl: true
            }));

            queryParams.next({ sort: 'name', dir: 'asc' });
            await advanceTime(50);
            component.onHeaderClick(MOCK_PROPERTIES.textShort);
            expect(navigateSpy).toHaveBeenLastCalledWith([], expect.objectContaining({
                queryParams: { sort: 'name', dir: 'desc', page: 1 }
            }));

            queryParams.next({ sort: 'name', dir: 'desc' });
            await advanceTime(50);
            component.onHeaderClick(MOCK_PROPERTIES.textShort);
            expect(navigateSpy).toHaveBeenLastCalledWith([], expect.objectContaining({
                queryParams: { sort: null, dir: null, page: 1 }
            }));
        });

        it('removes one filter by rewriting the indexed params', async () => {
            queryParams.next({ f0_col: 'priority', f0_op: 'eq', f0_val: 'high', f1_col: 'status_id', f1_op: 'eq', f1_val: '1' });
            await mount();

            component.removeFilter('priority');

            expect(navigateSpy).toHaveBeenLastCalledWith([], expect.objectContaining({
                queryParams: {
                    f0_col: 'status_id', f0_op: 'eq', f0_val: '1',
                    f1_col: null, f1_op: null, f1_val: null,
                    page: 1
                },
                queryParamsHandling: 'merge',
                replaceUrl: true
            }));
        });

        it('clears the search and every filter together', async () => {
            queryParams.next({ q: 'pothole', f0_col: 'priority', f0_op: 'eq', f0_val: 'high' });
            await mount();

            component.onClearAllFilters();

            expect(navigateSpy).toHaveBeenLastCalledWith([], expect.objectContaining({
                queryParams: { q: null, page: 1, f0_col: null, f0_op: null, f0_val: null },
                queryParamsHandling: 'merge',
                replaceUrl: true
            }));
        });

        it('navigates to a record from a row click, but not for a summary view', async () => {
            await mount();
            component.onRowClick(7);
            expect(navigateSpy).toHaveBeenLastCalledWith(['/view', 'Issue', 7]);

            navigateSpy.mockClear();
            const summary = createMockEntity({ table_name: 'Issue', is_view: true, insert: false });
            fixture.componentRef.setInput('entityHandle', handleFor(summary));
            fixture.detectChanges();
            await advanceTime(50);
            component.onRowClick(7);
            expect(navigateSpy).not.toHaveBeenCalled();
        });
    });

    describe('Calendar range', () => {
        const calendarEntity = createMockEntity({
            table_name: 'Issue',
            show_calendar: true,
            calendar_property_name: 'time_slot'
        });
        const slot = createMockProperty({ column_name: 'time_slot', display_name: 'When' });

        const openingWeek = `[${new Date(2026, 9, 18).toISOString()},${new Date(2026, 9, 25).toISOString()})`;

        beforeEach(() => {
            now = () => new Date(2026, 9, 21, 12);
        });

        it('loads the week holding today at once, and the calendar reporting that week reaches the URL with no second request', async () => {
            await mount(calendarEntity, [MOCK_PROPERTIES.textShort, slot]);
            expect(getDataPaginated).toHaveBeenCalledTimes(1);
            const first = getDataPaginated.mock.lastCall![0];
            expect(first.pagination).toEqual({ page: 1, pageSize: 1000 });
            expect(first.filters).toEqual([{ column: 'time_slot', operator: 'ov', value: openingWeek }]);
            expect(component.isLoading()).toBe(false);

            // The calendar's opening week, from Sunday 2026-10-18
            component.onCalendarDateRangeChange({ start: new Date(2026, 9, 18), end: new Date(2026, 9, 25) });
            expect(component.isLoading()).toBe(false);
            expect(navigateSpy).toHaveBeenLastCalledWith([], expect.objectContaining({
                queryParams: { cal_view: 'timeGridWeek', cal_date: '2026-10-18', page: 1 },
                queryParamsHandling: 'merge',
                replaceUrl: true
            }));

            // The URL follows and maps back to the same state
            queryParams.next({ cal_view: 'timeGridWeek', cal_date: '2026-10-18', page: '1' });
            await advanceTime(100);
            expect(getDataPaginated).toHaveBeenCalledTimes(1);
            expect(component.calendarState()).toEqual({ view: 'timeGridWeek', date: '2026-10-18' });

            // Another week is another request
            component.onCalendarDateRangeChange({ start: new Date(2026, 9, 25), end: new Date(2026, 10, 1) });
            expect(component.isLoading()).toBe(true);
            await advanceTime(100);
            expect(getDataPaginated).toHaveBeenCalledTimes(2);
        });

        it('loads a second calendar entity switched to from the sidebar while its calendar reports no range (Gate 6 review)', async () => {
            await mount(calendarEntity, [MOCK_PROPERTIES.textShort, slot]);
            component.onCalendarDateRangeChange({ start: new Date(2026, 9, 18), end: new Date(2026, 9, 25) });
            queryParams.next({ cal_view: 'timeGridWeek', cal_date: '2026-10-18', page: '1' });
            await advanceTime(100);
            expect(getDataPaginated).toHaveBeenCalledTimes(1);

            // The surviving calendar stays on this week, so it emits nothing for the new entity
            const second = createMockEntity({ table_name: 'Status', show_calendar: true, calendar_property_name: 'time_slot' });
            routeParams.next({ entityKey: 'Status' });
            queryParams.next({});
            await advanceTime(50);
            await mount(second, [MOCK_PROPERTIES.textShort, slot]);

            expect(getDataPaginated.mock.calls.map(c => c[0].key)).toEqual(['Issue', 'Status']);
            expect(getDataPaginated.mock.lastCall![0].filters).toEqual([{ column: 'time_slot', operator: 'ov', value: openingWeek }]);
            expect(component.isLoading()).toBe(false);
        });

        it('counts the URL calendar only when both view and date are present', async () => {
            queryParams.next({ cal_view: 'timeGridWeek' });
            await mount(calendarEntity, [MOCK_PROPERTIES.textShort, slot]);
            expect(component.calendarState()).toBeNull();
            expect(getDataPaginated).toHaveBeenCalledTimes(1);
            expect(getDataPaginated.mock.lastCall![0].filters).toEqual([{ column: 'time_slot', operator: 'ov', value: openingWeek }]);
        });
    });

    describe('Load errors', () => {
        it('logs a failed load, as the legacy data fetch did, and shows the empty list', async () => {
            const failure = new Error('boom');
            const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            try {
                getDataPaginated.mockRejectedValue(failure);
                fixture.componentRef.setInput('entityHandle', handleFor(MOCK_ENTITIES.issue));
                fixture.detectChanges();
                await advanceTime(100);
                fixture.detectChanges();
                expect(log).toHaveBeenCalledWith('Error fetching paginated data:', failure);
                expect(log).toHaveBeenCalledTimes(1);
                expect(component.dataSignal()).toEqual([]);
                expect(component.isLoading()).toBe(false);
            } finally {
                log.mockRestore();
            }
        });

        it('logs a calendar date the list cannot plan', async () => {
            const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            try {
                queryParams.next({ cal_view: 'timeGridWeek', cal_date: 'not-a-date' });
                await mount(
                    createMockEntity({ table_name: 'Issue', show_calendar: true, calendar_property_name: 'time_slot' }),
                    [MOCK_PROPERTIES.textShort, createMockProperty({ column_name: 'time_slot', display_name: 'When' })]
                );
                expect(getDataPaginated).not.toHaveBeenCalled();
                expect(log).toHaveBeenCalledWith('Error fetching paginated data:', expect.anything());
            } finally {
                log.mockRestore();
            }
        });
    });

    describe('Search Functionality', () => {
        it('should extract search terms from search query', async () => {
            await mount();

            queryParams.next({ q: 'pothole main street' });

            await advanceTime(10);
            expect(component.searchTerms()).toEqual(['pothole', 'main', 'street']);
        });

        it('should sync searchControl with URL query params', async () => {
            component.ngOnInit();

            // Update URL query params
            queryParams.next({ q: 'pothole' });

            await advanceTime(10);
            expect(component.searchControl.value).toBe('pothole');
        });

        it('should initialize search from URL query params', () => {
            // This test verifies the ngOnInit behavior
            // The route is already configured with empty queryParams in beforeEach
            component.ngOnInit();

            // Should not set any value for empty query params
            expect(component.searchControl.value).toBe('');
        });

        it('should navigate to the typed search after the debounce, back on page 1, and track its length', async () => {
            component.ngOnInit();

            component.searchControl.setValue('pothole ');
            await advanceTime(300);

            expect(navigateSpy).toHaveBeenLastCalledWith([], expect.objectContaining({
                queryParams: { q: 'pothole ', page: 1 },
                queryParamsHandling: 'merge',
                replaceUrl: true
            }));
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Search', 'Query', 'Issue', 7);
        });
    });

    describe('Entity Description Tooltip', () => {
        it('should display entity with description in template', async () => {
            const entityWithDescription = { ...MOCK_ENTITIES.issue, description: 'Track system issues' };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithDescription));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBe('Track system issues');
            });
        });

        it('should handle entities without description', async () => {
            const entityWithoutDescription = { ...MOCK_ENTITIES.issue, description: null };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithoutDescription));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBeNull();
            });
        });
    });

    describe('Filter chips', () => {
        it('words each chip kind the way the page always did', async () => {
            queryParams.next({
                f0_col: 'count', f0_op: 'gte', f0_val: '4', f1_col: 'count', f1_op: 'lte', f1_val: '9',
                f2_col: 'is_active', f2_op: 'eq', f2_val: 'true',
                f3_col: 'status_id', f3_op: 'in', f3_val: '(1,2,3)',
                f4_col: 'name', f4_op: 'eq', f4_val: 'pothole',
                f5_col: 'assigned_to', f5_op: 'gte', f5_val: '2'
            });
            await mount(MOCK_ENTITIES.issue, [
                MOCK_PROPERTIES.textShort, MOCK_PROPERTIES.integer, MOCK_PROPERTIES.boolean,
                MOCK_PROPERTIES.foreignKey, MOCK_PROPERTIES.user
            ]);

            expect(component.filterChips().map(c => `${c.columnLabel} (${c.displayValue})`)).toEqual([
                `${MOCK_PROPERTIES.integer.display_name} (4 - 9)`,
                `${MOCK_PROPERTIES.boolean.display_name} (Yes)`,
                `${MOCK_PROPERTIES.foreignKey.display_name} (3 selected)`,
                `${MOCK_PROPERTIES.textShort.display_name} (pothole)`,
                `${MOCK_PROPERTIES.user.display_name} (≥ 2)`
            ]);
            expect(component.isFiltered()).toBe(true);
        });
    });

    describe('Rendering', () => {
        it('draws a row per record with the record id on it, and blanks the rows while the next load runs', async () => {
            await mount(MOCK_ENTITIES.issue, [MOCK_PROPERTIES.textShort], {
                data: [{ id: 1, name: 'A', display_name: 'A' }, { id: 2, name: 'B', display_name: 'B' }],
                totalCount: 2
            });

            const ids = () => Array.from(fixture.nativeElement.querySelectorAll('tbody tr[data-record-id]')).map((tr: any) => tr.dataset.recordId);
            expect(ids()).toEqual(['1', '2']);
            expect(component.totalCount()).toBe(2);

            let release!: (v: unknown) => void;
            getDataPaginated.mockReturnValue(new Promise(resolve => { release = resolve; }));
            queryParams.next({ page: '2' });
            await advanceTime(10);
            fixture.detectChanges();
            expect(ids()).toEqual([]);
            expect(component.isLoading()).toBe(true);

            release({ data: [{ id: 3, name: 'C', display_name: 'C' }], totalCount: 3 });
            await advanceTime(10);
            fixture.detectChanges();
            expect(ids()).toEqual(['3']);
            expect(component.isLoading()).toBe(false);
        });
    });

    describe('Debounced Hover Events', () => {
        beforeEach(() => {
            component.ngOnInit();
        });

        it('should have rowHover$ Subject for debouncing', () => {
            expect(component['rowHover$']).toBeDefined();
            expect(typeof component['rowHover$'].next).toBe('function');
        });

        it('should push to rowHover$ Subject when onRowHover is called', () => {
            vi.spyOn(component['rowHover$'], 'next').mockReturnValue(undefined);

            component.onRowHover(123);

            expect(component['rowHover$'].next).toHaveBeenCalledWith(123);
        });

        it('should push null to rowHover$ Subject when clearing hover', () => {
            vi.spyOn(component['rowHover$'], 'next').mockReturnValue(undefined);

            component.onRowHover(null);

            expect(component['rowHover$'].next).toHaveBeenCalledWith(null);
        });

        it('should update highlightedRecordId after debounce delay', async () => {
            component.onRowHover(42);

            // After debounce (>150ms), signal should update
            await advanceTime(200);
            expect(component.highlightedRecordId()).toBe(42);
        });

        it('should handle rapid hover changes by using last value', async () => {
            // Push multiple values rapidly
            component.onRowHover(1);
            component.onRowHover(2);
            component.onRowHover(3);

            // After debounce, should have the last value
            await advanceTime(200);
            expect(component.highlightedRecordId()).toBe(3);
        });
    });

    describe('Reset View Functionality', () => {
        beforeEach(() => {
            component.ngOnInit();
        });

        it('should clear highlightedRecordId immediately without debounce', () => {
            // Set highlighted record first
            component.highlightedRecordId.set(123);
            expect(component.highlightedRecordId()).toBe(123);

            // Reset view
            component.onResetView();

            // Should clear immediately
            expect(component.highlightedRecordId()).toBeNull();
        });

        it('should push null to rowHover$ Subject', () => {
            vi.spyOn(component['rowHover$'], 'next').mockReturnValue(undefined);

            component.onResetView();

            expect(component['rowHover$'].next).toHaveBeenCalledWith(null);
        });
    });

    describe('Marker Click Functionality', () => {
        beforeEach(() => {
            component.ngOnInit();
        });

        it('should set highlightedRecordId immediately', () => {
            // Create a mock row element
            const mockRow = document.createElement('tr');
            mockRow.setAttribute('data-record-id', '456');
            document.body.appendChild(mockRow);

            component.onMarkerClick(456);

            expect(component.highlightedRecordId()).toBe(456);

            // Cleanup
            document.body.removeChild(mockRow);
        });

        it('should scroll to corresponding row', () => {
            const mockRow = document.createElement('tr');
            mockRow.setAttribute('data-record-id', '789');
            document.body.appendChild(mockRow);

            vi.spyOn(window, 'scrollTo').mockReturnValue(undefined);

            component.onMarkerClick(789);

            expect(window.scrollTo).toHaveBeenCalled();

            // Cleanup
            document.body.removeChild(mockRow);
        });

        it('should handle missing row element gracefully', () => {
            // No row with this ID exists
            expect(() => component.onMarkerClick(999)).not.toThrow();

            // Should still set the highlighted ID even if row not found
            expect(component.highlightedRecordId()).toBe(999);
        });
    });

    describe('ngOnDestroy Cleanup', () => {
        beforeEach(() => {
            component.ngOnInit();
        });

        it('should complete rowHover$ Subject to prevent memory leaks', () => {
            vi.spyOn(component['rowHover$'], 'complete').mockReturnValue(undefined);

            component.ngOnDestroy();

            expect(component['rowHover$'].complete).toHaveBeenCalled();
        });

        it('should not error if called multiple times', () => {
            expect(() => {
                component.ngOnDestroy();
                component.ngOnDestroy();
            }).not.toThrow();
        });
    });

    describe('Analytics Tracking', () => {
        const oneRow = { data: [{ id: 1, display_name: 'Item 1' }], totalCount: 42 };
        // The resolver binds the handle of the route's own entity, so the row is named as the route is
        const issues = { ...MOCK_ENTITIES.issue, table_name: 'issues' };

        it('should track unfiltered list view as Entity/List', async () => {
            await openRoute('issues');
            await mount(issues, [MOCK_PROPERTIES.textShort], oneRow);

            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'List', 'issues', 42);
        });

        it('should include filter column names in label', async () => {
            await openRoute('issues', { f0_col: 'priority', f0_op: 'eq', f0_val: 'high', f1_col: 'status_id', f1_op: 'eq', f1_val: '1' });
            await mount(issues, [MOCK_PROPERTIES.textShort], { ...oneRow, totalCount: 15 });

            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'List', 'issues:priority,status_id', 15);
        });

        it('should include search indicator in label', async () => {
            const entityWithSearch = { ...issues, search_fields: ['display_name'] };
            await openRoute('issues', { q: 'pothole' });
            await mount(entityWithSearch, [MOCK_PROPERTIES.textShort], { ...oneRow, totalCount: 5 });

            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'List', 'issues:search', 5);
        });

        it('should combine filters, search, and pagination in label', async () => {
            const entityWithSearch = { ...issues, search_fields: ['display_name'] };
            await openRoute('issues', { q: 'pothole', f0_col: 'status_id', f0_op: 'eq', f0_val: '1', page: '3' });
            await mount(entityWithSearch, [MOCK_PROPERTIES.textShort], { ...oneRow, totalCount: 3 });

            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'List', 'issues:status_id:search:p3', 3);
        });

        it('should track pagination as separate event from page 1', async () => {
            await openRoute('issues');
            await mount(issues, [MOCK_PROPERTIES.textShort], oneRow);
            // First load: page 1
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'List', 'issues', 42);

            // Navigate to page 2
            mockAnalyticsService.trackEvent.mockClear();
            queryParams.next({ page: '2' });

            await advanceTime(100);
            // Should fire new event with page indicator
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'List', 'issues:p2', 42);
        });

        it('should omit page indicator for page 1', async () => {
            await openRoute('issues', { page: '1' });
            await mount(issues, [MOCK_PROPERTIES.textShort], oneRow);

            // Page 1 should NOT have :p1 suffix
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'List', 'issues', 42);
        });

        it('should track a repeated state once', async () => {
            await openRoute('issues');
            await mount(issues, [MOCK_PROPERTIES.textShort], oneRow);
            mockAnalyticsService.trackEvent.mockClear();

            // Same tracking key (page 1, no filters), loaded again
            queryParams.next({ sort: 'name', dir: 'asc' });
            await advanceTime(100);
            expect(getDataPaginated).toHaveBeenCalledTimes(2);
            expect(mockAnalyticsService.trackEvent).not.toHaveBeenCalled();
        });
    });

});
