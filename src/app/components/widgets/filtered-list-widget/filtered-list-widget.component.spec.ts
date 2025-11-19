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
import { Router } from '@angular/router';
import { Observable, of } from 'rxjs';
import { FilteredListWidgetComponent } from './filtered-list-widget.component';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { DashboardWidget } from '../../../interfaces/dashboard';
import { SchemaEntityProperty } from '../../../interfaces/entity';

describe('FilteredListWidgetComponent', () => {
  let component: FilteredListWidgetComponent;
  let fixture: ComponentFixture<FilteredListWidgetComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockRouter: jasmine.SpyObj<Router>;

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

  const mockProperties: SchemaEntityProperty[] = [
    {
      table_name: 'participants',
      column_name: 'display_name',
      display_name: 'Name',
      data_type: 'varchar',
      property_type: 'TextShort',
      is_nullable: false,
      column_default: null,
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
      column_default: null,
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
      column_default: null,
      sort_order: 3,
      validations: []
    }
  ];

  beforeEach(async () => {
    mockDataService = jasmine.createSpyObj('DataService', ['getData']);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getEntityProperties']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);

    // Default mock responses
    mockDataService.getData.and.returnValue(
      of({
        data: [
          { id: 1, display_name: 'John Doe', enrolled_date: '2020-01-15', status: 'Active' },
          { id: 2, display_name: 'Jane Smith', enrolled_date: '2021-03-20', status: 'Active' }
        ],
        totalCount: 2
      })
    );

    mockSchemaService.getEntityProperties.and.returnValue(of(mockProperties));

    await TestBed.configureTestingModule({
      imports: [FilteredListWidgetComponent],
      providers: [
        { provide: DataService, useValue: mockDataService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: Router, useValue: mockRouter }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(FilteredListWidgetComponent);
    component = fixture.componentInstance;

    // Set required input
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should extract config from widget', () => {
    const config = component.config();
    expect(config.orderBy).toBe('enrolled_date');
    expect(config.orderDirection).toBe('desc');
    expect(config.limit).toBe(10);
  });

  it('should provide defaults for optional config fields', () => {
    const widgetWithMinimalConfig: DashboardWidget = {
      ...mockWidget,
      config: {}
    };

    fixture.componentRef.setInput('widget', widgetWithMinimalConfig);
    fixture.detectChanges();

    const config = component.config();
    expect(config.filters).toEqual([]);
    expect(config.orderBy).toBe('id');
    expect(config.orderDirection).toBe('desc');
    expect(config.limit).toBe(10);
    expect(config.showColumns).toEqual(['display_name']);
  });

  it('should fetch entity data with correct parameters', (done) => {
    component.records$.subscribe(() => {
      expect(mockDataService.getData).toHaveBeenCalledWith(
        'participants',
        ['id', 'display_name', 'enrolled_date', 'status'],
        [{ column: 'status', operator: 'eq', value: 'Active' }],
        'enrolled_date',
        10,
        'desc'
      );
      done();
    });
  });

  it('should load entity properties for column rendering', () => {
    expect(mockSchemaService.getEntityProperties).toHaveBeenCalledWith('participants');
    expect(component.properties().length).toBe(3);
  });

  it('should render records in table', (done) => {
    component.records$.subscribe(records => {
      expect(records.length).toBe(2);
      expect(records[0].display_name).toBe('John Doe');
      expect(records[1].display_name).toBe('Jane Smith');
      done();
    });
  });

  it('should navigate to detail page on row click', () => {
    component.onRowClick(42);
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'participants', 42]);
  });

  it('should get property metadata for column', () => {
    const property = component.getProperty('enrolled_date');
    expect(property).toBeDefined();
    expect(property?.display_name).toBe('Enrollment Date');
  });

  it('should get column label from property metadata', () => {
    const label = component.getColumnLabel('enrolled_date');
    expect(label).toBe('Enrollment Date');
  });

  it('should fallback to column name if property not found', () => {
    const label = component.getColumnLabel('unknown_column');
    expect(label).toBe('unknown_column');
  });

  it('should handle empty data gracefully', (done) => {
    mockDataService.getData.and.returnValue(
      of({ data: [], totalCount: 0 })
    );

    component.records$.subscribe(records => {
      expect(records.length).toBe(0);
      expect(component.isLoading()).toBe(false);
      done();
    });
  });

  it('should handle errors gracefully', (done) => {
    mockDataService.getData.and.returnValue(
      new Observable(subscriber => {
        subscriber.error(new Error('API Error'));
      })
    );

    component.records$.subscribe(records => {
      expect(records.length).toBe(0);
      expect(component.isLoading()).toBe(false);
      expect(component.error()).toBe('Failed to load data');
      done();
    });
  });

  it('should set loading state correctly', (done) => {
    expect(component.isLoading()).toBe(true);

    component.records$.subscribe(() => {
      expect(component.isLoading()).toBe(false);
      done();
    });
  });
});
