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
import { provideHttpClient, withXhr } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { CreatePage } from './create.page';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import { BehaviorSubject, of, firstValueFrom } from 'rxjs';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { FormControl, Validators } from '@angular/forms';
import { EntityPropertyType } from '../../interfaces/entity';
import Keycloak from 'keycloak-js';

describe('CreatePage', () => {
    let component: CreatePage;
    let fixture: ComponentFixture<CreatePage>;
    let mockSchemaService: any;
    let mockDataService: any;
    let mockAnalyticsService: any;
    let mockAuthService: any;
    let mockRouter: any;
    let mockKeycloak: any;
    let mockNavigationService: any;
    let routeParams: BehaviorSubject<any>;
    let queryParams: BehaviorSubject<any>;

    beforeEach(async () => {
        routeParams = new BehaviorSubject({ entityKey: 'Issue' });
        queryParams = new BehaviorSubject({});

        mockSchemaService = {
            getEntity: vi.fn().mockName("SchemaService.getEntity"),
            getPropsForCreate: vi.fn().mockName("SchemaService.getPropsForCreate"),
            getCreateRenderables: vi.fn().mockName("SchemaService.getCreateRenderables")
        };
        mockDataService = {
            createData: vi.fn().mockName("DataService.createData"),
            getData: vi.fn().mockName("DataService.getData")
        };
        mockAnalyticsService = {
            trackEvent: vi.fn().mockName("AnalyticsService.trackEvent")
        };
        mockAuthService = {
            login: vi.fn().mockName("AuthService.login"),
            authenticated: signal(false)
        };
        mockRouter = {
            navigate: vi.fn().mockName("Router.navigate")
        };
        mockKeycloak = {
            updateToken: vi.fn().mockName("Keycloak.updateToken")
        };
        mockNavigationService = {
            goBack: vi.fn().mockName("NavigationService.goBack")
        };

        // Setup getData to return empty array by default (for foreign key dropdowns)
        mockDataService.getData.mockReturnValue(of([]));

        // Setup updateToken to return resolved promise by default (for form submission)
        mockKeycloak.updateToken.mockResolvedValue(true);

        // Setup default for renderables (most tests use properties$ directly)
        mockSchemaService.getCreateRenderables.mockReturnValue(of([]));

        await TestBed.configureTestingModule({
            imports: [CreatePage],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideRouter([]),
                { provide: ActivatedRoute, useValue: { params: routeParams.asObservable(), queryParams: queryParams.asObservable() } },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: mockDataService },
                { provide: AnalyticsService, useValue: mockAnalyticsService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: Router, useValue: mockRouter },
                { provide: Keycloak, useValue: mockKeycloak },
                { provide: NavigationService, useValue: mockNavigationService }
            ]
        })
            .compileComponents();

        fixture = TestBed.createComponent(CreatePage);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Observable Chain Integration', () => {
        it('should load entity metadata from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([]));

            component.entity$.subscribe(entity => {
                expect(entity).toBeDefined();
                expect(entity?.table_name).toBe('Issue');
                expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
            });
        });

        it('should store entityKey from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([]));

            component.entity$.subscribe(() => {
                expect(component.entityKey).toBe('Issue');
            });
        });

        it('should fetch properties for create form', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.foreignKey
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProps));

            component.properties$.subscribe(props => {
                expect(props.length).toBe(2);
                expect(mockSchemaService.getPropsForCreate).toHaveBeenCalledWith(MOCK_ENTITIES.issue);
            });
        });

        it('should return empty array when entity is undefined', async () => {
            routeParams.next({});
            mockSchemaService.getEntity.mockReturnValue(of(undefined));

            component.properties$.subscribe(props => {
                expect(props).toEqual([]);
                expect(mockSchemaService.getPropsForCreate).not.toHaveBeenCalled();
            });
        });
    });

    describe('Form Generation', () => {
        it('should create form with controls for each property', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.integer,
                MOCK_PROPERTIES.boolean
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProps));

            component.properties$.subscribe(() => {
                expect(component.createForm).toBeDefined();
                expect(component.createForm?.get('name')).toBeDefined();
                expect(component.createForm?.get('count')).toBeDefined();
                expect(component.createForm?.get('is_active')).toBeDefined();
            });
        });

        it('should set default values for form controls', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.boolean
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProps));

            component.properties$.subscribe(() => {
                // Boolean should default to false
                expect(component.createForm?.get('is_active')?.value).toBe(false);
                // Other types default to null
                expect(component.createForm?.get('name')?.value).toBeNull();
            });
        });

        it('should add validators for required (non-nullable) fields', async () => {
            const mockProps = [
                createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false }),
                createMockProperty({ ...MOCK_PROPERTIES.integer, is_nullable: true })
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProps));

            component.properties$.subscribe(() => {
                const nameControl = component.createForm?.get('name');
                const countControl = component.createForm?.get('count');

                // Required field should have validator
                expect(nameControl?.hasError('required')).toBe(true);

                // Optional field should not require validation
                countControl?.setValue(null);
                expect(countControl?.hasError('required')).toBe(false);
            });
        });
    });

    describe('submitForm()', () => {
        beforeEach(() => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([MOCK_PROPERTIES.textShort]));

            // Initialize component
            fixture.detectChanges();
        });

        it('should call createData with form values', async () => {
            mockDataService.createData.mockReturnValue(of({ success: true, body: {} }));

            await firstValueFrom(component.properties$);
            component.createForm?.patchValue({ name: 'Test Issue' });
            component.submitForm({});

            // Wait for async promise to resolve
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockDataService.createData).toHaveBeenCalledWith('Issue', { name: 'Test Issue' });
        });

        it('should show success modal on successful create', async () => {
            mockDataService.createData.mockReturnValue(of({ success: true, body: { id: 1 } }));

            await firstValueFrom(component.properties$);
            component.createForm?.patchValue({ name: 'Test' });
            component.submitForm({});

            // Wait for async observable to complete
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(component.showSuccessModal()).toBe(true);
            expect(component.showErrorModal()).toBe(false);
        });

        it('should show error modal on failed create', async () => {
            const error = {
                httpCode: 400,
                message: 'Database error',
                details: 'Constraint violation',
                hint: 'Check your input',
                humanMessage: 'Could not create'
            };
            mockDataService.createData.mockReturnValue(of({ success: false, error }));

            await firstValueFrom(component.properties$);
            component.createForm?.patchValue({ name: 'Test' });
            component.submitForm({});

            // Wait for async observable to complete
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(error);
            expect(component.showSuccessModal()).toBe(false);
        });

        it('should not submit when entityKey is undefined', () => {
            component.entityKey = undefined;
            component.createForm = undefined;

            component.submitForm({});

            expect(mockDataService.createData).not.toHaveBeenCalled();
        });

        it('should not submit when createForm is undefined', () => {
            component.entityKey = 'Issue';
            component.createForm = undefined;

            component.submitForm({});

            expect(mockDataService.createData).not.toHaveBeenCalled();
        });
    });

    describe('Form Validation UX', () => {
        beforeEach(() => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([
                createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })
            ]));

            fixture.detectChanges();
        });

        it('should not submit when form is invalid', async () => {
            mockDataService.createData.mockReturnValue(of({ success: true, body: {} }));

            component.properties$.subscribe(() => {
                // Leave form empty (required field not filled)
                component.submitForm({});

                expect(mockDataService.createData).not.toHaveBeenCalled();
            });
        });

        it('should set showValidationError flag when submitting invalid form', async () => {
            component.properties$.subscribe(() => {
                expect(component.showValidationError).toBe(false);

                // Submit invalid form
                component.submitForm({});

                expect(component.showValidationError).toBe(true);
            });
        });

        it('should mark all controls as touched when submitting invalid form', async () => {
            component.properties$.subscribe(() => {
                const nameControl = component.createForm?.get('name');
                expect(nameControl?.touched).toBe(false);

                // Submit invalid form
                component.submitForm({});

                expect(nameControl?.touched).toBe(true);
            });
        });

        it('should hide error banner when form becomes valid', async () => {
            component.properties$.subscribe(async () => {
                // Submit invalid form to show error
                component.submitForm({});
                expect(component.showValidationError).toBe(true);

                // Make form valid
                component.createForm?.patchValue({ name: 'Valid Name' });

                // Wait for statusChanges observable to trigger
                await new Promise(resolve => setTimeout(resolve, 50));
                expect(component.showValidationError).toBe(false);
            });
        });

        it('should call scrollToFirstError when form is invalid', async () => {
            component.properties$.subscribe(() => {
                vi.spyOn(component as any, 'scrollToFirstError').mockReturnValue(undefined);

                // Submit invalid form
                component.submitForm({});

                expect((component as any).scrollToFirstError).toHaveBeenCalled();
            });
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
        it('should navigate with replaceUrl: true', () => {
            component.entityKey = 'Issue';
            (component as any).createdRecordId = 42;
            component.navToDetail();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue', 42], { replaceUrl: true });
        });
    });

    describe('navToCreate()', () => {
        beforeEach(() => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
        });

        it('should close success modal, reset form with defaults, and navigate', async () => {
            component.properties$.subscribe(() => {
                component.showSuccessModal.set(true);
                component.createForm?.patchValue({ name: 'Old Value' });

                component.navToCreate();

                expect(component.showSuccessModal()).toBe(false);
                expect(component.createForm?.get('name')?.value).toBeNull();
                expect(mockRouter.navigate).toHaveBeenCalledWith(['create', 'Issue']);
            });
        });

        it('should navigate to specified entity create', async () => {
            component.properties$.subscribe(() => {
                component.navToCreate('Status');

                expect(mockRouter.navigate).toHaveBeenCalledWith(['create', 'Status']);
            });
        });

        it('should reset boolean fields to false, not null', async () => {
            mockSchemaService.getPropsForCreate.mockReturnValue(of([MOCK_PROPERTIES.textShort, MOCK_PROPERTIES.boolean]));

            component.properties$.subscribe(() => {
                // Simulate user having filled out the form
                component.createForm?.patchValue({ name: 'Test', is_active: true });

                component.navToCreate();

                expect(component.createForm?.get('is_active')?.value).toBe(false);
                expect(component.createForm?.get('name')?.value).toBeNull();
            });
        });
    });

    describe('Route Parameter Changes', () => {
        it('should recreate form when entityKey changes', async () => {
            let callCount = 0;

            mockSchemaService.getEntity.mockImplementation((key: string) => {
                if (key === 'Issue')
                    return of(MOCK_ENTITIES.issue);
                if (key === 'Status')
                    return of(MOCK_ENTITIES.status);
                return of(undefined);
            });
            mockSchemaService.getPropsForCreate.mockReturnValue(of([MOCK_PROPERTIES.textShort]));

            component.properties$.subscribe(() => {
                callCount++;
                if (callCount === 1) {
                    expect(component.entityKey).toBe('Issue');
                    expect(component.createForm).toBeDefined();

                    // Trigger route change
                    routeParams.next({ entityKey: 'Status' });
                }
                else if (callCount === 2) {
                    expect(component.entityKey).toBe('Status');
                    expect(component.createForm).toBeDefined();
                }
            });
        });
    });

    describe('Entity Description Tooltip', () => {
        it('should display entity with description in template', async () => {
            const entityWithDescription = { ...MOCK_ENTITIES.issue, description: 'Track system issues' };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithDescription));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([MOCK_PROPERTIES.textShort]));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBe('Track system issues');
            });
        });

        it('should handle entities without description', async () => {
            const entityWithoutDescription = { ...MOCK_ENTITIES.issue, description: null };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithoutDescription));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([MOCK_PROPERTIES.textShort]));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBeNull();
            });
        });
    });

    describe('Token Refresh (Keycloak Integration)', () => {
        let mockKeycloak: any;

        beforeEach(() => {
            mockKeycloak = {
                updateToken: vi.fn().mockName("Keycloak.updateToken")
            };
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForCreate.mockReturnValue(of([MOCK_PROPERTIES.textShort]));

            // Manually inject the mock Keycloak instance
            (component as any).keycloak = mockKeycloak;

            fixture.detectChanges();
        });

        it('should call updateToken before form submission', async () => {
            mockKeycloak.updateToken.mockResolvedValue(true);
            mockDataService.createData.mockReturnValue(of({ success: true, body: { id: 1 } }));

            await firstValueFrom(component.properties$);
            component.createForm?.patchValue({ name: 'Test Issue' });
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
            expect(mockDataService.createData).toHaveBeenCalled();
        });

        it('should proceed with submission when token refresh succeeds', async () => {
            mockKeycloak.updateToken.mockResolvedValue(true);
            mockDataService.createData.mockReturnValue(of({ success: true, body: { id: 1 } }));

            await firstValueFrom(component.properties$);
            component.createForm?.patchValue({ name: 'Test Issue' });
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockDataService.createData).toHaveBeenCalledWith('Issue', { name: 'Test Issue' });
            expect(component.showSuccessModal()).toBe(true);
            expect(component.showErrorModal()).toBe(false);
        });

        it('should show 401 error modal when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Token refresh failed'));

            component.properties$.subscribe(async () => {
                component.createForm?.patchValue({ name: 'Test Issue' });
                component.submitForm({});

                await new Promise(resolve => setTimeout(resolve, 10));
                expect(component.showErrorModal()).toBe(true);
                expect(component.currentError()).toEqual(expect.objectContaining({
                    httpCode: 401,
                    message: 'Session expired',
                    humanMessage: 'Session Expired',
                    hint: 'Your login session has expired. Please refresh the page to log in again.'
                }));
                expect(mockDataService.createData).not.toHaveBeenCalled();
                expect(component.showSuccessModal()).toBe(false);
            });
        });

        it('should not call createData when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Token refresh failed'));

            component.properties$.subscribe(async () => {
                component.createForm?.patchValue({ name: 'Test Issue' });
                component.submitForm({});

                await new Promise(resolve => setTimeout(resolve, 10));
                expect(mockDataService.createData).not.toHaveBeenCalled();
            });
        });
    });
});
