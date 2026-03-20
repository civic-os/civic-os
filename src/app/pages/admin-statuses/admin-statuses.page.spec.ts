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
import { of } from 'rxjs';
import { AdminStatusesPage } from './admin-statuses.page';
import { StatusAdminService, StatusType, StatusValue, StatusTransition } from '../../services/status-admin.service';
import { SchemaService } from '../../services/schema.service';

describe('AdminStatusesPage', () => {
  let component: AdminStatusesPage;
  let fixture: ComponentFixture<AdminStatusesPage>;
  let mockStatusAdmin: jasmine.SpyObj<StatusAdminService>;
  let mockSchema: jasmine.SpyObj<SchemaService>;

  const mockTypes: StatusType[] = [
    { entity_type: 'issues_status', display_name: 'Issue Status', description: 'Issue statuses', status_count: 4 },
    { entity_type: 'request_status', display_name: 'Request Status', description: 'Request statuses', status_count: 3 }
  ];

  const mockStatuses: StatusValue[] = [
    { id: 1, entity_type: 'issues_status', status_key: 'open', display_name: 'Open', description: null, color: '#22C55E', sort_order: 0, is_initial: true, is_terminal: false },
    { id: 2, entity_type: 'issues_status', status_key: 'closed', display_name: 'Closed', description: null, color: '#EF4444', sort_order: 1, is_initial: false, is_terminal: true }
  ];

  const mockTransitions: StatusTransition[] = [
    {
      id: 1, entity_type: 'issues_status',
      from_status_id: 1, from_display_name: 'Open', from_color: '#22C55E',
      to_status_id: 2, to_display_name: 'Closed', to_color: '#EF4444',
      on_transition_rpc: null, display_name: 'Close', description: null,
      sort_order: 0, is_enabled: true
    }
  ];

  beforeEach(async () => {
    mockStatusAdmin = jasmine.createSpyObj('StatusAdminService', [
      'getStatusEntityTypes', 'getStatusesForEntity',
      'upsertStatusType', 'deleteStatusType',
      'upsertStatus', 'deleteStatus',
      'getTransitionsForEntity', 'upsertTransition', 'deleteTransition'
    ]);
    mockSchema = jasmine.createSpyObj('SchemaService', ['invalidateStatusCache']);

    mockStatusAdmin.getStatusEntityTypes.and.returnValue(of(mockTypes));
    mockStatusAdmin.getStatusesForEntity.and.returnValue(of(mockStatuses));
    mockStatusAdmin.getTransitionsForEntity.and.returnValue(of(mockTransitions));

    await TestBed.configureTestingModule({
      imports: [AdminStatusesPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: StatusAdminService, useValue: mockStatusAdmin },
        { provide: SchemaService, useValue: mockSchema }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AdminStatusesPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load status types on init', () => {
    expect(mockStatusAdmin.getStatusEntityTypes).toHaveBeenCalled();
    expect(component.statusTypes()).toEqual(mockTypes);
  });

  it('should auto-select first type and load statuses', () => {
    expect(component.selectedEntityType()).toBe('issues_status');
    expect(mockStatusAdmin.getStatusesForEntity).toHaveBeenCalledWith('issues_status');
    expect(component.statuses()).toEqual(mockStatuses);
  });

  it('should switch entity type and reload statuses', () => {
    component.onEntityTypeChange('request_status');
    expect(component.selectedEntityType()).toBe('request_status');
    expect(mockStatusAdmin.getStatusesForEntity).toHaveBeenCalledWith('request_status');
  });

  describe('Tab Switching', () => {
    it('should start on statuses tab', () => {
      expect(component.activeTab()).toBe('statuses');
    });

    it('should switch to transitions tab and load transitions', () => {
      component.switchTab('transitions');
      expect(component.activeTab()).toBe('transitions');
      expect(mockStatusAdmin.getTransitionsForEntity).toHaveBeenCalledWith('issues_status');
      expect(component.transitions()).toEqual(mockTransitions);
    });

    it('should switch back to statuses tab', () => {
      component.switchTab('transitions');
      component.switchTab('statuses');
      expect(component.activeTab()).toBe('statuses');
    });
  });

  describe('Status CRUD', () => {
    it('should open create status modal with defaults', () => {
      component.openCreateStatusModal();
      expect(component.showStatusModal()).toBeTrue();
      expect(component.editingStatus()).toBeNull();
      expect(component.statusForm().isInitial).toBeFalse();
      expect(component.statusForm().isTerminal).toBeFalse();
    });

    it('should open edit status modal with status data', () => {
      component.openEditStatusModal(mockStatuses[0]);
      expect(component.showStatusModal()).toBeTrue();
      expect(component.editingStatus()).toEqual(mockStatuses[0]);
      expect(component.statusForm().displayName).toBe('Open');
      expect(component.statusForm().isInitial).toBeTrue();
    });

    it('should validate display name required', () => {
      component.openCreateStatusModal();
      component.submitStatus();
      expect(component.statusError()).toContain('Display name');
    });

    it('should submit status successfully', () => {
      mockStatusAdmin.upsertStatus.and.returnValue(of({ success: true, body: { id: 3 } }));
      component.openCreateStatusModal();
      component.updateStatusFormField('displayName', 'In Progress');
      component.submitStatus();
      expect(mockStatusAdmin.upsertStatus).toHaveBeenCalledWith(
        'issues_status', 'In Progress', undefined, '#3B82F6', 2, false, false, undefined
      );
      expect(component.showStatusModal()).toBeFalse();
      expect(mockSchema.invalidateStatusCache).toHaveBeenCalledWith('issues_status');
    });

    it('should handle delete status with reference error', () => {
      mockStatusAdmin.deleteStatus.and.returnValue(of({
        success: false,
        error: { message: 'Cannot delete', humanMessage: 'Cannot delete: 10 records reference this status' }
      }));
      component.openDeleteStatusModal(mockStatuses[0]);
      component.submitDeleteStatus();
      expect(component.error()).toContain('Cannot delete');
    });
  });

  describe('Transition CRUD', () => {
    it('should open create transition modal with first two statuses', () => {
      component.openCreateTransitionModal();
      expect(component.showTransitionModal()).toBeTrue();
      expect(component.editingTransition()).toBeNull();
      expect(component.transitionForm().fromStatusId).toBe(1);
      expect(component.transitionForm().toStatusId).toBe(2);
    });

    it('should open edit transition modal with transition data', () => {
      component.openEditTransitionModal(mockTransitions[0]);
      expect(component.showTransitionModal()).toBeTrue();
      expect(component.editingTransition()).toEqual(mockTransitions[0]);
      expect(component.transitionForm().displayName).toBe('Close');
    });

    it('should validate from and to statuses are different', () => {
      component.openCreateTransitionModal();
      component.updateTransitionStatusId('fromStatusId', 1);
      component.updateTransitionStatusId('toStatusId', 1);
      component.submitTransition();
      expect(component.transitionError()).toContain('different');
    });

    it('should submit transition successfully', () => {
      mockStatusAdmin.upsertTransition.and.returnValue(of({ success: true, body: { id: 2 } }));
      component.openCreateTransitionModal();
      component.updateTransitionFormField('displayName', 'Reopen');
      component.submitTransition();
      expect(mockStatusAdmin.upsertTransition).toHaveBeenCalled();
      expect(component.showTransitionModal()).toBeFalse();
    });

    it('should delete transition', () => {
      mockStatusAdmin.deleteTransition.and.returnValue(of({ success: true }));
      component.openDeleteTransitionModal(mockTransitions[0]);
      component.submitDeleteTransition();
      expect(mockStatusAdmin.deleteTransition).toHaveBeenCalledWith(1);
      expect(component.showDeleteTransitionModal()).toBeFalse();
    });
  });

  describe('Type CRUD', () => {
    it('should open and close type modal', () => {
      component.openCreateTypeModal();
      expect(component.showTypeModal()).toBeTrue();
      component.closeTypeModal();
      expect(component.showTypeModal()).toBeFalse();
    });

    it('should delete type and invalidate cache', () => {
      mockStatusAdmin.deleteStatusType.and.returnValue(of({ success: true }));
      // After delete, loadTypes returns empty so selectedEntityType stays undefined
      mockStatusAdmin.getStatusEntityTypes.and.returnValue(of([]));
      component.openDeleteTypeModal();
      component.submitDeleteType();
      expect(mockStatusAdmin.deleteStatusType).toHaveBeenCalledWith('issues_status');
      expect(mockSchema.invalidateStatusCache).toHaveBeenCalledWith('issues_status');
      expect(component.selectedEntityType()).toBeUndefined();
    });
  });
});
