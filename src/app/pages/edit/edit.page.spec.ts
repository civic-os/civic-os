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
import { Component, input, output, provideZonelessChangeDetection, signal } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { EditPage } from './edit.page';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import { GuidedFormService } from '../../services/guided-form.service';
import { SaveProgressComponent, SaveStep } from '../../components/save-progress/save-progress.component';
import { BehaviorSubject, of, firstValueFrom } from 'rxjs';
import type { EditorDeps, EntityHandle } from '@civic-os/core';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockManyToManyMeta, createMockProperty } from '../../testing';
import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable } from '../../interfaces/entity';
import Keycloak from 'keycloak-js';
import { FACADE_DEPS } from '../../sdk/facade-deps';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';

/**
 * Stands in for the progress component, which would start the steps itself on render:
 * the tests run each step by hand to see what it sends.
 */
@Component({ selector: 'app-save-progress', template: '' })
class StubSaveProgress {
    steps = input.required<SaveStep[]>();
    completed = output<void>();
}

/** A core entity handle over a row, as the route resolver would hand the page. */
function handleFor(row: SchemaEntityTable, features: Record<string, unknown> = {}): EntityHandle {
    return {
        name: row.table_name,
        get liveRow() { return row; },
        features,
        can: { insert: row.insert, select: row.select, update: true },
    } as unknown as EntityHandle;
}

const ok = { check: { success: true } };

describe('EditPage', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: EditPage;
    let fixture: ComponentFixture<EditPage>;
    let mockSchemaService: any;
    let mockAnalyticsService: any;
    let mockAuthService: any;
    let mockRouter: any;
    let mockKeycloak: any;
    let mockNavigationService: any;
    let mockGuidedFormService: any;
    let routeParams: BehaviorSubject<any>;
    let routeSnapshot: { queryParamMap: { get: (k: string) => string | null } };

    /** The facade's data client and schema reads: every record request the page causes goes through them. */
    let getData: ReturnType<typeof vi.fn>;
    let editData: ReturnType<typeof vi.fn>;
    let callRpc: ReturnType<typeof vi.fn>;
    let addManyToManyRelation: ReturnType<typeof vi.fn>;
    let removeManyToManyRelation: ReturnType<typeof vi.fn>;
    let updateManyToManyRelation: ReturnType<typeof vi.fn>;
    let schemaProperties: ReturnType<typeof vi.fn>;
    let formRenderables: ReturnType<typeof vi.fn>;
    /** SchemaService's loaded entity rows; a new array is a schema refresh. */
    let entityRows: ReturnType<typeof signal<SchemaEntityTable[] | undefined>>;
    /** What the record read answers for the route's record. */
    let record: Record<string, unknown> | undefined;

    beforeEach(async () => {
        routeParams = new BehaviorSubject({ entityKey: 'Issue', entityId: '42' });
        routeSnapshot = { queryParamMap: { get: () => null } };
        entityRows = signal<SchemaEntityTable[] | undefined>([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);
        record = { id: 42, name: 'Old Name' };

        mockSchemaService = {
            getEntity: vi.fn().mockName("SchemaService.getEntity"),
            entityRows
        };
        mockAnalyticsService = {
            trackEvent: vi.fn().mockName("AnalyticsService.trackEvent")
        };
        mockAuthService = {
            login: vi.fn().mockName("AuthService.login"),
            authenticated: signal(false)
        };
        mockRouter = {
            navigate: vi.fn().mockName("Router.navigate"),
            navigateByUrl: vi.fn().mockName("Router.navigateByUrl")
        };
        mockKeycloak = {
            updateToken: vi.fn().mockName("Keycloak.updateToken")
        };
        mockNavigationService = {
            goBack: vi.fn().mockName("NavigationService.goBack")
        };
        mockGuidedFormService = {
            invalidateContextForForm: vi.fn().mockName("GuidedFormService.invalidateContextForForm"),
            getEffectiveSteps: vi.fn().mockName("GuidedFormService.getEffectiveSteps").mockReturnValue([])
        };

        // Setup updateToken to return resolved promise by default (for form submission)
        mockKeycloak.updateToken.mockResolvedValue(true);

        mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));

        getData = vi.fn(async (query: { key?: string }) => {
            if (query.key === 'time_slot_series') return [{ timezone: 'America/New_York', dtstart: '2026-01-06T17:30:00', time_slot_property: 'time_slot' }];
            return record ? [record] : [];
        });
        editData = vi.fn(async () => ok);
        callRpc = vi.fn(async () => null);
        addManyToManyRelation = vi.fn(async () => undefined);
        removeManyToManyRelation = vi.fn(async () => undefined);
        updateManyToManyRelation = vi.fn(async () => undefined);
        schemaProperties = vi.fn(async () => [MOCK_PROPERTIES.textShort]);
        formRenderables = vi.fn(async () => []);
        const facadeDeps = {
            data: { getData, editData, callRpc, addManyToManyRelation, removeManyToManyRelation, updateManyToManyRelation },
            schema: {
                properties: schemaProperties,
                formRenderables,
                constraintMessages: () => undefined,
            },
            clock: { now: () => new Date() },
        } as unknown as EditorDeps;

        await TestBed.configureTestingModule({
            imports: [EditPage],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                provideRouter([]),
                { provide: ActivatedRoute, useValue: { params: routeParams.asObservable(), get snapshot() { return routeSnapshot; } } },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: {} },
                { provide: AnalyticsService, useValue: mockAnalyticsService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: Router, useValue: mockRouter },
                { provide: Keycloak, useValue: mockKeycloak },
                { provide: NavigationService, useValue: mockNavigationService },
                { provide: GuidedFormService, useValue: mockGuidedFormService },
                { provide: FACADE_DEPS, useValue: facadeDeps }
            ]
        })
            .overrideComponent(EditPage, { remove: { imports: [SaveProgressComponent] }, add: { imports: [StubSaveProgress] } })
            .compileComponents();

        fixture = TestBed.createComponent(EditPage);
        component = fixture.componentInstance;
    });

    /** Gives the page its route entity handle, as the resolver does, and lets the first load settle. */
    async function mount(
        options: { row?: SchemaEntityTable; props?: SchemaEntityProperty[]; features?: Record<string, unknown> } = {}
    ): Promise<void> {
        schemaProperties.mockResolvedValue(options.props ?? [MOCK_PROPERTIES.textShort]);
        fixture.componentRef.setInput('entityHandle', handleFor(options.row ?? MOCK_ENTITIES.issue, options.features));
        fixture.detectChanges();
        await advanceTime(100);
        fixture.detectChanges();
    }

    /** Writes values into the bound form, as typing would. */
    function fill(values: Record<string, unknown>): void {
        component.editForm()!.patchValue(values);
    }

    /** Runs a save to its result: the page's handler is async and settles after the editor's request. */
    async function submit(): Promise<void> {
        await component.submitForm({});
        await advanceTime(10);
        fixture.detectChanges();
    }

    async function continueSave(): Promise<void> {
        await component.saveAndContinue();
        await advanceTime(10);
        fixture.detectChanges();
    }

    /** Runs a step the way the progress component does. */
    const runStep = (index: number) => firstValueFrom(component.saveSteps()![index].execute());

    /** A required name, so clearing it makes the form invalid. */
    const requiredName = () => ({ ...MOCK_PROPERTIES.textShort, is_nullable: false });

    const timeSlot = () => createMockProperty({
        table_name: 'Issue', column_name: 'time_slot', display_name: 'Time', type: EntityPropertyType.TimeSlot, udt_name: 'time_slot',
        is_nullable: true
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Observable Chain Integration', () => {
        it('should load entity metadata from route params', async () => {
            component.entity$.subscribe(entity => {
                expect(entity).toBeDefined();
                expect(entity?.table_name).toBe('Issue');
                expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
            });
        });

        it('should store entityKey and entityId from route params', async () => {
            component.entity$.subscribe(() => {
                expect(component.entityKey).toBe('Issue');
                expect(component.entityId).toBe('42');
            });
        });

        it('should return undefined when entityKey or entityId is missing', async () => {
            routeParams.next({ entityKey: 'Issue' });
            let result: unknown = 'unset';
            component.entity$.subscribe(entity => { result = entity; });
            expect(result).toBeUndefined();

            routeParams.next({ entityId: '42' });
            result = 'unset';
            component.entity$.subscribe(entity => { result = entity; });
            expect(result).toBeUndefined();
        });
    });

    describe('Editor binding', () => {
        it('builds the form from the route handle and the record once the load settles', async () => {
            expect(component.editForm()).toBeUndefined();

            await mount();

            expect(component.editForm()?.get('name')?.value).toBe('Old Name');
            expect(component.record()).toEqual({ id: 42, name: 'Old Name' });
            expect(schemaProperties).toHaveBeenCalledTimes(1);
            expect(formRenderables).toHaveBeenCalledTimes(1);
            expect(getData).toHaveBeenCalledWith(expect.objectContaining({ key: 'Issue', entityId: '42' }));
        });

        it('builds no editor while the handle is not the route entity', async () => {
            routeParams.next({ entityKey: 'Status', entityId: '42' });
            await mount();

            expect(component.snapshot()).toBeUndefined();
            expect(component.editForm()).toBeUndefined();
            expect(schemaProperties).not.toHaveBeenCalled();
        });

        it('has no editor without a route entity id', async () => {
            routeParams.next({ entityKey: 'Issue' });
            await mount();

            expect(component.snapshot()).toBeUndefined();
            expect(schemaProperties).not.toHaveBeenCalled();
        });

        it('has no editor without a route entity key', async () => {
            routeParams.next({ entityId: '42' });
            await mount();

            expect(component.snapshot()).toBeUndefined();
            expect(schemaProperties).not.toHaveBeenCalled();
        });

        it('rebuilds the editor, and reads the new record, when the route entity id changes', async () => {
            await mount();
            const first = (component as any).editor;
            record = { id: 99, name: 'Issue 99' };

            routeParams.next({ entityKey: 'Issue', entityId: '99' });
            fixture.detectChanges();
            await advanceTime(100);
            fixture.detectChanges();

            expect((component as any).editor).not.toBe(first);
            // the old editor is disposed: its commands throw
            expect(() => first.save()).toThrow();
            expect(component.entityId).toBe('99');
            expect(component.editForm()!.get('name')!.value).toBe('Issue 99');
            expect(getData).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'Issue', entityId: '99' }));
        });

        it('rebuilds the editor from the new handle when the route entity key changes', async () => {
            await mount();
            const first = (component as any).editor;

            routeParams.next({ entityKey: 'Status', entityId: '5' });
            fixture.componentRef.setInput('entityHandle', handleFor(MOCK_ENTITIES.status));
            fixture.detectChanges();
            await advanceTime(100);
            fixture.detectChanges();

            expect((component as any).editor).not.toBe(first);
            expect(() => first.save()).toThrow();
            expect(component.entityKey).toBe('Status');
            expect(schemaProperties).toHaveBeenCalledTimes(2);

            fill({ name: 'Second' });
            await submit();
            expect(editData).toHaveBeenCalledWith('Status', '5', { name: 'Second' });
        });

        it('rebuilds the editor when the schema rows reload', async () => {
            await mount();
            const first = (component as any).editor;

            entityRows.set([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);
            fixture.detectChanges();
            await advanceTime(100);
            fixture.detectChanges();

            expect((component as any).editor).not.toBe(first);
            expect(schemaProperties).toHaveBeenCalledTimes(2);
        });

        it('drops the editor with the page', async () => {
            await mount();
            const editor = (component as any).editor;
            fixture.destroy();

            expect(() => editor.save()).toThrow();
        });

        it('shows the loading spinner while the first read is in flight', async () => {
            let release: (rows: unknown[]) => void = () => undefined;
            getData.mockImplementation(() => new Promise(resolve => { release = resolve; }));
            await mount();
            // schema reads settled, the record read has not
            fixture.detectChanges();

            expect(component.dataLoading()).toBe(true);
            expect(component.record()).toBeNull();
            expect(fixture.nativeElement.querySelector('.loading-spinner')).not.toBeNull();

            release([{ id: 42, name: 'Late' }]);
            await advanceTime(100);
            fixture.detectChanges();

            expect(component.dataLoading()).toBe(false);
            expect(component.editForm()!.get('name')!.value).toBe('Late');
        });

        it('shows the not-found block when the record does not exist', async () => {
            record = undefined;
            await mount();

            expect(component.snapshot()!.notFound).toBe(true);
            expect(component.record()).toBeNull();
            expect(component.editForm()).toBeUndefined();
            expect(fixture.nativeElement.querySelector('app-empty-state, .alert, h1')).not.toBeNull();
        });

        it('shows the not-found block when the record read fails', async () => {
            getData.mockRejectedValue(new Error('network'));
            await mount();

            expect(component.snapshot()!.error).toBeTruthy();
            expect(component.record()).toBeNull();
            expect(component.editForm()).toBeUndefined();
        });
    });

    describe('submitForm()', () => {
        beforeEach(async () => {
            await mount();
        });

        it('should call editData with form values', async () => {
            fill({ name: 'Updated Name' });
            await submit();

            expect(editData).toHaveBeenCalledWith('Issue', '42', { name: 'Updated Name' });
        });

        it('should show success modal on successful update', async () => {
            await submit();

            expect(component.showSuccessModal()).toBe(true);
            expect(component.showErrorModal()).toBe(false);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Edit', 'Issue');
        });

        it('should show error modal on failed update', async () => {
            const error = {
                httpCode: 400,
                message: 'Update failed',
                details: 'Constraint violation',
                hint: 'Check your input',
                humanMessage: 'Could not update'
            };
            editData.mockResolvedValue({ check: { success: false, error } });
            const logged = vi.spyOn(console, 'error').mockReturnValue(undefined);

            await submit();

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(error);
            expect(component.showSuccessModal()).toBe(false);
            expect(logged).toHaveBeenCalledWith('[EDIT SUBMIT] API returned error:', error);
        });

        it('should not submit when the route has no entity key', async () => {
            component.entityKey = undefined;
            routeParams.next({ entityId: '42' });
            fixture.detectChanges();
            await advanceTime(10);
            await component.submitForm({});

            expect(editData).not.toHaveBeenCalled();
        });

        it('should not submit when the route has no entity id', async () => {
            routeParams.next({ entityKey: 'Issue' });
            fixture.detectChanges();
            await advanceTime(10);
            await component.submitForm({});

            expect(editData).not.toHaveBeenCalled();
        });

        it('should not submit when there is no form', async () => {
            record = undefined;
            const fresh = TestBed.createComponent(EditPage);
            fresh.componentRef.setInput('entityHandle', handleFor(MOCK_ENTITIES.issue));
            fresh.detectChanges();
            await advanceTime(100);
            await fresh.componentInstance.submitForm({});

            expect(fresh.componentInstance.editForm()).toBeUndefined();
            expect(editData).not.toHaveBeenCalled();
        });

        it('keeps Save disabled while a save is in flight, and ignores a second submit', async () => {
            let finish: (v: unknown) => void = () => undefined;
            editData.mockImplementation(() => new Promise(resolve => { finish = resolve; }));

            const first = component.submitForm({});
            await advanceTime(10);
            expect(component.isSaving()).toBe(true);
            await component.submitForm({});
            expect(editData).toHaveBeenCalledTimes(1);

            finish(ok);
            await first;
            await advanceTime(10);
            expect(component.isSaving()).toBe(false);
        });
    });

    describe('Form Validation UX', () => {
        beforeEach(async () => {
            await mount({ props: [requiredName()] });
        });

        it('should not submit when form is invalid', async () => {
            fill({ name: '' });
            await submit();

            expect(editData).not.toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(false);
        });

        it('should set showValidationError flag when submitting invalid form', async () => {
            fill({ name: '' });
            await submit();

            expect(component.showValidationError()).toBe(true);
            expect(component.showErrorModal()).toBe(false);
        });

        it('should hide error banner when form becomes valid', async () => {
            fill({ name: '' });
            await submit();
            expect(component.showValidationError()).toBe(true);

            fill({ name: 'Valid Name' });
            await advanceTime(10);
            fixture.detectChanges();

            expect(component.showValidationError()).toBe(false);
        });

        it('should call scrollToFirstError when form is invalid', async () => {
            const spy = vi.spyOn(component as any, 'scrollToFirstError').mockReturnValue(undefined);

            fill({ name: '' });
            await submit();

            expect(spy).toHaveBeenCalled();
        });

        it('clears the banner after a valid save', async () => {
            component.showValidationError.set(true);
            fill({ name: 'Fine' });
            await submit();

            expect(component.showValidationError()).toBe(false);
        });
    });

    describe('goBack()', () => {
        it('should delegate to NavigationService with fallback URL including entityId', () => {
            component.entityKey = 'Issue';
            component.entityId = '42';
            component.goBack();

            expect(mockNavigationService.goBack).toHaveBeenCalledWith('/view/Issue/42');
        });
    });

    describe('navToList()', () => {
        it('should navigate to current entity list with replaceUrl', () => {
            component.entityKey = 'Issue';
            component.navToList();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue'], { replaceUrl: true });
        });

        it('should navigate to specified entity list with replaceUrl', () => {
            component.navToList('Status');

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Status'], { replaceUrl: true });
        });
    });

    describe('navToRecord()', () => {
        it('should navigate to specified record with replaceUrl', () => {
            component.navToRecord('Issue', '42');

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue', '42'], { replaceUrl: true });
        });
    });

    describe('Entity Description Tooltip', () => {
        it('should display entity with description in template', async () => {
            mockSchemaService.getEntity.mockReturnValue(of({ ...MOCK_ENTITIES.issue, description: 'Track system issues' }));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBe('Track system issues');
            });
        });

        it('should handle entities without description', async () => {
            mockSchemaService.getEntity.mockReturnValue(of({ ...MOCK_ENTITIES.issue, description: null }));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBeNull();
            });
        });
    });

    describe('Token Refresh (Keycloak Integration)', () => {
        beforeEach(async () => {
            await mount();
        });

        it('should call updateToken before form submission', async () => {
            await submit();

            expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
            expect(editData).toHaveBeenCalled();
        });

        it('should proceed with submission when token refresh succeeds', async () => {
            fill({ name: 'Updated' });
            await submit();

            expect(editData).toHaveBeenCalledWith('Issue', '42', { name: 'Updated' });
            expect(component.showSuccessModal()).toBe(true);
        });

        it('should show 401 error modal when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Token refresh failed'));

            await submit();

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({
                httpCode: 401,
                message: 'Session expired',
                humanMessage: 'Session Expired',
                hint: 'Your login session has expired. Please refresh the page to log in again.'
            }));
            expect(editData).not.toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(false);
        });

        it('should not call editData when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Expired'));

            await submit();

            expect(editData).not.toHaveBeenCalled();
        });
    });

    describe('returnTo', () => {
        it('navigates to returnTo instead of showing the modal, as read when the record loaded', async () => {
            routeSnapshot.queryParamMap.get = (k: string) => (k === 'returnTo' ? '/profile' : null);
            await mount();
            // a later change of the query is not seen: it is read at load time
            routeSnapshot.queryParamMap.get = () => null;

            await submit();

            expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/profile', { replaceUrl: true });
            expect(component.showSuccessModal()).toBe(false);
        });

        it('shows the success modal without returnTo', async () => {
            await mount();
            await submit();

            expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(true);
        });
    });

    describe('Coordinated saves (steps)', () => {
        const m2m = () => createMockProperty({
            table_name: 'Issue', column_name: 'tags', display_name: 'Tags', type: EntityPropertyType.ManyToMany,
            udt_name: '_junction_', show_inline: true, many_to_many_meta: createMockManyToManyMeta()
        });

        beforeEach(async () => {
            await mount({ props: [MOCK_PROPERTIES.textShort, m2m()] });
        });

        it('runs the record and the many-to-many changes as labelled steps, and keeps Save disabled until they complete', async () => {
            component.onM2mDiffChanged('tags', { toAdd: [1, 2], toRemove: [3] });
            fill({ name: 'Changed' });
            await submit();

            const steps = component.saveSteps()!;
            expect(component.showSuccessModal()).toBe(true);
            expect(steps.map(s => s.label)).toEqual([
                'Saving record',
                'Updating Tags (2 to add, 1 to remove)'
            ]);
            expect(component.isSaving()).toBe(true);

            expect(await runStep(0)).toEqual({ success: true });
            expect(editData).toHaveBeenCalledWith('Issue', '42', { name: 'Changed' });
            expect(await runStep(1)).toEqual(expect.objectContaining({ success: true }));
            expect(addManyToManyRelation).toHaveBeenCalledTimes(2);
            expect(removeManyToManyRelation).toHaveBeenCalledTimes(1);

            component.onSaveComplete();
            expect(component.saveComplete()).toBe(true);
            expect(component.isSaving()).toBe(false);
        });

        it('words a partly failed many-to-many step by its counts', async () => {
            component.onM2mDiffChanged('tags', { toAdd: [1, 2], toRemove: [] });
            addManyToManyRelation.mockRejectedValueOnce(new Error('x'));
            await submit();

            const result = await runStep(1);
            expect(result.success).toBe(false);
            expect(result.errorMessage).toBe('1 of 2 changes failed');
        });

        it('shows a failed record step with the server message', async () => {
            component.onM2mDiffChanged('tags', { toAdd: [1], toRemove: [] });
            editData.mockResolvedValue({ check: { success: false, error: { httpCode: 400, message: 'm', humanMessage: 'Human' } } });
            await submit();

            expect(await runStep(0)).toEqual({ success: false, errorMessage: 'Human' });
        });

        it('labels a rich many-to-many step by its change total', async () => {
            component.onRichM2mDiffChanged('tags', { toAdd: [{ id: 1, extraData: {} }], toRemove: [2], toUpdate: [{ id: 3, extraData: {} }] } as any);
            await submit();

            expect(component.saveSteps()!.map(s => s.label)).toEqual(['Saving record', 'Updating Tags (3 changes)']);
            expect(await runStep(1)).toEqual(expect.objectContaining({ success: true }));
            expect(updateManyToManyRelation).toHaveBeenCalledTimes(1);
        });
    });

    describe('Galleries', () => {
        let gallery: { hasPendingChanges: ReturnType<typeof vi.fn> };
        let saveGalleryChanges: ReturnType<typeof vi.fn>;

        beforeEach(async () => {
            await mount();
            gallery = { hasPendingChanges: vi.fn(() => true) };
            saveGalleryChanges = vi.fn(async () => true);
            (component as any).editProperties = [{
                galleryEditor: gallery,
                prop: () => ({ column_name: 'photos' }),
                saveGalleryChanges
            }];
        });

        it('registers the mounted gallery editors with the editor before a save, so a pending gallery makes the save coordinated', async () => {
            await submit();

            expect(component.saveSteps()!.map(s => s.label)).toEqual(['Saving record', 'Saving gallery changes']);
            expect(await runStep(1)).toEqual({ success: true });
            expect(saveGalleryChanges).toHaveBeenCalledTimes(1);
        });

        it('reports a gallery that saved nothing', async () => {
            saveGalleryChanges.mockResolvedValue(false);
            await submit();

            expect(await runStep(1)).toEqual({ success: false, errorMessage: 'Failed to save gallery changes' });
        });

        it('rejects the step when a gallery save throws', async () => {
            saveGalleryChanges.mockRejectedValue(new Error('upload'));
            await submit();

            await expect(runStep(1)).rejects.toThrow('upload');
        });

        it('does not coordinate a save without pending gallery changes', async () => {
            gallery.hasPendingChanges.mockReturnValue(false);
            await submit();

            expect(component.saveSteps()).toBeNull();
            expect(component.showSuccessModal()).toBe(true);
        });
    });

    describe('Series (recurring time slots)', () => {
        beforeEach(async () => {
            callRpc.mockImplementation(async (name: string) => {
                if (name === 'get_series_membership') return { is_member: true, series_id: 3, occurrence_date: '2026-01-13' };
                if (name === 'split_series_from_date' || name === 'update_series_template') return { success: true, message: '' };
                return null;
            });
            record = { id: 42, name: 'Old Name', time_slot: '["2026-01-13 17:30:00+00","2026-01-13 18:30:00+00")' };
            await mount({ props: [MOCK_PROPERTIES.textShort, timeSlot()] });
        });

        it('reads the membership and asks which occurrences a save applies to, sending nothing yet', async () => {
            expect(component.seriesMembership()).toEqual({ is_member: true, series_id: 3, occurrence_date: '2026-01-13' });
            expect(callRpc).toHaveBeenCalledWith('get_series_membership', { p_entity_table: 'Issue', p_entity_id: '42' });

            fill({ name: 'Edited' });
            await submit();

            expect(component.showScopeDialog()).toBe(true);
            expect(editData).not.toHaveBeenCalled();
        });

        it('closes the dialog and sends nothing when the scope is cancelled', async () => {
            await submit();
            component.onScopeCancel();
            await advanceTime(10);

            expect(component.showScopeDialog()).toBe(false);
            expect(editData).not.toHaveBeenCalled();
        });

        it('saves only this occurrence for "this only"', async () => {
            fill({ name: 'Edited' });
            await submit();
            await component.onScopeConfirm({ scope: 'this_only' });
            await advanceTime(10);

            expect(editData).toHaveBeenCalledWith('Issue', '42', expect.objectContaining({ name: 'Edited' }));
            expect(component.showSuccessModal()).toBe(true);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Edit', 'Issue');
        });

        it('splits the series for "this and following", tracks it and shows success', async () => {
            fill({ name: 'Edited' });
            await submit();
            await component.onScopeConfirm({ scope: 'this_and_future' });
            await advanceTime(10);

            expect(callRpc).toHaveBeenCalledWith('split_series_from_date', expect.objectContaining({ p_series_id: 3, p_split_date: '2026-01-13' }));
            expect(editData).not.toHaveBeenCalled();
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'EditSeriesFuture', 'Issue');
            expect(component.showSuccessModal()).toBe(true);
        });

        it('updates the template for "all occurrences", tracks it and shows success', async () => {
            fill({ name: 'Edited' });
            await submit();
            await component.onScopeConfirm({ scope: 'all' });
            await advanceTime(10);

            expect(callRpc).toHaveBeenCalledWith('update_series_template', expect.objectContaining({ p_series_id: 3 }));
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'EditSeriesAll', 'Issue');
            expect(component.showSuccessModal()).toBe(true);
        });

        it('shows the split wording when the split RPC reports failure', async () => {
            callRpc.mockImplementation(async (name: string) => {
                if (name === 'get_series_membership') return { is_member: true, series_id: 3, occurrence_date: '2026-01-13' };
                if (name === 'split_series_from_date') return { success: false, message: 'Overlap' };
                return null;
            });
            await fixture.componentInstance.onScopeCancel();
            fill({ name: 'Edited' });
            await submit();
            await component.onScopeConfirm({ scope: 'this_and_future' });
            await advanceTime(10);

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({ httpCode: 400, message: 'Overlap' }));
            expect(component.showSuccessModal()).toBe(false);
            expect(editData).not.toHaveBeenCalled();
        });

        it('shows the series wording when the template update fails', async () => {
            callRpc.mockImplementation(async (name: string) => {
                if (name === 'get_series_membership') return { is_member: true, series_id: 3, occurrence_date: '2026-01-13' };
                if (name === 'update_series_template') return { success: false, message: 'Nope' };
                return null;
            });
            const logged = vi.spyOn(console, 'error').mockReturnValue(undefined);
            fill({ name: 'Edited' });
            await submit();
            await component.onScopeConfirm({ scope: 'all' });
            await advanceTime(10);

            expect(component.currentError()).toEqual({ httpCode: 400, message: 'Nope', humanMessage: 'Series Update Failed' });
            expect(component.showErrorModal()).toBe(true);
            expect(logged).toHaveBeenCalledWith('[SERIES UPDATE] API returned error:', 'Nope');
        });
    });

    describe('Guided forms', () => {
        const step = (key: string, table: string, order: number, over: Record<string, unknown> = {}) => ({
            id: order + 1, guided_form_key: 'intake', step_key: key, display_name: key, description: null, step_table: table,
            parent_fk_column: 'application_id', step_order: order, can_skip: true, track_key: null, conditions: [], ...over
        });
        const context = (overrides: Record<string, unknown> = {}) => ({
            definition: {
                guided_form_key: 'intake', description: null, parent_table: 'applications', ownership_column: null,
                lock_on_submit: true, on_submit_rpc: null, review_intro_text: null, precondition_rpc: null,
                auto_submit_on_all_skipped: false, is_enabled: true, status_options: []
            },
            steps: [
                step('__parent__', 'applications', 0, { parent_fk_column: null, can_skip: false }),
                step('about', 'Issue', 1),
                step('budget', 'budgets', 2, { can_skip: false })
            ],
            progress: [], status_options: [], parent_status_id: 1, parent_status_key: 'draft', parent_id: 100,
            record_id: 42, is_child_step: true, step_key: 'about', step_record_ids: {},
            ...overrides
        });

        beforeEach(() => {
            mockGuidedFormService.invalidateContextForForm.mockClear();
        });

        it('is not in guided mode without a guided form key', async () => {
            await mount();

            expect(component.isGuidedFormMode()).toBe(false);
            expect(component.guidedFormContext()).toBeNull();
        });

        it('loads the context through the editor and navigates to the parent after a draft save', async () => {
            callRpc.mockImplementation(async (name: string) => (name === 'get_guided_form_context' ? context() : null));
            await mount({ features: { guidedFormKey: 'intake' } });

            expect(component.isGuidedFormMode()).toBe(true);
            expect(component.isGuidedFormDraft()).toBe(true);

            await submit();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'applications', expect.anything()]);
            expect(component.showSuccessModal()).toBe(false);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Edit', 'Issue');
        });

        it('skipStep navigates to the next step, ensuring its record', async () => {
            callRpc.mockImplementation(async (name: string) => {
                if (name === 'get_guided_form_context') return context();
                if (name === 'ensure_guided_form_step_record') return { record_id: 301 };
                return null;
            });
            await mount({ features: { guidedFormKey: 'intake' } });

            await component.skipStep();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['/edit', 'budgets', 301]);
        });

        it('skipStep goes to the parent after the last step', async () => {
            callRpc.mockImplementation(async (name: string) =>
                (name === 'get_guided_form_context' ? context({ steps: [step('__parent__', 'applications', 0, { parent_fk_column: null }), step('about', 'Issue', 1)] }) : null));
            await mount({ features: { guidedFormKey: 'intake' } });

            await component.skipStep();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'applications', 100]);
        });

        it('goes to a step through the editor, and shows the message when the step record cannot be made', async () => {
            callRpc.mockImplementation(async (name: string) => {
                if (name === 'get_guided_form_context') return context();
                if (name === 'ensure_guided_form_step_record') throw new Error('no record');
                return null;
            });
            await mount({ features: { guidedFormKey: 'intake' } });

            await component.onGuidedFormStepClick('budget');
            await advanceTime(10);

            expect(mockRouter.navigate).not.toHaveBeenCalled();
            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({ humanMessage: 'Failed to load step record.', message: 'no record' }));
        });

        it('goes to the parent for the parent step', async () => {
            callRpc.mockImplementation(async (name: string) => (name === 'get_guided_form_context' ? context() : null));
            await mount({ features: { guidedFormKey: 'intake' } });

            await component.onGuidedFormStepClick('__parent__');

            expect(mockRouter.navigate).toHaveBeenCalledWith(['/edit', 'applications', expect.anything()]);
        });

        it('Save and Continue invalidates the cached context, tracks the step and navigates', async () => {
            callRpc.mockImplementation(async (name: string) => {
                if (name === 'get_guided_form_context') return context();
                if (name === 'complete_guided_form_step') return { success: true, navigate_to: '/done' };
                return null;
            });
            await mount({ features: { guidedFormKey: 'intake' } });

            await continueSave();

            expect(editData).toHaveBeenCalled();
            expect(mockGuidedFormService.invalidateContextForForm).toHaveBeenCalledWith('intake');
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('GuidedForm', 'StepComplete', expect.stringMatching(/^intake:/));
        });

        it('Save and Continue shows the failure and does not navigate or invalidate', async () => {
            callRpc.mockImplementation(async (name: string) => (name === 'get_guided_form_context' ? context() : null));
            editData.mockResolvedValue({ check: { success: false, error: { httpCode: 400, message: 'bad', humanMessage: 'Bad' } } });
            await mount({ features: { guidedFormKey: 'intake' } });

            await continueSave();

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({ humanMessage: 'Bad' }));
            expect(mockGuidedFormService.invalidateContextForForm).not.toHaveBeenCalled();
            expect(mockRouter.navigate).not.toHaveBeenCalled();
        });

        it('Save and Continue shows a validation banner for an invalid form', async () => {
            callRpc.mockImplementation(async (name: string) => (name === 'get_guided_form_context' ? context() : null));
            await mount({ features: { guidedFormKey: 'intake' }, props: [requiredName()] });

            fill({ name: '' });
            await continueSave();

            expect(component.showValidationError()).toBe(true);
            expect(editData).not.toHaveBeenCalled();
        });
    });
});
