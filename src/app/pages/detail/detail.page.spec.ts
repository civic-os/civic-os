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
import { effect, provideZonelessChangeDetection, signal } from '@angular/core';
import { ActivatedRoute, NavigationStart } from '@angular/router';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { DetailPage } from './detail.page';
import { Router } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryService } from '../../services/gallery.service';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { TranslationService } from '../../services/translation.service';
import type { EntityHandle, ViewerAction, ViewerDeps } from '@civic-os/core';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { EntityPropertyType, EntityAction, EntityActionParam, SchemaEntityProperty, SchemaEntityTable } from '../../interfaces/entity';
import { FACADE_DEPS } from '../../sdk/facade-deps';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';

/** A core entity handle over a row, as the route resolver would hand the page. */
function handleFor(row: SchemaEntityTable, features: Record<string, unknown> = {}): EntityHandle {
    return {
        name: row.table_name,
        get liveRow() { return row; },
        features,
        can: { insert: row.insert, select: row.select },
    } as unknown as EntityHandle;
}

function createMockAction(overrides?: Partial<EntityAction>): EntityAction {
    return {
        id: 1,
        table_name: 'Issue',
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

describe('DetailPage', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: DetailPage;
    let fixture: ComponentFixture<DetailPage>;
    let mockAnalyticsService: any;
    let mockAuthService: any;
    let mockNavigationService: any;
    let mockFileUploadService: any;
    let mockGalleryService: any;
    let routeParams: BehaviorSubject<any>;
    let router: Router;
    let navigateSpy: ReturnType<typeof vi.fn>;

    /** The facade's data client: every record request, RPC and delete the page causes goes through it. */
    let getData: ReturnType<typeof vi.fn>;
    let callRpc: ReturnType<typeof vi.fn>;
    let executeRpc: ReturnType<typeof vi.fn>;
    let deleteData: ReturnType<typeof vi.fn>;
    let schemaProperties: ReturnType<typeof vi.fn>;
    let schemaActions: ReturnType<typeof vi.fn>;
    let schemaRenderables: ReturnType<typeof vi.fn>;
    /** The record the fake transport serves for the entity under test. */
    let recordRow: Record<string, unknown> | undefined;
    /** SchemaService's loaded entity rows; a new array is a schema refresh. */
    let entityRows: ReturnType<typeof signal<SchemaEntityTable[] | undefined>>;

    beforeEach(async () => {
        routeParams = new BehaviorSubject({ entityKey: 'Issue', entityId: '42' });
        recordRow = { id: 42, name: 'Pothole', created_at: '', updated_at: '', display_name: 'Pothole' };
        entityRows = signal<SchemaEntityTable[] | undefined>([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);

        mockAnalyticsService = { trackEvent: vi.fn().mockName("AnalyticsService.trackEvent") };
        mockAuthService = {
            login: vi.fn().mockName("AuthService.login"),
            isAdmin: vi.fn().mockName("AuthService.isAdmin"),
            authenticated: signal(false)
        };
        mockAuthService.isAdmin.mockReturnValue(false);
        mockNavigationService = { goBack: vi.fn().mockName("NavigationService.goBack") };
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

        getData = vi.fn(async (query: { key: string }) => {
            if (query.key === 'Issue' || query.key === 'Status') return recordRow ? [recordRow] : [];
            return [{ id: 1, display_name: 'Option A' }];
        });
        callRpc = vi.fn(async (fn: string) => fn === 'get_series_membership' ? { is_member: false } : null);
        executeRpc = vi.fn(async () => ({ success: true, message: 'Done', refresh: true }));
        deleteData = vi.fn(async () => undefined);
        schemaProperties = vi.fn(async () => [MOCK_PROPERTIES.textShort]);
        schemaActions = vi.fn(async () => []);
        schemaRenderables = vi.fn(async () => []);
        const facadeDeps = {
            data: {
                getData,
                callRpc,
                executeRpc,
                deleteData,
                getInverseRelationshipPreview: vi.fn(async () => ({ records: [], totalCount: 0 })),
            },
            schema: {
                properties: schemaProperties,
                renderables: schemaRenderables,
                actions: schemaActions,
                inverseRelationships: vi.fn(async () => []),
                entities: vi.fn(async () => [MOCK_ENTITIES.issue, MOCK_ENTITIES.status]),
            },
            clock: { now: () => new Date() },
        } as unknown as ViewerDeps;

        await TestBed.configureTestingModule({
            imports: [DetailPage],
            providers: [
                provideZonelessChangeDetection(),
                provideRouter([]),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                { provide: ActivatedRoute, useValue: { params: routeParams.asObservable() } },
                { provide: SchemaService, useValue: { entityRows } },
                { provide: DataService, useValue: {} },
                { provide: AnalyticsService, useValue: mockAnalyticsService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: NavigationService, useValue: mockNavigationService },
                { provide: FileUploadService, useValue: mockFileUploadService },
                { provide: GalleryService, useValue: mockGalleryService },
                { provide: FACADE_DEPS, useValue: facadeDeps }
            ]
        })
            .compileComponents();

        router = TestBed.inject(Router);
        navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;

        fixture = TestBed.createComponent(DetailPage);
        component = fixture.componentInstance;
    });

    /** Gives the page its route entity handle, as the resolver does, and lets the first load settle. */
    async function mount(
        row: SchemaEntityTable = MOCK_ENTITIES.issue,
        options: { props?: SchemaEntityProperty[]; actions?: EntityAction[]; features?: Record<string, unknown> } = {}
    ): Promise<void> {
        schemaProperties.mockResolvedValue(options.props ?? [MOCK_PROPERTIES.textShort]);
        schemaActions.mockResolvedValue(options.actions ?? []);
        fixture.componentRef.setInput('entityHandle', handleFor(row, options.features));
        fixture.detectChanges();
        await advanceTime(100);
        fixture.detectChanges();
    }

    /** Mounts with one action and returns the facade's view of it (what the page's modal and buttons hold). */
    async function mountAction(action: EntityAction, row: SchemaEntityTable = MOCK_ENTITIES.issue): Promise<ViewerAction> {
        await mount(row, { actions: [action] });
        return component.visibleActions().find(a => a.key === action.action_name)!;
    }

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Route and entity wiring', () => {
        it('should load entity metadata from route params', async () => {
            await mount();

            expect(component.currentEntity()?.table_name).toBe('Issue');
            expect(getData).toHaveBeenCalledWith(expect.objectContaining({ key: 'Issue', entityId: '42' }), expect.anything());
        });

        it('should store entityKey and entityId from route params', () => {
            expect(component.entityKey).toBe('Issue');
            expect(component.entityId).toBe('42');
        });

        it('should return undefined when entityKey is missing', async () => {
            routeParams.next({ entityId: '42' });
            await mount();

            expect(component.currentEntity()).toBeUndefined();
            expect(getData).not.toHaveBeenCalled();
        });

        it('rebuilds the viewer and re-reads the entity row when the schema rows reload (a locale change)', async () => {
            const live = { row: MOCK_ENTITIES.issue };
            const handle = {
                name: 'Issue',
                get liveRow() { return live.row; },
                features: {},
                can: { insert: true, select: true },
            } as unknown as EntityHandle;
            fixture.componentRef.setInput('entityHandle', handle);
            fixture.detectChanges();
            await advanceTime(100);
            expect(getData).toHaveBeenCalledTimes(1);
            expect(schemaActions).toHaveBeenCalledTimes(1);

            live.row = { ...MOCK_ENTITIES.issue, display_name: 'Problemas' };
            entityRows.set([live.row, MOCK_ENTITIES.status]);
            fixture.detectChanges();
            await advanceTime(100);
            fixture.detectChanges();

            expect(component.currentEntity()?.display_name).toBe('Problemas');
            expect(getData).toHaveBeenCalledTimes(2);
            expect(schemaActions).toHaveBeenCalledTimes(2);
            expect(schemaProperties).toHaveBeenCalledTimes(2);
        });

        it('reloads only the record on refreshData, keeping the actions and properties it read', async () => {
            await mount();
            component.refreshData();
            await advanceTime(100);

            expect(getData).toHaveBeenCalledTimes(2);
            expect(schemaActions).toHaveBeenCalledTimes(1);
            expect(schemaProperties).toHaveBeenCalledTimes(1);
        });

        it('shows the record once the facade has loaded it', async () => {
            await mount();

            expect(component.snapshot()?.record?.['id']).toBe(42);
            expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Pothole');
        });

        it('sets the document title from the entity and record', async () => {
            await mount();

            expect(document.title).toContain('Pothole');
        });
    });

    describe('Route Parameter Changes', () => {
        it('should reload data when entityId changes', async () => {
            await mount();
            expect(component.snapshot()?.record?.['id']).toBe(42);

            recordRow = { id: 99, name: 'Issue 99', created_at: '', updated_at: '', display_name: 'Issue 99' };
            routeParams.next({ entityKey: 'Issue', entityId: '99' });
            await advanceTime(100);
            fixture.detectChanges();

            expect(getData).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'Issue', entityId: '99' }), expect.anything());
            expect(component.snapshot()?.record?.['id']).toBe(99);
            expect(component.entityId).toBe('99');
        });

        it('should reload data when entityKey changes', async () => {
            await mount();

            recordRow = { id: 5, name: 'Open', created_at: '', updated_at: '', display_name: 'Open' };
            routeParams.next({ entityKey: 'Status', entityId: '5' });
            // The resolver hands the page the new entity; until then the old one must not load the new id
            await advanceTime(100);
            expect(getData).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Issue', entityId: '5' }), expect.anything());

            fixture.componentRef.setInput('entityHandle', handleFor(MOCK_ENTITIES.status));
            fixture.detectChanges();
            await advanceTime(100);

            expect(getData).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'Status', entityId: '5' }), expect.anything());
            expect(component.currentEntity()?.table_name).toBe('Status');
            expect(component.entityKey).toBe('Status');
        });

        it('disposes the previous viewer when the record changes', async () => {
            await mount();
            const first = (component as any).viewer;
            routeParams.next({ entityKey: 'Issue', entityId: '43' });
            await advanceTime(100);

            expect((component as any).viewer).not.toBe(first);
            expect(() => first.reload()).toThrow();
        });
    });

    describe('Not-found block', () => {
        function notFoundMarkup(): string {
            return fixture.nativeElement.querySelector('app-empty-state')?.outerHTML ?? '';
        }

        it('renders the not-found block when the record request fails, as it does for a missing record', async () => {
            mockAuthService.authenticated.set(true);
            recordRow = undefined;
            await mount();
            expect(component.snapshot()?.notFound).toBe(true);
            const missing = notFoundMarkup();
            expect(missing).toContain('alert-error');

            getData.mockImplementation(async () => { throw new Error('boom'); });
            routeParams.next({ entityKey: 'Issue', entityId: '43' });
            await advanceTime(100);
            fixture.detectChanges();

            expect(component.snapshot()?.error).toBeTruthy();
            expect(component.snapshot()?.notFound).toBe(false);
            expect(notFoundMarkup()).toBe(missing);
            expect(fixture.nativeElement.querySelector('h1')).toBeNull();
            expect(fixture.nativeElement.querySelector('.loading-spinner')).toBeNull();
        });
    });

    describe('Navigation', () => {
        it('goBack() should delegate to NavigationService with fallback URL', () => {
            component.entityKey = 'issues';
            component.goBack();

            expect(mockNavigationService.goBack).toHaveBeenCalledWith('/view/issues');
        });

        it('onActionButtonClick("edit") should navigate with replaceUrl: true', async () => {
            await mount({ ...MOCK_ENTITIES.issue, update: true });
            component.onActionButtonClick('edit');

            await advanceTime(10);
            expect(navigateSpy).toHaveBeenCalledWith(['/edit', 'Issue', 42], { replaceUrl: true });
        });
    });

    describe('Delete', () => {
        const member = { is_member: true, series_id: 7, group_id: 3, occurrence_date: '2026-01-01' };

        async function mountSeriesMember(): Promise<void> {
            callRpc.mockImplementation(async (fn: string) => fn === 'get_series_membership' ? member : { success: true });
            await mount(MOCK_ENTITIES.issue, { features: { recurring: true } });
        }

        it('navigates to the list and tracks the delete when the record is deleted', async () => {
            await mount();
            await component.confirmDelete();

            expect(deleteData).toHaveBeenCalledWith('Issue', '42');
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Delete', 'Issue');
            expect(navigateSpy).toHaveBeenCalledWith(['/view', 'Issue']);
        });

        it('shows the page fallback when the delete fails without a message', async () => {
            await mount();
            deleteData.mockRejectedValue(new Error('x'));
            await component.confirmDelete();

            expect(component.deleteError()).toBe('Failed to delete record');
            expect(component.deleteLoading()).toBe(false);
            expect(navigateSpy).not.toHaveBeenCalled();
        });

        it('opens the scope dialog for a series member', async () => {
            await mountSeriesMember();
            component.openDeleteModal();

            expect(component.showDeleteScopeDialog()).toBe(true);
            expect(component.showDeleteModal()).toBe(false);
        });

        it('navigates after a scoped delete succeeds', async () => {
            await mountSeriesMember();
            component.onDeleteScopeConfirm({ scope: 'this_only', reason: 'rain' });
            await advanceTime(10);

            expect(callRpc).toHaveBeenCalledWith('cancel_series_occurrence', { p_entity_table: 'Issue', p_entity_id: 42, p_reason: 'rain' });
            expect(navigateSpy).toHaveBeenCalledWith(['/view', 'Issue']);
        });

        it('ends the series from the occurrence and navigates for this and the following occurrences', async () => {
            await mountSeriesMember();
            callRpc.mockImplementation(async (fn: string) => fn === 'end_series_from_date' ? { success: true, entities_deleted: 4 } : member);
            component.onDeleteScopeConfirm({ scope: 'this_and_future' });
            await advanceTime(10);

            expect(callRpc).toHaveBeenCalledWith('end_series_from_date', { p_series_id: 7, p_occurrence_date: '2026-01-01' });
            expect(callRpc).not.toHaveBeenCalledWith('cancel_series_occurrence', expect.anything());
            expect(navigateSpy).toHaveBeenCalledWith(['/view', 'Issue']);
        });

        it('reopens the delete modal with the message when ending the series fails', async () => {
            await mountSeriesMember();
            callRpc.mockImplementation(async (fn: string) => fn === 'end_series_from_date' ? { success: false, message: 'Series not found' } : member);
            component.onDeleteScopeConfirm({ scope: 'this_and_future' });
            await advanceTime(10);

            expect(component.deleteError()).toBe('Series not found');
            expect(component.deleteLoading()).toBe(false);
            expect(component.showDeleteModal()).toBe(true);
            expect(navigateSpy).not.toHaveBeenCalled();
        });

        it('sets the delete error and reopens the delete modal when a scoped delete fails', async () => {
            await mountSeriesMember();
            callRpc.mockImplementation(async (fn: string) => fn === 'delete_series_group' ? { success: false, message: 'Group is locked' } : member);
            component.onDeleteScopeConfirm({ scope: 'all' });
            await advanceTime(10);

            expect(component.deleteError()).toBe('Group is locked');
            expect(component.showDeleteModal()).toBe(true);
            expect(navigateSpy).not.toHaveBeenCalled();
        });

        it('falls back to the RecurringService strings when a scoped delete is rejected without a message', async () => {
            await mountSeriesMember();
            callRpc.mockImplementation(async (fn: string) => {
                if (fn === 'get_series_membership') return member;
                throw new Error('network down');
            });

            component.onDeleteScopeConfirm({ scope: 'all' });
            await advanceTime(10);
            expect(component.deleteError()).toBe('Failed to delete series group');

            component.onDeleteScopeConfirm({ scope: 'this_only' });
            await advanceTime(10);
            expect(component.deleteError()).toBe('Failed to cancel occurrence');
        });

        it('opens the plain delete modal when the facade cannot apply the scope', async () => {
            await mount();
            component.onDeleteScopeConfirm({ scope: 'all' });
            await advanceTime(10);

            expect(component.showDeleteModal()).toBe(true);
            expect(callRpc).not.toHaveBeenCalledWith('delete_series_group', expect.anything());
        });
    });

    describe('Entity Action Parameters (v0.32.0)', () => {
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

        it('should show modal when action has parameters even without requires_confirmation', async () => {
            const action = await mountAction(createMockAction({
                requires_confirmation: false,
                parameters: [createMockParam()]
            }));

            component.onEntityActionClick(action);

            expect(component.showActionModal()).toBe(true);
            expect(component.actionParamForm()).toBeTruthy();
        });

        it('should not build param form for actions without parameters', async () => {
            const action = await mountAction(createMockAction({
                requires_confirmation: true,
                parameters: []
            }));

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

        it('should handle actions with no params same as before', async () => {
            const action = await mountAction(createMockAction({
                requires_confirmation: false,
                parameters: []
            }));

            component.onEntityActionClick(action);

            // Should execute immediately (no modal) with only p_entity_id
            expect(component.showActionModal()).toBe(false);
            expect(executeRpc).toHaveBeenCalledWith('test_rpc', {
                p_entity_id: '42'
            });
        });

        it('should reset param form when modal is closed', async () => {
            const action = await mountAction(createMockAction({
                parameters: [createMockParam({ param_name: 'p_notes' })]
            }));

            component.onEntityActionClick(action);
            expect(component.actionParamForm()).toBeTruthy();

            component.closeActionModal();
            expect(component.actionParamForm()).toBeUndefined();
            expect(component.actionParamOptions()).toEqual({});
        });

        it('should not submit when required param form is invalid', async () => {
            const action = await mountAction(createMockAction({
                parameters: [createMockParam({ param_name: 'p_notes', required: true })]
            }));

            component.onEntityActionClick(action);
            // Don't fill the required field
            await component.confirmEntityAction();

            // executeRpc should NOT have been called
            expect(executeRpc).not.toHaveBeenCalled();
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

            const action = await mountAction(createMockAction({
                parameters: [createMockParam({ param_name: 'p_document_file', param_type: 'file', file_type: 'any' })]
            }));
            component.onEntityActionClick(action);

            // Simulate file selection
            const mockFile = new File(['content'], 'test.pdf', { type: 'application/pdf' });
            const mockEvent = { target: { files: [mockFile], value: '' } } as any;

            component.onActionFileSelected(mockEvent, 'p_document_file');

            // Wait for async upload promise + then/finally microtasks to settle
            await vi.mocked(mockFileUploadService.uploadFile).mock.results.at(-1)!.value;
            await advanceTime(0);

            expect(component.actionParamForm()!.get('p_document_file')!.value).toBe('file-uuid-123');
            expect(component.actionUploadedFile()['p_document_file'].file_name).toBe('test.pdf');
            expect(component.actionFileUploading()).toBe(false);
        });

        it('should show upload error on failed upload', async () => {
            mockFileUploadService.uploadFile.mockRejectedValue(new Error('Network error'));

            const action = await mountAction(createMockAction({
                parameters: [createMockParam({ param_name: 'p_file', param_type: 'file' })]
            }));
            component.onEntityActionClick(action);

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
            await advanceTime(0);

            expect(component.actionUploadError()).toBe('Network error');
            expect(component.actionFileUploading()).toBe(false);
        });

        it('should show validation error for invalid file type', async () => {
            mockFileUploadService.validateFile.mockReturnValue('File type text/plain is not allowed');

            const action = await mountAction(createMockAction({
                parameters: [createMockParam({ param_name: 'p_file', param_type: 'file', file_type: 'image' })]
            }));
            component.onEntityActionClick(action);

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
            const action = await mountAction(createMockAction({
                rpc_function: 'submit_staff_document',
                parameters: [createMockParam({ param_name: 'p_document_file', param_type: 'file', required: true })]
            }));
            component.onEntityActionClick(action);
            // Simulate that file was already uploaded and UUID stored in form
            component.actionParamForm()!.get('p_document_file')!.setValue('file-uuid-456');

            await component.confirmEntityAction();

            expect(executeRpc).toHaveBeenCalledWith('submit_staff_document', {
                p_entity_id: '42',
                p_document_file: 'file-uuid-456'
            });
        });

        it('should always return display_name from getParamDisplayColumn', () => {
            expect(component.getParamDisplayColumn(createMockParam({ param_type: 'foreign_key', join_column: 'id' }))).toBe('display_name');

            expect(component.getParamDisplayColumn(createMockParam({ param_type: 'foreign_key', join_column: 'code' }))).toBe('display_name');

            expect(component.getParamDisplayColumn(createMockParam({ param_type: 'text' }))).toBe('display_name');
        });

        // =====================================================================
        // Parameter bridge: the page's form over the facade's ActionParamSession
        // =====================================================================

        describe('parameter session bridge', () => {
            const typeParam = createMockParam({
                param_name: 'p_tool_type_id',
                param_type: 'foreign_key',
                join_table: 'tool_types',
                join_column: 'id',
                sort_order: 10
            });
            const instanceParam = createMockParam({
                id: 2,
                param_name: 'p_tool_instance_id',
                param_type: 'foreign_key',
                join_table: 'tool_instances',
                join_column: 'id',
                options_source_rpc: 'get_tool_instance_options',
                depends_on_params: ['p_tool_type_id'],
                sort_order: 20
            });

            async function openCascade(): Promise<void> {
                const action = await mountAction(createMockAction({ parameters: [typeParam, instanceParam] }));
                component.onEntityActionClick(action);
                await advanceTime(10);
            }

            it('feeds the session options into actionParamOptions', async () => {
                await openCascade();

                expect(component.actionParamOptions()['p_tool_type_id']).toEqual([{ id: 1, display_name: 'Option A' }]);
                // The dependent skips its initial load while every dependency is empty
                expect(callRpc).not.toHaveBeenCalledWith('get_tool_instance_options', expect.anything(), expect.anything());
            });

            it('sends a control change to the session, which re-fetches the dependent after its debounce', async () => {
                await openCascade();
                callRpc.mockImplementation(async (fn: string) => fn === 'get_tool_instance_options' ? [{ id: 10, display_name: 'Instance X' }] : null);

                component.actionParamForm()!.get('p_tool_type_id')!.setValue(3);
                await advanceTime(100);
                expect(callRpc).not.toHaveBeenCalledWith('get_tool_instance_options', expect.anything(), expect.anything());

                await advanceTime(300);
                expect(callRpc).toHaveBeenCalledWith('get_tool_instance_options', { p_id: 42, p_depends_on: { p_tool_type_id: 3 } }, expect.anything());
                expect(component.actionParamOptions()['p_tool_instance_id']).toEqual([{ id: 10, display_name: 'Instance X' }]);
            });

            it('writes a value the session clears back into the control, without echoing it to the session', async () => {
                await openCascade();
                callRpc.mockImplementation(async (fn: string) => fn === 'get_tool_instance_options' ? [{ id: 10, display_name: 'Instance X' }] : null);
                const form = component.actionParamForm()!;
                form.get('p_tool_type_id')!.setValue(3);
                await advanceTime(400);
                form.get('p_tool_instance_id')!.setValue(10);
                callRpc.mockClear();

                // Clearing the dependency empties the dependent at once, with no request
                form.get('p_tool_type_id')!.setValue(null);
                await advanceTime(400);

                expect(form.get('p_tool_instance_id')!.value).toBeNull();
                expect(component.actionParamOptions()['p_tool_instance_id']).toEqual([]);
                expect(callRpc).not.toHaveBeenCalledWith('get_tool_instance_options', expect.anything(), expect.anything());
            });

            it('writes back a selection that is no longer among the re-fetched options', async () => {
                await openCascade();
                const form = component.actionParamForm()!;
                callRpc.mockImplementation(async (fn: string) => fn === 'get_tool_instance_options' ? [{ id: 10, display_name: 'Instance X' }] : null);
                form.get('p_tool_type_id')!.setValue(1);
                await advanceTime(400);
                form.get('p_tool_instance_id')!.setValue(10);

                callRpc.mockImplementation(async (fn: string) => fn === 'get_tool_instance_options' ? [{ id: 20, display_name: 'Instance Y' }] : null);
                form.get('p_tool_type_id')!.setValue(2);
                await advanceTime(400);

                expect(form.get('p_tool_instance_id')!.value).toBeNull();
                expect(component.actionParamOptions()['p_tool_instance_id']).toEqual([{ id: 20, display_name: 'Instance Y' }]);
            });

            it('disposes the session when the modal closes, so a stale control no longer triggers requests', async () => {
                await openCascade();
                const staleForm = component.actionParamForm()!;
                component.closeActionModal();
                callRpc.mockClear();

                staleForm.get('p_tool_type_id')!.setValue(3);
                await advanceTime(400);

                expect(callRpc).not.toHaveBeenCalled();
            });
        });

        // =========================================================================
        // PHOTO GALLERY ACTION PARAM TESTS (v0.55.0)
        // =========================================================================

        it('should create form control with null default for photo_gallery param', async () => {
            const action = await mountAction(createMockAction({
                parameters: [createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos' })]
            }));
            mockGalleryService.getConfig.mockReturnValue(of({}));

            component.onEntityActionClick(action);

            const form = component.actionParamForm()!;
            expect(form.get('p_checkout_photos')).toBeTruthy();
            expect(form.get('p_checkout_photos')!.value).toBeNull();
        });

        it('should load gallery config via GalleryService.getConfig on modal open', async () => {
            const mockConfig = { table_name: 'tool_reservation_checkouts', column_name: 'checkout_photos', max_images: 10, allowed_types: 'image/*' };
            mockGalleryService.getConfig.mockReturnValue(of(mockConfig));
            const action = await mountAction(createMockAction({
                parameters: [createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos' })]
            }));

            component.onEntityActionClick(action);

            expect(mockGalleryService.getConfig).toHaveBeenCalledWith('Issue', 'checkout_photos');
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
            mockGalleryService.getConfig.mockReturnValue(of({}));
            const action = await mountAction(createMockAction({
                rpc_function: 'confirm_checkout',
                parameters: [createMockParam({ param_name: 'p_checkout_photos', param_type: 'photo_gallery', target_column: 'checkout_photos', required: false })]
            }));
            component.onEntityActionClick(action);
            // Simulate draft gallery was created and UUID stored
            component.onActionGalleryDraftCreated('p_checkout_photos', 'gallery-uuid-789');
            // A successful action closes the modal 1.5 s later; drive that timer
            // instead of leaving it to fire after this spec file.

            await component.confirmEntityAction();

            expect(executeRpc).toHaveBeenCalledWith('confirm_checkout', {
                p_entity_id: '42',
                p_checkout_photos: 'gallery-uuid-789'
            });

            const refreshesBefore = component.refreshCounter();
            await advanceTime(1500);
            expect(component.currentAction()).toBeUndefined();
            expect(component.refreshCounter()).toBe(refreshesBefore + 1); // response asked for refresh
        });

        it('should clear gallery state when modal is closed', () => {
            // Set up some gallery state
            component.actionGalleryConfig.set({ 'p_photos': { table_name: 't', column_name: 'c', max_images: 20, allowed_types: 'image/*' } });
            component.actionGalleryIds.set({ 'p_photos': 'some-uuid' });

            component.closeActionModal();

            expect(component.actionGalleryConfig()).toEqual({});
            expect(component.actionGalleryIds()).toEqual({});
        });
    });

    /**
     * After a successful action the modal auto-closes after 1.5 s, then navigates
     * (navigate_to) or refreshes. That timer belongs to the record the action ran
     * on: once the user has navigated away or the page is destroyed it must not
     * pull them back or refresh another record.
     */
    describe('Action auto-close timer', () => {
        useFakeTimeInEachTest();

        let refreshSpy: any;
        let action: ViewerAction;

        beforeEach(async () => {
            action = await mountAction(createMockAction({ action_name: 'approve', display_name: 'Approve', rpc_function: 'approve_issue' }));
            refreshSpy = vi.spyOn(component, 'refreshData').mockImplementation(() => undefined);
        });

        async function runAction(navigateTo?: string) {
            executeRpc.mockResolvedValue({ success: true, message: 'Approved', navigate_to: navigateTo });
            component.currentAction.set(action);
            component.showActionModal.set(true);
            await component.confirmEntityAction();
            expect(component.actionSuccess()).toBe('Approved');
        }

        it('closes the modal and navigates to navigate_to after 1.5 s', async () => {
            await runAction('/view/Issue');
            await advanceTime(1499);
            expect(navigateSpy).not.toHaveBeenCalled();

            await advanceTime(1);
            expect(component.showActionModal()).toBe(false);
            expect(navigateSpy).toHaveBeenCalledWith(['/view/Issue']);
        });

        it('does not navigate after the page is destroyed', async () => {
            await runAction('/view/Issue');
            fixture.destroy();
            await advanceTime(2000);

            expect(navigateSpy).not.toHaveBeenCalled();
        });

        it('does not pull the user back after they navigate elsewhere', async () => {
            await runAction('/view/Issue');
            (router.events as Subject<any>).next(new NavigationStart(99, '/view/Other/7'));
            // The success modal does not follow the user to the next page
            expect(component.showActionModal()).toBe(false);
            await advanceTime(2000);

            expect(navigateSpy).not.toHaveBeenCalled();
        });

        it('leaves an unrelated open action modal alone on navigation', () => {
            component.currentAction.set(action);
            component.showActionModal.set(true);

            (router.events as Subject<any>).next(new NavigationStart(99, '/view/Issue/42?tab=notes'));

            expect(component.showActionModal()).toBe(true);
        });

        it('does not refresh after the user navigates to another record', async () => {
            await runAction();
            (router.events as Subject<any>).next(new NavigationStart(99, '/view/Issue/43'));
            await advanceTime(2000);

            expect(refreshSpy).not.toHaveBeenCalled();
        });
    });

    describe('Built-in action button labels (i18n)', () => {
        const SPANISH: Record<string, string> = { 'action.edit': 'Editar', 'action.delete': 'Eliminar' };

        beforeEach(async () => {
            await mount({ ...MOCK_ENTITIES.issue, update: true, delete: true });
        });

        it('translates the Edit and Delete labels', () => {
            const translation = TestBed.inject(TranslationService);
            vi.spyOn(translation, 'get').mockImplementation((key: string) => SPANISH[key] ?? key);
            (translation as any)._version.update((v: number) => v + 1);

            const buttons = component.actionButtons();

            expect(buttons.find(b => b.id === 'edit')?.label).toBe('Editar');
            expect(buttons.find(b => b.id === 'delete')?.label).toBe('Eliminar');
        });

        it('re-labels the buttons when translations for a new locale arrive', () => {
            const translation = TestBed.inject(TranslationService);
            expect(component.actionButtons().map(b => b.label)).toEqual(['Edit', 'Delete']);

            // Locale switched and its translations loaded: the service bumps its version
            vi.spyOn(translation, 'get').mockImplementation((key: string) => SPANISH[key] ?? key);
            (translation as any)._version.update((v: number) => v + 1);

            expect(component.actionButtons().map(b => b.label)).toEqual(['Editar', 'Eliminar']);
        });
    });

    describe('Payment button label (i18n)', () => {
        const SPANISH: Record<string, string> = {
            'action.pay_now': 'Pagar Ahora',
            'payment.complete_payment': 'Completar pago'
        };
        const paymentProp = createMockProperty({
            column_name: 'payment_transaction_id',
            display_name: 'Payment',
            udt_name: 'uuid',
            type: EntityPropertyType.Payment
        });

        async function setup(payment: { id: string; status: string } | null, row: SchemaEntityTable = MOCK_ENTITIES.issue) {
            recordRow = { id: 42, name: 'Pothole', payment_transaction_id: payment };
            await mount(row, { props: [MOCK_PROPERTIES.textShort, paymentProp], features: { paymentInitiationRpc: 'initiate_issue_payment' } });
        }

        function paymentLabel(buttons: { id: string; label: string }[]) {
            return buttons.find(b => b.id === 'payment')?.label;
        }

        function bumpLocale(map: Record<string, string>) {
            const translation = TestBed.inject(TranslationService);
            vi.spyOn(translation, 'get').mockImplementation((key: string) => map[key] ?? key);
            (translation as any)._version.update((v: number) => v + 1);
        }

        it('translates Pay Now when no payment exists', async () => {
            await setup(null);
            bumpLocale(SPANISH);

            expect(paymentLabel(component.actionButtons())).toBe('Pagar Ahora');
        });

        it('translates Complete Payment for an unfinished payment', async () => {
            await setup({ id: 'pay_1', status: 'pending_intent' });
            bumpLocale(SPANISH);

            expect(paymentLabel(component.actionButtons())).toBe('Completar pago');
        });

        it('re-labels the payment button when translations for a new locale arrive', async () => {
            await setup(null);
            expect(paymentLabel(component.actionButtons())).toBe('Pay Now');

            bumpLocale(SPANISH);

            expect(paymentLabel(component.actionButtons())).toBe('Pagar Ahora');
        });

        it('re-labels all buttons in a single emission after a locale change', async () => {
            await setup(null, { ...MOCK_ENTITIES.issue, update: true, delete: true });
            const emissions: string[][] = [];
            TestBed.runInInjectionContext(() => effect(() => { emissions.push(component.actionButtons().map(x => x.label)); }));
            TestBed.tick();
            expect(emissions.at(-1)).toEqual(['Edit', 'Delete', 'Pay Now']);
            const before = emissions.length;

            bumpLocale({ ...SPANISH, 'action.edit': 'Editar', 'action.delete': 'Eliminar' });
            TestBed.tick();
            await advanceTime(20);

            // One translation.version emission re-labels every button at once: a single, fully
            // translated emission (the label is not a second stream racing the version signal)
            expect(emissions.slice(before)).toEqual([['Editar', 'Eliminar', 'Pagar Ahora']]);
        });
    });

    describe('Action parameter labels (a11y)', () => {
        const params: EntityActionParam[] = [
            { id: 1, param_name: 'p_text', display_name: 'Field text', param_type: 'text' as any, required: true, sort_order: 1 },
            { id: 2, param_name: 'p_text_short', display_name: 'Field text_short', param_type: 'text_short' as any, required: false, sort_order: 2 },
            { id: 3, param_name: 'p_number', display_name: 'Field number', param_type: 'number' as any, required: true, sort_order: 3 },
            { id: 4, param_name: 'p_boolean', display_name: 'Field boolean', param_type: 'boolean' as any, required: false, sort_order: 4 },
            { id: 5, param_name: 'p_money', display_name: 'Field money', param_type: 'money' as any, required: true, sort_order: 5 },
            { id: 6, param_name: 'p_date', display_name: 'Field date', param_type: 'date' as any, required: false, sort_order: 6 },
            { id: 7, param_name: 'p_datetime', display_name: 'Field datetime', param_type: 'datetime' as any, required: true, sort_order: 7 },
            { id: 8, param_name: 'p_datetime_local', display_name: 'Field datetime_local', param_type: 'datetime_local' as any, required: false, sort_order: 8 },
            { id: 9, param_name: 'p_color', display_name: 'Field color', param_type: 'color' as any, required: true, sort_order: 9 },
            { id: 10, param_name: 'p_email', display_name: 'Field email', param_type: 'email' as any, required: false, sort_order: 10 },
            { id: 11, param_name: 'p_telephone', display_name: 'Field telephone', param_type: 'telephone' as any, required: true, sort_order: 11 },
            { id: 12, param_name: 'p_status', display_name: 'Field status', param_type: 'status' as any, required: false, sort_order: 12 },
            { id: 13, param_name: 'p_category', display_name: 'Field category', param_type: 'category' as any, required: true, sort_order: 13 },
            { id: 14, param_name: 'p_foreign_key', display_name: 'Field foreign_key', param_type: 'foreign_key' as any, required: false, sort_order: 14 },
            { id: 15, param_name: 'p_user', display_name: 'Field user', param_type: 'user' as any, required: true, sort_order: 15 },
            { id: 16, param_name: 'p_file', display_name: 'Field file', param_type: 'file' as any, required: false, sort_order: 16 },
            { id: 17, param_name: 'p_geo_point', display_name: 'Field geo_point', param_type: 'geo_point' as any, required: true, sort_order: 17 }
        ];

        function expectEveryParamLabelled(root: HTMLElement, params: EntityActionParam[]) {
            for (const param of params) {
                const label = Array.from(root.querySelectorAll('label'))
                    .find(l => l.textContent!.includes(param.display_name));
                expect(label, `label for ${param.param_name}`).toBeTruthy();
                const forId = label!.getAttribute('for');
                expect(forId, `for= on ${param.param_name} label`).toBeTruthy();
                const control = root.querySelector(`[id="${forId}"]`) as HTMLElement | null;
                expect(control, `control #${forId}`).toBeTruthy();
                expect(['INPUT', 'SELECT', 'TEXTAREA']).toContain(control!.tagName);
                expect(control!.getAttribute('aria-required')).toBe(param.required ? 'true' : null);
            }
        }

        it('associates a <label for> with every parameter control and marks required ones', async () => {
            const action = await mountAction(createMockAction({ action_name: 'close', display_name: 'Close', parameters: params }));
            expect(fixture.nativeElement.querySelector('h1')).toBeTruthy();

            component.onEntityActionClick(action);
            fixture.detectChanges();

            expectEveryParamLabelled(fixture.nativeElement, params);
        });
    });
});
