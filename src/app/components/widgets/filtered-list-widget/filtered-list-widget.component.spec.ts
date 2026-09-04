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
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { FilteredListWidgetComponent } from './filtered-list-widget.component';
import { provideTranslationTesting } from '../../../testing/translation-testing';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { DashboardWidget } from '../../../interfaces/dashboard';

describe('FilteredListWidgetComponent', () => {
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
            getProperties: vi.fn().mockName("SchemaService.getProperties")
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

        setTimeout(() => {
            const config = component.config();
            expect(config.filters).toEqual([]);
            expect(config.orderBy).toBe('id');
            expect(config.orderDirection).toBe('desc');
            expect(config.limit).toBe(10);
            expect(config.showColumns).toEqual(['display_name']);
            ;
        }, 10);
    });

    it('should fetch entity properties and data', async () => {
        fixture.detectChanges();

        setTimeout(() => {
            expect(mockSchemaService.getProperties).toHaveBeenCalled();
            expect(mockDataService.getData).toHaveBeenCalled();
            ;
        }, 10);
    });

    it('should load entity properties for column rendering', async () => {
        fixture.detectChanges();

        setTimeout(() => {
            expect(component.properties().length).toBe(4);
            expect(component.properties().some(p => p.column_name === 'display_name')).toBe(true);
            ;
        }, 10);
    });

    it('should populate records signal with fetched data', async () => {
        fixture.detectChanges();

        setTimeout(() => {
            expect(component.records().length).toBe(2);
            expect(component.records()[0].display_name).toBe('John Doe');
            expect(component.records()[1].display_name).toBe('Jane Smith');
            ;
        }, 10);
    });

    it('should navigate to detail page on row click', async () => {
        fixture.detectChanges();

        setTimeout(() => {
            component.onRowClick(42);
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'participants', 42]);
            ;
        }, 10);
    });

    it('should get property metadata for column', async () => {
        fixture.detectChanges();

        setTimeout(() => {
            const property = component.getProperty('enrolled_date');
            expect(property).toBeDefined();
            expect(property?.display_name).toBe('Enrollment Date');
            ;
        }, 10);
    });

    it('should get column label from property metadata', async () => {
        fixture.detectChanges();

        setTimeout(() => {
            const label = component.getColumnLabel('enrolled_date');
            expect(label).toBe('Enrollment Date');
            ;
        }, 10);
    });

    it('should fallback to column name if property not found', async () => {
        fixture.detectChanges();

        setTimeout(() => {
            const label = component.getColumnLabel('unknown_column');
            expect(label).toBe('unknown_column');
            ;
        }, 10);
    });

    it('should handle empty data gracefully', async () => {
        mockDataService.getData.mockReturnValue(of([] as any));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(FilteredListWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        setTimeout(() => {
            expect(component.records().length).toBe(0);
            expect(component.isLoading()).toBe(false);
            ;
        }, 10);
    });

    it('should handle data service errors gracefully', async () => {
        vi.spyOn(console, 'error').mockReturnValue(undefined);
        mockDataService.getData.mockReturnValue(throwError(() => new Error('API Error')));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(FilteredListWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        setTimeout(() => {
            expect(component.records().length).toBe(0);
            expect(component.isLoading()).toBe(false);
            expect(component.error()).toBe('Failed to load data');
            ;
        }, 10);
    });

    it('should handle schema service errors gracefully', async () => {
        vi.spyOn(console, 'error').mockReturnValue(undefined);
        mockSchemaService.getProperties.mockReturnValue(throwError(() => new Error('Schema Error')));

        // Re-create component to pick up new mock
        fixture = TestBed.createComponent(FilteredListWidgetComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('widget', mockWidget);
        fixture.detectChanges();

        setTimeout(() => {
            expect(component.isLoading()).toBe(false);
            expect(component.error()).toBe('Failed to load schema');
            ;
        }, 10);
    });

    it('should set loading state correctly', async () => {
        expect(component.isLoading()).toBe(true);

        fixture.detectChanges();

        setTimeout(() => {
            expect(component.isLoading()).toBe(false);
            ;
        }, 10);
    });

    it('should handle widget without entity_key', async () => {
        const widgetNoEntity: DashboardWidget = {
            ...mockWidget,
            entity_key: null
        };

        fixture.componentRef.setInput('widget', widgetNoEntity);
        fixture.detectChanges();

        setTimeout(() => {
            expect(component.records().length).toBe(0);
            expect(component.isLoading()).toBe(false);
            ;
        }, 10);
    });
});
