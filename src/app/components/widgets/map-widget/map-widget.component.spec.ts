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
import { MapWidgetComponent } from './map-widget.component';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { DashboardWidget } from '../../../interfaces/dashboard';

describe('MapWidgetComponent', () => {
  let component: MapWidgetComponent;
  let fixture: ComponentFixture<MapWidgetComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockRouter: jasmine.SpyObj<Router>;

  const mockWidget: DashboardWidget = {
    id: 1,
    dashboard_id: 1,
    widget_type: 'map',
    title: 'Test Map',
    entity_key: 'participants',
    refresh_interval_seconds: null,
    sort_order: 1,
    width: 2,
    height: 2,
    config: {
      entityKey: 'participants',
      mapPropertyName: 'home_location',
      filters: [],
      showColumns: ['display_name', 'enrolled_date']
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
      column_name: 'home_location',
      display_name: 'Home Location',
      data_type: 'geography',
      property_type: 'GeoPoint',
      is_nullable: true,
      sort_order: 2,
      validations: []
    },
    {
      table_name: 'participants',
      column_name: 'enrolled_date',
      display_name: 'Enrollment Date',
      data_type: 'date',
      property_type: 'Date',
      is_nullable: false,
      sort_order: 3,
      validations: []
    }
  ];

  const mockRecords = [
    {
      id: 1,
      display_name: 'Test Participant',
      home_location_text: 'POINT(-83.7 43.0)',
      enrolled_date: '2020-01-01',
      created_at: '2020-01-01',
      updated_at: '2020-01-01'
    }
  ];

  beforeEach(async () => {
    mockDataService = jasmine.createSpyObj('DataService', ['getData']);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getProperties']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);

    // Default mock responses
    mockDataService.getData.and.returnValue(of(mockRecords as any));
    mockSchemaService.getProperties.and.returnValue(of(mockProperties as any));

    await TestBed.configureTestingModule({
      imports: [MapWidgetComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DataService, useValue: mockDataService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: Router, useValue: mockRouter }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(MapWidgetComponent);
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
    expect(config.entityKey).toBe('participants');
    expect(config.mapPropertyName).toBe('home_location');
  });

  it('should provide defaults for optional config fields', () => {
    fixture.detectChanges();
    const config = component.config();
    expect(config.maxMarkers).toBe(500);
    expect(config.enableClustering).toBe(false);
    expect(config.clusterRadius).toBe(50);
  });

  it('should fetch entity properties and data', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(mockSchemaService.getProperties).toHaveBeenCalled();
      expect(mockDataService.getData).toHaveBeenCalled();
      done();
    }, 10);
  });

  it('should transform records to markers', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers().length).toBe(1);
      expect(component.markers()[0].id).toBe(1);
      expect(component.markers()[0].name).toBe('Test Participant');
      expect(component.markers()[0].wkt).toBe('POINT(-83.7 43.0)');
      done();
    }, 10);
  });

  it('should filter out records without geography', (done) => {
    mockDataService.getData.and.returnValue(
      of([
        { id: 1, display_name: 'Has Location', home_location_text: 'POINT(-83.7 43.0)', created_at: '2020-01-01', updated_at: '2020-01-01' },
        { id: 2, display_name: 'No Location', home_location_text: null, created_at: '2020-01-01', updated_at: '2020-01-01' }
      ] as any)
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(MapWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers().length).toBe(1);
      expect(component.markers()[0].id).toBe(1);
      done();
    }, 10);
  });

  it('should navigate to detail page on marker click', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      component.onMarkerClick(42);
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'participants', 42]);
      done();
    }, 10);
  });

  it('should handle empty data gracefully', (done) => {
    mockDataService.getData.and.returnValue(of([] as any));

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(MapWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should handle data service errors gracefully', (done) => {
    spyOn(console, 'error');
    mockDataService.getData.and.returnValue(
      throwError(() => new Error('API Error'))
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(MapWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      expect(component.error()).toBeTruthy();
      done();
    }, 10);
  });

  it('should handle schema service errors gracefully', (done) => {
    spyOn(console, 'error');
    mockSchemaService.getProperties.and.returnValue(
      throwError(() => new Error('Schema Error'))
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(MapWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.isLoading()).toBe(false);
      expect(component.error()).toBe('Failed to load schema');
      done();
    }, 10);
  });

  it('should set loading state correctly', (done) => {
    expect(component.isLoading()).toBe(true);

    fixture.detectChanges();

    setTimeout(() => {
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should handle widget without entity_key', (done) => {
    const widgetNoEntity: DashboardWidget = {
      ...mockWidget,
      entity_key: null
    };

    fixture.componentRef.setInput('widget', widgetNoEntity);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should handle widget without mapPropertyName', (done) => {
    const widgetNoMap: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        mapPropertyName: undefined
      }
    };

    fixture.componentRef.setInput('widget', widgetNoMap);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should use display_name as marker name', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers()[0].name).toBe('Test Participant');
      done();
    }, 10);
  });

  it('should fallback to Record ID if no display_name', (done) => {
    mockDataService.getData.and.returnValue(
      of([
        {
          id: 1,
          display_name: null,
          home_location_text: 'POINT(-83.7 43.0)',
          created_at: '2020-01-01',
          updated_at: '2020-01-01'
        }
      ] as any)
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(MapWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.markers()[0].name).toBe('Record 1');
      done();
    }, 10);
  });
});
