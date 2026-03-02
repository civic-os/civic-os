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
import { ActivatedRoute } from '@angular/router';
import { provideRouter } from '@angular/router';
import { DetailPage } from './detail.page';
import { Router } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AuthService } from '../../services/auth.service';
import { RecurringService } from '../../services/recurring.service';
import { NavigationService } from '../../services/navigation.service';
import { FileUploadService } from '../../services/file-upload.service';
import { BehaviorSubject, of } from 'rxjs';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { EntityPropertyType, EntityAction, EntityActionParam } from '../../interfaces/entity';

describe('DetailPage', () => {
  let component: DetailPage;
  let fixture: ComponentFixture<DetailPage>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockAuthService: jasmine.SpyObj<AuthService>;
  let mockRecurringService: jasmine.SpyObj<RecurringService>;
  let mockNavigationService: jasmine.SpyObj<NavigationService>;
  let mockFileUploadService: jasmine.SpyObj<FileUploadService>;
  let routeParams: BehaviorSubject<any>;

  beforeEach(async () => {
    routeParams = new BehaviorSubject({ entityKey: 'Issue', entityId: '42' });

    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntity',
      'getPropsForDetail',
      'getDetailRenderables',
      'getInverseRelationships',
      'getEntities',
      'getEntityActions'
    ]);
    mockDataService = jasmine.createSpyObj('DataService', ['getData', 'getInverseRelationshipData', 'executeRpc']);
    mockAuthService = jasmine.createSpyObj('AuthService', ['login', 'isAdmin'], {
      authenticated: signal(false)
    });
    mockAuthService.isAdmin.and.returnValue(false);
    mockRecurringService = jasmine.createSpyObj('RecurringService', [
      'getSeriesMembership',
      'cancelOccurrence',
      'splitSeries',
      'deleteSeriesGroup'
    ]);
    mockNavigationService = jasmine.createSpyObj('NavigationService', ['goBack']);
    mockFileUploadService = jasmine.createSpyObj('FileUploadService', ['validateFile', 'uploadFile']);
    mockFileUploadService.validateFile.and.returnValue(null);

    // Default mock for series membership - not a member
    mockRecurringService.getSeriesMembership.and.returnValue(of({ is_member: false }));

    // Default mock for getEntity to prevent afterAll stream errors during teardown
    mockSchemaService.getEntity.and.returnValue(of(undefined));

    // Default mocks for inverse relationships
    mockSchemaService.getInverseRelationships.and.returnValue(of([]));
    mockSchemaService.getEntities.and.returnValue(of([
      MOCK_ENTITIES.issue,
      MOCK_ENTITIES.status
    ]));

    // Setup default for renderables (most tests use properties$ directly)
    mockSchemaService.getDetailRenderables.and.returnValue(of([]));

    // Default mock for entity actions (returns empty array)
    mockSchemaService.getEntityActions.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [DetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { params: routeParams.asObservable() } },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: RecurringService, useValue: mockRecurringService },
        { provide: NavigationService, useValue: mockNavigationService },
        { provide: FileUploadService, useValue: mockFileUploadService }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DetailPage);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('Observable Chain Integration', () => {
    it('should load entity metadata from route params', (done) => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of([]));
      mockDataService.getData.and.returnValue(of([] as any));

      component.entity$.subscribe(entity => {
        expect(entity).toBeDefined();
        expect(entity?.table_name).toBe('Issue');
        expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
        done();
      });
    });

    it('should store entityKey and entityId from route params', (done) => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of([]));
      mockDataService.getData.and.returnValue(of([] as any));

      component.entity$.subscribe(() => {
        expect(component.entityKey).toBe('Issue');
        expect(component.entityId).toBe('42');
        done();
      });
    });

    it('should return undefined when entityKey is missing', (done) => {
      routeParams.next({ entityId: '42' });
      mockSchemaService.getEntity.and.returnValue(of(undefined));

      component.entity$.subscribe(entity => {
        expect(entity).toBeUndefined();
        expect(mockSchemaService.getEntity).not.toHaveBeenCalled();
        done();
      });
    });

    it('should fetch properties for detail view', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.foreignKey,
        MOCK_PROPERTIES.geoPoint
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of([{}] as any));

      component.properties$.subscribe(props => {
        expect(props.length).toBe(3);
        expect(mockSchemaService.getPropsForDetail).toHaveBeenCalledWith(MOCK_ENTITIES.issue);
        done();
      });
    });

    it('should return empty array when entity is undefined', (done) => {
      routeParams.next({});
      mockSchemaService.getEntity.and.returnValue(of(undefined));

      component.properties$.subscribe(props => {
        expect(props).toEqual([]);
        expect(mockSchemaService.getPropsForDetail).not.toHaveBeenCalled();
        done();
      });
    });

    it('should build PostgREST query with entityId filter', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.foreignKey
      ];
      const mockData = [
        {
          id: 42,
          created_at: '',
          updated_at: '',
          display_name: 'Test Issue',
          name: 'Test Issue',
          status_id: { id: 1, display_name: 'Open' }
        }
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of(mockData));

      component.data$.subscribe(data => {
        expect(mockDataService.getData).toHaveBeenCalledWith({
          key: 'Issue',
          fields: ['name', 'status_id:Status!status_id(id,display_name)'],
          entityId: '42'
        });
        done();
      });
    });

    it('should extract first item from data array', (done) => {
      const mockProps = [MOCK_PROPERTIES.textShort];
      const mockData = [
        { id: 42, name: 'First Item', created_at: '', updated_at: '', display_name: 'First Item' },
        { id: 43, name: 'Second Item', created_at: '', updated_at: '', display_name: 'Second Item' }
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of(mockData));

      component.data$.subscribe(data => {
        expect(data).toEqual(jasmine.objectContaining({ id: 42, name: 'First Item' }));
        done();
      });
    });

    it('should return undefined when no data found', (done) => {
      const mockProps = [MOCK_PROPERTIES.textShort];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of([]));

      component.data$.subscribe(data => {
        expect(data).toBeUndefined();
        done();
      });
    });

    it('should handle string entityId values', (done) => {
      routeParams.next({ entityKey: 'Issue', entityId: 'abc-123-uuid' });
      const mockProps = [MOCK_PROPERTIES.textShort];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of([{
        id: 'abc-123-uuid' as any,
        name: 'Test',
        created_at: '',
        updated_at: '',
        display_name: 'Test'
      }]));

      component.data$.subscribe(() => {
        expect(mockDataService.getData).toHaveBeenCalledWith(
          jasmine.objectContaining({ entityId: 'abc-123-uuid' })
        );
        done();
      });
    });
  });

  describe('Route Parameter Changes', () => {
    it('should reload data when entityId changes', (done) => {
      let callCount = 0;

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));

      // Return different property arrays to trigger distinctUntilChanged
      // The distinctUntilChanged operator compares properties array length, so we need different lengths
      mockSchemaService.getPropsForDetail.and.callFake(() => {
        if (callCount === 0) {
          return of([MOCK_PROPERTIES.textShort]);
        } else {
          // Return different properties array (different length) to bypass distinctUntilChanged
          return of([MOCK_PROPERTIES.textShort, MOCK_PROPERTIES.integer]);
        }
      });

      mockDataService.getData.and.callFake((params: any) => {
        if (params.entityId === '42') {
          return of([{ id: 42, name: 'Issue 42', created_at: '', updated_at: '', display_name: 'Issue 42' }]);
        } else {
          return of([{ id: 99, name: 'Issue 99', count: 1, created_at: '', updated_at: '', display_name: 'Issue 99' }]);
        }
      });

      component.data$.subscribe(data => {
        callCount++;
        if (callCount === 1) {
          expect(data.id).toBe(42);
          // Trigger route change to different record
          routeParams.next({ entityKey: 'Issue', entityId: '99' });
        } else if (callCount === 2) {
          expect(data.id).toBe(99);
          expect(component.entityId).toBe('99');
          done();
        }
      });
    });

    it('should reload data when entityKey changes', (done) => {
      let callCount = 0;

      mockSchemaService.getEntity.and.callFake((key: string) => {
        if (key === 'Issue') return of(MOCK_ENTITIES.issue);
        if (key === 'Status') return of(MOCK_ENTITIES.status);
        return of(undefined);
      });
      mockSchemaService.getPropsForDetail.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.returnValue(of([{
        id: 1,
        name: 'Test',
        created_at: '',
        updated_at: '',
        display_name: 'Test'
      }]));

      component.entity$.subscribe(entity => {
        callCount++;
        if (callCount === 1) {
          expect(entity?.table_name).toBe('Issue');
          routeParams.next({ entityKey: 'Status', entityId: '5' });
        } else if (callCount === 2) {
          expect(entity?.table_name).toBe('Status');
          expect(component.entityKey).toBe('Status');
          done();
        }
      });
    });
  });

  describe('Navigation', () => {
    it('goBack() should delegate to NavigationService with fallback URL', () => {
      component.entityKey = 'issues';
      component.goBack();

      expect(mockNavigationService.goBack).toHaveBeenCalledWith('/view/issues');
    });

    it('onActionButtonClick("edit") should navigate with replaceUrl: true', (done) => {
      const mockRouter = TestBed.inject(Router) as jasmine.SpyObj<Router>;
      // Router is from provideRouter([]) — spy on navigate
      spyOn(mockRouter, 'navigate');

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.returnValue(of([{ id: 42, name: 'Test', created_at: '', updated_at: '', display_name: 'Test' }]));

      component.data$.subscribe(() => {
        component.onActionButtonClick('edit');

        setTimeout(() => {
          expect(mockRouter.navigate).toHaveBeenCalledWith(
            ['/edit', 'Issue', 42],
            { replaceUrl: true }
          );
          done();
        }, 10);
      });
    });
  });

  describe('Entity Action Parameters (v0.32.0)', () => {
    function createMockAction(overrides?: Partial<EntityAction>): EntityAction {
      return {
        id: 1,
        table_name: 'test_entity',
        action_name: 'test_action',
        display_name: 'Test Action',
        rpc_function: 'test_rpc',
        button_style: 'primary',
        sort_order: 10,
        requires_confirmation: true,
        confirmation_message: 'Are you sure?',
        refresh_after_action: true,
        show_on_detail: true,
        can_execute: true,
        parameters: [],
        ...overrides
      };
    }

    function createMockParam(overrides?: Partial<EntityActionParam>): EntityActionParam {
      return {
        id: 1,
        param_name: 'p_reason',
        display_name: 'Reason',
        param_type: 'text',
        required: false,
        sort_order: 10,
        ...overrides
      };
    }

    it('should build form from action parameters', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_reason', display_name: 'Reason', param_type: 'text' }),
        createMockParam({ id: 2, param_name: 'p_amount', display_name: 'Amount', param_type: 'number', sort_order: 20 })
      ];

      component.buildActionParamForm(params);

      const form = component.actionParamForm();
      expect(form).toBeTruthy();
      expect(form!.get('p_reason')).toBeTruthy();
      expect(form!.get('p_amount')).toBeTruthy();
    });

    it('should apply required validator for required params', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_notes', required: true })
      ];

      component.buildActionParamForm(params);

      const form = component.actionParamForm()!;
      const control = form.get('p_notes');
      expect(control).toBeTruthy();
      expect(control!.valid).toBeFalse(); // Empty required field is invalid
      control!.setValue('Some notes');
      expect(control!.valid).toBeTrue();
    });

    it('should show modal when action has parameters even without requires_confirmation', () => {
      const action = createMockAction({
        requires_confirmation: false,
        parameters: [createMockParam()]
      });

      component.onEntityActionClick(action);

      expect(component.showActionModal()).toBeTrue();
      expect(component.actionParamForm()).toBeTruthy();
    });

    it('should not build param form for actions without parameters', () => {
      const action = createMockAction({
        requires_confirmation: true,
        parameters: []
      });

      component.onEntityActionClick(action);

      expect(component.showActionModal()).toBeTrue();
      expect(component.actionParamForm()).toBeUndefined();
    });

    it('should disable confirm when required param is empty', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_notes', required: true })
      ];

      component.buildActionParamForm(params);

      const form = component.actionParamForm()!;
      expect(form.invalid).toBeTrue(); // Required field empty
    });

    it('should pass param values to executeRpc', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_response_notes', param_type: 'text' })
      ];
      const action = createMockAction({
        rpc_function: 'deny_time_off',
        parameters: params
      });

      component.entityId = '42';
      mockDataService.executeRpc.and.returnValue(of({
        success: true,
        body: { success: true, message: 'Denied.', refresh: true }
      }));

      // Build form and set value
      component.buildActionParamForm(params);
      component.actionParamForm()!.get('p_response_notes')!.setValue('Schedule conflict');
      component.currentAction.set(action);

      component.confirmEntityAction();

      expect(mockDataService.executeRpc).toHaveBeenCalledWith('deny_time_off', {
        p_entity_id: '42',
        p_response_notes: 'Schedule conflict'
      });
    });

    it('should handle actions with no params same as before', () => {
      const action = createMockAction({
        requires_confirmation: false,
        parameters: []
      });

      component.entityId = '42';
      mockDataService.executeRpc.and.returnValue(of({
        success: true,
        body: { success: true, message: 'Done.', refresh: true }
      }));

      component.onEntityActionClick(action);

      // Should execute immediately (no modal) with only p_entity_id
      expect(component.showActionModal()).toBeFalse();
      expect(mockDataService.executeRpc).toHaveBeenCalledWith('test_rpc', {
        p_entity_id: '42'
      });
    });

    it('should set boolean default to false when not provided', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_flag', param_type: 'boolean' })
      ];

      component.buildActionParamForm(params);

      const form = component.actionParamForm()!;
      expect(form.get('p_flag')!.value).toBeFalse();
    });

    it('should cast number default_value correctly', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_amount', param_type: 'number', default_value: '42.5' })
      ];

      component.buildActionParamForm(params);

      const form = component.actionParamForm()!;
      expect(form.get('p_amount')!.value).toBe(42.5);
    });

    it('should reset param form when modal is closed', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_notes' })
      ];
      const action = createMockAction({ parameters: params });

      component.onEntityActionClick(action);
      expect(component.actionParamForm()).toBeTruthy();

      component.closeActionModal();
      expect(component.actionParamForm()).toBeUndefined();
      expect(component.actionParamOptions()).toEqual({});
    });

    it('should not submit when required param form is invalid', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_notes', required: true })
      ];
      const action = createMockAction({ parameters: params });

      component.buildActionParamForm(params);
      component.currentAction.set(action);

      // Don't fill the required field
      component.confirmEntityAction();

      // executeRpc should NOT have been called
      expect(mockDataService.executeRpc).not.toHaveBeenCalled();
    });

    it('should return correct accept string for file param types', () => {
      expect(component.getFileAcceptForParam(
        createMockParam({ param_type: 'file', file_type: 'image' })
      )).toBe('image/*');
      expect(component.getFileAcceptForParam(
        createMockParam({ param_type: 'file', file_type: 'pdf' })
      )).toBe('application/pdf');
      expect(component.getFileAcceptForParam(
        createMockParam({ param_type: 'file', file_type: 'any' })
      )).toBe('*/*');
      expect(component.getFileAcceptForParam(
        createMockParam({ param_type: 'file' })
      )).toBe('*/*');
      expect(component.getFileAcceptForParam(undefined)).toBe('*/*');
    });

    it('should set file UUID in form control after successful upload', async () => {
      const fileRef = { id: 'file-uuid-123', file_name: 'test.pdf' } as any;
      mockFileUploadService.uploadFile.and.returnValue(Promise.resolve(fileRef));

      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_document_file', param_type: 'file', file_type: 'any' })
      ];
      const action = createMockAction({ parameters: params });

      component.entityKey = 'staff_documents';
      component.entityId = '42';
      component.currentAction.set(action);
      component.buildActionParamForm(params);

      // Simulate file selection
      const mockFile = new File(['content'], 'test.pdf', { type: 'application/pdf' });
      const mockEvent = { target: { files: [mockFile], value: '' } } as any;

      component.onActionFileSelected(mockEvent, 'p_document_file');

      // Wait for async upload promise + then/finally microtasks to settle
      await mockFileUploadService.uploadFile.calls.mostRecent().returnValue;
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(component.actionParamForm()!.get('p_document_file')!.value).toBe('file-uuid-123');
      expect(component.actionUploadedFile()['p_document_file'].file_name).toBe('test.pdf');
      expect(component.actionFileUploading()).toBeFalse();
    });

    it('should show upload error on failed upload', async () => {
      mockFileUploadService.uploadFile.and.returnValue(Promise.reject(new Error('Network error')));

      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_file', param_type: 'file' })
      ];
      const action = createMockAction({ parameters: params });

      component.entityKey = 'test_entity';
      component.entityId = '1';
      component.currentAction.set(action);
      component.buildActionParamForm(params);

      const mockFile = new File(['x'], 'bad.txt', { type: 'text/plain' });
      const mockEvent = { target: { files: [mockFile], value: '' } } as any;

      component.onActionFileSelected(mockEvent, 'p_file');

      // Wait for the rejected promise to settle
      try {
        await mockFileUploadService.uploadFile.calls.mostRecent().returnValue;
      } catch {
        // Expected
      }
      // Allow microtasks (finally block) to execute
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(component.actionUploadError()).toBe('Network error');
      expect(component.actionFileUploading()).toBeFalse();
    });

    it('should show validation error for invalid file type', () => {
      mockFileUploadService.validateFile.and.returnValue('File type text/plain is not allowed');

      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_file', param_type: 'file', file_type: 'image' })
      ];
      const action = createMockAction({ parameters: params });

      component.entityKey = 'test_entity';
      component.entityId = '1';
      component.currentAction.set(action);
      component.buildActionParamForm(params);

      const mockFile = new File(['x'], 'doc.txt', { type: 'text/plain' });
      const mockEvent = { target: { files: [mockFile], value: '' } } as any;

      component.onActionFileSelected(mockEvent, 'p_file');

      expect(component.actionUploadError()).toBe('File type text/plain is not allowed');
      expect(mockFileUploadService.uploadFile).not.toHaveBeenCalled();
    });

    it('should reset file upload state when modal is closed', () => {
      component.actionUploadedFile.set({ p_file: { file_name: 'test.pdf' } as any });
      component.actionUploadError.set('some error');
      component.actionFileUploading.set(true);

      component.closeActionModal();

      expect(component.actionUploadedFile()).toEqual({});
      expect(component.actionUploadError()).toBeUndefined();
      expect(component.actionFileUploading()).toBeFalse();
    });

    it('should pass uploaded file UUID to executeRpc via confirmEntityAction', () => {
      const params: EntityActionParam[] = [
        createMockParam({ param_name: 'p_document_file', param_type: 'file', required: true })
      ];
      const action = createMockAction({
        rpc_function: 'submit_staff_document',
        parameters: params
      });

      component.entityId = '42';
      mockDataService.executeRpc.and.returnValue(of({
        success: true,
        body: { success: true, message: 'Submitted.', refresh: true }
      }));

      component.buildActionParamForm(params);
      // Simulate that file was already uploaded and UUID stored in form
      component.actionParamForm()!.get('p_document_file')!.setValue('file-uuid-456');
      component.currentAction.set(action);

      component.confirmEntityAction();

      expect(mockDataService.executeRpc).toHaveBeenCalledWith('submit_staff_document', {
        p_entity_id: '42',
        p_document_file: 'file-uuid-456'
      });
    });
  });

  describe('Data Flow with Complex Property Types', () => {
    it('should handle all property types in detail view', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.textLong,
        MOCK_PROPERTIES.boolean,
        MOCK_PROPERTIES.integer,
        MOCK_PROPERTIES.money,
        MOCK_PROPERTIES.date,
        MOCK_PROPERTIES.dateTime,
        MOCK_PROPERTIES.foreignKey,
        MOCK_PROPERTIES.user,
        MOCK_PROPERTIES.geoPoint
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForDetail.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of([{}] as any));

      component.data$.subscribe(() => {
        const callArgs = mockDataService.getData.calls.argsFor(0)[0];
        expect(callArgs.fields).toContain('name');
        expect(callArgs.fields).toContain('description');
        expect(callArgs.fields).toContain('is_active');
        expect(callArgs.fields).toContain('count');
        expect(callArgs.fields).toContain('amount');
        expect(callArgs.fields).toContain('due_date');
        expect(callArgs.fields).toContain('created_at');
        expect(callArgs.fields).toContain('status_id:Status!status_id(id,display_name)');
        expect(callArgs.fields).toContain('assigned_to:civic_os_users!assigned_to(id,display_name,full_name,phone,email)');
        expect(callArgs.fields).toContain('location:location_text');
        done();
      });
    });
  });
});
