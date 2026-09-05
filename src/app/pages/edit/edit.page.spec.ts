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
import { EditPage } from './edit.page';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import { BehaviorSubject, of, firstValueFrom } from 'rxjs';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { EntityPropertyType } from '../../interfaces/entity';
import { GuidedFormService } from '../../services/guided-form.service';
import { GuidedFormContext, GuidedFormStep } from '../../interfaces/guided-form';
import Keycloak from 'keycloak-js';

describe('EditPage', () => {
    let component: EditPage;
    let fixture: ComponentFixture<EditPage>;
    let mockSchemaService: any;
    let mockDataService: any;
    let mockAnalyticsService: any;
    let mockAuthService: any;
    let mockRouter: any;
    let mockKeycloak: any;
    let mockNavigationService: any;
    let mockGuidedFormService: any;
    let routeParams: BehaviorSubject<any>;

    beforeEach(async () => {
        routeParams = new BehaviorSubject({ entityKey: 'Issue', entityId: '42' });

        mockSchemaService = {
            getEntity: vi.fn().mockName("SchemaService.getEntity"),
            getPropsForEdit: vi.fn().mockName("SchemaService.getPropsForEdit"),
            getEditRenderables: vi.fn().mockName("SchemaService.getEditRenderables")
        };
        mockDataService = {
            getData: vi.fn().mockName("DataService.getData"),
            editData: vi.fn().mockName("DataService.editData")
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
        mockGuidedFormService = {
            loadContext: vi.fn().mockName("GuidedFormService.loadContext"),
            getEffectiveSteps: vi.fn().mockName("GuidedFormService.getEffectiveSteps"),
            getLockedFields: vi.fn().mockName("GuidedFormService.getLockedFields"),
            ensureStepRecord: vi.fn().mockName("GuidedFormService.ensureStepRecord"),
            completeStep: vi.fn().mockName("GuidedFormService.completeStep"),
            submitGuidedForm: vi.fn().mockName("GuidedFormService.submitGuidedForm"),
            cancelGuidedForm: vi.fn().mockName("GuidedFormService.cancelGuidedForm"),
            refreshContext: vi.fn().mockName("GuidedFormService.refreshContext")
        };
        mockGuidedFormService.getEffectiveSteps.mockReturnValue([]);
        mockGuidedFormService.getLockedFields.mockReturnValue(new Set());

        // Setup updateToken to return resolved promise by default (for form submission)
        mockKeycloak.updateToken.mockResolvedValue(true);

        // Setup default for renderables (most tests use properties$ directly)
        mockSchemaService.getEditRenderables.mockReturnValue(of([]));

        await TestBed.configureTestingModule({
            imports: [EditPage],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideRouter([]),
                { provide: ActivatedRoute, useValue: { params: routeParams.asObservable() } },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: mockDataService },
                { provide: AnalyticsService, useValue: mockAnalyticsService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: Router, useValue: mockRouter },
                { provide: Keycloak, useValue: mockKeycloak },
                { provide: NavigationService, useValue: mockNavigationService },
                { provide: GuidedFormService, useValue: mockGuidedFormService }
            ]
        })
            .compileComponents();

        fixture = TestBed.createComponent(EditPage);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Observable Chain Integration', () => {
        it('should load entity metadata from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([]));
            mockDataService.getData.mockReturnValue(of([] as any));

            component.entity$.subscribe(entity => {
                expect(entity).toBeDefined();
                expect(entity?.table_name).toBe('Issue');
                expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
            });
        });

        it('should store entityKey and entityId from route params', async () => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([]));
            mockDataService.getData.mockReturnValue(of([] as any));

            component.entity$.subscribe(() => {
                expect(component.entityKey).toBe('Issue');
                expect(component.entityId).toBe('42');
            });
        });

        it('should return undefined when entityKey or entityId is missing', async () => {
            routeParams.next({ entityKey: 'Issue' });
            mockSchemaService.getEntity.mockReturnValue(of(undefined));

            component.entity$.subscribe(entity => {
                expect(entity).toBeUndefined();
                expect(mockSchemaService.getEntity).not.toHaveBeenCalled();
            });
        });

        it('should fetch properties for edit form', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.foreignKey
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of([{ id: 42, name: 'Test' }] as any));

            component.properties$.subscribe(props => {
                expect(props.length).toBe(2);
                expect(mockSchemaService.getPropsForEdit).toHaveBeenCalledWith(MOCK_ENTITIES.issue);
            });
        });

        it('should fetch existing record data', async () => {
            const mockProps = [MOCK_PROPERTIES.textShort];
            const mockData = [{ id: 42, name: 'Existing Issue' }];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of(mockData as any));

            component.data$.subscribe(data => {
                expect(mockDataService.getData).toHaveBeenCalledWith({
                    key: 'Issue',
                    fields: ['name'],
                    entityId: '42'
                });
                expect(data).toEqual({ id: 42, name: 'Existing Issue' });
            });
        });
    });

    describe('Form Generation and Population', () => {
        it('should create form with controls for each editable property', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.integer
            ];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of([{ id: 42, name: 'Test', count: 5 }] as any));

            component.data$.subscribe(() => {
                expect(component.editForm).toBeDefined();
                expect(component.editForm?.get('name')).toBeDefined();
                expect(component.editForm?.get('count')).toBeDefined();
            });
        });

        it('should populate form with existing data', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.integer,
                MOCK_PROPERTIES.boolean
            ];
            const mockData = [{ id: 42, name: 'Test Issue', count: 10, is_active: true }];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of(mockData as any));

            component.data$.subscribe(() => {
                expect(component.editForm?.get('name')?.value).toBe('Test Issue');
                expect(component.editForm?.get('count')?.value).toBe(10);
                expect(component.editForm?.get('is_active')?.value).toBe(true);
            });
        });

        it('should not populate id field (filtered out)', async () => {
            const mockProps = [MOCK_PROPERTIES.textShort];
            const mockData = [{ id: 42, name: 'Test' }];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of(mockData as any));

            component.data$.subscribe(() => {
                // Note: FormGroup.get returns null for non-existent controls, not undefined
                expect(component.editForm?.get('id')).toBeNull();
            });
        });

        it('should add validators for required fields', async () => {
            const mockProps = [
                createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })
            ];
            const mockData = [{ id: 42, name: '' }];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of(mockData as any));

            component.data$.subscribe(() => {
                const nameControl = component.editForm?.get('name');
                nameControl?.setValue('');
                expect(nameControl?.hasError('required')).toBe(true);
            });
        });
    });

    describe('submitForm()', () => {
        beforeEach(() => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockReturnValue(of([{ id: 42, name: 'Old Name' }] as any));

            // Initialize component
            fixture.detectChanges();
        });

        it('should call editData with form values', async () => {
            mockDataService.editData.mockReturnValue(of({ success: true }));

            await firstValueFrom(component.data$);
            component.editForm?.patchValue({ name: 'Updated Name' });
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockDataService.editData).toHaveBeenCalledWith('Issue', '42', { name: 'Updated Name' });
        });

        it('should show success modal on successful update', async () => {
            mockDataService.editData.mockReturnValue(of({ success: true }));

            await firstValueFrom(component.data$);
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(component.showSuccessModal()).toBe(true);
            expect(component.showErrorModal()).toBe(false);
        });

        it('should show error modal on failed update', async () => {
            const error = {
                httpCode: 400,
                message: 'Update failed',
                details: 'Constraint violation',
                hint: 'Check your input',
                humanMessage: 'Could not update'
            };
            mockDataService.editData.mockReturnValue(of({ success: false, error }));

            await firstValueFrom(component.data$);
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(error);
            expect(component.showSuccessModal()).toBe(false);
        });

        it('should not submit when entityKey is undefined', () => {
            component.entityKey = undefined;
            component.entityId = '42';
            component.submitForm({});

            expect(mockDataService.editData).not.toHaveBeenCalled();
        });

        it('should not submit when entityId is undefined', () => {
            component.entityKey = 'Issue';
            component.entityId = undefined;
            component.submitForm({});

            expect(mockDataService.editData).not.toHaveBeenCalled();
        });

        it('should not submit when editForm is undefined', () => {
            component.entityKey = 'Issue';
            component.entityId = '42';
            component.editForm = undefined;
            component.submitForm({});

            expect(mockDataService.editData).not.toHaveBeenCalled();
        });
    });

    describe('Form Validation UX', () => {
        beforeEach(() => {
            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([
                createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })
            ]));
            mockDataService.getData.mockReturnValue(of([{ id: 42, name: '' }] as any));

            fixture.detectChanges();
        });

        it('should not submit when form is invalid', async () => {
            mockDataService.editData.mockReturnValue(of({ success: true }));

            component.data$.subscribe(() => {
                // Clear required field to make form invalid
                component.editForm?.patchValue({ name: '' });
                component.submitForm({});

                expect(mockDataService.editData).not.toHaveBeenCalled();
            });
        });

        it('should set showValidationError flag when submitting invalid form', async () => {
            component.data$.subscribe(() => {
                expect(component.showValidationError()).toBe(false);

                // Clear required field and submit
                component.editForm?.patchValue({ name: '' });
                component.submitForm({});

                expect(component.showValidationError()).toBe(true);
            });
        });

        it('should mark all controls as touched when submitting invalid form', async () => {
            component.data$.subscribe(() => {
                const nameControl = component.editForm?.get('name');
                expect(nameControl?.touched).toBe(false);

                // Clear required field and submit
                component.editForm?.patchValue({ name: '' });
                component.submitForm({});

                expect(nameControl?.touched).toBe(true);
            });
        });

        it('should hide error banner when form becomes valid', async () => {
            component.data$.subscribe(async () => {
                // Make form invalid and submit to show error
                component.editForm?.patchValue({ name: '' });
                component.submitForm({});
                expect(component.showValidationError()).toBe(true);

                // Make form valid
                component.editForm?.patchValue({ name: 'Valid Name' });

                // Wait for statusChanges observable to trigger
                await new Promise(resolve => setTimeout(resolve, 50));
                expect(component.showValidationError()).toBe(false);
            });
        });

        it('should call scrollToFirstError when form is invalid', async () => {
            component.data$.subscribe(() => {
                vi.spyOn(component as any, 'scrollToFirstError').mockReturnValue(undefined);

                // Clear required field and submit
                component.editForm?.patchValue({ name: '' });
                component.submitForm({});

                expect((component as any).scrollToFirstError).toHaveBeenCalled();
            });
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
            component.entityKey = 'Issue';
            component.navToList('Status');

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Status'], { replaceUrl: true });
        });
    });

    describe('navToRecord()', () => {
        it('should navigate to specified record with replaceUrl', () => {
            component.navToRecord('Issue', '99');

            expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue', '99'], { replaceUrl: true });
        });
    });

    describe('Route Parameter Changes', () => {
        it('should reload data when entityId changes', async () => {
            let callCount = 0;

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockImplementation((params: any) => {
                if (params.entityId === '42') {
                    return of([{ id: 42, name: 'Issue 42' }] as any);
                }
                else {
                    return of([{ id: 99, name: 'Issue 99' }] as any);
                }
            });

            await new Promise<void>((resolve, reject) => {
                component.data$.subscribe({
                    next: async data => {
                        try {
                            callCount++;
                            if (callCount === 1) {
                                expect(data.id).toBe(42);
                                expect(component.editForm?.get('name')?.value).toBe('Issue 42');

                                // Trigger route change to different record
                                routeParams.next({ entityKey: 'Issue', entityId: '99' });
                            }
                            else if (callCount === 2) {
                                expect(data.id).toBe(99);
                                expect(component.entityId).toBe('99');
                                // Form should be repopulated with new data
                                await new Promise(r => setTimeout(r, 10));
                                expect(component.editForm?.get('name')?.value).toBe('Issue 99');
                                resolve();
                            }
                        } catch (e) { reject(e); }
                    }
                });
            });
        });

        it('should recreate form when entityKey changes', async () => {
            let callCount = 0;

            mockSchemaService.getEntity.mockImplementation((key: string) => {
                if (key === 'Issue')
                    return of(MOCK_ENTITIES.issue);
                if (key === 'Status')
                    return of(MOCK_ENTITIES.status);
                return of(undefined);
            });
            mockSchemaService.getPropsForEdit.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockReturnValue(of([{ id: 1, name: 'Test' }] as any));

            component.data$.subscribe(() => {
                callCount++;
                if (callCount === 1) {
                    expect(component.entityKey).toBe('Issue');
                    expect(component.editForm).toBeDefined();

                    routeParams.next({ entityKey: 'Status', entityId: '5' });
                }
                else if (callCount === 2) {
                    expect(component.entityKey).toBe('Status');
                    expect(component.editForm).toBeDefined();
                }
            });
        });
    });

    describe('Data Flow with Complex Property Types', () => {
        it('should handle all property types in edit form', async () => {
            const mockProps = [
                MOCK_PROPERTIES.textShort,
                MOCK_PROPERTIES.textLong,
                MOCK_PROPERTIES.boolean,
                MOCK_PROPERTIES.integer,
                MOCK_PROPERTIES.money,
                MOCK_PROPERTIES.date,
                MOCK_PROPERTIES.foreignKey,
                MOCK_PROPERTIES.geoPoint
            ];
            const mockData = [{
                    id: 42,
                    name: 'Test',
                    description: 'Long text',
                    is_active: true,
                    count: 5,
                    amount: '$100',
                    due_date: '2025-12-31',
                    status_id: 1,
                    location: 'POINT(-83 43)'
                }];

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
            mockDataService.getData.mockReturnValue(of(mockData as any));

            component.data$.subscribe(() => {
                const callArgs = vi.mocked(mockDataService.getData).mock.calls[0][0];
                expect(callArgs.fields).toContain('name');
                expect(callArgs.fields).toContain('description');
                expect(callArgs.fields).toContain('is_active');
                expect(callArgs.fields).toContain('count');
                expect(callArgs.fields).toContain('amount');
                expect(callArgs.fields).toContain('due_date');
                expect(callArgs.fields).toContain('status_id'); // Edit forms use raw ID, not embedded object
                expect(callArgs.fields).toContain('location:location_text');
            });
        });
    });

    describe('Entity Description Tooltip', () => {
        it('should display entity with description in template', async () => {
            const entityWithDescription = { ...MOCK_ENTITIES.issue, description: 'Track system issues' };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithDescription));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockReturnValue(of([{ id: 1, name: 'Test' }] as any));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBe('Track system issues');
            });
        });

        it('should handle entities without description', async () => {
            const entityWithoutDescription = { ...MOCK_ENTITIES.issue, description: null };
            mockSchemaService.getEntity.mockReturnValue(of(entityWithoutDescription));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockReturnValue(of([{ id: 1, name: 'Test' }] as any));

            component.entity$.subscribe(entity => {
                expect(entity?.description).toBeNull();
            });
        });
    });

    describe('Value Transformation', () => {
        /**
         * TIMEZONE-AWARE TESTS
         *
         * These tests verify correct handling of DateTime (naive) vs DateTimeLocal (timezone-aware) fields.
         *
         * IMPORTANT: DateTimeLocal tests depend on the test runner's timezone setting.
         * The expected values shown here assume the tests run in UTC timezone.
         * If tests run in a different timezone (e.g., EST, PST), the expected output
         * will be different. This is CORRECT and EXPECTED behavior.
         *
         * Example: Database has "2025-01-15T10:30:00Z" (10:30 UTC)
         * - In UTC timezone: Display "2025-01-15T10:30" ✓
         * - In EST (UTC-5): Display "2025-01-15T05:30" ✓
         * - In PST (UTC-8): Display "2025-01-15T02:30" ✓
         */
        describe('transformValueForControl() - Load-time transformations', () => {
            it('should format DateTime field for input (timezone-naive)', async () => {
                // DateTime fields (timestamp without time zone) are timezone-naive
                const mockProps = [MOCK_PROPERTIES.dateTime];
                const mockData = [{ id: 42, created_at: '2025-01-15T10:30:00' }];

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));

                component.data$.subscribe(() => {
                    const controlValue = component.editForm?.get('created_at')?.value;
                    // Should show exactly what's stored (no timezone conversion)
                    expect(controlValue).toBe('2025-01-15T10:30');
                });
            });

            it('should convert DateTimeLocal UTC to user local time', async () => {
                // DateTimeLocal fields (timestamptz) are timezone-aware
                const mockProps = [MOCK_PROPERTIES.dateTimeLocal];
                const mockData = [{ id: 42, updated_at: '2025-01-15T10:30:00.000Z' }]; // 10:30 UTC

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));

                component.data$.subscribe(() => {
                    const controlValue = component.editForm?.get('updated_at')?.value;
                    // Should convert UTC to local timezone
                    // The exact value depends on test runner's timezone
                    const utcDate = new Date('2025-01-15T10:30:00.000Z');
                    const expectedValue = `${utcDate.getFullYear()}-${String(utcDate.getMonth() + 1).padStart(2, '0')}-${String(utcDate.getDate()).padStart(2, '0')}T${String(utcDate.getHours()).padStart(2, '0')}:${String(utcDate.getMinutes()).padStart(2, '0')}`;
                    expect(controlValue).toBe(expectedValue);
                });
            });

            it('should parse money string to number', async () => {
                const mockProps = [MOCK_PROPERTIES.money];
                const mockData = [{ id: 42, amount: '$1,234.56' }];

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));

                component.data$.subscribe(() => {
                    const controlValue = component.editForm?.get('amount')?.value;
                    expect(controlValue).toBe(1234.56);
                    expect(typeof controlValue).toBe('number');
                });
            });

            it('should handle null values without transformation', async () => {
                const mockProps = [MOCK_PROPERTIES.dateTime, MOCK_PROPERTIES.money];
                const mockData = [{ id: 42, created_at: null, amount: null }];

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));

                component.data$.subscribe(() => {
                    expect(component.editForm?.get('created_at')?.value).toBeNull();
                    expect(component.editForm?.get('amount')?.value).toBeNull();
                });
            });
        });

        describe('transformValuesForApi() - Submit-time transformations', () => {
            /**
             * These tests verify correct transformation of form values back to database format.
             *
             * DateTime (timestamp without time zone):
             * - Input: "2025-01-15T10:30" (naive time from datetime-local input)
             * - Output: "2025-01-15T10:30:00" (add seconds, no timezone)
             *
             * DateTimeLocal (timestamptz):
             * - Input: "2025-01-15T17:30" (user's local time from datetime-local input)
             * - Output: "2025-01-15T22:30:00.000Z" (convert to UTC ISO format)
             * - Test expectations are timezone-aware (calculated values match test runner TZ)
             */

            it('should add seconds to DateTime value on submit (timezone-naive)', async () => {
                const mockProps = [MOCK_PROPERTIES.dateTime];
                const mockData = [{ id: 42, created_at: '2025-01-15T10:30:00' }];

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));
                mockDataService.editData.mockReturnValue(of({ success: true }));

                fixture.detectChanges();

                await firstValueFrom(component.data$);
                // Form receives '2025-01-15T10:30' from transformValueForControl
                // User edits to '2025-01-15T11:45' (naive time, no timezone)
                component.editForm?.patchValue({ created_at: '2025-01-15T11:45' });
                component.submitForm({});

                await new Promise(resolve => setTimeout(resolve, 10));
                // Should add ':00' seconds for API (no timezone conversion)
                expect(mockDataService.editData).toHaveBeenCalledWith('Issue', '42', { created_at: '2025-01-15T11:45:00' });
            });

            it('should convert DateTimeLocal local time to UTC on submit', async () => {
                const mockProps = [MOCK_PROPERTIES.dateTimeLocal];
                const mockData = [{ id: 42, updated_at: '2025-01-15T10:30:00.000Z' }];

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));
                mockDataService.editData.mockReturnValue(of({ success: true }));

                fixture.detectChanges();

                await firstValueFrom(component.data$);
                // User enters time in their local timezone (e.g., "5:30 PM" shows as "17:30")
                const localTimeInput = '2025-01-15T17:30';
                component.editForm?.patchValue({ updated_at: localTimeInput });
                component.submitForm({});

                await new Promise(resolve => setTimeout(resolve, 10));
                // Should convert to UTC ISO format with .000Z suffix
                // The exact UTC time depends on test runner's timezone
                const localDate = new Date(localTimeInput);
                const expectedUTC = localDate.toISOString(); // e.g., "2025-01-15T22:30:00.000Z" in EST

                expect(mockDataService.editData).toHaveBeenCalledWith('Issue', '42', { updated_at: expectedUTC });
            });

            it('should keep money value as number on submit', async () => {
                const mockProps = [MOCK_PROPERTIES.money];
                const mockData = [{ id: 42, amount: '$100.00' }];

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));
                mockDataService.editData.mockReturnValue(of({ success: true }));

                fixture.detectChanges();

                await firstValueFrom(component.data$);
                // Form receives 100 (number) from transformValueForControl
                // User edits to 250.75
                component.editForm?.patchValue({ amount: 250.75 });
                component.submitForm({});

                await new Promise(resolve => setTimeout(resolve, 10));
                const callArgs = vi.mocked(mockDataService.editData).mock.calls[0][2];
                expect(callArgs.amount).toBe(250.75);
                expect(typeof callArgs.amount).toBe('number');
            });

            it('should handle mixed property types correctly (DateTime + DateTimeLocal + Money)', async () => {
                const mockProps = [
                    MOCK_PROPERTIES.textShort,
                    MOCK_PROPERTIES.dateTime,
                    MOCK_PROPERTIES.dateTimeLocal,
                    MOCK_PROPERTIES.money
                ];
                const mockData = [{
                        id: 42,
                        name: 'Test',
                        created_at: '2025-01-15T10:30:00', // DateTime (naive)
                        updated_at: '2025-01-15T10:30:00.000Z', // DateTimeLocal (UTC)
                        amount: '$100.00'
                    }];

                mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
                mockSchemaService.getPropsForEdit.mockReturnValue(of(mockProps));
                mockDataService.getData.mockReturnValue(of(mockData as any));
                mockDataService.editData.mockReturnValue(of({ success: true }));

                fixture.detectChanges();

                await firstValueFrom(component.data$);
                const dateTimeInput = '2025-01-20T14:30'; // Naive time
                const dateTimeLocalInput = '2025-01-20T18:00'; // Local time

                component.editForm?.patchValue({
                    name: 'Updated Name',
                    created_at: dateTimeInput,
                    updated_at: dateTimeLocalInput,
                    amount: 500
                });
                component.submitForm({});

                await new Promise(resolve => setTimeout(resolve, 10));
                // DateTime: Just add seconds (naive)
                // DateTimeLocal: Convert to UTC ISO format
                const expectedDateTimeLocal = new Date(dateTimeLocalInput).toISOString();

                expect(mockDataService.editData).toHaveBeenCalledWith('Issue', '42', {
                    name: 'Updated Name',
                    created_at: '2025-01-20T14:30:00', // DateTime with seconds
                    updated_at: expectedDateTimeLocal, // DateTimeLocal as UTC ISO
                    amount: 500
                });
            });
        });
    });

    describe('Token Refresh (Keycloak Integration)', () => {
        let mockKeycloak: any;

        beforeEach(() => {
            // Create mock Keycloak instance
            mockKeycloak = {
                updateToken: vi.fn().mockName("Keycloak.updateToken")
            };

            mockSchemaService.getEntity.mockReturnValue(of(MOCK_ENTITIES.issue));
            mockSchemaService.getPropsForEdit.mockReturnValue(of([MOCK_PROPERTIES.textShort]));
            mockDataService.getData.mockReturnValue(of([{ id: 42, name: 'Test' }] as any));

            // Manually inject mock Keycloak (bypass DI for testing)
            (component as any).keycloak = mockKeycloak;

            fixture.detectChanges();
        });

        it('should call updateToken before form submission', async () => {
            mockKeycloak.updateToken.mockResolvedValue(true);
            mockDataService.editData.mockReturnValue(of({ success: true }));

            await firstValueFrom(component.data$);
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
            expect(mockDataService.editData).toHaveBeenCalled();
        });

        it('should proceed with submission when token refresh succeeds', async () => {
            mockKeycloak.updateToken.mockResolvedValue(true);
            mockDataService.editData.mockReturnValue(of({ success: true }));

            await firstValueFrom(component.data$);
            component.editForm?.patchValue({ name: 'Updated' });
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockDataService.editData).toHaveBeenCalledWith('Issue', '42', { name: 'Updated' });
            expect(component.showSuccessModal()).toBe(true);
        });

        it('should show 401 error modal when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Token refresh failed'));

            await firstValueFrom(component.data$);
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(component.showErrorModal()).toBe(true);
            expect(component.currentError()).toEqual(expect.objectContaining({
                httpCode: 401,
                message: 'Session expired',
                humanMessage: 'Session Expired',
                hint: 'Your login session has expired. Please refresh the page to log in again.'
            }));
            expect(mockDataService.editData).not.toHaveBeenCalled();
            expect(component.showSuccessModal()).toBe(false);
        });

        it('should not call editData when token refresh fails', async () => {
            mockKeycloak.updateToken.mockRejectedValue(new Error('Expired'));

            await firstValueFrom(component.data$);
            component.submitForm({});

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(mockDataService.editData).not.toHaveBeenCalled();
        });
    });

    describe('isCurrentStepSkippable', () => {
        const mockSteps: GuidedFormStep[] = [
            {
                id: 1, guided_form_key: 'test_form', step_key: '__parent__',
                display_name: 'Parent', description: null, step_table: 'parent_table',
                parent_fk_column: null, step_order: 0, can_skip: false,
                track_key: null, conditions: []
            },
            {
                id: 2, guided_form_key: 'test_form', step_key: 'optional_step',
                display_name: 'Optional Step', description: null, step_table: 'optional_table',
                parent_fk_column: 'parent_id', step_order: 1, can_skip: true,
                track_key: null, conditions: []
            },
            {
                id: 3, guided_form_key: 'test_form', step_key: 'required_step',
                display_name: 'Required Step', description: null, step_table: 'required_table',
                parent_fk_column: 'parent_id', step_order: 2, can_skip: false,
                track_key: null, conditions: []
            }
        ];

        const makeContext = (overrides?: Partial<GuidedFormContext>): GuidedFormContext => ({
            definition: {
                guided_form_key: 'test_form', description: null, parent_table: 'parent_table',
                ownership_column: null, lock_on_submit: false, on_submit_rpc: null,
                review_intro_text: null, precondition_rpc: null, auto_submit_on_all_skipped: false,
                is_enabled: true, status_options: []
            },
            steps: mockSteps,
            progress: [],
            status_options: [],
            parent_status_id: 1,
            parent_status_key: 'draft',
            parent_id: 100,
            record_id: 200,
            is_child_step: true,
            step_key: 'optional_step',
            step_record_ids: {},
            ...overrides
        });

        it('should return false when no guided form context', () => {
            expect(component.isCurrentStepSkippable()).toBe(false);
        });

        it('should return false for parent step (__parent__)', () => {
            component.entityKey = 'parent_table';
            component.guidedFormContext.set(makeContext());
            // getEffectiveSteps would be called but __parent__ is excluded before it
            expect(component.isCurrentStepSkippable()).toBe(false);
        });

        it('should return true for optional step (can_skip=true) in draft mode', () => {
            component.entityKey = 'optional_table';
            component.guidedFormContext.set(makeContext());

            mockGuidedFormService.getEffectiveSteps.mockReturnValue([
                { ...mockSteps[0], isSkipped: false, isCompleted: false, isRequired: true },
                { ...mockSteps[1], isSkipped: false, isCompleted: false, isRequired: false },
                { ...mockSteps[2], isSkipped: false, isCompleted: false, isRequired: true }
            ]);

            expect(component.isCurrentStepSkippable()).toBe(true);
        });

        it('should return false for required step (can_skip=false)', () => {
            component.entityKey = 'required_table';
            component.guidedFormContext.set(makeContext());

            mockGuidedFormService.getEffectiveSteps.mockReturnValue([
                { ...mockSteps[0], isSkipped: false, isCompleted: false, isRequired: true },
                { ...mockSteps[1], isSkipped: false, isCompleted: false, isRequired: false },
                { ...mockSteps[2], isSkipped: false, isCompleted: false, isRequired: true }
            ]);

            expect(component.isCurrentStepSkippable()).toBe(false);
        });

        it('should return false when require_if makes optional step required', () => {
            component.entityKey = 'optional_table';
            component.guidedFormContext.set(makeContext());

            // require_if condition matched — step is now required
            mockGuidedFormService.getEffectiveSteps.mockReturnValue([
                { ...mockSteps[0], isSkipped: false, isCompleted: false, isRequired: true },
                { ...mockSteps[1], isSkipped: false, isCompleted: false, isRequired: true },
                { ...mockSteps[2], isSkipped: false, isCompleted: false, isRequired: true }
            ]);

            expect(component.isCurrentStepSkippable()).toBe(false);
        });

        it('should return false when step is condition-skipped', () => {
            component.entityKey = 'optional_table';
            component.guidedFormContext.set(makeContext());

            mockGuidedFormService.getEffectiveSteps.mockReturnValue([
                { ...mockSteps[0], isSkipped: false, isCompleted: false, isRequired: true },
                { ...mockSteps[1], isSkipped: true, isCompleted: false, isRequired: false },
                { ...mockSteps[2], isSkipped: false, isCompleted: false, isRequired: true }
            ]);

            expect(component.isCurrentStepSkippable()).toBe(false);
        });
    });

    describe('skipStep()', () => {
        const mockSteps: GuidedFormStep[] = [
            {
                id: 1, guided_form_key: 'test_form', step_key: '__parent__',
                display_name: 'Parent', description: null, step_table: 'parent_table',
                parent_fk_column: null, step_order: 0, can_skip: false,
                track_key: null, conditions: []
            },
            {
                id: 2, guided_form_key: 'test_form', step_key: 'step_a',
                display_name: 'Step A', description: null, step_table: 'step_a_table',
                parent_fk_column: 'parent_id', step_order: 1, can_skip: true,
                track_key: null, conditions: []
            },
            {
                id: 3, guided_form_key: 'test_form', step_key: 'step_b',
                display_name: 'Step B', description: null, step_table: 'step_b_table',
                parent_fk_column: 'parent_id', step_order: 2, can_skip: false,
                track_key: null, conditions: []
            }
        ];

        const makeContext = (): GuidedFormContext => ({
            definition: {
                guided_form_key: 'test_form', description: null, parent_table: 'parent_table',
                ownership_column: null, lock_on_submit: false, on_submit_rpc: null,
                review_intro_text: null, precondition_rpc: null, auto_submit_on_all_skipped: false,
                is_enabled: true, status_options: []
            },
            steps: mockSteps,
            progress: [],
            status_options: [],
            parent_status_id: 1,
            parent_status_key: 'draft',
            parent_id: 100,
            record_id: 200,
            is_child_step: true,
            step_key: 'step_a',
            step_record_ids: {}
        });

        it('should navigate to next step when skipping a non-last step', () => {
            component.entityKey = 'step_a_table';
            component.entityId = '200';
            component.guidedFormKey.set('test_form');
            component.guidedFormParentId.set('100');
            component.guidedFormContext.set(makeContext());

            mockGuidedFormService.getEffectiveSteps.mockReturnValue([
                { ...mockSteps[0], isSkipped: false, isCompleted: false, isRequired: true },
                { ...mockSteps[1], isSkipped: false, isCompleted: false, isRequired: false },
                { ...mockSteps[2], isSkipped: false, isCompleted: false, isRequired: true }
            ]);

            mockGuidedFormService.ensureStepRecord.mockReturnValue(of({ record_id: 301, created: false }));

            component.skipStep();

            expect(mockGuidedFormService.ensureStepRecord).toHaveBeenCalledWith('test_form', 100, 'step_b');
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/edit', 'step_b_table', 301]);
        });

        it('should navigate to detail page when skipping the last step', () => {
            component.entityKey = 'step_b_table';
            component.entityId = '301';
            component.guidedFormKey.set('test_form');
            component.guidedFormParentId.set('100');
            component.guidedFormContext.set(makeContext());

            mockGuidedFormService.getEffectiveSteps.mockReturnValue([
                { ...mockSteps[0], isSkipped: false, isCompleted: false, isRequired: true },
                { ...mockSteps[1], isSkipped: false, isCompleted: false, isRequired: false },
                { ...mockSteps[2], isSkipped: false, isCompleted: false, isRequired: true }
            ]);

            component.skipStep();

            expect(mockRouter.navigate).toHaveBeenCalledWith(['/view', 'parent_table', 100]);
        });
    });
});
