/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { EntityActionPanelComponent } from './entity-action-panel.component';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryService } from '../../services/gallery.service';
import { EntityAction } from '../../interfaces/entity';

describe('EntityActionPanelComponent', () => {
  let component: EntityActionPanelComponent;
  let fixture: ComponentFixture<EntityActionPanelComponent>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockFileUploadService: jasmine.SpyObj<FileUploadService>;
  let mockGalleryService: jasmine.SpyObj<GalleryService>;

  const mockAction: EntityAction = {
    id: 1,
    table_name: 'civic_os_users',
    action_name: 'test_action',
    display_name: 'Test Action',
    rpc_function: 'test_user_action',
    icon: 'science',
    button_style: 'primary',
    sort_order: 1,
    requires_confirmation: true,
    confirmation_message: 'Run the test action?',
    refresh_after_action: true,
    show_on_detail: true,
    can_execute: true,
    parameters: []
  };

  const mockActionNoConfirm: EntityAction = {
    ...mockAction,
    id: 2,
    action_name: 'quick_action',
    display_name: 'Quick Action',
    rpc_function: 'quick_action_rpc',
    requires_confirmation: false
  };

  const mockActionWithVisibility: EntityAction = {
    ...mockAction,
    id: 3,
    action_name: 'conditional_action',
    display_name: 'Conditional Action',
    visibility_condition: { field: 'status', operator: 'eq', value: 'active' }
  };

  const mockActionWithEnabled: EntityAction = {
    ...mockAction,
    id: 4,
    action_name: 'enabled_action',
    display_name: 'Enabled Action',
    enabled_condition: { field: 'amount', operator: 'gt', value: 0 },
    disabled_tooltip: 'Amount must be greater than 0'
  };

  const mockEntityData: Record<string, any> = {
    id: 'user-123',
    display_name: 'Test User',
    status: 'active',
    amount: 100
  };

  beforeEach(async () => {
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getEntityActions']);
    mockDataService = jasmine.createSpyObj('DataService', ['executeRpc', 'callRpc', 'getData']);
    mockFileUploadService = jasmine.createSpyObj('FileUploadService', ['uploadFile', 'validateFile']);
    mockGalleryService = jasmine.createSpyObj('GalleryService', ['getConfig']);

    mockSchemaService.getEntityActions.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [EntityActionPanelComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService },
        { provide: FileUploadService, useValue: mockFileUploadService },
        { provide: GalleryService, useValue: mockGalleryService }
      ]
    }).compileComponents();
  });

  function createComponent(actions: EntityAction[] = [], data: Record<string, any> = mockEntityData): void {
    mockSchemaService.getEntityActions.and.returnValue(of(actions));
    fixture = TestBed.createComponent(EntityActionPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('tableName', 'civic_os_users');
    fixture.componentRef.setInput('entityId', 'user-123');
    fixture.componentRef.setInput('entityData', data);
  }

  describe('Component Creation', () => {
    it('should create', async () => {
      createComponent();
      await fixture.whenStable();
      expect(component).toBeTruthy();
    });

    it('should fetch actions for the given tableName', async () => {
      createComponent([mockAction]);
      await fixture.whenStable();
      expect(mockSchemaService.getEntityActions).toHaveBeenCalledWith('civic_os_users');
    });
  });

  describe('Action Button Assembly', () => {
    it('should show no buttons when no actions exist', async () => {
      createComponent([]);
      await fixture.whenStable();
      expect(component.actionButtons().length).toBe(0);
    });

    it('should create buttons for visible actions', async () => {
      createComponent([mockAction]);
      await fixture.whenStable();
      expect(component.actionButtons().length).toBe(1);
      expect(component.actionButtons()[0].id).toBe('action:test_action');
      expect(component.actionButtons()[0].label).toBe('Test Action');
      expect(component.actionButtons()[0].style).toBe('btn-primary');
    });

    it('should filter out actions where can_execute is false', async () => {
      const noExecAction = { ...mockAction, can_execute: false };
      createComponent([noExecAction]);
      await fixture.whenStable();
      expect(component.actionButtons().length).toBe(0);
    });

    it('should filter out actions failing visibility_condition', async () => {
      createComponent([mockActionWithVisibility], { ...mockEntityData, status: 'inactive' });
      await fixture.whenStable();
      expect(component.actionButtons().length).toBe(0);
    });

    it('should show action when visibility_condition passes', async () => {
      createComponent([mockActionWithVisibility], { ...mockEntityData, status: 'active' });
      await fixture.whenStable();
      expect(component.actionButtons().length).toBe(1);
    });

    it('should disable button when enabled_condition fails', async () => {
      createComponent([mockActionWithEnabled], { ...mockEntityData, amount: 0 });
      await fixture.whenStable();
      expect(component.actionButtons()[0].disabled).toBe(true);
      expect(component.actionButtons()[0].tooltip).toBe('Amount must be greater than 0');
    });

    it('should enable button when enabled_condition passes', async () => {
      createComponent([mockActionWithEnabled], { ...mockEntityData, amount: 100 });
      await fixture.whenStable();
      expect(component.actionButtons()[0].disabled).toBe(false);
    });
  });

  describe('Confirmation Action Flow', () => {
    it('should open modal for confirmation actions', async () => {
      createComponent([mockAction]);
      await fixture.whenStable();

      component.onActionButtonClick('action:test_action');
      expect(component.showActionModal()).toBe(true);
      expect(component.currentAction()?.action_name).toBe('test_action');
    });

    it('should close modal and reset state', async () => {
      createComponent([mockAction]);
      await fixture.whenStable();

      component.onActionButtonClick('action:test_action');
      expect(component.showActionModal()).toBe(true);

      component.closeActionModal();
      expect(component.showActionModal()).toBe(false);
      expect(component.currentAction()).toBeUndefined();
      expect(component.actionError()).toBeUndefined();
      expect(component.actionSuccess()).toBeUndefined();
    });

    it('should execute RPC on confirm and emit actionExecuted', async () => {
      mockDataService.executeRpc.and.returnValue(of({
        success: true,
        body: { success: true, message: 'Done!' }
      }));

      createComponent([mockAction]);
      await fixture.whenStable();

      spyOn(component.actionExecuted, 'emit');

      component.onActionButtonClick('action:test_action');
      await component.confirmEntityAction();

      expect(mockDataService.executeRpc).toHaveBeenCalledWith('test_user_action', {
        p_entity_id: 'user-123'
      });
      expect(component.actionSuccess()).toBe('Done!');
    });

    it('should show error on RPC failure', async () => {
      mockDataService.executeRpc.and.returnValue(of({
        success: false,
        error: { httpCode: 400, message: 'Failed', humanMessage: 'Something went wrong' }
      }));

      createComponent([mockAction]);
      await fixture.whenStable();

      component.onActionButtonClick('action:test_action');
      await component.confirmEntityAction();

      expect(component.actionError()).toBe('Something went wrong');
    });
  });

  describe('Non-Confirmation Action Flow', () => {
    it('should show overlay and execute immediately for non-confirmation actions', async () => {
      mockDataService.executeRpc.and.returnValue(of({
        success: true,
        body: { success: true, message: 'Quick done!' }
      }));

      createComponent([mockActionNoConfirm]);
      await fixture.whenStable();

      component.onActionButtonClick('action:quick_action');
      expect(component.showActionModal()).toBe(false);
      // After RPC completes, overlay should clear
      expect(component.actionOverlayLoading()).toBe(false);
    });
  });

  describe('Parameter Form', () => {
    const actionWithParams: EntityAction = {
      ...mockAction,
      parameters: [
        {
          id: 1,
          param_name: 'p_reason',
          display_name: 'Reason',
          param_type: 'text',
          required: true,
          sort_order: 1
        },
        {
          id: 2,
          param_name: 'p_amount',
          display_name: 'Amount',
          param_type: 'number',
          required: false,
          sort_order: 2
        }
      ]
    };

    it('should build param form with validators', async () => {
      createComponent([actionWithParams]);
      await fixture.whenStable();

      component.onActionButtonClick('action:test_action');

      const form = component.actionParamForm();
      expect(form).toBeTruthy();
      expect(form!.get('p_reason')).toBeTruthy();
      expect(form!.get('p_amount')).toBeTruthy();

      // Required validator on p_reason
      form!.get('p_reason')!.setValue(null);
      expect(form!.get('p_reason')!.hasError('required')).toBe(true);
    });

    it('should not confirm when form is invalid', async () => {
      createComponent([actionWithParams]);
      await fixture.whenStable();

      component.onActionButtonClick('action:test_action');
      // Leave required field empty
      await component.confirmEntityAction();

      expect(mockDataService.executeRpc).not.toHaveBeenCalled();
    });

    it('should pass param values to RPC', async () => {
      mockDataService.executeRpc.and.returnValue(of({
        success: true,
        body: { success: true, message: 'Done' }
      }));

      createComponent([actionWithParams]);
      await fixture.whenStable();

      component.onActionButtonClick('action:test_action');
      const form = component.actionParamForm()!;
      form.get('p_reason')!.setValue('Test reason');
      form.get('p_amount')!.setValue('42');

      await component.confirmEntityAction();

      expect(mockDataService.executeRpc).toHaveBeenCalledWith('test_user_action', {
        p_entity_id: 'user-123',
        p_reason: 'Test reason',
        p_amount: 42  // converted to number
      });
    });
  });

  describe('Button ID Filtering', () => {
    it('should ignore non-action button IDs', async () => {
      createComponent([mockAction]);
      await fixture.whenStable();

      component.onActionButtonClick('edit');
      expect(component.showActionModal()).toBe(false);

      component.onActionButtonClick('delete');
      expect(component.showActionModal()).toBe(false);
    });
  });

  describe('Utility Methods', () => {
    it('should return correct file accept for param types', async () => {
      createComponent([mockAction]);
      await fixture.whenStable();
      expect(component.getFileAcceptForParam({ file_type: 'image' } as any)).toBe('image/*');
      expect(component.getFileAcceptForParam({ file_type: 'pdf' } as any)).toBe('application/pdf');
      expect(component.getFileAcceptForParam({ file_type: 'any' } as any)).toBe('*/*');
      expect(component.getFileAcceptForParam(undefined)).toBe('*/*');
    });

    it('should always return display_name for param display column', async () => {
      createComponent([mockAction]);
      await fixture.whenStable();
      expect(component.getParamDisplayColumn({} as any)).toBe('display_name');
    });
  });
});
