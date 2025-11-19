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
import { MapWidgetComponent } from './map-widget.component';
import { DataService } from '../../../services/data.service';
import { DashboardWidget } from '../../../interfaces/dashboard';

describe('MapWidgetComponent', () => {
  let component: MapWidgetComponent;
  let fixture: ComponentFixture<MapWidgetComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;
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

  beforeEach(async () => {
    mockDataService = jasmine.createSpyObj('DataService', ['getData']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);

    // Default mock response
    mockDataService.getData.and.returnValue(
      of({
        data: [
          {
            id: 1,
            display_name: 'Test Participant',
            home_location_text: 'POINT(-83.7 43.0)',
            enrolled_date: '2020-01-01'
          }
        ],
        totalCount: 1
      })
    );

    await TestBed.configureTestingModule({
      imports: [MapWidgetComponent],
      providers: [
        { provide: DataService, useValue: mockDataService },
        { provide: Router, useValue: mockRouter }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(MapWidgetComponent);
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
    expect(config.entityKey).toBe('participants');
    expect(config.mapPropertyName).toBe('home_location');
  });

  it('should provide defaults for optional config fields', () => {
    const config = component.config();
    expect(config.maxMarkers).toBe(500);
    expect(config.enableClustering).toBe(false);
    expect(config.clusterRadius).toBe(50);
  });

  it('should fetch entity data with correct columns', (done) => {
    component.markers$.subscribe(markers => {
      expect(mockDataService.getData).toHaveBeenCalledWith(
        'participants',
        jasmine.arrayContaining(['id', 'display_name', 'home_location_text', 'enrolled_date']),
        [],
        undefined,
        500
      );
      done();
    });
  });

  it('should transform records to markers', (done) => {
    component.markers$.subscribe(markers => {
      expect(markers.length).toBe(1);
      expect(markers[0].id).toBe(1);
      expect(markers[0].name).toBe('Test Participant');
      expect(markers[0].wkt).toBe('POINT(-83.7 43.0)');
      done();
    });
  });

  it('should filter out records without geography', (done) => {
    mockDataService.getData.and.returnValue(
      of({
        data: [
          { id: 1, display_name: 'Has Location', home_location_text: 'POINT(-83.7 43.0)' },
          { id: 2, display_name: 'No Location', home_location_text: null }
        ],
        totalCount: 2
      })
    );

    component.markers$.subscribe(markers => {
      expect(markers.length).toBe(1);
      expect(markers[0].id).toBe(1);
      done();
    });
  });

  it('should navigate to detail page on marker click', () => {
    component.onMarkerClick(42);
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'participants', 42]);
  });

  it('should handle empty data gracefully', (done) => {
    mockDataService.getData.and.returnValue(
      of({ data: [], totalCount: 0 })
    );

    component.markers$.subscribe(markers => {
      expect(markers.length).toBe(0);
      done();
    });
  });

  it('should handle errors gracefully', (done) => {
    mockDataService.getData.and.returnValue(
      new Observable(subscriber => {
        subscriber.error(new Error('API Error'));
      })
    );

    component.markers$.subscribe(markers => {
      expect(markers.length).toBe(0);
      done();
    });
  });
});
