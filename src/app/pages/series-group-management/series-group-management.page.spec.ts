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
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { SeriesGroupManagementPage } from './series-group-management.page';
import { RecurringService } from '../../services/recurring.service';
import { SchemaService } from '../../services/schema.service';
import { AuthService } from '../../services/auth.service';
import { SeriesGroup } from '../../interfaces/entity';
import { of } from 'rxjs';

describe('SeriesGroupManagementPage', () => {
  let component: SeriesGroupManagementPage;
  let fixture: ComponentFixture<SeriesGroupManagementPage>;
  let mockRecurringService: jasmine.SpyObj<RecurringService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockAuthService: jasmine.SpyObj<AuthService>;
  let mockRouter: jasmine.SpyObj<Router>;

  const mockGroups: SeriesGroup[] = [
    {
      id: 1,
      display_name: 'Weekly Yoga',
      description: 'Monday yoga in Room A',
      entity_table: 'reservations',
      color: '#3B82F6',
      versions: [{ id: 1, terminated_at: null } as any],
      active_instance_count: 10
    } as SeriesGroup,
    {
      id: 2,
      display_name: 'Monthly Staff Meeting',
      description: 'All-hands meeting',
      entity_table: 'events',
      color: '#EF4444',
      versions: [{ id: 2, terminated_at: '2026-03-01' } as any],
      active_instance_count: 0
    } as SeriesGroup,
    {
      id: 3,
      display_name: 'Daily Standup',
      description: null,
      entity_table: 'reservations',
      color: null,
      versions: [{ id: 3, terminated_at: null } as any],
      active_instance_count: 20
    } as SeriesGroup
  ];

  function createTestBed(routeParams: any = {}) {
    mockRecurringService = jasmine.createSpyObj('RecurringService', [
      'getSeriesGroups',
      'getSeriesGroupDetail',
      'deleteSeriesGroup',
      'describeRRule',
      'splitSeries',
      'updateSeriesGroupInfo',
      'updateSeriesSchedule',
      'updateSeriesTemplate'
    ]);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getEntities', 'getProperties']);
    mockAuthService = jasmine.createSpyObj('AuthService', ['hasPermission']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);

    mockRecurringService.getSeriesGroups.and.returnValue(of(mockGroups));
    mockRecurringService.getSeriesGroupDetail.and.returnValue(of(mockGroups[0]));
    mockRecurringService.describeRRule.and.returnValue('Weekly');
    mockSchemaService.getEntities.and.returnValue(of([]));
    mockSchemaService.getProperties.and.returnValue(of([]));
    mockAuthService.hasPermission.and.returnValue(true);

    return TestBed.configureTestingModule({
      imports: [SeriesGroupManagementPage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: RecurringService, useValue: mockRecurringService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: Router, useValue: mockRouter },
        { provide: ActivatedRoute, useValue: { params: of(routeParams) } }
      ]
    }).compileComponents();
  }

  beforeEach(async () => {
    await createTestBed();
    fixture = TestBed.createComponent(SeriesGroupManagementPage);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('ngOnInit', () => {
    it('should load groups when read permission is granted', () => {
      fixture.detectChanges();

      expect(mockAuthService.hasPermission).toHaveBeenCalledWith('time_slot_series_groups', 'read');
      expect(mockAuthService.hasPermission).toHaveBeenCalledWith('time_slot_series_groups', 'create');
      expect(mockRecurringService.getSeriesGroups).toHaveBeenCalled();
      expect(component.groups().length).toBe(3);
      expect(component.loading()).toBe(false);
    });

    it('should not load groups when read permission is denied', () => {
      mockAuthService.hasPermission.and.callFake((_table: string, action: string) => {
        return false;
      });

      fixture.detectChanges();

      expect(component.hasPermission()).toBe(false);
      expect(component.loading()).toBe(false);
      expect(mockRecurringService.getSeriesGroups).not.toHaveBeenCalled();
    });

    it('should extract entity types from loaded groups', () => {
      fixture.detectChanges();

      const types = component.entityTypes();
      expect(types).toContain('reservations');
      expect(types).toContain('events');
      expect(types.length).toBe(2);
    });
  });

  describe('filtering', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should filter by entity type', () => {
      component.onEntityTypeChange('reservations');

      const filtered = component.filteredGroups();
      expect(filtered.length).toBe(2);
      expect(filtered.every(g => g.entity_table === 'reservations')).toBe(true);
    });

    it('should show all groups when filter is cleared', () => {
      component.onEntityTypeChange('reservations');
      expect(component.filteredGroups().length).toBe(2);

      component.onEntityTypeChange('');
      expect(component.filteredGroups().length).toBe(3);
    });

    it('should filter by search query (display_name)', () => {
      component.onSearchChange('yoga');

      const filtered = component.filteredGroups();
      expect(filtered.length).toBe(1);
      expect(filtered[0].display_name).toBe('Weekly Yoga');
    });

    it('should filter by search query (description)', () => {
      component.onSearchChange('all-hands');

      const filtered = component.filteredGroups();
      expect(filtered.length).toBe(1);
      expect(filtered[0].display_name).toBe('Monthly Staff Meeting');
    });

    it('should be case-insensitive', () => {
      component.onSearchChange('YOGA');

      expect(component.filteredGroups().length).toBe(1);
    });

    it('should clear all filters', () => {
      component.onSearchChange('yoga');
      component.onEntityTypeChange('reservations');
      component.onStatusChange('active');

      component.clearFilters();

      expect(component.searchQuery()).toBe('');
      expect(component.entityTypeFilter()).toBe('');
      expect(component.statusFilter()).toBe('');
      expect(component.filteredGroups().length).toBe(3);
    });
  });

  describe('isGroupActive', () => {
    it('should return true when group has active versions', () => {
      const group = { versions: [{ id: 1, terminated_at: null }] } as any;
      expect(component.isGroupActive(group)).toBe(true);
    });

    it('should return false when all versions are terminated', () => {
      const group = { versions: [{ id: 1, terminated_at: '2026-01-01' }] } as any;
      expect(component.isGroupActive(group)).toBe(false);
    });

    it('should return true when no versions array', () => {
      const group = {} as any;
      expect(component.isGroupActive(group)).toBe(true);
    });
  });

  describe('selectGroup', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should set selected group ID and load detail', () => {
      component.selectGroup(mockGroups[0]);

      expect(component.selectedGroupId()).toBe(1);
      expect(mockRecurringService.getSeriesGroupDetail).toHaveBeenCalledWith(1);
      expect(mockRouter.navigate).toHaveBeenCalledWith(
        ['/admin/recurring-schedules', 1],
        { replaceUrl: true }
      );
    });
  });

  describe('route param group selection', () => {
    it('should select group from route params', async () => {
      TestBed.resetTestingModule();
      await createTestBed({ groupId: '42' });

      fixture = TestBed.createComponent(SeriesGroupManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      expect(component.selectedGroupId()).toBe(42);
      expect(mockRecurringService.getSeriesGroupDetail).toHaveBeenCalledWith(42);
    });
  });
});
