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
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { CreatePage } from './create.page';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AnalyticsService } from '../../services/analytics.service';
import { BehaviorSubject, of } from 'rxjs';
import { MOCK_ENTITIES, MOCK_PROPERTIES, createMockProperty } from '../../testing';
import { FormControl, Validators } from '@angular/forms';
import { EntityPropertyType } from '../../interfaces/entity';
import Keycloak from 'keycloak-js';

describe('CreatePage', () => {
  let component: CreatePage;
  let fixture: ComponentFixture<CreatePage>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockAnalyticsService: jasmine.SpyObj<AnalyticsService>;
  let mockRouter: jasmine.SpyObj<Router>;
  let mockKeycloak: jasmine.SpyObj<Keycloak>;
  let routeParams: BehaviorSubject<any>;
  let queryParams: BehaviorSubject<any>;

  beforeEach(async () => {
    routeParams = new BehaviorSubject({ entityKey: 'Issue' });
    queryParams = new BehaviorSubject({});

    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntity',
      'getPropsForCreate'
    ]);
    mockDataService = jasmine.createSpyObj('DataService', ['createData', 'getData']);
    mockAnalyticsService = jasmine.createSpyObj('AnalyticsService', ['trackEvent']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);
    mockKeycloak = jasmine.createSpyObj('Keycloak', ['updateToken']);

    // Setup getData to return empty array by default (for foreign key dropdowns)
    mockDataService.getData.and.returnValue(of([]));

    // Setup updateToken to return resolved promise by default (for form submission)
    mockKeycloak.updateToken.and.returnValue(Promise.resolve(true));

    await TestBed.configureTestingModule({
      imports: [CreatePage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { params: routeParams.asObservable(), queryParams: queryParams.asObservable() } },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService },
        { provide: AnalyticsService, useValue: mockAnalyticsService },
        { provide: Router, useValue: mockRouter },
        { provide: Keycloak, useValue: mockKeycloak }
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
    it('should load entity metadata from route params', (done) => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of([]));

      component.entity$.subscribe(entity => {
        expect(entity).toBeDefined();
        expect(entity?.table_name).toBe('Issue');
        expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
        done();
      });
    });

    it('should store entityKey from route params', (done) => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of([]));

      component.entity$.subscribe(() => {
        expect(component.entityKey).toBe('Issue');
        done();
      });
    });

    it('should fetch properties for create form', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.foreignKey
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProps));

      component.properties$.subscribe(props => {
        expect(props.length).toBe(2);
        expect(mockSchemaService.getPropsForCreate).toHaveBeenCalledWith(MOCK_ENTITIES.issue);
        done();
      });
    });

    it('should return empty array when entity is undefined', (done) => {
      routeParams.next({});
      mockSchemaService.getEntity.and.returnValue(of(undefined));

      component.properties$.subscribe(props => {
        expect(props).toEqual([]);
        expect(mockSchemaService.getPropsForCreate).not.toHaveBeenCalled();
        done();
      });
    });
  });

  describe('Form Generation', () => {
    it('should create form with controls for each property', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.integer,
        MOCK_PROPERTIES.boolean
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProps));

      component.properties$.subscribe(() => {
        expect(component.createForm).toBeDefined();
        expect(component.createForm?.get('name')).toBeDefined();
        expect(component.createForm?.get('count')).toBeDefined();
        expect(component.createForm?.get('is_active')).toBeDefined();
        done();
      });
    });

    it('should set default values for form controls', (done) => {
      const mockProps = [
        MOCK_PROPERTIES.textShort,
        MOCK_PROPERTIES.boolean
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProps));

      component.properties$.subscribe(() => {
        // Boolean should default to false
        expect(component.createForm?.get('is_active')?.value).toBe(false);
        // Other types default to null
        expect(component.createForm?.get('name')?.value).toBeNull();
        done();
      });
    });

    it('should add validators for required (non-nullable) fields', (done) => {
      const mockProps = [
        createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false }),
        createMockProperty({ ...MOCK_PROPERTIES.integer, is_nullable: true })
      ];

      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProps));

      component.properties$.subscribe(() => {
        const nameControl = component.createForm?.get('name');
        const countControl = component.createForm?.get('count');

        // Required field should have validator
        expect(nameControl?.hasError('required')).toBe(true);

        // Optional field should not require validation
        countControl?.setValue(null);
        expect(countControl?.hasError('required')).toBe(false);
        done();
      });
    });
  });

  describe('submitForm()', () => {
    beforeEach(() => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of([MOCK_PROPERTIES.textShort]));

      // Initialize component and dialogs FIRST
      fixture.detectChanges();

      // THEN spy on the dialog components
      spyOn(component.successDialog, 'open');
      spyOn(component.errorDialog, 'open');
    });

    it('should call createData with form values', (done) => {
      mockDataService.createData.and.returnValue(of({ success: true, body: {} }));

      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Test Issue' });
        component.submitForm({});

        // Wait for async promise to resolve
        setTimeout(() => {
          expect(mockDataService.createData).toHaveBeenCalledWith('Issue', { name: 'Test Issue' });
          done();
        }, 10);
      });
    });

    it('should open success dialog on successful create', (done) => {
      mockDataService.createData.and.returnValue(of({ success: true, body: { id: 1 } }));

      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Test' });
        component.submitForm({});

        // Wait for async observable to complete
        setTimeout(() => {
          expect(component.successDialog.open).toHaveBeenCalled();
          expect(component.errorDialog.open).not.toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should open error dialog on failed create', (done) => {
      const error = {
        httpCode: 400,
        message: 'Database error',
        details: 'Constraint violation',
        hint: 'Check your input',
        humanMessage: 'Could not create'
      };
      mockDataService.createData.and.returnValue(of({ success: false, error }));

      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Test' });
        component.submitForm({});

        // Wait for async observable to complete
        setTimeout(() => {
          expect(component.errorDialog.open).toHaveBeenCalledWith(error);
          expect(component.successDialog.open).not.toHaveBeenCalled();
          done();
        }, 10);
      });
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
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of([
        createMockProperty({ ...MOCK_PROPERTIES.textShort, is_nullable: false })
      ]));

      fixture.detectChanges();
    });

    it('should not submit when form is invalid', (done) => {
      mockDataService.createData.and.returnValue(of({ success: true, body: {} }));

      component.properties$.subscribe(() => {
        // Leave form empty (required field not filled)
        component.submitForm({});

        expect(mockDataService.createData).not.toHaveBeenCalled();
        done();
      });
    });

    it('should set showValidationError flag when submitting invalid form', (done) => {
      component.properties$.subscribe(() => {
        expect(component.showValidationError).toBe(false);

        // Submit invalid form
        component.submitForm({});

        expect(component.showValidationError).toBe(true);
        done();
      });
    });

    it('should mark all controls as touched when submitting invalid form', (done) => {
      component.properties$.subscribe(() => {
        const nameControl = component.createForm?.get('name');
        expect(nameControl?.touched).toBe(false);

        // Submit invalid form
        component.submitForm({});

        expect(nameControl?.touched).toBe(true);
        done();
      });
    });

    it('should hide error banner when form becomes valid', (done) => {
      component.properties$.subscribe(() => {
        // Submit invalid form to show error
        component.submitForm({});
        expect(component.showValidationError).toBe(true);

        // Make form valid
        component.createForm?.patchValue({ name: 'Valid Name' });

        // Wait for statusChanges observable to trigger
        setTimeout(() => {
          expect(component.showValidationError).toBe(false);
          done();
        }, 50);
      });
    });

    it('should call scrollToFirstError when form is invalid', (done) => {
      component.properties$.subscribe(() => {
        spyOn<any>(component, 'scrollToFirstError');

        // Submit invalid form
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

  describe('navToCreate()', () => {
    beforeEach(() => {
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of([MOCK_PROPERTIES.textShort]));
    });

    it('should reset form and navigate to current entity create', (done) => {
      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Old Value' });
        spyOn(component.createForm!, 'reset');

        component.navToCreate();

        expect(component.createForm?.reset).toHaveBeenCalled();
        expect(mockRouter.navigate).toHaveBeenCalledWith(['create', 'Issue']);
        done();
      });
    });

    it('should navigate to specified entity create', (done) => {
      component.properties$.subscribe(() => {
        spyOn(component.createForm!, 'reset');

        component.navToCreate('Status');

        expect(component.createForm?.reset).toHaveBeenCalled();
        expect(mockRouter.navigate).toHaveBeenCalledWith(['create', 'Status']);
        done();
      });
    });
  });

  describe('Route Parameter Changes', () => {
    it('should recreate form when entityKey changes', (done) => {
      let callCount = 0;

      mockSchemaService.getEntity.and.callFake((key: string) => {
        if (key === 'Issue') return of(MOCK_ENTITIES.issue);
        if (key === 'Status') return of(MOCK_ENTITIES.status);
        return of(undefined);
      });
      mockSchemaService.getPropsForCreate.and.returnValue(of([MOCK_PROPERTIES.textShort]));

      component.properties$.subscribe(() => {
        callCount++;
        if (callCount === 1) {
          expect(component.entityKey).toBe('Issue');
          expect(component.createForm).toBeDefined();

          // Trigger route change
          routeParams.next({ entityKey: 'Status' });
        } else if (callCount === 2) {
          expect(component.entityKey).toBe('Status');
          expect(component.createForm).toBeDefined();
          done();
        }
      });
    });
  });

  describe('Entity Description Tooltip', () => {
    it('should display entity with description in template', (done) => {
      const entityWithDescription = { ...MOCK_ENTITIES.issue, description: 'Track system issues' };
      mockSchemaService.getEntity.and.returnValue(of(entityWithDescription));
      mockSchemaService.getPropsForCreate.and.returnValue(of([MOCK_PROPERTIES.textShort]));

      component.entity$.subscribe(entity => {
        expect(entity?.description).toBe('Track system issues');
        done();
      });
    });

    it('should handle entities without description', (done) => {
      const entityWithoutDescription = { ...MOCK_ENTITIES.issue, description: null };
      mockSchemaService.getEntity.and.returnValue(of(entityWithoutDescription));
      mockSchemaService.getPropsForCreate.and.returnValue(of([MOCK_PROPERTIES.textShort]));

      component.entity$.subscribe(entity => {
        expect(entity?.description).toBeNull();
        done();
      });
    });
  });

  describe('Token Refresh (Keycloak Integration)', () => {
    let mockKeycloak: jasmine.SpyObj<any>;

    beforeEach(() => {
      mockKeycloak = jasmine.createSpyObj('Keycloak', ['updateToken']);
      mockSchemaService.getEntity.and.returnValue(of(MOCK_ENTITIES.issue));
      mockSchemaService.getPropsForCreate.and.returnValue(of([MOCK_PROPERTIES.textShort]));

      // Manually inject the mock Keycloak instance
      (component as any).keycloak = mockKeycloak;

      fixture.detectChanges();

      // Spy on dialogs after fixture init
      spyOn(component.successDialog, 'open');
      spyOn(component.errorDialog, 'open');
    });

    it('should call updateToken before form submission', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.resolve(true));
      mockDataService.createData.and.returnValue(of({ success: true, body: { id: 1 } }));

      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Test Issue' });
        component.submitForm({});

        setTimeout(() => {
          expect(mockKeycloak.updateToken).toHaveBeenCalledWith(60);
          expect(mockDataService.createData).toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should proceed with submission when token refresh succeeds', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.resolve(true));
      mockDataService.createData.and.returnValue(of({ success: true, body: { id: 1 } }));

      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Test Issue' });
        component.submitForm({});

        setTimeout(() => {
          expect(mockDataService.createData).toHaveBeenCalledWith('Issue', { name: 'Test Issue' });
          expect(component.successDialog.open).toHaveBeenCalled();
          expect(component.errorDialog.open).not.toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should show 401 error dialog when token refresh fails', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.reject(new Error('Token refresh failed')));

      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Test Issue' });
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
          expect(mockDataService.createData).not.toHaveBeenCalled();
          expect(component.successDialog.open).not.toHaveBeenCalled();
          done();
        }, 10);
      });
    });

    it('should not call createData when token refresh fails', (done) => {
      mockKeycloak.updateToken.and.returnValue(Promise.reject(new Error('Token refresh failed')));

      component.properties$.subscribe(() => {
        component.createForm?.patchValue({ name: 'Test Issue' });
        component.submitForm({});

        setTimeout(() => {
          expect(mockDataService.createData).not.toHaveBeenCalled();
          done();
        }, 10);
      });
    });
  });
});
