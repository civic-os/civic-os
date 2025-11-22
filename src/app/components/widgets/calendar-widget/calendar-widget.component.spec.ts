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

describe('CalendarWidgetComponent', () => {
  let component: CalendarWidgetComponent;
  let fixture: ComponentFixture<CalendarWidgetComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockAuthService: jasmine.SpyObj<AuthService>;
  let mockRouter: jasmine.SpyObj<Router>;

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
    mockDataService = jasmine.createSpyObj('DataService', ['getData']);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getProperties']);
    mockAuthService = jasmine.createSpyObj('AuthService', ['hasPermission']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate', 'createUrlTree', 'serializeUrl']);

    // Default mock responses
    mockDataService.getData.and.returnValue(of(mockRecords as any));
    mockSchemaService.getProperties.and.returnValue(of(mockProperties as any));
    mockAuthService.hasPermission.and.returnValue(of(true)); // Default: user has permission
    mockRouter.createUrlTree.and.returnValue({} as any);
    mockRouter.serializeUrl.and.returnValue('/view/reservations/1');

    await TestBed.configureTestingModule({
      imports: [CalendarWidgetComponent],
      providers: [
        provideZonelessChangeDetection(),
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

  it('should fetch entity properties and data', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(mockSchemaService.getProperties).toHaveBeenCalled();
      expect(mockDataService.getData).toHaveBeenCalled();
      done();
    }, 10);
  });

  it('should transform records to calendar events', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events().length).toBe(1);
      expect(component.events()[0].id).toBe(1);
      expect(component.events()[0].title).toBe('Test Reservation');
      expect(component.events()[0].color).toBe('#10B981');
      expect(component.events()[0].start).toEqual(new Date('2025-03-15T14:00:00Z'));
      expect(component.events()[0].end).toEqual(new Date('2025-03-15T16:00:00Z'));
      done();
    }, 10);
  });

  it('should filter out records without time_slot', (done) => {
    mockDataService.getData.and.returnValue(
      of([
        { id: 1, display_name: 'Has Slot', time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")', status_color: '#10B981' },
        { id: 2, display_name: 'No Slot', time_slot: null, status_color: '#EF4444' }
      ] as any)
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(CalendarWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events().length).toBe(1);
      expect(component.events()[0].id).toBe(1);
      done();
    }, 10);
  });

  it('should open detail page in new tab on event click', () => {
    spyOn(window, 'open');
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

  it('should update date range and refetch on date range change', (done) => {
    fixture.detectChanges();

    const newRange = {
      start: new Date('2025-03-10T00:00:00Z'),
      end: new Date('2025-03-17T00:00:00Z')
    };

    // Call count before change
    const initialCallCount = mockDataService.getData.calls.count();

    component.onDateRangeChange(newRange);

    setTimeout(() => {
      expect(component.dateRange()).toEqual(newRange);
      // Should have been called again due to dateRange signal change
      expect(mockDataService.getData.calls.count()).toBeGreaterThan(initialCallCount);
      done();
    }, 10);
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

  it('should handle empty data gracefully', (done) => {
    mockDataService.getData.and.returnValue(of([] as any));

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(CalendarWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events().length).toBe(0);
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
    fixture = TestBed.createComponent(CalendarWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events().length).toBe(0);
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
    fixture = TestBed.createComponent(CalendarWidgetComponent);
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
      entity_key: null,
      config: {
        ...mockWidget.config,
        entityKey: ''
      }
    };

    fixture.componentRef.setInput('widget', widgetNoEntity);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      expect(component.error()).toContain('Missing required configuration');
      done();
    }, 10);
  });

  it('should handle widget without timeSlotPropertyName', (done) => {
    const widgetNoTimeSlot: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        timeSlotPropertyName: undefined as any
      }
    };

    fixture.componentRef.setInput('widget', widgetNoTimeSlot);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      expect(component.error()).toContain('Missing required configuration');
      done();
    }, 10);
  });

  it('should use display_name as event title', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events()[0].title).toBe('Test Reservation');
      done();
    }, 10);
  });

  it('should fallback to Record ID if no display_name', (done) => {
    mockDataService.getData.and.returnValue(
      of([
        {
          id: 1,
          display_name: null,
          time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")',
          status_color: '#10B981'
        }
      ] as any)
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(CalendarWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events()[0].title).toBe('Record 1');
      done();
    }, 10);
  });

  it('should use defaultColor when colorProperty is not set', (done) => {
    const widgetNoColor: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        colorProperty: undefined
      }
    };

    fixture.componentRef.setInput('widget', widgetNoColor);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events()[0].color).toBe('#3B82F6');
      done();
    }, 10);
  });

  it('should use defaultColor when record has no color value', (done) => {
    mockDataService.getData.and.returnValue(
      of([
        {
          id: 1,
          display_name: 'No Color',
          time_slot: '["2025-03-15 14:00:00+00","2025-03-15 16:00:00+00")',
          status_color: null
        }
      ] as any)
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(CalendarWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.events()[0].color).toBe('#3B82F6');
      done();
    }, 10);
  });

  it('should handle invalid tstzrange format gracefully', (done) => {
    spyOn(console, 'error');
    mockDataService.getData.and.returnValue(
      of([
        {
          id: 1,
          display_name: 'Invalid Format',
          time_slot: 'invalid-range-format',
          status_color: '#10B981'
        }
      ] as any)
    );

    // Re-create component to pick up new mock
    fixture = TestBed.createComponent(CalendarWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      // Should still create event with placeholder dates
      expect(component.events().length).toBe(1);
      expect(console.error).toHaveBeenCalled();
      done();
    }, 10);
  });

  // Permission checking tests
  it('should show create button when showCreateButton is true and user has permission', (done) => {
    const widgetWithButton: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        showCreateButton: true
      }
    };

    mockAuthService.hasPermission.and.returnValue(of(true));

    fixture.componentRef.setInput('widget', widgetWithButton);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.canShowCreateButton()).toBe(true);
      expect(mockAuthService.hasPermission).toHaveBeenCalledWith('reservations', 'create');
      done();
    }, 10);
  });

  it('should hide create button when showCreateButton is false even if user has permission', (done) => {
    const widgetNoButton: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        showCreateButton: false
      }
    };

    mockAuthService.hasPermission.and.returnValue(of(true));

    fixture.componentRef.setInput('widget', widgetNoButton);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.canShowCreateButton()).toBe(false);
      done();
    }, 10);
  });

  it('should hide create button when showCreateButton is true but user lacks permission', (done) => {
    const widgetWithButton: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        showCreateButton: true
      }
    };

    mockAuthService.hasPermission.and.returnValue(of(false));

    // Re-create component to pick up new permission mock
    fixture = TestBed.createComponent(CalendarWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', widgetWithButton);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.canShowCreateButton()).toBe(false);
      expect(mockAuthService.hasPermission).toHaveBeenCalledWith('reservations', 'create');
      done();
    }, 10);
  });

  it('should check permission for correct entity key', (done) => {
    const customWidget: DashboardWidget = {
      ...mockWidget,
      entity_key: 'appointments',
      config: {
        ...mockWidget.config,
        entityKey: 'appointments',
        showCreateButton: true
      }
    };

    mockAuthService.hasPermission.and.returnValue(of(true));

    fixture.componentRef.setInput('widget', customWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(mockAuthService.hasPermission).toHaveBeenCalledWith('appointments', 'create');
      done();
    }, 10);
  });

  describe('Filter Application', () => {
    it('should apply static filters to query', (done) => {
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

      setTimeout(() => {
        expect(mockDataService.getData).toHaveBeenCalled();
        const query: DataQuery = mockDataService.getData.calls.mostRecent().args[0];
        expect(query.filters).toBeDefined();
        expect(query.filters?.some((f: FilterCriteria) =>
          f.column === 'status' && f.operator === 'neq' && f.value === 'cancelled'
        )).toBe(true);
        done();
      }, 10);
    });

    it('should combine static filters with date range filter', (done) => {
      const widgetWithFilters: DashboardWidget = {
        ...mockWidget,
        config: {
          ...mockWidget.config,
          filters: [{ column: 'resource_id', operator: 'eq', value: 5 }]
        }
      };

      fixture.componentRef.setInput('widget', widgetWithFilters);
      fixture.detectChanges();

      setTimeout(() => {
        component.onDateRangeChange({
          start: new Date('2025-03-10T00:00:00Z'),
          end: new Date('2025-03-17T00:00:00Z')
        });

        setTimeout(() => {
          const query: DataQuery = mockDataService.getData.calls.mostRecent().args[0];
          expect(query.filters?.length).toBe(2); // static + date range
          expect(query.filters?.some((f: FilterCriteria) =>
            f.column === 'resource_id' && f.operator === 'eq' && f.value === 5
          )).toBe(true);
          expect(query.filters?.some((f: FilterCriteria) =>
            f.column === 'time_slot' && f.operator === 'ov'
          )).toBe(true);
          done();
        }, 10);
      }, 10);
    });
  });

  describe('Deduplication', () => {
    it('should prevent duplicate requests with same params', (done) => {
      fixture.detectChanges();

      setTimeout(() => {
        const initialCallCount = mockDataService.getData.calls.count();

        // Trigger same request (no change to config or dateRange)
        const currentRange = component.dateRange();
        if (currentRange) {
          component.onDateRangeChange(currentRange);

          setTimeout(() => {
            expect(mockDataService.getData.calls.count()).toBe(initialCallCount);
            done();
          }, 10);
        } else {
          done();
        }
      }, 10);
    });

    it('should allow new request when params change', (done) => {
      fixture.detectChanges();

      setTimeout(() => {
        const initialCallCount = mockDataService.getData.calls.count();

        // Change date range
        component.onDateRangeChange({
          start: new Date('2025-04-01T00:00:00Z'),
          end: new Date('2025-04-08T00:00:00Z')
        });

        setTimeout(() => {
          expect(mockDataService.getData.calls.count()).toBeGreaterThan(initialCallCount);
          done();
        }, 10);
      }, 10);
    });
  });
});
