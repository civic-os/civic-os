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
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { CalendarWidgetComponent } from './calendar-widget.component';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { AuthService } from '../../../services/auth.service';
import { DashboardWidget } from '../../../interfaces/dashboard';
import { DataQuery, FilterCriteria } from '../../../interfaces/query';
import { provideTranslationTesting } from '../../../testing/translation-testing';

describe('CalendarWidgetComponent', () => {
    let component: CalendarWidgetComponent;
    let fixture: ComponentFixture<CalendarWidgetComponent>;
    let mockDataService: any;
    let mockSchemaService: any;
    let mockAuthService: any;
    let mockRouter: any;

    const mockWidget: DashboardWidget = {
        id: 1,
        dashboard_id: 1,
        widget_type: 'calendar',
        title: 'Test Calendar',
        entity_key: 'reservations',
        refresh_interval_seconds: null,
        sort_order: 1,
        width: 2,
        height: 2,
        config: {
            entityKey: 'reservations',
            timeSlotPropertyName: 'time_slot',
            colorProperty: 'status_color',
            defaultColor: '#3B82F6',
            initialView: 'timeGridWeek',
            showCreateButton: false,
            filters: []
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    const mockProperties = [
        {
            table_name: 'reservations',
            column_name: 'id',
            display_name: 'ID',
            data_type: 'int8',
            property_type: 'IntegerNumber',
            is_nullable: false,
            sort_order: 0,
            validations: []
        },
        {
            table_name: 'reservations',
            column_name: 'display_name',
            display_name: 'Name',
            data_type: 'varchar',
            property_type: 'TextShort',
            is_nullable: false,
            sort_order: 1,
            validations: []
        },
        {
            table_name: 'reservations',
            column_name: 'time_slot',
            display_name: 'Time Slot',
            data_type: 'tstzrange',
            property_type: 'TimeSlot',
            is_nullable: false,
            sort_order: 2,
            validations: []
        },
        {
            table_name: 'reservations',
            column_name: 'status_color',
            display_name: 'Status Color',
            data_type: 'hex_color',
            property_type: 'Color',
            is_nullable: true,
            sort_order: 3,
            validations: []
        }
    ];

    const mockRecords = [
        {
            id: 1,
            display_name: 'Test Reservation',
            time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")',
            status_color: '#10B981',
            created_at: '2025-01-01',
            updated_at: '2025-01-01'
        }
    ];

    beforeEach(async () => {
        mockDataService = {
            getData: vi.fn().mockName("DataService.getData")
        };
        mockSchemaService = {
            getProperties: vi.fn().mockName("SchemaService.getProperties")
        };
        mockAuthService = {
            hasPermission: vi.fn().mockName("AuthService.hasPermission")
        };
        mockRouter = {
            navigate: vi.fn().mockName("Router.navigate"),
            createUrlTree: vi.fn().mockName("Router.createUrlTree"),
            serializeUrl: vi.fn().mockName("Router.serializeUrl")
        };

        // Default mock responses
        mockDataService.getData.mockReturnValue(of(mockRecords as any));
        mockSchemaService.getProperties.mockReturnValue(of(mockProperties as any));
        mockAuthService.hasPermission.mockReturnValue(true); // Default: user has permission
        mockRouter.createUrlTree.mockReturnValue({} as any);
        mockRouter.serializeUrl.mockReturnValue('/view/reservations/1');

        await TestBed.configureTestingModule({
            imports: [CalendarWidgetComponent],
            providers: [
                provideZonelessChangeDetection(),
                ...provideTranslationTesting(),
                { provide: DataService, useValue: mockDataService },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: Router, useValue: mockRouter }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(CalendarWidgetComponent);
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
        expect(config.entityKey).toBe('reservations');
        expect(config.timeSlotPropertyName).toBe('time_slot');
    });

    it('should provide defaults for optional config fields', () => {
        fixture.detectChanges();
        const config = component.config();
        expect(config.defaultColor).toBe('#3B82F6');
        expect(config.initialView).toBe('timeGridWeek');
        expect(config.maxEvents).toBe(1000);
        expect(config.showCreateButton).toBe(false);
    });

    it('should fetch entity properties and data', async () => {
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(mockSchemaService.getProperties).toHaveBeenCalled();
        expect(mockDataService.getData).toHaveBeenCalled();
    });

    it('should transform records to calendar events', async () => {
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events().length).toBe(1);
        expect(component.events()[0].id).toBe(1);
        expect(component.events()[0].title).toBe('Test Reservation');
        expect(component.events()[0].color).toBe('#10B981');
        expect(component.events()[0].start).toEqual(new Date('2025-03-15T14:00:00Z'));
        expect(component.events()[0].end).toEqual(new Date('2025-03-15T16:00:00Z'));
    });

    it('should filter out records without time_slot', async () => {
        mockDataService.getData.mockReturnValue(of([
            { id: 1, display_name: 'Has Slot', time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")', status_color: '#10B981' },
            { id: 2, display_name: 'No Slot', time_slot: null, status_color: '#EF4444' }
        ] as any));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events().length).toBe(1);
        expect(component.events()[0].id).toBe(1);
    });

    it('should open detail page in new tab on event click', () => {
        vi.spyOn(window, 'open').mockReturnValue(null);
        fixture.detectChanges();

        const mockEvent = {
            id: 42,
            title: 'Test Event',
            start: new Date(),
            end: new Date(),
            color: '#3B82F6'
        };

        component.onEventClick(mockEvent);

        expect(mockRouter.createUrlTree).toHaveBeenCalledWith(['/view', 'reservations', 42]);
        expect(window.open).toHaveBeenCalledWith('/view/reservations/1', '_blank');
    });

    it('should update date range and refetch on date range change', async () => {
        fixture.detectChanges();

        const newRange = {
            start: new Date('2025-03-10T00:00:00Z'),
            end: new Date('2025-03-17T00:00:00Z')
        };

        // Call count before change
        const initialCallCount = vi.mocked(mockDataService.getData).mock.calls.length;

        component.onDateRangeChange(newRange);

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.dateRange()).toEqual(newRange);
        // Should have been called again due to dateRange signal change
        expect(vi.mocked(mockDataService.getData).mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it('should navigate to create page on create button click', () => {
        fixture.detectChanges();
        component.onCreateClick();
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/create', 'reservations']);
    });

    it('should generate entity display name correctly', () => {
        fixture.detectChanges();
        expect(component.getEntityDisplayName()).toBe('Reservations');
    });

    it('should handle empty data gracefully', async () => {
        mockDataService.getData.mockReturnValue(of([] as any));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events().length).toBe(0);
        expect(component.isLoading()).toBe(false);
    });

    it('should handle data service errors gracefully', async () => {
        vi.spyOn(console, 'error').mockReturnValue(undefined);
        mockDataService.getData.mockReturnValue(throwError(() => new Error('API Error')));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events().length).toBe(0);
        expect(component.isLoading()).toBe(false);
        expect(component.error()).toBeTruthy();
    });

    it('should handle schema service errors gracefully', async () => {
        vi.spyOn(console, 'error').mockReturnValue(undefined);
        mockSchemaService.getProperties.mockReturnValue(throwError(() => new Error('Schema Error')));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.isLoading()).toBe(false);
        expect(component.error()).toBe('Failed to load schema');
    });

    it('should set loading state correctly', async () => {
        expect(component.isLoading()).toBe(true);

        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.isLoading()).toBe(false);
    });

    it('should handle widget without entity_key', async () => {
        const widgetNoEntity: DashboardWidget = {
            ...mockWidget,
            entity_key: null,
            config: {
                ...mockWidget.config,
                entityKey: ''
            }
        };

        fixture.componentRef.setInput('widget', widgetNoEntity);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events().length).toBe(0);
        expect(component.isLoading()).toBe(false);
        expect(component.error()).toContain('Missing required configuration');
    });

    it('should handle widget without timeSlotPropertyName', async () => {
        const widgetNoTimeSlot: DashboardWidget = {
            ...mockWidget,
            config: {
                ...mockWidget.config,
                timeSlotPropertyName: undefined as any
            }
        };

        fixture.componentRef.setInput('widget', widgetNoTimeSlot);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events().length).toBe(0);
        expect(component.isLoading()).toBe(false);
        expect(component.error()).toContain('Missing required configuration');
    });

    it('should use display_name as event title', async () => {
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events()[0].title).toBe('Test Reservation');
    });

    it('should fallback to Record ID if no display_name', async () => {
        mockDataService.getData.mockReturnValue(of([
            {
                id: 1,
                display_name: null,
                time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")',
                status_color: '#10B981'
            }
        ] as any));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events()[0].title).toBe('Record 1');
    });

    it('should use defaultColor when colorProperty is not set', async () => {
        const widgetNoColor: DashboardWidget = {
            ...mockWidget,
            config: {
                ...mockWidget.config,
                colorProperty: undefined
            }
        };

        fixture.componentRef.setInput('widget', widgetNoColor);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events()[0].color).toBe('#3B82F6');
    });

    it('should use defaultColor when record has no color value', async () => {
        mockDataService.getData.mockReturnValue(of([
            {
                id: 1,
                display_name: 'No Color',
                time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")',
                status_color: null
            }
        ] as any));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.events()[0].color).toBe('#3B82F6');
    });

    it('should handle invalid tstzrange format gracefully', async () => {
        vi.spyOn(console, 'error').mockReturnValue(undefined);
        mockDataService.getData.mockReturnValue(of([
            {
                id: 1,
                display_name: 'Invalid Format',
                time_slot: 'invalid-range-format',
                status_color: '#10B981'
            }
        ] as any));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        // Should still create event with placeholder dates
        expect(component.events().length).toBe(1);
        expect(console.error).toHaveBeenCalled();
    });

    // Permission checking tests
    it('should show create button when showCreateButton is true and user has permission', async () => {
        const widgetWithButton: DashboardWidget = {
            ...mockWidget,
            config: {
                ...mockWidget.config,
                showCreateButton: true
            }
        };

        mockAuthService.hasPermission.mockReturnValue(true);

        fixture.componentRef.setInput('widget', widgetWithButton);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.canShowCreateButton()).toBe(true);
        expect(mockAuthService.hasPermission).toHaveBeenCalledWith('reservations', 'create');
    });

    it('should hide create button when showCreateButton is false even if user has permission', async () => {
        const widgetNoButton: DashboardWidget = {
            ...mockWidget,
            config: {
                ...mockWidget.config,
                showCreateButton: false
            }
        };

        mockAuthService.hasPermission.mockReturnValue(true);

        fixture.componentRef.setInput('widget', widgetNoButton);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.canShowCreateButton()).toBe(false);
    });

    it('should hide create button when showCreateButton is true but user lacks permission', async () => {
        const widgetWithButton: DashboardWidget = {
            ...mockWidget,
            config: {
                ...mockWidget.config,
                showCreateButton: true
            }
        };

        mockAuthService.hasPermission.mockReturnValue(false);

        // Re-create component to pick up new permission mock
        fixture = TestBed.createComponent(CalendarWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', widgetWithButton);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(component.canShowCreateButton()).toBe(false);
        expect(mockAuthService.hasPermission).toHaveBeenCalledWith('reservations', 'create');
    });

    it('should check permission for correct entity key', async () => {
        const customWidget: DashboardWidget = {
            ...mockWidget,
            entity_key: 'appointments',
            config: {
                ...mockWidget.config,
                entityKey: 'appointments',
                showCreateButton: true
            }
        };

        mockAuthService.hasPermission.mockReturnValue(true);

        fixture.componentRef.setInput('widget', customWidget);
        fixture.detectChanges();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(mockAuthService.hasPermission).toHaveBeenCalledWith('appointments', 'create');
    });

    describe('Filter Application', () => {
        it('should apply static filters to query', async () => {
            const widgetWithFilters: DashboardWidget = {
                ...mockWidget,
                config: {
                    ...mockWidget.config,
                    filters: [
                        { column: 'status', operator: 'neq', value: 'cancelled' }
                    ]
                }
            };

            fixture.componentRef.setInput('widget', widgetWithFilters);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockDataService.getData).toHaveBeenCalled();
            const query: DataQuery = vi.mocked(mockDataService.getData).mock.lastCall[0];
            expect(query.filters).toBeDefined();
            expect(query.filters?.some((f: FilterCriteria) => f.column === 'status' && f.operator === 'neq' && f.value === 'cancelled')).toBe(true);
        });

        it('should combine static filters with date range filter', async () => {
            const widgetWithFilters: DashboardWidget = {
                ...mockWidget,
                config: {
                    ...mockWidget.config,
                    filters: [{ column: 'resource_id', operator: 'eq', value: 5 }]
                }
            };

            fixture.componentRef.setInput('widget', widgetWithFilters);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 10));
            component.onDateRangeChange({
                start: new Date('2025-03-10T00:00:00Z'),
                end: new Date('2025-03-17T00:00:00Z')
            });

            await new Promise(resolve => setTimeout(resolve, 10));
            const query: DataQuery = vi.mocked(mockDataService.getData).mock.lastCall[0];
            expect(query.filters?.length).toBe(2); // static + date range
            expect(query.filters?.some((f: FilterCriteria) => f.column === 'resource_id' && f.operator === 'eq' && f.value === 5)).toBe(true);
            expect(query.filters?.some((f: FilterCriteria) => f.column === 'time_slot' && f.operator === 'ov')).toBe(true);
        });
    });

    describe('Deduplication', () => {
        it('should prevent duplicate requests with same params', async () => {
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 10));
            const initialCallCount = vi.mocked(mockDataService.getData).mock.calls.length;

            // Trigger same request (no change to config or dateRange)
            const currentRange = component.dateRange();
            if (currentRange) {
                component.onDateRangeChange(currentRange);

                await new Promise(resolve => setTimeout(resolve, 10));
                expect(vi.mocked(mockDataService.getData).mock.calls.length).toBe(initialCallCount);
            }
        });

        it('should allow new request when params change', async () => {
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 10));
            const initialCallCount = vi.mocked(mockDataService.getData).mock.calls.length;

            // Change date range
            component.onDateRangeChange({
                start: new Date('2025-04-01T00:00:00Z'),
                end: new Date('2025-04-08T00:00:00Z')
            });

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(vi.mocked(mockDataService.getData).mock.calls.length).toBeGreaterThan(initialCallCount);
        });
    });
});
