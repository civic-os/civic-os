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
import { SaveProgressComponent, SaveStep } from '../../components/save-progress/save-progress.component';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { CreatePage } from './create.page';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import { GuidedFormService } from '../../services/guided-form.service';
import { ProfileService } from '../../services/profile.service';
import { BehaviorSubject, of, firstValueFrom } from 'rxjs';
import { DataClientError, TransportError, type EditorDeps, type EntityHandle } from '@civic-os/core';
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
        can: { insert: row.insert, select: row.select },
    } as unknown as EntityHandle;
}

/** A rejection as the core data client raises it for an HTTP error status. */
function httpError(status: number, body: Record<string, unknown>): DataClientError {
    return new DataClientError('http', { status, statusText: 'Error', headers: {}, text: JSON.stringify(body) }, body);
}

describe('CreatePage', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: CreatePage;
    let fixture: ComponentFixture<CreatePage>;
    let mockSchemaService: any;
    let mockAnalyticsService: any;
    let mockAuthService: any;
    let mockRouter: any;
    let mockKeycloak: any;
    let mockNavigationService: any;
    let routeParams: BehaviorSubject<any>;
    let queryParams: BehaviorSubject<any>;

    /** The facade's data client and schema reads: every record request the page causes goes through them. */
    let createData: ReturnType<typeof vi.fn>;
    let callRpc: ReturnType<typeof vi.fn>;
    let addManyToManyRelation: ReturnType<typeof vi.fn>;
    let schemaProperties: ReturnType<typeof vi.fn>;
    let formRenderables: ReturnType<typeof vi.fn>;
    /** SchemaService's loaded entity rows; a new array is a schema refresh. */
    let entityRows: ReturnType<typeof signal<SchemaEntityTable[] | undefined>>;

    beforeEach(async () => {
        routeParams = new BehaviorSubject({ entityKey: 'Issue' });
        queryParams = new BehaviorSubject({});
        entityRows = signal<SchemaEntityTable[] | undefined>([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);

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

        // Setup updateToken to return resolved promise by default (for form submission)
        mockKeycloak.updateToken.mockResolvedValue(true);

        mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));

        createData = vi.fn(async (_entity: string, data: Record<string, unknown>) => [{ id: 1, ...data }]);
        callRpc = vi.fn(async () => null);
        addManyToManyRelation = vi.fn(async () => undefined);
        schemaProperties = vi.fn(async () => [MOCK_PROPERTIES.textShort]);
        formRenderables = vi.fn(async () => []);
        const facadeDeps = {
            data: { createData, callRpc, addManyToManyRelation },
            schema: {
                properties: schemaProperties,
                formRenderables,
                constraintMessages: () => undefined,
            },
            clock: { now: () => new Date() },
        } as unknown as EditorDeps;

        await TestBed.configureTestingModule({
            imports: [CreatePage],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                provideRouter([]),
                { provide: ActivatedRoute, useValue: { params: routeParams.asObservable(), queryParams: queryParams.asObservable() } },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: {} },
                { provide: AnalyticsService, useValue: mockAnalyticsService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: Router, useValue: mockRouter },
                { provide: Keycloak, useValue: mockKeycloak },
                { provide: NavigationService, useValue: mockNavigationService },
                { provide: FACADE_DEPS, useValue: facadeDeps }
            ]
        })
            .overrideComponent(CreatePage, { remove: { imports: [SaveProgressComponent] }, add: { imports: [StubSaveProgress] } })
            .compileComponents();

        fixture = TestBed.createComponent(CreatePage);
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
        component.createForm()!.patchValue(values);
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

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Observable Chain Integration', () => {
        it('should load entity metadata from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));

            component.entity$.subscribe(entity => {
                expect(entity).toBeDefined();
                expect(entity?.table_name).toBe('Issue');
                expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
            });
        });

        it('should store entityKey from route params', async () => {
            component.entity$.subscribe(() => {
                expect(component.entityKey).toBe('Issue');
            });
        });
    });

    describe('Editor binding', () => {
        it('builds the form from the route handle once the load settles', async () => {
            expect(component.loaded()).toBe(false);
            expect(component.createForm()).toBeUndefined();

            await mount();

            expect(component.loaded()).toBe(true);
            expect(component.createForm()?.get('name')).toBeDefined();
            expect(schemaProperties).toHaveBeenCalledTimes(1);
            expect(formRenderables).toHaveBeenCalledTimes(1);
        });

        it('builds no editor while the handle is not the route entity', async () => {
            routeParams.next({ entityKey: 'Status' });
            await mount();

            expect(component.snapshot()).toBeUndefined();
            expect(component.createForm()).toBeUndefined();
            expect(schemaProperties).not.toHaveBeenCalled();
        });

        it('has no editor without a route entity key', async () => {
            routeParams.next({});
            await mount();

            expect(component.snapshot()).toBeUndefined();
            expect(schemaProperties).not.toHaveBeenCalled();
        });

        it('prefills the form from the route query params', async () => {
            queryParams.next({ name: 'Pothole', unknown_param: 'x' });
            await mount();

            expect(component.createForm()!.get('name')!.value).toBe('Pothole');
            expect(component.createForm()!.get('name')!.touched).toBe(true);
            expect(component.createForm()!.get('unknown_param')).toBeNull();
        });

        it('rebuilds the editor, with the current query params, when the route entity changes', async () => {
            await mount();
            const first = (component as any).editor;
            createData.mockClear();

            queryParams.next({ name: 'Second' });
            routeParams.next({ entityKey: 'Status' });
            fixture.componentRef.setInput('entityHandle', handleFor(MOCK_ENTITIES.status));
            fixture.detectChanges();
            await advanceTime(100);
            fixture.detectChanges();

            const second = (component as any).editor;
            expect(second).not.toBe(first);
            expect(component.createForm()!.get('name')!.value).toBe('Second');
            // the old editor is disposed: its commands throw
            expect(() => first.save()).toThrow();
            expect(schemaProperties).toHaveBeenCalledTimes(2);

            fill({ name: 'Second' });
            await submit();
            expect(createData).toHaveBeenCalledWith('Status', { name: 'Second' });
        });

        it('rebuilds the editor, with the current query params, when the schema rows reload', async () => {
            await mount();
            const first = (component as any).editor;

            queryParams.next({ name: 'After refresh' });
            entityRows.set([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);
            fixture.detectChanges();
            await advanceTime(100);
            fixture.detectChanges();

            expect((component as any).editor).not.toBe(first);
            expect(schemaProperties).toHaveBeenCalledTimes(2);
            expect(component.createForm()!.get('name')!.value).toBe('After refresh');
        });

        it('reads returnTo from the query params when the editor is built', async () => {
            queryParams.next({ returnTo: '/profile' });
            await mount();
            fill({ name: 'Test' });
            await submit();

            expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/profile', { replaceUrl: true });
            expect(component.showSuccessModal()).toBe(false);
        });

        it('drops the editor with the page', async () => {
            await mount();
            const editor = (component as any).editor;
            fixture.destroy();

            expect(() => editor.save()).toThrow();
        });
    });

    describe('submitForm()', () => {
        beforeEach(async () => {
            await mount();
        });

        it('should call createData with form values', async () => {
            fill({ name: 'Test Issue' });
            await submit();

            expect(createData).toHaveBeenCalledWith('Issue', { name: 'Test Issue' });
        });

        it('should show success modal on successful create', async () => {
            fill({ name: 'Test' });
            await submit();

            expect(component.showSuccessModal()).toBe(true);
            expect(component.showErrorModal()).toBe(false);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'Issue');
        });

        it('should show error modal on failed create', async () => {
            const body = {
                code: '23514',
                message: 'Database error',
                details: 'Constraint violation',
                hint: 'Check your input'
            };
            createData.mockRejectedValue(httpError(400, body));
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

            fill({ name: 'Test' });
            await submit();

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({
                httpCode: 400,
                code: '23514',
                message: 'Database error',
                details: 'Constraint violation',
                hint: 'Check your input'
            }));
            expect(component.currentError()!.humanMessage).toBeTruthy();
            expect(component.showSuccessModal()).toBe(false);
            expect(mockAnalyticsService.trackEvent).not.toHaveBeenCalled();
            expect(logged).toHaveBeenCalledWith('[CREATE SUBMIT] API returned error:', component.currentError());
            expect(logged).toHaveBeenCalledWith('[CREATE SUBMIT] Error details:', expect.objectContaining({ httpCode: 400, message: 'Database error' }));
            logged.mockRestore();
        });

        it('shows the System Error modal for an unexpected failure', async () => {
            createData.mockRejectedValue(new TypeError('boom'));
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

            fill({ name: 'Test' });
            await submit();

            expect(component.currentError()).toEqual({ httpCode: 500, message: 'An unexpected error occurred', humanMessage: 'System Error' });
            expect(component.showErrorModal()).toBe(true);
            logged.mockRestore();
        });

        it('gives a network failure the editor\'s "Unknown error" message (legacy HttpErrorResponse path showed "Unknown Error")', async () => {
            createData.mockRejectedValue(new TransportError('network'));
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

            fill({ name: 'Test' });
            await submit();

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({ httpCode: 0, message: 'Unknown error' }));
            logged.mockRestore();
        });

        it('should not submit when entityKey is undefined', async () => {
            const bare = TestBed.createComponent(CreatePage).componentInstance;
            bare.entityKey = undefined;

            await bare.submitForm({});

            expect(createData).not.toHaveBeenCalled();
        });

        it('should not submit when createForm is undefined', async () => {
            const bare = TestBed.createComponent(CreatePage).componentInstance;
            bare.entityKey = 'Issue';
            expect(bare.createForm()).toBeUndefined();

            await bare.submitForm({});

            expect(createData).not.toHaveBeenCalled();
        });

        it('keeps Save disabled after a single create until Create another', async () => {
            expect(component.isSaving()).toBe(false);
            fill({ name: 'Test' });
            await submit();
            expect(component.isSaving()).toBe(true);

            component.navToCreate();
            expect(component.isSaving()).toBe(false);
            await advanceTime(10);
        });

        it('re-enables Save after a failed create', async () => {
            createData.mockRejectedValue(httpError(400, { message: 'no' }));
            const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
            fill({ name: 'Test' });
            await submit();

            expect(component.isSaving()).toBe(false);
            logged.mockRestore();
        });

        it('disables Save while the request is in flight, and not Save and Continue', async () => {
            let release!: (v: unknown) => void;
            createData.mockReturnValue(new Promise(r => { release = r; }));
            fill({ name: 'Test' });

            const running = component.submitForm({});
            await advanceTime(10);
            expect(component.isSaving()).toBe(true);
            expect(component.savingAndContinuing()).toBe(false);

            release([{ id: 3 }]);
            await running;
            await advanceTime(10);
            expect(createData).toHaveBeenCalledTimes(1);
        });
    });

    describe('Form Validation UX', () => {
        beforeEach(async () => {
            await mount({ props: [createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })] });
        });

        afterEach(() => {
            vi.runOnlyPendingTimers();
        });

        it('should not send anything when form is invalid, and leave Save enabled', async () => {
            await component.submitForm({});

            expect(createData).not.toHaveBeenCalled();
            expect(component.isSaving()).toBe(false);
        });

        it('should set showValidationError flag when submitting invalid form', async () => {
            expect(component.showValidationError()).toBe(false);

            await component.submitForm({});

            expect(component.showValidationError()).toBe(true);
        });

        it('should hide error banner when form becomes valid', async () => {
            await component.submitForm({});
            expect(component.showValidationError()).toBe(true);

            // Make form valid
            fill({ name: 'Valid Name' });
            fixture.detectChanges();
            await fixture.whenStable();

            expect(component.showValidationError()).toBe(false);
        });

        it('keeps the banner while the form stays invalid', async () => {
            await component.submitForm({});
            fixture.detectChanges();
            await fixture.whenStable();

            expect(component.showValidationError()).toBe(true);
        });

        it('should call scrollToFirstError when form is invalid', async () => {
            vi.spyOn(component as any, 'scrollToFirstError').mockReturnValue(undefined);

            await component.submitForm({});

            expect((component as any).scrollToFirstError).toHaveBeenCalled();
        });

        it('shows the banner in the template', async () => {
            await component.submitForm({});
            fixture.detectChanges();

            expect(fixture.nativeElement.querySelector('[role="alert"].alert-error')).toBeTruthy();
        });
    });

    describe('goBack()', () => {
        it('should delegate to NavigationService with fallback URL', () => {
            component.entityKey = 'Issue';
            component.goBack();

            expect(mockNavigationService.goBack).toHaveBeenCalledWith('/view/Issue');
        });
    });

    describe('navToList()', () => {
        it('should navigate to current entity list with replaceUrl', () => {
            component.entityKey = 'Issue';
            component.navToList();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue'], { replaceUrl: true });
        });

        it('should navigate to specified entity list with replaceUrl', () => {
            component.entityKey = 'Issue';
            component.navToList('Status');

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Status'], { replaceUrl: true });
        });
    });

    describe('navToDetail()', () => {
        it('should navigate with replaceUrl: true, to the record the editor created', async () => {
            await mount();
            createData.mockResolvedValue([{ id: 42 }]);
            fill({ name: 'Test' });
            await submit();

            component.navToDetail();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue', 42], { replaceUrl: true });
        });

        it('does nothing before a record was created', async () => {
            await mount();
            component.navToDetail();

            expect(mockRouter.navigate).not.toHaveBeenCalled();
        });
    });

    describe('navToCreate()', () => {
        beforeEach(async () => {
            await mount();
        });

        it('should close success modal, reset form with defaults, and navigate', async () => {
            component.showSuccessModal.set(true);
            fill({ name: 'Old Value' });

            component.navToCreate();

            expect(component.showSuccessModal()).toBe(false);
            expect(component.createForm()!.get('name')!.value).toBeNull();
            expect(mockRouter.navigate).toHaveBeenCalledWith(['create', 'Issue']);
            await advanceTime(10);
        });

        it('should navigate to specified entity create', async () => {
            component.navToCreate('Status');

            expect(mockRouter.navigate).toHaveBeenCalledWith(['create', 'Status']);
            await advanceTime(10);
        });

        it('resets the editor in place: no rebuild, no schema re-read, the same form group', async () => {
            const editor = (component as any).editor;
            const form = component.createForm();
            const reset = vi.spyOn(editor, 'resetForAnother');

            component.navToCreate();

            expect(reset).toHaveBeenCalledTimes(1);
            expect((component as any).editor).toBe(editor);
            expect(component.createForm()).toBe(form);
            expect(schemaProperties).toHaveBeenCalledTimes(1);
            await advanceTime(10);
        });

        it('clears the progress state', async () => {
            component.saveSteps.set([]);
            component.saveComplete.set(true);

            component.navToCreate();

            expect(component.saveSteps()).toBeNull();
            expect(component.saveComplete()).toBe(false);
            await advanceTime(10);
        });
    });

    describe('Entity Description Tooltip', () => {
        it('should display entity with description in template', async () => {
            const entityWithDescription = { ...MOCK_ENTITIES.issue, description: 'Track system issues' };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithDescription));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBe('Track system issues');
            });
        });

        it('should handle entities without description', async () => {
            const entityWithoutDescription = { ...MOCK_ENTITIES.issue, description: null };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithoutDescription));

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
            fill({ name: 'Test Issue' });
            await submit();

            expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
            expect(createData).toHaveBeenCalled();
            expect(mockKeycloak.updateToken.mock.invocationCallOrder[0]).toBeLessThan(createData.mock.invocationCallOrder[0]);
        });

        it('should proceed with submission when token refresh succeeds', async () => {
            fill({ name: 'Test Issue' });
            await submit();

            expect(createData).toHaveBeenCalledWith('Issue', { name: 'Test Issue' });
            expect(component.showSuccessModal()).toBe(true);
            expect(component.showErrorModal()).toBe(false);
        });

        it('should show 401 error modal when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Token refresh failed'));

            fill({ name: 'Test Issue' });
            await submit();

            expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({
                httpCode: 401,
                message: 'Session expired',
                humanMessage: 'Session Expired',
                hint: 'Your login session has expired. Please refresh the page to log in again.'
            }));
            expect(createData).not.toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(false);
            expect(component.isSaving()).toBe(false);
        });

        it('should not call createData when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Token refresh failed'));

            fill({ name: 'Test Issue' });
            await submit();

            expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
            expect(createData).not.toHaveBeenCalled();
        });

        it('does not refresh the token for an invalid form', async () => {
            await mount({ props: [createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })] });
            mockKeycloak.updateToken.mockClear();

            await component.submitForm({});

            expect(mockKeycloak.updateToken).not.toHaveBeenCalled();
            vi.runOnlyPendingTimers();
        });
    });

    describe('Transform errors', () => {
        it('names the field and stops the save for an impossible local time', async () => {
            await mount({ props: [MOCK_PROPERTIES.textShort, createMockProperty({ column_name: 'starts_at', display_name: 'Starts At', type: EntityPropertyType.DateTime })] });
            fill({ name: 'Test', starts_at: '2025-13-45T10:30' });

            await submit();

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({ httpCode: 400 }));
            expect(component.currentError()!.humanMessage).toMatch(/^Starts At: /);
            expect(createData).not.toHaveBeenCalled();
            expect(mockKeycloak.updateToken).not.toHaveBeenCalled();
            expect(component.isSaving()).toBe(false);
        });
    });

    describe('Coordinated create', () => {
        const tags = createMockProperty({
            column_name: 'tags',
            display_name: 'Tags',
            type: EntityPropertyType.ManyToMany,
            show_inline: true,
            many_to_many_meta: createMockManyToManyMeta()
        });

        beforeEach(async () => {
            await mount({ props: [MOCK_PROPERTIES.textShort, tags] });
            fill({ name: 'Test' });
        });

        it('sends nothing at Save, opens the progress modal with the steps in legacy wording', async () => {
            component.onM2mDiffChanged('tags', { toAdd: [1, 2], toRemove: [] });
            component.onDraftGalleryCreated({ columnName: 'photos', galleryId: 'g-1' });

            await submit();

            expect(createData).not.toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(true);
            expect(component.saveSteps()!.map(s => s.label)).toEqual([
                'Creating record',
                'Adding Tags (2 to add)',
                'Linking photo gallery',
                'Saving gallery images',
            ]);
            // Save stays disabled until the steps have all run
            expect(component.isSaving()).toBe(true);
        });

        it('runs the record step as the create, and tracks the create event once the id is known', async () => {
            createData.mockResolvedValue([{ id: 9 }]);
            component.onM2mDiffChanged('tags', { toAdd: [1], toRemove: [] });
            await submit();

            expect(await runStep(0)).toEqual({ success: true });
            expect(createData).toHaveBeenCalledWith('Issue', { name: 'Test' });
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'Issue');
        });

        it('words a failed record step with the human message', async () => {
            createData.mockRejectedValue(httpError(400, { message: 'bad row' }));
            component.onM2mDiffChanged('tags', { toAdd: [1], toRemove: [] });
            await submit();

            const result = await runStep(0);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeTruthy();
            expect(mockAnalyticsService.trackEvent).not.toHaveBeenCalled();
        });

        it('adds each target with the junction, and words a partial failure', async () => {
            createData.mockResolvedValue([{ id: 9 }]);
            addManyToManyRelation.mockRejectedValueOnce(new Error('x'));
            component.onM2mDiffChanged('tags', { toAdd: [1, 2, 3], toRemove: [] });
            await submit();
            await runStep(0);

            const result = await runStep(1);

            expect(addManyToManyRelation).toHaveBeenCalledTimes(3);
            expect(result).toEqual({ success: false, failedCount: 1, totalCount: 3, errorMessage: '1 of 3 additions failed' });
        });

        it('words a missing record id', async () => {
            createData.mockResolvedValue([]);
            component.onM2mDiffChanged('tags', { toAdd: [1], toRemove: [] });
            await submit();
            await runStep(0);

            expect(await runStep(1)).toEqual({ success: false, errorMessage: 'Record ID not available' });
        });

        it('words gallery failures', async () => {
            createData.mockResolvedValue([{ id: 9 }]);
            callRpc.mockRejectedValue(new TypeError('no server text'));
            vi.spyOn(component as any, 'saveGalleryChanges').mockResolvedValue(false);
            component.onDraftGalleryCreated({ columnName: 'photos', galleryId: 'g-1' });
            await submit();
            await runStep(0);

            expect(await runStep(1)).toEqual({ success: false, errorMessage: 'Failed to link gallery' });
            expect(await runStep(2)).toEqual({ success: false, errorMessage: 'Failed to save gallery images' });
        });

        it('passes the server text of a failed gallery link through', async () => {
            createData.mockResolvedValue([{ id: 9 }]);
            callRpc.mockRejectedValue(httpError(400, { message: 'gallery locked' }));
            component.onDraftGalleryCreated({ columnName: 'photos', galleryId: 'g-1' });
            await submit();
            await runStep(0);

            expect(await runStep(1)).toEqual({ success: false, errorMessage: 'gallery locked' });
        });

        it('persists the buffered gallery rows through the page in the last step', async () => {
            createData.mockResolvedValue([{ id: 9 }]);
            const persist = vi.spyOn(component as any, 'saveGalleryChanges').mockResolvedValue(true);
            component.onDraftGalleryCreated({ columnName: 'photos', galleryId: 'g-1' });
            await submit();
            await runStep(0);
            await runStep(1);

            expect(await runStep(2)).toEqual({ success: true });
            expect(persist).toHaveBeenCalled();
        });

        it('forgets an emptied diff, so the save creates directly', async () => {
            component.onM2mDiffChanged('tags', { toAdd: [1], toRemove: [] });
            component.onM2mDiffChanged('tags', { toAdd: [], toRemove: [] });

            await submit();

            expect(component.saveSteps()).toBeNull();
            expect(createData).toHaveBeenCalledTimes(1);
        });

        it('takes rich junction diffs', async () => {
            createData.mockResolvedValue([{ id: 9 }]);
            component.onRichM2mDiffChanged('tags', { toAdd: [{ id: 5, extraData: { note: 'x' } }], toRemove: [], toUpdate: [] });
            await submit();

            expect(component.saveSteps()!.map(s => s.label)).toEqual(['Creating record', 'Adding Tags (1 to add)']);
            await runStep(0);
            await runStep(1);
            expect(addManyToManyRelation).toHaveBeenCalledWith(9, expect.anything(), 5, { note: 'x' });
        });

        it('onSaveComplete finishes: enables Save, forgets the changes, tracks the create again, and shows the actions', async () => {
            createData.mockResolvedValue([{ id: 9 }]);
            component.onM2mDiffChanged('tags', { toAdd: [1], toRemove: [] });
            await submit();
            await runStep(0);
            mockAnalyticsService.trackEvent.mockClear();

            component.onSaveComplete();

            expect(component.saveComplete()).toBe(true);
            expect(component.isSaving()).toBe(false);
            expect(component.snapshot()!.saving).toBe(false);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'Issue');

            // the pending diff is gone: the next save creates directly
            component.saveSteps.set(null);
            fill({ name: 'Again' });
            createData.mockClear();
            await submit();
            expect(createData).toHaveBeenCalledTimes(1);
        });

        it('onSaveComplete navigates to returnTo instead of showing the actions', async () => {
            queryParams.next({ returnTo: '/profile' });
            entityRows.set([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);
            fixture.detectChanges();
            await advanceTime(100);
            fixture.detectChanges();
            const invalidate = vi.spyOn(TestBed.inject(ProfileService), 'invalidateCache');

            component.onSaveComplete();

            expect(invalidate).toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(false);
            expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/profile', { replaceUrl: true });
        });
    });

    describe('saveAndContinue()', () => {
        const guided = { guidedFormKey: 'intake' };
        const context = { step_key: 'basics', parent_id: 7, definition: { parent_table: 'requests' } };

        /** Answers the two guided-form RPCs. */
        function guidedRpcs(completion: Record<string, unknown>): void {
            callRpc.mockImplementation(async (fn: string) => {
                if (fn === 'get_guided_form_context') return context;
                if (fn === 'complete_guided_form_step') return completion;
                return null;
            });
        }

        beforeEach(async () => {
            await mount({ features: guided });
            fill({ name: 'Test' });
        });

        it('is guided form mode, and shows the Save and Continue button', () => {
            expect(component.isGuidedFormMode()).toBe(true);
            expect(fixture.nativeElement.textContent).toContain('Save and continue');
        });

        it('creates and goes to the next step\'s edit page', async () => {
            guidedRpcs({ next_record_id: 9, next_step_table: 'details' });
            const invalidate = vi.spyOn(TestBed.inject(GuidedFormService), 'invalidateContextForForm');

            await continueSave();

            expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
            expect(createData).toHaveBeenCalledWith('Issue', { name: 'Test' });
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/edit', 'details', 9]);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'Issue');
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('GuidedForm', 'StepComplete', 'intake:basics');
            expect(invalidate).toHaveBeenCalledWith('intake');
            expect(component.savingAndContinuing()).toBe(false);
        });

        it('goes to the parent record when all data steps are complete', async () => {
            guidedRpcs({ all_data_steps_complete: true });

            await continueSave();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'requests', '7']);
        });

        it('goes to the url the backend named when it auto-submitted', async () => {
            guidedRpcs({ auto_submitted: true, navigate_to: '/view/requests/7?done=1' });

            await continueSave();

            expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/view/requests/7?done=1');
        });

        it('stays put when the step result names no destination', async () => {
            guidedRpcs({});

            await continueSave();

            expect(mockRouter.navigate).not.toHaveBeenCalled();
            expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(false);
        });

        it('shows the legacy modal when completing the step fails', async () => {
            callRpc.mockImplementation(async (fn: string) => {
                if (fn === 'get_guided_form_context') return context;
                throw httpError(400, { message: 'Step is locked', code: 'P0001', hint: 'Unlock it' });
            });

            await continueSave();

            expect(component.currentError()).toEqual({ humanMessage: 'Step is locked', message: 'Step is locked', code: 'P0001', hint: 'Unlock it' });
            expect(component.showErrorModal()).toBe(true);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'Issue');
        });

        it('says "Failed to complete step." when the server gave no text', async () => {
            callRpc.mockImplementation(async (fn: string) => {
                if (fn === 'get_guided_form_context') return context;
                throw httpError(500, {});
            });

            await continueSave();

            expect(component.currentError()).toEqual(expect.objectContaining({ humanMessage: 'Failed to complete step.' }));
        });

        it('falls back to the normal success when the entity has no guided form', async () => {
            await mount({ features: {} });
            fill({ name: 'Test' });

            await continueSave();

            expect(component.showSuccessModal()).toBe(true);
            expect(callRpc).not.toHaveBeenCalled();
            expect(component.savingAndContinuing()).toBe(false);
            expect(component.isSaving()).toBe(false);
        });

        it('falls back to the normal success when the context cannot be loaded', async () => {
            callRpc.mockRejectedValue(new Error('down'));

            await continueSave();

            expect(component.showSuccessModal()).toBe(true);
            expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'Issue');
        });

        it('shows the error modal when the create fails', async () => {
            createData.mockRejectedValue(httpError(400, { message: 'bad row' }));

            await continueSave();

            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({ httpCode: 400, message: 'bad row' }));
            expect(callRpc).not.toHaveBeenCalled();
            expect(mockAnalyticsService.trackEvent).not.toHaveBeenCalled();
        });

        it('shows the 401 modal when the token refresh fails, sending nothing', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('expired'));

            await continueSave();

            expect(component.currentError()).toEqual(expect.objectContaining({ httpCode: 401, message: 'Session expired', humanMessage: 'Session Expired' }));
            expect(createData).not.toHaveBeenCalled();
            expect(component.savingAndContinuing()).toBe(false);
        });

        it('shows the validation banner and sends nothing for an invalid form', async () => {
            await mount({ features: guided, props: [createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })] });

            await continueSave();

            expect(component.showValidationError()).toBe(true);
            expect(createData).not.toHaveBeenCalled();
            expect(mockKeycloak.updateToken).not.toHaveBeenCalled();
            vi.runOnlyPendingTimers();
        });

        it('disables Save and Continue, not Save, while it runs', async () => {
            let release!: (v: unknown) => void;
            createData.mockReturnValue(new Promise(r => { release = r; }));
            guidedRpcs({});

            const running = component.saveAndContinue();
            await advanceTime(10);
            expect(component.savingAndContinuing()).toBe(true);
            expect(component.isSaving()).toBe(false);

            release([{ id: 3 }]);
            await running;
            await advanceTime(10);
            expect(component.savingAndContinuing()).toBe(false);
        });

        it('does nothing without a form', async () => {
            const bare = TestBed.createComponent(CreatePage).componentInstance;
            bare.entityKey = 'Issue';

            await bare.saveAndContinue();

            expect(createData).not.toHaveBeenCalled();
        });
    });
});
