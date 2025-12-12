/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { EditPage } from './edit.page';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { BehaviorSubject, of } from 'rxjs';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { EntityPropertyType } from '../../interfaces/entity';
import Keycloak from 'keycloak-js';

describe('EditPage', () => {
  let component: EditPage;
  let fixture: ComponentFixture<EditPage>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockAnalyticsService: jasmine.SpyObj<AnalyticsService>;
  let mockAuthService: jasmine.SpyObj<AuthService>;
  let mockRouter: jasmine.SpyObj<Router>;
  let mockKeycloak: jasmine.SpyObj<Keycloak>;
  let routeParams: BehaviorSubject<any>;

  beforeEach(async () => {
    routeParams = new BehaviorSubject({ entityKey: 'Issue', entityId: '42' });

    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntity',
      'getPropsForEdit',
      'getEditRenderables'
    ]);
    mockDataService = jasmine.createSpyObj('DataService', ['getData', 'editData']);
    mockAnalyticsService = jasmine.createSpyObj('AnalyticsService', ['trackEvent']);
    mockAuthService = jasmine.createSpyObj('AuthService', ['login'], {
      authenticated: signal(false)
    });
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);
    mockKeycloak = jasmine.createSpyObj('Keycloak', ['updateToken']);

    // Setup updateToken to return resolved promise by default (for form submission)
    mockKeycloak.updateToken.and.returnValue(Promise.resolve(true));

    // Setup default for renderables (most tests use properties$ directly)
    mockSchemaService.getEditRenderables.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [EditPage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { params: routeParams.asObservable() } },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService },
        { provide: AnalyticsService, useValue: mockAnalyticsService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: Router, useValue: mockRouter },
        { provide: Keycloak, useValue: mockKeycloak }
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
    it('should load entity metadata from route params', (done) => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of([]));
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
      mockSchemaService.getPropsForEdit.and.returnValue(of([]));
      mockDataService.getData.and.returnValue(of([] as any));

      component.entity$.subscribe(() => {
        expect(component.entityKey).toBe('Issue');
        expect(component.entityId).toBe('42');
        done();
      });
    });

    it('should return undefined when entityKey or entityId is missing', (done) => {
      routeParams.next({ entityKey: 'Issue' });
      mockSchemaService.getEntity.and.returnValue(of(undefined));

      component.entity$.subscribe(entity => {
        expect(entity).toBeUndefined();
        expect(mockSchemaService.getEntity).not.toHaveBeenCalled();
        done();
      });
    });

    it('should fetch properties for edit form', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.foreignKey
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of([{ id: 42, name: 'Test' }] as any));

      component.properties$.subscribe(props => {
        expect(props.length).toBe(2);
        expect(mockSchemaService.getPropsForEdit).toHaveBeenCalledWith(MOCK_ENTITIES.issue);
        done();
      });
    });

    it('should fetch existing record data', (done) => {
      const mockProps = [MOCK_PROPERTIES.textShort];
      const mockData = [{ id: 42, name: 'Existing Issue' }];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of(mockData as any));

      component.data$.subscribe(data => {
        expect(mockDataService.getData).toHaveBeenCalledWith({
          key: 'Issue',
          fields: ['name'],
          entityId: '42'
        });
        expect(data).toEqual({ id: 42, name: 'Existing Issue' });
        done();
      });
    });
  });

  describe('Form Generation and Population', () => {
    it('should create form with controls for each editable property', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.integer
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of([{ id: 42, name: 'Test', count: 5 }] as any));

      component.data$.subscribe(() => {
        expect(component.editForm).toBeDefined();
        expect(component.editForm?.get('name')).toBeDefined();
        expect(component.editForm?.get('count')).toBeDefined();
        done();
      });
    });

    it('should populate form with existing data', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.integer,
        MOCK_PROPERTIES.boolean
      ];
      const mockData = [{ id: 42, name: 'Test Issue', count: 10, is_active: true }];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of(mockData as any));

      component.data$.subscribe(() => {
        expect(component.editForm?.get('name')?.value).toBe('Test Issue');
        expect(component.editForm?.get('count')?.value).toBe(10);
        expect(component.editForm?.get('is_active')?.value).toBe(true);
        done();
      });
    });

    it('should not populate id field (filtered out)', (done) => {
      const mockProps = [MOCK_PROPERTIES.textShort];
      const mockData = [{ id: 42, name: 'Test' }];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of(mockData as any));

      component.data$.subscribe(() => {
        // Note: FormGroup.get returns null for non-existent controls, not undefined
        expect(component.editForm?.get('id')).toBeNull();
        done();
      });
    });

    it('should add validators for required fields', (done) => {
      const mockProps = [
        createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })
      ];
      const mockData = [{ id: 42, name: '' }];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of(mockData as any));

      component.data$.subscribe(() => {
        const nameControl = component.editForm?.get('name');
        nameControl?.setValue('');
        expect(nameControl?.hasError('required')).toBe(true);
        done();
      });
    });
  });

  describe('submitForm()', () => {
    beforeEach(() => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.returnValue(of([{ id: 42, name: 'Old Name' }] as any));

      // Initialize component and dialogs FIRST
      fixture.detectChanges();

      // THEN spy on the dialog components
      spyOn(component.successDialog, 'open');
      spyOn(component.errorDialog, 'open');
    });

    it('should call editData with form values', (done) => {
      mockDataService.editData.and.returnValue(of({ success: true }));

      component.data$.subscribe(() => {
        component.editForm?.patchValue({ name: 'Updated Name' });
        component.submitForm({});

        setTimeout(() => {
          expect(mockDataService.editData).toHaveBeenCalledWith(
            'Issue',
            '42',
            { name: 'Updated Name' }
          );
          done();
        }, 10);
      });
    });

    it('should open success dialog on successful update', (done) => {
      mockDataService.editData.and.returnValue(of({ success: true }));

      component.data$.subscribe(() => {
        component.submitForm({});

        setTimeout(() => {
          expect(component.successDialog.open).toHaveBeenCalled();
          expect(component.errorDialog.open).not.toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should open error dialog on failed update', (done) => {
      const error = {
        httpCode: 400,
        message: 'Update failed',
        details: 'Constraint violation',
        hint: 'Check your input',
        humanMessage: 'Could not update'
      };
      mockDataService.editData.and.returnValue(of({ success: false, error }));

      component.data$.subscribe(() => {
        component.submitForm({});

        setTimeout(() => {
          expect(component.errorDialog.open).toHaveBeenCalledWith(error);
          expect(component.successDialog.open).not.toHaveBeenCalled();
          done();
        }, 10);
      });
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
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of([
        createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })
      ]));
      mockDataService.getData.and.returnValue(of([{ id: 42, name: '' }] as any));

      fixture.detectChanges();
    });

    it('should not submit when form is invalid', (done) => {
      mockDataService.editData.and.returnValue(of({ success: true }));

      component.data$.subscribe(() => {
        // Clear required field to make form invalid
        component.editForm?.patchValue({ name: '' });
        component.submitForm({});

        expect(mockDataService.editData).not.toHaveBeenCalled();
        done();
      });
    });

    it('should set showValidationError flag when submitting invalid form', (done) => {
      component.data$.subscribe(() => {
        expect(component.showValidationError()).toBe(false);

        // Clear required field and submit
        component.editForm?.patchValue({ name: '' });
        component.submitForm({});

        expect(component.showValidationError()).toBe(true);
        done();
      });
    });

    it('should mark all controls as touched when submitting invalid form', (done) => {
      component.data$.subscribe(() => {
        const nameControl = component.editForm?.get('name');
        expect(nameControl?.touched).toBe(false);

        // Clear required field and submit
        component.editForm?.patchValue({ name: '' });
        component.submitForm({});

        expect(nameControl?.touched).toBe(true);
        done();
      });
    });

    it('should hide error banner when form becomes valid', (done) => {
      component.data$.subscribe(() => {
        // Make form invalid and submit to show error
        component.editForm?.patchValue({ name: '' });
        component.submitForm({});
        expect(component.showValidationError()).toBe(true);

        // Make form valid
        component.editForm?.patchValue({ name: 'Valid Name' });

        // Wait for statusChanges observable to trigger
        setTimeout(() => {
          expect(component.showValidationError()).toBe(false);
          done();
        }, 50);
      });
    });

    it('should call scrollToFirstError when form is invalid', (done) => {
      component.data$.subscribe(() => {
        spyOn<any>(component, 'scrollToFirstError');

        // Clear required field and submit
        component.editForm?.patchValue({ name: '' });
        component.submitForm({});

        expect((component as any).scrollToFirstError).toHaveBeenCalled();
        done();
      });
    });
  });

  describe('navToList()', () => {
    it('should navigate to current entity list', () => {
      component.entityKey = 'Issue';
      component.navToList();

      expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue']);
    });

    it('should navigate to specified entity list', () => {
      component.entityKey = 'Issue';
      component.navToList('Status');

      expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Status']);
    });
  });

  describe('navToRecord()', () => {
    it('should navigate to specified record', () => {
      component.navToRecord('Issue', '99');

      expect(mockRouter.navigate).toHaveBeenCalledWith(['view', 'Issue', '99']);
    });
  });

  describe('Route Parameter Changes', () => {
    it('should reload data when entityId changes', (done) => {
      let callCount = 0;

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.callFake((params: any) => {
        if (params.entityId === '42') {
          return of([{ id: 42, name: 'Issue 42' }] as any);
        } else {
          return of([{ id: 99, name: 'Issue 99' }] as any);
        }
      });

      component.data$.subscribe(data => {
        callCount++;
        if (callCount === 1) {
          expect(data.id).toBe(42);
          expect(component.editForm?.get('name')?.value).toBe('Issue 42');

          // Trigger route change to different record
          routeParams.next({ entityKey: 'Issue', entityId: '99' });
        } else if (callCount === 2) {
          expect(data.id).toBe(99);
          expect(component.entityId).toBe('99');
          // Form should be repopulated with new data
          setTimeout(() => {
            expect(component.editForm?.get('name')?.value).toBe('Issue 99');
            done();
          }, 10);
        }
      });
    });

    it('should recreate form when entityKey changes', (done) => {
      let callCount = 0;

      mockSchemaService.getEntity.and.callFake((key: string) => {
        if (key === 'Issue') return of(MOCK_ENTITIES.issue);
        if (key === 'Status') return of(MOCK_ENTITIES.status);
        return of(undefined);
      });
      mockSchemaService.getPropsForEdit.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.returnValue(of([{ id: 1, name: 'Test' }] as any));

      component.data$.subscribe(() => {
        callCount++;
        if (callCount === 1) {
          expect(component.entityKey).toBe('Issue');
          expect(component.editForm).toBeDefined();

          routeParams.next({ entityKey: 'Status', entityId: '5' });
        } else if (callCount === 2) {
          expect(component.entityKey).toBe('Status');
          expect(component.editForm).toBeDefined();
          done();
        }
      });
    });
  });

  describe('Data Flow with Complex Property Types', () => {
    it('should handle all property types in edit form', (done) => {
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

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
      mockDataService.getData.and.returnValue(of(mockData as any));

      component.data$.subscribe(() => {
        const callArgs = mockDataService.getData.calls.argsFor(0)[0];
        expect(callArgs.fields).toContain('name');
        expect(callArgs.fields).toContain('description');
        expect(callArgs.fields).toContain('is_active');
        expect(callArgs.fields).toContain('count');
        expect(callArgs.fields).toContain('amount');
        expect(callArgs.fields).toContain('due_date');
        expect(callArgs.fields).toContain('status_id'); // Edit forms use raw ID, not embedded object
        expect(callArgs.fields).toContain('location:location_text');
        done();
      });
    });
  });

  describe('Entity Description Tooltip', () => {
    it('should display entity with description in template', (done) => {
      const entityWithDescription = { ...MOCK_ENTITIES.issue, description: 'Track system issues' };
      mockSchemaService.getEntity.and.returnValue(of(entityWithDescription));
      mockSchemaService.getPropsForEdit.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.returnValue(of([{ id: 1, name: 'Test' }] as any));

      component.entity$.subscribe(entity => {
        expect(entity?.description).toBe('Track system issues');
        done();
      });
    });

    it('should handle entities without description', (done) => {
      const entityWithoutDescription = { ...MOCK_ENTITIES.issue, description: null };
      mockSchemaService.getEntity.and.returnValue(of(entityWithoutDescription));
      mockSchemaService.getPropsForEdit.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.returnValue(of([{ id: 1, name: 'Test' }] as any));

      component.entity$.subscribe(entity => {
        expect(entity?.description).toBeNull();
        done();
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
      it('should format DateTime field for input (timezone-naive)', (done) => {
        // DateTime fields (timestamp without time zone) are timezone-naive
        const mockProps = [MOCK_PROPERTIES.dateTime];
        const mockData = [{ id: 42, created_at: '2025-01-15T10:30:00' }];

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));

        component.data$.subscribe(() => {
          const controlValue = component.editForm?.get('created_at')?.value;
          // Should show exactly what's stored (no timezone conversion)
          expect(controlValue).toBe('2025-01-15T10:30');
          done();
        });
      });

      it('should convert DateTimeLocal UTC to user local time', (done) => {
        // DateTimeLocal fields (timestamptz) are timezone-aware
        const mockProps = [MOCK_PROPERTIES.dateTimeLocal];
        const mockData = [{ id: 42, updated_at: '2025-01-15T10:30:00.000Z' }]; // 10:30 UTC

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));

        component.data$.subscribe(() => {
          const controlValue = component.editForm?.get('updated_at')?.value;
          // Should convert UTC to local timezone
          // The exact value depends on test runner's timezone
          const utcDate = new Date('2025-01-15T10:30:00.000Z');
          const expectedValue = `${utcDate.getFullYear()}-${String(utcDate.getMonth() + 1).padStart(2, '0')}-${String(utcDate.getDate()).padStart(2, '0')}T${String(utcDate.getHours()).padStart(2, '0')}:${String(utcDate.getMinutes()).padStart(2, '0')}`;
          expect(controlValue).toBe(expectedValue);
          done();
        });
      });

      it('should parse money string to number', (done) => {
        const mockProps = [MOCK_PROPERTIES.money];
        const mockData = [{ id: 42, amount: '$1,234.56' }];

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));

        component.data$.subscribe(() => {
          const controlValue = component.editForm?.get('amount')?.value;
          expect(controlValue).toBe(1234.56);
          expect(typeof controlValue).toBe('number');
          done();
        });
      });

      it('should handle null values without transformation', (done) => {
        const mockProps = [MOCK_PROPERTIES.dateTime, MOCK_PROPERTIES.money];
        const mockData = [{ id: 42, created_at: null, amount: null }];

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));

        component.data$.subscribe(() => {
          expect(component.editForm?.get('created_at')?.value).toBeNull();
          expect(component.editForm?.get('amount')?.value).toBeNull();
          done();
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

      it('should add seconds to DateTime value on submit (timezone-naive)', (done) => {
        const mockProps = [MOCK_PROPERTIES.dateTime];
        const mockData = [{ id: 42, created_at: '2025-01-15T10:30:00' }];

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));
        mockDataService.editData.and.returnValue(of({ success: true }));

        fixture.detectChanges();

        component.data$.subscribe(() => {
          spyOn(component.successDialog, 'open');
          spyOn(component.errorDialog, 'open');

          // Form receives '2025-01-15T10:30' from transformValueForControl
          // User edits to '2025-01-15T11:45' (naive time, no timezone)
          component.editForm?.patchValue({ created_at: '2025-01-15T11:45' });
          component.submitForm({});

          setTimeout(() => {
            // Should add ':00' seconds for API (no timezone conversion)
            expect(mockDataService.editData).toHaveBeenCalledWith(
              'Issue',
              '42',
              { created_at: '2025-01-15T11:45:00' }
            );
            done();
          }, 10);
        });
      });

      it('should convert DateTimeLocal local time to UTC on submit', (done) => {
        const mockProps = [MOCK_PROPERTIES.dateTimeLocal];
        const mockData = [{ id: 42, updated_at: '2025-01-15T10:30:00.000Z' }];

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));
        mockDataService.editData.and.returnValue(of({ success: true }));

        fixture.detectChanges();

        component.data$.subscribe(() => {
          spyOn(component.successDialog, 'open');
          spyOn(component.errorDialog, 'open');

          // User enters time in their local timezone (e.g., "5:30 PM" shows as "17:30")
          const localTimeInput = '2025-01-15T17:30';
          component.editForm?.patchValue({ updated_at: localTimeInput });
          component.submitForm({});

          setTimeout(() => {
            // Should convert to UTC ISO format with .000Z suffix
            // The exact UTC time depends on test runner's timezone
            const localDate = new Date(localTimeInput);
            const expectedUTC = localDate.toISOString(); // e.g., "2025-01-15T22:30:00.000Z" in EST

            expect(mockDataService.editData).toHaveBeenCalledWith(
              'Issue',
              '42',
              { updated_at: expectedUTC }
            );
            done();
          }, 10);
        });
      });

      it('should keep money value as number on submit', (done) => {
        const mockProps = [MOCK_PROPERTIES.money];
        const mockData = [{ id: 42, amount: '$100.00' }];

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));
        mockDataService.editData.and.returnValue(of({ success: true }));

        fixture.detectChanges();

        component.data$.subscribe(() => {
          spyOn(component.successDialog, 'open');
          spyOn(component.errorDialog, 'open');

          // Form receives 100 (number) from transformValueForControl
          // User edits to 250.75
          component.editForm?.patchValue({ amount: 250.75 });
          component.submitForm({});

          setTimeout(() => {
            const callArgs = mockDataService.editData.calls.argsFor(0)[2];
            expect(callArgs.amount).toBe(250.75);
            expect(typeof callArgs.amount).toBe('number');
            done();
          }, 10);
        });
      });

      it('should handle mixed property types correctly (DateTime + DateTimeLocal + Money)', (done) => {
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

        mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
        mockSchemaService.getPropsForEdit.and.returnValue(of(mockProps));
        mockDataService.getData.and.returnValue(of(mockData as any));
        mockDataService.editData.and.returnValue(of({ success: true }));

        fixture.detectChanges();

        component.data$.subscribe(() => {
          spyOn(component.successDialog, 'open');
          spyOn(component.errorDialog, 'open');

          const dateTimeInput = '2025-01-20T14:30'; // Naive time
          const dateTimeLocalInput = '2025-01-20T18:00'; // Local time

          component.editForm?.patchValue({
            name: 'Updated Name',
            created_at: dateTimeInput,
            updated_at: dateTimeLocalInput,
            amount: 500
          });
          component.submitForm({});

          setTimeout(() => {
            // DateTime: Just add seconds (naive)
            // DateTimeLocal: Convert to UTC ISO format
            const expectedDateTimeLocal = new Date(dateTimeLocalInput).toISOString();

            expect(mockDataService.editData).toHaveBeenCalledWith(
              'Issue',
              '42',
              {
                name: 'Updated Name',
                created_at: '2025-01-20T14:30:00', // DateTime with seconds
                updated_at: expectedDateTimeLocal, // DateTimeLocal as UTC ISO
                amount: 500
              }
            );
            done();
          }, 10);
        });
      });
    });
  });

  describe('Token Refresh (Keycloak Integration)', () => {
    let mockKeycloak: jasmine.SpyObj<any>;

    beforeEach(() => {
      // Create mock Keycloak instance
      mockKeycloak = jasmine.createSpyObj('Keycloak', ['updateToken']);

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForEdit.and.returnValue(of([MOCK_PROPERTIES.textShort]));
      mockDataService.getData.and.returnValue(of([{ id: 42, name: 'Test' }] as any));

      // Manually inject mock Keycloak (bypass DI for testing)
      (component as any).keycloak = mockKeycloak;

      fixture.detectChanges();
    });

    it('should call updateToken before form submission', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.resolve(true));
      mockDataService.editData.and.returnValue(of({ success: true }));

      component.data$.subscribe(() => {
        spyOn(component.successDialog, 'open');
        spyOn(component.errorDialog, 'open');

        component.submitForm({});

        setTimeout(() => {
          expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
          expect(mockDataService.editData).toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should proceed with submission when token refresh succeeds', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.resolve(true));
      mockDataService.editData.and.returnValue(of({ success: true }));

      component.data$.subscribe(() => {
        spyOn(component.successDialog, 'open');
        spyOn(component.errorDialog, 'open');

        component.editForm?.patchValue({ name: 'Updated' });
        component.submitForm({});

        setTimeout(() => {
          expect(mockDataService.editData).toHaveBeenCalledWith(
            'Issue',
            '42',
            { name: 'Updated' }
          );
          expect(component.successDialog.open).toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should show 401 error dialog when token refresh fails', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.reject(new Error('Token refresh failed')));

      component.data$.subscribe(() => {
        spyOn(component.errorDialog, 'open');
        spyOn(component.successDialog, 'open');

        component.submitForm({});

        setTimeout(() => {
          expect(component.errorDialog.open).toHaveBeenCalledWith(
            jasmine.objectContaining({
              httpCode: 401,
              message: 'Session expired',
              humanMessage: 'Session Expired',
              hint: 'Your login session has expired. Please refresh the page to log in again.'
            })
          );
          expect(mockDataService.editData).not.toHaveBeenCalled();
          expect(component.successDialog.open).not.toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should not call editData when token refresh fails', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.reject(new Error('Expired')));

      component.data$.subscribe(() => {
        component.submitForm({});

        setTimeout(() => {
          expect(mockDataService.editData).not.toHaveBeenCalled();
          done();
        }, 10);
      });
    });
  });
});
