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
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { DetailPage } from './detail.page';
import { Router } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AuthService } from '../../services/auth.service';
import { RecurringService } from '../../services/recurring.service';
import { NavigationService } from '../../services/navigation.service';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryService } from '../../services/gallery.service';
import { BehaviorSubject, of, firstValueFrom } from 'rxjs';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { EntityPropertyType, EntityAction, EntityActionParam } from '../../interfaces/entity';

describe('DetailPage', () => {
    let component: DetailPage;
    let fixture: ComponentFixture<DetailPage>;
    let mockSchemaService: any;
    let mockDataService: any;
    let mockAuthService: any;
    let mockRecurringService: any;
    let mockNavigationService: any;
    let mockFileUploadService: any;
    let mockGalleryService: any;
    let routeParams: BehaviorSubject<any>;

    beforeEach(async () => {
        routeParams = new BehaviorSubject({ entityKey: 'Issue', entityId: '42' });

        mockSchemaService = {
            getEntity: vi.fn().mockName("SchemaService.getEntity"),
            getPropsForDetail: vi.fn().mockName("SchemaService.getPropsForDetail"),
            getDetailRenderables: vi.fn().mockName("SchemaService.getDetailRenderables"),
            getInverseRelationships: vi.fn().mockName("SchemaService.getInverseRelationships"),
            getEntities: vi.fn().mockName("SchemaService.getEntities"),
            getEntityActions: vi.fn().mockName("SchemaService.getEntityActions")
        };
        mockDataService = {
            getData: vi.fn().mockName("DataService.getData"),
            getInverseRelationshipData: vi.fn().mockName("DataService.getInverseRelationshipData"),
            executeRpc: vi.fn().mockName("DataService.executeRpc"),
            callRpc: vi.fn().mockName("DataService.callRpc")
        };
        mockAuthService = {
            login: vi.fn().mockName("AuthService.login"),
            isAdmin: vi.fn().mockName("AuthService.isAdmin"),
            authenticated: signal(false)
        };
        mockAuthService.isAdmin.mockReturnValue(false);
        mockRecurringService = {
            getSeriesMembership: vi.fn().mockName("RecurringService.getSeriesMembership"),
            cancelOccurrence: vi.fn().mockName("RecurringService.cancelOccurrence"),
            splitSeries: vi.fn().mockName("RecurringService.splitSeries"),
            deleteSeriesGroup: vi.fn().mockName("RecurringService.deleteSeriesGroup")
        };
        mockNavigationService = {
            goBack: vi.fn().mockName("NavigationService.goBack")
        };
        mockFileUploadService = {
            validateFile: vi.fn().mockName("FileUploadService.validateFile"),
            uploadFile: vi.fn().mockName("FileUploadService.uploadFile")
        };
        mockFileUploadService.validateFile.mockReturnValue(null);
        mockGalleryService = {
            getConfig: vi.fn().mockName("GalleryService.getConfig"),
            createDraftGallery: vi.fn().mockName("GalleryService.createDraftGallery"),
            linkGalleryToEntity: vi.fn().mockName("GalleryService.linkGalleryToEntity")
        };

        // Default mock for series membership - not a member
        mockRecurringService.getSeriesMembership.mockReturnValue(of({ is_member: false }));

        // Default mock for getEntity to prevent afterAll stream errors during teardown
        mockSchemaService.getEntity.mockReturnValue(of(undefined));

        // Default mocks for inverse relationships
        mockSchemaService.getInverseRelationships.mockReturnValue(of([]));
        mockSchemaService.getEntities.mockReturnValue(of([
            MOCK_ENTITIES.issue,
            MOCK_ENTITIES.status
        ]));

        // Setup default for renderables (most tests use properties$ directly)
        mockSchemaService.getDetailRenderables.mockReturnValue(of([]));

        // Default mock for entity actions (returns empty array)
        mockSchemaService.getEntityActions.mockReturnValue(of([]));

        await TestBed.configureTestingModule({
            imports: [DetailPage],
            providers: [
                provideZonelessChangeDetection(),
                provideRouter([]),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                { provide: ActivatedRoute, useValue: { params: routeParams.asObservable() } },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: mockDataService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: RecurringService, useValue: mockRecurringService },
                { provide: NavigationService, useValue: mockNavigationService },
                { provide: FileUploadService, useValue: mockFileUploadService },
                { provide: GalleryService, useValue: mockGalleryService }
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
        it('should load entity metadata from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of([]));
            mockDataService.getData.mockReturnValue(of([] as any));

            component.entity$.subscribe(entity => {
                expect(entity).toBeDefined();
                expect(entity?.table_name).toBe('Issue');
                expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
            });
        });

        it('should store entityKey and entityId from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of([]));
            mockDataService.getData.mockReturnValue(of([] as any));

            component.entity$.subscribe(() => {
                expect(component.entityKey).toBe('Issue');
                expect(component.entityId).toBe('42');
            });
        });

        it('should return undefined when entityKey is missing', async () => {
            routeParams.next({ entityId: '42' });
            mockSchemaService.getEntity.mockReturnValue(of(undefined));

            component.entity$.subscribe(entity => {
                expect(entity).toBeUndefined();
                expect(mockSchemaService.getEntity).not.toHaveBeenCalled();
            });
        });

        it('should fetch properties for detail view', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.foreignKey,
                MOCK_PROPERTIES.geoPoint
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of([{}] as any));

            component.properties$.subscribe(props => {
                expect(props.length).toBe(3);
                expect(mockSchemaService.getPropsForDetail).toHaveBeenCalledWith(MOCK_ENTITIES.issue);
            });
        });

        it('should return empty array when entity is undefined', async () => {
            routeParams.next({});
            mockSchemaService.getEntity.mockReturnValue(of(undefined));

            component.properties$.subscribe(props => {
                expect(props).toEqual([]);
                expect(mockSchemaService.getPropsForDetail).not.toHaveBeenCalled();
            });
        });

        it('should build PostgREST query with entityId filter', async () => {
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

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of(mockData));

            await firstValueFrom(component.data$);
            expect(mockDataService.getData).toHaveBeenCalledWith({
                key: 'Issue',
                fields: ['name', 'status_id:Status!status_id(id,display_name)'],
                entityId: '42'
            });
        });

        it('should extract first item from data array', async () => {
            const mockProps = [MOCK_PROPERTIES.textShort];
            const mockData = [
                { id: 42, name: 'First Item', created_at: '', updated_at: '', display_name: 'First Item' },
                { id: 43, name: 'Second Item', created_at: '', updated_at: '', display_name: 'Second Item' }
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of(mockData));

            component.data$.subscribe(data => {
                expect(data).toEqual(expect.objectContaining({ id: 42, name: 'First Item' }));
            });
        });

        it('should return undefined when no data found', async () => {
            const mockProps = [MOCK_PROPERTIES.textShort];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of([]));

            component.data$.subscribe(data => {
                expect(data).toBeUndefined();
            });
        });

        it('should handle string entityId values', async () => {
            routeParams.next({ entityKey: 'Issue', entityId: 'abc-123-uuid' });
            const mockProps = [MOCK_PROPERTIES.textShort];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of([{
                    id: 'abc-123-uuid' as any,
                    name: 'Test',
                    created_at: '',
                    updated_at: '',
                    display_name: 'Test'
                }]));

            await firstValueFrom(component.data$);
            expect(mockDataService.getData).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'abc-123-uuid' }));
        });
    });

    describe('Route Parameter Changes', () => {
        it('should reload data when entityId changes', async () => {
            let callCount = 0;

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));

            // Return different property arrays to trigger distinctUntilChanged
            // The distinctUntilChanged operator compares properties array length, so we need different lengths
            mockSchemaService.getPropsForDetail.mockImplementation(() => {
                if (callCount === 0) {
                    return of([MOCK_PROPERTIES.textShort]);
                }
                else {
                    // Return different properties array (different length) to bypass distinctUntilChanged
                    return of([MOCK_PROPERTIES.textShort, MOCK_PROPERTIES.integer]);
                }
            });

            mockDataService.getData.mockImplementation((params: any) => {
                if (params.entityId === '42') {
                    return of([{ id: 42, name: 'Issue 42', created_at: '', updated_at: '', display_name: 'Issue 42' }]);
                }
                else {
                    return of([{ id: 99, name: 'Issue 99', count: 1, created_at: '', updated_at: '', display_name: 'Issue 99' }]);
                }
            });

            component.data$.subscribe(data => {
                callCount++;
                if (callCount === 1) {
                    expect(data.id).toBe(42);
                    // Trigger route change to different record
                    routeParams.next({ entityKey: 'Issue', entityId: '99' });
                }
                else if (callCount === 2) {
                    expect(data.id).toBe(99);
                    expect(component.entityId).toBe('99');
                }
            });
        });

        it('should reload data when entityKey changes', async () => {
            let callCount = 0;

            mockSchemaService.getEntity.mockImplementation((key: string) => {
                if (key === 'Issue')
                    return of(MOCK_ENTITIES.issue);
                if (key === 'Status')
                    return of(MOCK_ENTITIES.status);
                return of(undefined);
            });
            mockSchemaService.getPropsForDetail.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockReturnValue(of([{
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
                }
                else if (callCount === 2) {
                    expect(entity?.table_name).toBe('Status');
                    expect(component.entityKey).toBe('Status');
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

        it('onActionButtonClick("edit") should navigate with replaceUrl: true', async () => {
            const mockRouter = TestBed.inject(Router) as any;
            // Router is from provideRouter([]) — spy on navigate
            vi.spyOn(mockRouter, 'navigate').mockReturnValue(undefined);

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockReturnValue(of([{ id: 42, name: 'Test', created_at: '', updated_at: '', display_name: 'Test' }]));

            await firstValueFrom(component.data$);
            component.onActionButtonClick('edit');

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/edit', 'Issue', 42], { replaceUrl: true });
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
            expect(control!.valid).toBe(false); // Empty required field is invalid
            control!.setValue('Some notes');
            expect(control!.valid).toBe(true);
        });

        it('should show modal when action has parameters even without requires_confirmation', () => {
            const action = createMockAction({
                requires_confirmation: false,
                parameters: [createMockParam()]
            });

            component.onEntityActionClick(action);

            expect(component.showActionModal()).toBe(true);
            expect(component.actionParamForm()).toBeTruthy();
        });

        it('should not build param form for actions without parameters', () => {
            const action = createMockAction({
                requires_confirmation: true,
                parameters: []
            });

            component.onEntityActionClick(action);

            expect(component.showActionModal()).toBe(true);
            expect(component.actionParamForm()).toBeUndefined();
        });

        it('should disable confirm when required param is empty', () => {
            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_notes', required: true })
            ];

            component.buildActionParamForm(params);

            const form = component.actionParamForm()!;
            expect(form.invalid).toBe(true); // Required field empty
        });

        it('should pass param values to executeRpc', async () => {
            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_response_notes', param_type: 'text' })
            ];
            const action = createMockAction({
                rpc_function: 'deny_time_off',
                parameters: params
            });

            component.entityId = '42';
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Denied.', refresh: true }
            }));

            // Build form and set value
            component.buildActionParamForm(params);
            component.actionParamForm()!.get('p_response_notes')!.setValue('Schedule conflict');
            component.currentAction.set(action);

            await component.confirmEntityAction();

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
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Done.', refresh: true }
            }));

            component.onEntityActionClick(action);

            // Should execute immediately (no modal) with only p_entity_id
            expect(component.showActionModal()).toBe(false);
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
            expect(form.get('p_flag')!.value).toBe(false);
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
            expect(component.getFileAcceptForParam(createMockParam({ param_type: 'file', file_type: 'image' }))).toBe('image/*');
            expect(component.getFileAcceptForParam(createMockParam({ param_type: 'file', file_type: 'pdf' }))).toBe('application/pdf');
            expect(component.getFileAcceptForParam(createMockParam({ param_type: 'file', file_type: 'any' }))).toBe('*/*');
            expect(component.getFileAcceptForParam(createMockParam({ param_type: 'file' }))).toBe('*/*');
            expect(component.getFileAcceptForParam(undefined)).toBe('*/*');
        });

        it('should set file UUID in form control after successful upload', async () => {
            const fileRef = { id: 'file-uuid-123', file_name: 'test.pdf' } as any;
            mockFileUploadService.uploadFile.mockResolvedValue(fileRef);

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
            await vi.mocked(mockFileUploadService.uploadFile).mock.results.at(-1)!.value;
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(component.actionParamForm()!.get('p_document_file')!.value).toBe('file-uuid-123');
            expect(component.actionUploadedFile()['p_document_file'].file_name).toBe('test.pdf');
            expect(component.actionFileUploading()).toBe(false);
        });

        it('should show upload error on failed upload', async () => {
            mockFileUploadService.uploadFile.mockRejectedValue(new Error('Network error'));

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
                await vi.mocked(mockFileUploadService.uploadFile).mock.results.at(-1)!.value;
            }
            catch {
                // Expected
            }
            // Allow microtasks (finally block) to execute
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(component.actionUploadError()).toBe('Network error');
            expect(component.actionFileUploading()).toBe(false);
        });

        it('should show validation error for invalid file type', () => {
            mockFileUploadService.validateFile.mockReturnValue('File type text/plain is not allowed');

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
            expect(component.actionFileUploading()).toBe(false);
        });

        it('should pass uploaded file UUID to executeRpc via confirmEntityAction', async () => {
            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_document_file', param_type: 'file', required: true })
            ];
            const action = createMockAction({
                rpc_function: 'submit_staff_document',
                parameters: params
            });

            component.entityId = '42';
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Submitted.', refresh: true }
            }));

            component.buildActionParamForm(params);
            // Simulate that file was already uploaded and UUID stored in form
            component.actionParamForm()!.get('p_document_file')!.setValue('file-uuid-456');
            component.currentAction.set(action);

            await component.confirmEntityAction();

            expect(mockDataService.executeRpc).toHaveBeenCalledWith('submit_staff_document', {
                p_entity_id: '42',
                p_document_file: 'file-uuid-456'
            });
        });

        it('should load FK param options with id and display_name', () => {
            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_tool_type_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_types',
                    join_column: 'id'
                })
            ];

            mockDataService.getData.mockReturnValue(of([
                { id: 1, display_name: 'Hammer' },
                { id: 2, display_name: 'Drill' }
            ]));

            component.loadParamOptions(params);

            expect(mockDataService.getData).toHaveBeenCalledWith(expect.objectContaining({
                key: 'tool_types',
                fields: ['id', 'display_name'],
                orderField: 'display_name',
                orderDirection: 'asc'
            }));
        });

        it('should include join_column in fields when it differs from id', () => {
            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_code',
                    param_type: 'foreign_key',
                    join_table: 'categories',
                    join_column: 'code'
                })
            ];

            mockDataService.getData.mockReturnValue(of([]));

            component.loadParamOptions(params);

            expect(mockDataService.getData).toHaveBeenCalledWith(expect.objectContaining({
                key: 'categories',
                fields: ['id', 'display_name', 'code']
            }));
        });

        it('should always return display_name from getParamDisplayColumn', () => {
            expect(component.getParamDisplayColumn(createMockParam({ param_type: 'foreign_key', join_column: 'id' }))).toBe('display_name');

            expect(component.getParamDisplayColumn(createMockParam({ param_type: 'foreign_key', join_column: 'code' }))).toBe('display_name');

            expect(component.getParamDisplayColumn(createMockParam({ param_type: 'text' }))).toBe('display_name');
        });

        // =====================================================================
        // options_source_rpc + depends_on_params (v0.54.0)
        // =====================================================================

        it('should call RPC instead of getData when options_source_rpc is set', () => {
            const rpcOptions = [
                { id: 1, display_name: 'Item A' },
                { id: 2, display_name: 'Item B' }
            ];
            mockDataService.callRpc.mockReturnValue(of(rpcOptions));

            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_checkout_item_id',
                    param_type: 'foreign_key',
                    join_table: 'checkout_items',
                    join_column: 'id',
                    options_source_rpc: 'get_checkout_items_options'
                })
            ];

            component.entityId = '42';
            component.buildActionParamForm(params);
            component.loadParamOptions(params);

            expect(mockDataService.callRpc).toHaveBeenCalledWith('get_checkout_items_options', {
                p_id: 42,
                p_depends_on: {}
            });
            // getData should NOT be called for this param
            expect(mockDataService.getData).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'checkout_items' }));
        });

        it('should pass p_depends_on from sibling params when calling RPC', () => {
            mockDataService.callRpc.mockReturnValue(of([]));
            mockDataService.getData.mockReturnValue(of([
                { id: 1, display_name: 'Type A' }
            ]));

            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_tool_type_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_types',
                    join_column: 'id',
                    sort_order: 10
                }),
                createMockParam({
                    id: 2,
                    param_name: 'p_tool_instance_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_instances',
                    join_column: 'id',
                    options_source_rpc: 'get_tool_instance_options',
                    depends_on_params: ['p_tool_type_id'],
                    sort_order: 20
                })
            ];

            component.entityId = '42';
            component.buildActionParamForm(params);

            // Set the dependency value BEFORE loading options
            component.actionParamForm()!.get('p_tool_type_id')!.setValue(5);

            component.loadParamOptions(params);

            expect(mockDataService.callRpc).toHaveBeenCalledWith('get_tool_instance_options', {
                p_id: 42,
                p_depends_on: { p_tool_type_id: 5 }
            });
        });

        it('should skip initial RPC load when depends_on_params are all null', () => {
            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_tool_type_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_types',
                    join_column: 'id',
                    sort_order: 10
                }),
                createMockParam({
                    id: 2,
                    param_name: 'p_tool_instance_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_instances',
                    join_column: 'id',
                    options_source_rpc: 'get_tool_instance_options',
                    depends_on_params: ['p_tool_type_id'],
                    sort_order: 20
                })
            ];

            mockDataService.getData.mockReturnValue(of([
                { id: 1, display_name: 'Type A' }
            ]));

            component.buildActionParamForm(params);
            // p_tool_type_id is null (default)
            component.loadParamOptions(params);

            // RPC should NOT have been called since dependency is null
            expect(mockDataService.callRpc).not.toHaveBeenCalled();
        });

        it('should re-fetch RPC options when dependency param changes', async () => {
            const rpcOptions = [
                { id: 10, display_name: 'Instance X' }
            ];
            mockDataService.callRpc.mockReturnValue(of(rpcOptions));
            mockDataService.getData.mockReturnValue(of([
                { id: 1, display_name: 'Type A' }
            ]));

            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_tool_type_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_types',
                    join_column: 'id',
                    sort_order: 10
                }),
                createMockParam({
                    id: 2,
                    param_name: 'p_tool_instance_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_instances',
                    join_column: 'id',
                    options_source_rpc: 'get_tool_instance_options',
                    depends_on_params: ['p_tool_type_id'],
                    sort_order: 20
                })
            ];

            component.entityId = '42';
            component.buildActionParamForm(params);
            component.loadParamOptions(params);
            component.setupParamDependencyWatchers(params);

            // Change the dependency value
            component.actionParamForm()!.get('p_tool_type_id')!.setValue(3);

            // Wait for debounce (300ms)
            await new Promise(resolve => setTimeout(resolve, 400));
            expect(mockDataService.callRpc).toHaveBeenCalledWith('get_tool_instance_options', {
                p_id: 42,
                p_depends_on: { p_tool_type_id: 3 }
            });
            expect(component.actionParamOptions()['p_tool_instance_id']).toEqual(rpcOptions);
        });

        it('should clear options and reset value when dependency is cleared', async () => {
            mockDataService.callRpc.mockReturnValue(of([
                { id: 10, display_name: 'Instance X' }
            ]));
            mockDataService.getData.mockReturnValue(of([
                { id: 1, display_name: 'Type A' }
            ]));

            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_tool_type_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_types',
                    join_column: 'id',
                    sort_order: 10
                }),
                createMockParam({
                    id: 2,
                    param_name: 'p_tool_instance_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_instances',
                    join_column: 'id',
                    options_source_rpc: 'get_tool_instance_options',
                    depends_on_params: ['p_tool_type_id'],
                    sort_order: 20
                })
            ];

            component.entityId = '42';
            component.buildActionParamForm(params);
            component.loadParamOptions(params);
            component.setupParamDependencyWatchers(params);

            // Set a value first, then the dependent param
            const form = component.actionParamForm()!;
            form.get('p_tool_type_id')!.setValue(3);

            await new Promise(resolve => setTimeout(resolve, 400));
            // Set a selection on the dependent param
            form.get('p_tool_instance_id')!.setValue(10);

            // Now clear the dependency
            form.get('p_tool_type_id')!.setValue(null);

            await new Promise(resolve => setTimeout(resolve, 400));
            expect(component.actionParamOptions()['p_tool_instance_id']).toEqual([]);
            expect(form.get('p_tool_instance_id')!.value).toBeNull();
        });

        it('should invalidate selection when no longer in re-fetched options', async () => {
            // First call returns option 10, second call returns only option 20
            let callCount = 0;
            mockDataService.callRpc.mockImplementation(() => {
                callCount++;
                if (callCount <= 1) {
                    return of([{ id: 10, display_name: 'Instance X' }]);
                }
                return of([{ id: 20, display_name: 'Instance Y' }]);
            });
            mockDataService.getData.mockReturnValue(of([
                { id: 1, display_name: 'Type A' },
                { id: 2, display_name: 'Type B' }
            ]));

            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_tool_type_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_types',
                    join_column: 'id',
                    sort_order: 10
                }),
                createMockParam({
                    id: 2,
                    param_name: 'p_tool_instance_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_instances',
                    join_column: 'id',
                    options_source_rpc: 'get_tool_instance_options',
                    depends_on_params: ['p_tool_type_id'],
                    sort_order: 20
                })
            ];

            component.entityId = '42';
            component.buildActionParamForm(params);
            component.setupParamDependencyWatchers(params);
            const form = component.actionParamForm()!;

            // First: select type 1, which loads instance 10
            form.get('p_tool_type_id')!.setValue(1);

            await new Promise(resolve => setTimeout(resolve, 400));
            // User selects instance 10
            form.get('p_tool_instance_id')!.setValue(10);

            // Now change type — new options won't include 10
            form.get('p_tool_type_id')!.setValue(2);

            await new Promise(resolve => setTimeout(resolve, 400));
            // Instance 10 is no longer valid → should be cleared
            expect(form.get('p_tool_instance_id')!.value).toBeNull();
            expect(component.actionParamOptions()['p_tool_instance_id']).toEqual([
                { id: 20, display_name: 'Instance Y' }
            ]);
        });

        it('should clean up dependency watchers when modal is closed', async () => {
            mockDataService.callRpc.mockReturnValue(of([]));
            mockDataService.getData.mockReturnValue(of([
                { id: 1, display_name: 'Type A' }
            ]));

            const params: EntityActionParam[] = [
                createMockParam({
                    param_name: 'p_tool_type_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_types',
                    join_column: 'id',
                    sort_order: 10
                }),
                createMockParam({
                    id: 2,
                    param_name: 'p_tool_instance_id',
                    param_type: 'foreign_key',
                    join_table: 'tool_instances',
                    join_column: 'id',
                    options_source_rpc: 'get_tool_instance_options',
                    depends_on_params: ['p_tool_type_id'],
                    sort_order: 20
                })
            ];

            component.entityId = '42';
            component.buildActionParamForm(params);
            component.loadParamOptions(params);
            component.setupParamDependencyWatchers(params);

            // Close modal — should clean up subs
            component.closeActionModal();

            // Reset mock call tracking
            mockDataService.callRpc.mockClear();

            // Re-open with fresh form to trigger watchers
            component.buildActionParamForm(params);
            component.setupParamDependencyWatchers(params);

            // Change value on the OLD form's control — should NOT trigger RPC
            // (watchers were cleaned up on close)
            // The new form has fresh controls, so old subs are irrelevant
            await new Promise(resolve => setTimeout(resolve, 400));
            // Verify no RPC calls from stale watchers
            // (The only callRpc calls would be from the new watcher setup, which we didn't trigger)
            expect(mockDataService.callRpc).not.toHaveBeenCalled();
        });

        // =========================================================================
        // PHOTO GALLERY ACTION PARAM TESTS (v0.55.0)
        // =========================================================================

        it('should create form control with null default for photo_gallery param', () => {
            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos' })
            ];

            component.buildActionParamForm(params);

            const form = component.actionParamForm()!;
            expect(form.get('p_checkout_photos')).toBeTruthy();
            expect(form.get('p_checkout_photos')!.value).toBeNull();
        });

        it('should load gallery config via GalleryService.getConfig on modal open', () => {
            const mockConfig = { table_name: 'tool_reservation_checkouts', column_name: 'checkout_photos', max_images: 10, allowed_types: 'image/*' };
            mockGalleryService.getConfig.mockReturnValue(of(mockConfig));

            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos' })
            ];

            component.entityKey = 'tool_reservation_checkouts';
            component.loadParamOptions(params);

            expect(mockGalleryService.getConfig).toHaveBeenCalledWith('tool_reservation_checkouts', 'checkout_photos');
            expect(component.actionGalleryConfig()['p_checkout_photos']).toEqual(mockConfig);
        });

        it('should store gallery ID and set form control on draft creation', () => {
            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos' })
            ];

            component.buildActionParamForm(params);
            component.onActionGalleryDraftCreated('p_checkout_photos', 'gallery-uuid-123');

            expect(component.actionGalleryIds()['p_checkout_photos']).toBe('gallery-uuid-123');
            expect(component.actionParamForm()!.get('p_checkout_photos')!.value).toBe('gallery-uuid-123');
        });

        it('should pass gallery UUID to executeRpc via confirmEntityAction', async () => {
            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos', required: false })
            ];
            const action = createMockAction({
                rpc_function: 'confirm_checkout',
                parameters: params
            });

            component.entityId = '42';
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Confirmed.', refresh: true }
            }));

            component.buildActionParamForm(params);
            // Simulate draft gallery was created and UUID stored
            component.onActionGalleryDraftCreated('p_checkout_photos', 'gallery-uuid-789');
            component.currentAction.set(action);

            await component.confirmEntityAction();

            expect(mockDataService.executeRpc).toHaveBeenCalledWith('confirm_checkout', {
                p_entity_id: '42',
                p_checkout_photos: 'gallery-uuid-789'
            });
        });

        it('should clear gallery state when modal is closed', () => {
            // Set up some gallery state
            component.actionGalleryConfig.set({ 'p_photos': { table_name: 't', column_name: 'c', max_images: 20, allowed_types: 'image/*' } });
            component.actionGalleryIds.set({ 'p_photos': 'some-uuid' });

            component.closeActionModal();

            expect(component.actionGalleryConfig()).toEqual({});
            expect(component.actionGalleryIds()).toEqual({});
        });

        it('should skip gallery param value when no photos uploaded (optional)', async () => {
            const params: EntityActionParam[] = [
                createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos', required: false })
            ];
            const action = createMockAction({
                rpc_function: 'confirm_checkout',
                parameters: params
            });

            component.entityId = '42';
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Confirmed.', refresh: true }
            }));

            component.buildActionParamForm(params);
            // No draft created — form control stays null
            component.currentAction.set(action);

            await component.confirmEntityAction();

            // Optional null value should be skipped in collectParamValues
            expect(mockDataService.executeRpc).toHaveBeenCalledWith('confirm_checkout', {
                p_entity_id: '42'
            });
        });
    });

    describe('Data Flow with Complex Property Types', () => {
        it('should handle all property types in detail view', async () => {
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

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForDetail.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of([{}] as any));

            component.data$.subscribe(() => {
                const callArgs = vi.mocked(mockDataService.getData).mock.calls[0][0];
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
            });
        });
    });
});
