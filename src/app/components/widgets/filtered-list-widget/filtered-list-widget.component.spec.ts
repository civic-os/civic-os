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
import { Router, provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { KeyFilterError } from '@civic-os/core';
import { FilteredListWidgetComponent } from './filtered-list-widget.component';
import { provideTranslationTesting } from '../../../testing/translation-testing';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { DashboardWidget } from '../../../interfaces/dashboard';
import { TranslationService } from '../../../services/translation.service';
import { advanceTime, useFakeTimeInEachTest } from '../../../testing/fake-time';

describe('FilteredListWidgetComponent', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: FilteredListWidgetComponent;
    let fixture: ComponentFixture<FilteredListWidgetComponent>;
    let mockDataService: any;
    let mockSchemaService: any;
    let mockRouter: any;

    const mockWidget: DashboardWidget = {
        id: 1,
        dashboard_id: 1,
        widget_type: 'filtered_list',
        title: 'Recent Participants',
        entity_key: 'participants',
        refresh_interval_seconds: null,
        sort_order: 1,
        width: 1,
        height: 1,
        config: {
            filters: [{ column: 'status', operator: 'eq', value: 'Active' }],
            orderBy: 'enrolled_date',
            orderDirection: 'desc',
            limit: 10,
            showColumns: ['display_name', 'enrolled_date', 'status']
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    const mockProperties = [
        {
            table_name: 'participants',
            column_name: 'id',
            display_name: 'ID',
            data_type: 'int4',
            property_type: 'IntegerNumber',
            is_nullable: false,
            sort_order: 0,
            validations: []
        },
        {
            table_name: 'participants',
            column_name: 'display_name',
            display_name: 'Name',
            data_type: 'varchar',
            property_type: 'TextShort',
            is_nullable: false,
            sort_order: 1,
            validations: []
        },
        {
            table_name: 'participants',
            column_name: 'enrolled_date',
            display_name: 'Enrollment Date',
            data_type: 'date',
            property_type: 'Date',
            is_nullable: false,
            sort_order: 2,
            validations: []
        },
        {
            table_name: 'participants',
            column_name: 'status',
            display_name: 'Status',
            data_type: 'varchar',
            property_type: 'TextShort',
            is_nullable: false,
            sort_order: 3,
            validations: []
        }
    ];

    const mockRecords = [
        { id: 1, display_name: 'John Doe', enrolled_date: '2020-01-15', status: 'Active', created_at: '2020-01-01', updated_at: '2020-01-01' },
        { id: 2, display_name: 'Jane Smith', enrolled_date: '2021-03-20', status: 'Active', created_at: '2021-03-01', updated_at: '2021-03-01' }
    ];

    beforeEach(async () => {
        mockDataService = {
            getData: vi.fn().mockName("DataService.getData")
        };
        mockSchemaService = {
            getProperties: vi.fn().mockName("SchemaService.getProperties"),
            resolveWidgetFilters: vi.fn((filters: unknown[] | undefined) => of(filters ?? [])).mockName("SchemaService.resolveWidgetFilters")
        };

        // Default mock responses
        mockDataService.getData.mockReturnValue(of(mockRecords as any));
        mockSchemaService.getProperties.mockReturnValue(of(mockProperties as any));

        await TestBed.configureTestingModule({
            imports: [FilteredListWidgetComponent],
            providers: [
                provideTranslationTesting(),
                provideZonelessChangeDetection(),
                // Real router provides ActivatedRoute for the first-cell RouterLink; navigate is spied below.
                provideRouter([]),
                { provide: DataService, useValue: mockDataService },
                { provide: SchemaService, useValue: mockSchemaService }
            ]
        }).compileComponents();

        mockRouter = TestBed.inject(Router) as any;
        vi.spyOn(mockRouter, 'navigate').mockReturnValue(undefined);

        fixture = TestBed.createComponent(FilteredListWidgetComponent);
        component = fixture.componentInstance;

        // Set required input
        fixture.componentRef.setInput('widget', mockWidget);
    });

    it('should create', () => {
        fixture.detectChanges();
        expect(component).toBeTruthy();
    });

    it('should extract config from widget', () => {
        fixture.detectChanges();
        const config = component.config();
        expect(config.orderBy).toBe('enrolled_date');
        expect(config.orderDirection).toBe('desc');
        expect(config.limit).toBe(10);
    });

    it('should provide defaults for optional config fields', async () => {
        const widgetWithMinimalConfig: DashboardWidget = {
            ...mockWidget,
            config: {}
        };

        fixture.componentRef.setInput('widget', widgetWithMinimalConfig);
        fixture.detectChanges();

        await advanceTime(10);
        const config = component.config();
        expect(config.filters).toEqual([]);
        expect(config.orderBy).toBe('id');
        expect(config.orderDirection).toBe('desc');
        expect(config.limit).toBe(10);
        expect(config.showColumns).toEqual(['display_name']);
    });

    it('should fetch entity properties and data', async () => {
        fixture.detectChanges();

        await advanceTime(10);
        expect(mockSchemaService.getProperties).toHaveBeenCalled();
        expect(mockDataService.getData).toHaveBeenCalled();
    });

    it('Q-10: a configured limit above the app maximum is clamped to 1000', async () => {
        fixture.componentRef.setInput('widget', { ...mockWidget, config: { ...mockWidget.config, limit: 50000 } });
        fixture.detectChanges();

        await advanceTime(10);
        const queries = mockDataService.getData.mock.calls.map((c: any[]) => c[0]);
        expect(queries.length).toBeGreaterThan(0);
        expect(queries.every((q: any) => q.limit === 1000)).toBe(true);
    });

    it('should load entity properties for column rendering', async () => {
        fixture.detectChanges();

        await advanceTime(10);
        expect(component.properties().length).toBe(4);
        expect(component.properties().some(p => p.column_name === 'display_name')).toBe(true);
    });

    it('should populate records signal with fetched data', async () => {
        fixture.detectChanges();

        await advanceTime(10);
        expect(component.records().length).toBe(2);
        expect(component.records()[0].display_name).toBe('John Doe');
        expect(component.records()[1].display_name).toBe('Jane Smith');
    });

    it('should navigate to detail page on row click', async () => {
        fixture.detectChanges();

        await advanceTime(10);
        component.onRowClick(42);
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'participants', 42]);
    });

    it('should get property metadata for column', async () => {
        fixture.detectChanges();

        await advanceTime(10);
        const property = component.getProperty('enrolled_date');
        expect(property).toBeDefined();
        expect(property?.display_name).toBe('Enrollment Date');
    });

    it('should get column label from property metadata', async () => {
        fixture.detectChanges();

        await advanceTime(10);
        const label = component.getColumnLabel('enrolled_date');
        expect(label).toBe('Enrollment Date');
    });

    it('should fallback to column name if property not found', async () => {
        fixture.detectChanges();

        await advanceTime(10);
        const label = component.getColumnLabel('unknown_column');
        expect(label).toBe('unknown_column');
    });

    it('should handle empty data gracefully', async () => {
        mockDataService.getData.mockReturnValue(of([] as any));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(FilteredListWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await advanceTime(10);
        expect(component.records().length).toBe(0);
        expect(component.isLoading()).toBe(false);
    });

    it('should handle data service errors gracefully', async () => {
        vi.spyOn(console, 'error').mockReturnValue(undefined);
        mockDataService.getData.mockReturnValue(throwError(() => new Error('API Error')));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(FilteredListWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await advanceTime(10);
        expect(component.records().length).toBe(0);
        expect(component.isLoading()).toBe(false);
        expect(component.error()).toBe('Failed to load data');
    });

    it('should handle schema service errors gracefully', async () => {
        vi.spyOn(console, 'error').mockReturnValue(undefined);
        mockSchemaService.getProperties.mockReturnValue(throwError(() => new Error('Schema Error')));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(FilteredListWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await advanceTime(10);
        expect(component.isLoading()).toBe(false);
        expect(component.error()).toBe('Failed to load schema');
    });

    it('should set loading state correctly', async () => {
        expect(component.isLoading()).toBe(true);

        fixture.detectChanges();

        await advanceTime(10);
        expect(component.isLoading()).toBe(false);
    });

    it('should handle widget without entity_key', async () => {
        const widgetNoEntity: DashboardWidget = {
            ...mockWidget,
            entity_key: null
        };

        fixture.componentRef.setInput('widget', widgetNoEntity);
        fixture.detectChanges();

        await advanceTime(10);
        expect(component.records().length).toBe(0);
        expect(component.isLoading()).toBe(false);
    });

    describe('key filters', () => {
        const keyed: DashboardWidget = {
            ...mockWidget,
            config: { ...mockWidget.config, filters: [{ column: 'status_id.status_key', operator: 'eq', value: 'active' }] }
        };

        // The fixture from the outer beforeEach would read the mocks these tests set.
        beforeEach(() => fixture.destroy());

        async function render(): Promise<void> {
            fixture = TestBed.createComponent(FilteredListWidgetComponent);
            component = fixture.componentInstance;
            fixture.componentRef.setInput('widget', keyed);
            fixture.detectChanges();
            await advanceTime(10);
        }

        it('should query with the resolved filters and pass only the entity properties', async () => {
            const resolved = [{ column: 'status_id', operator: 'eq', value: 7 }];
            mockSchemaService.resolveWidgetFilters.mockReturnValue(of(resolved));

            await render();

            const [filters, properties] = mockSchemaService.resolveWidgetFilters.mock.lastCall;
            expect(filters).toEqual((keyed.config as any).filters);
            expect(properties.every((p: any) => p.table_name === 'participants')).toBe(true);
            expect(mockDataService.getData.mock.calls.at(-1)[0].filters).toEqual(resolved);
        });

        it.each(['not_status_or_category', 'operator', 'invalid_value', 'unknown_key', 'unavailable'] as const)('should show a translated %s failure and send no data request', async (reason) => {
            vi.spyOn(console, 'error').mockReturnValue(undefined);
            mockDataService.getData.mockClear();
            mockSchemaService.resolveWidgetFilters.mockReturnValue(
                throwError(() => new KeyFilterError(reason, 'status_id.status_key', 'participant', 'lost'))
            );

            await render();

            expect(component.error()).toContain('status_id.status_key');
            expect(component.error()).not.toContain('dashboard.');
            expect(component.isLoading()).toBe(false);
            expect(mockDataService.getData).not.toHaveBeenCalled();
        });
    });

    describe('empty state and See more', () => {
        const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, display_name: `Row ${i + 1}` }));
        const withConfig = (extra: Record<string, unknown>): DashboardWidget =>
            ({ ...mockWidget, title: 'Awaiting approval', config: { ...mockWidget.config, limit: 3, ...extra } });

        beforeEach(() => fixture.destroy());

        async function render(widget: DashboardWidget): Promise<HTMLElement> {
            fixture = TestBed.createComponent(FilteredListWidgetComponent);
            component = fixture.componentInstance;
            fixture.componentRef.setInput('widget', widget);
            fixture.detectChanges();
            await advanceTime(10);
            fixture.detectChanges();
            return fixture.nativeElement as HTMLElement;
        }

        it('shows a neutral empty text without the filter hint', async () => {
            mockDataService.getData.mockReturnValue(of([]));
            const el = await render(withConfig({}));
            expect(el.textContent).toContain('Nothing to show');
            expect(el.textContent).not.toContain('adjusting the filters');
        });

        it('shows config.emptyMessage instead of the default text', async () => {
            mockDataService.getData.mockReturnValue(of([]));
            const el = await render(withConfig({ emptyMessage: 'No requests awaiting approval' }));
            expect(el.textContent).toContain('No requests awaiting approval');
            expect(el.textContent).not.toContain('Nothing to show');
        });

        it('requests limit + 1 rows, renders limit, and links to the list when the extra row exists', async () => {
            mockDataService.getData.mockReturnValue(of(rows(4)));
            const el = await render(withConfig({}));

            expect(mockDataService.getData.mock.calls.at(-1)[0].limit).toBe(4);
            expect(component.records().length).toBe(3);
            const link = el.querySelector('a[aria-label]') as HTMLAnchorElement;
            expect(link.textContent?.trim()).toBe('See more');
            expect(link.getAttribute('aria-label')).toBe('See more: Awaiting approval');
        });

        it('builds the link from the resolved filters (ids, not keys) and the widget order', async () => {
            mockDataService.getData.mockReturnValue(of(rows(4)));
            mockSchemaService.resolveWidgetFilters.mockReturnValue(of([
                { column: 'status_id', operator: 'in', value: [7, 9] }
            ]));
            const el = await render(withConfig({
                filters: [{ column: 'status_id.status_key', operator: 'in', value: ['open', 'review'] }]
            }));

            expect(component.seeMoreLink()).toEqual({
                commands: ['/view', 'participants'],
                queryParams: { f0_col: 'status_id', f0_op: 'in', f0_val: '(7,9)', sort: 'enrolled_date', dir: 'desc' }
            });
            const href = (el.querySelector('a[aria-label]') as HTMLAnchorElement).getAttribute('href')!;
            expect(href).toContain('/view/participants?');
            expect(href).toContain('f0_col=status_id');
            expect(href).not.toContain('status_key');
        });

        it('leaves the sort out of the link when the order column is hidden from the list', async () => {
            // The list page ignores a sort on a column it does not show, so sending it would only mislead.
            mockSchemaService.getProperties.mockReturnValue(of(mockProperties.map(p =>
                p.column_name === 'id' ? { ...p, show_on_list: false } : p) as any));
            mockDataService.getData.mockReturnValue(of(rows(4)));
            await render(withConfig({ orderBy: 'id', orderDirection: 'asc' }));

            expect(mockDataService.getData.mock.calls.at(-1)[0].orderField).toBe('id');
            expect(component.seeMoreLink()?.queryParams).toEqual({ f0_col: 'status', f0_op: 'eq', f0_val: 'Active' });
        });

        it('shows no link when a filter cannot go in the URL, since the list would show rows the widget excludes', async () => {
            mockDataService.getData.mockReturnValue(of(rows(4)));
            mockSchemaService.resolveWidgetFilters.mockReturnValue(of([
                { column: 'name', operator: 'in', value: ['Smith, J', 'Doe'] }
            ]));
            const el = await render(withConfig({}));
            expect(component.records().length).toBe(3);
            expect(component.seeMoreLink()).toBeNull();
            expect(el.querySelector('a[aria-label]')).toBeNull();
        });

        it('re-reads the empty and count texts when the locale translations arrive', async () => {
            // TranslationService.get() falls back to English until the locale's strings load, then bumps version().
            const translation = TestBed.inject(TranslationService) as unknown as {
                version: ReturnType<typeof signal<number>>; get: (key: string, params?: Record<string, unknown>) => string;
            };
            const englishGet = translation.get;
            mockDataService.getData.mockReturnValue(of([]));
            const el = await render(withConfig({}));
            expect(el.textContent).toContain('Nothing to show');

            translation.get = (key, params) => key === 'dashboard.empty_default' ? 'Nada que mostrar' : englishGet(key, params as any);
            translation.version.update(v => v + 1);
            fixture.detectChanges();
            expect(el.textContent).toContain('Nada que mostrar');
            translation.get = englishGet;
        });

        it('shows no link when the extra row does not come back', async () => {
            mockDataService.getData.mockReturnValue(of(rows(3)));
            const el = await render(withConfig({}));
            expect(component.records().length).toBe(3);
            expect(component.seeMoreLink()).toBeNull();
            expect(el.querySelector('a[aria-label]')).toBeNull();
        });

        it('shows no link when showSeeMore is false, but still renders only limit rows', async () => {
            mockDataService.getData.mockReturnValue(of(rows(4)));
            const el = await render(withConfig({ showSeeMore: false }));
            expect(component.records().length).toBe(3);
            expect(el.querySelector('a[aria-label]')).toBeNull();
        });

        it('cannot detect overflow at the API cap, so it asks for the cap and shows no link', async () => {
            // Never answers: rendering a thousand rows would only slow the test. The request is what matters,
            // since a full page at the cap cannot have a row beyond it.
            mockDataService.getData.mockReturnValue(new Subject<any[]>());
            fixture = TestBed.createComponent(FilteredListWidgetComponent);
            component = fixture.componentInstance;
            fixture.componentRef.setInput('widget', withConfig({ limit: 5000 }));
            fixture.detectChanges();
            await advanceTime(10);
            expect(mockDataService.getData.mock.calls.at(-1)[0].limit).toBe(1000);
            expect(component.seeMoreLink()).toBeNull();
            fixture.destroy();
        });
    });

    describe('superseded loads', () => {
        it('a signal the schema service reads does not re-run the load', async () => {
            // getProperties() reads the entities signal while its cache is cold; when the schema
            // finished loading, every widget used to send its data request a second time.
            const entities = signal(0);
            mockSchemaService.getProperties.mockImplementation(() => { entities(); return of(mockProperties as any); });
            fixture.detectChanges();
            await advanceTime(10);
            expect(mockDataService.getData).toHaveBeenCalledTimes(1);

            entities.set(1);
            fixture.detectChanges();
            await advanceTime(10);
            expect(mockDataService.getData).toHaveBeenCalledTimes(1);
        });

        it('a re-run cancels the previous load, so its late response is dropped', async () => {
            const stale = new Subject<any[]>();
            const fresh = new Subject<any[]>();
            mockDataService.getData.mockReturnValueOnce(stale).mockReturnValueOnce(fresh);
            fixture.detectChanges();
            await advanceTime(10);
            expect(stale.observed).toBe(true);

            fixture.componentRef.setInput('widget', { ...mockWidget, config: { ...mockWidget.config, limit: 5 } });
            fixture.detectChanges();
            await advanceTime(10);
            expect(stale.observed).toBe(false);

            fresh.next([mockRecords[0]]);
            stale.next(mockRecords);
            expect(component.records().length).toBe(1);
        });

        it('destroying the widget cancels its in-flight load', async () => {
            const pending = new Subject<any[]>();
            mockDataService.getData.mockReturnValue(pending);
            fixture.detectChanges();
            await advanceTime(10);
            expect(pending.observed).toBe(true);

            fixture.destroy();
            expect(pending.observed).toBe(false);
        });
    });
});
