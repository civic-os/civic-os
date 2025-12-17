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
import { EntityManagementPage } from './entity-management.page';
import { SchemaService } from '../../services/schema.service';
import { EntityManagementService } from '../../services/entity-management.service';
import { of, throwError } from 'rxjs';
import { CdkDragDrop } from '@angular/cdk/drag-drop';

describe('EntityManagementPage', () => {
  let component: EntityManagementPage;
  let fixture: ComponentFixture<EntityManagementPage>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockEntityManagementService: jasmine.SpyObj<EntityManagementService>;

  const mockEntities = [
    { table_name: 'Issue', display_name: 'Issues', description: 'Track issues', search_fields: null, sort_order: 0, insert: true, select: true, update: true, delete: true, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null },
    { table_name: 'WorkPackage', display_name: 'Work Packages', description: null, search_fields: null, sort_order: 1, insert: true, select: true, update: true, delete: true, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null },
    { table_name: 'Bid', display_name: 'Bid', description: null, search_fields: null, sort_order: 2, insert: true, select: true, update: true, delete: false, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null }
  ];

  beforeEach(async () => {
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getEntitiesForMenu', 'getPropertiesForEntity', 'refreshCache']);
    mockEntityManagementService = jasmine.createSpyObj('EntityManagementService', [
      'isAdmin',
      'upsertEntityMetadata',
      'updateEntitiesOrder'
    ]);

    // Set default return value for getPropertiesForEntity to avoid undefined errors
    mockSchemaService.getPropertiesForEntity.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [EntityManagementPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: EntityManagementService, useValue: mockEntityManagementService }
      ]
    })
    .compileComponents();
  });

  it('should create', () => {
    // Set up mocks before creating component
    mockEntityManagementService.isAdmin.and.returnValue(of(false));

    fixture = TestBed.createComponent(EntityManagementPage);
    component = fixture.componentInstance;

    expect(component).toBeTruthy();
  });

  describe('Admin Access Check', () => {
    it('should load entities when user is admin', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.isAdmin()).toBe(true);
        expect(component.entities().length).toBe(3);
        expect(component.loading()).toBe(false);
        done();
      }, 100);
    });

    it('should show error when user is not admin', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(false));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.isAdmin()).toBe(false);
        expect(component.error()).toBe('Admin access required');
        expect(component.loading()).toBe(false);
        done();
      }, 100);
    });

    it('should handle admin check error', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(throwError(() => new Error('Network error')));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('Failed to verify admin access');
        expect(component.loading()).toBe(false);
        done();
      }, 100);
    });
  });

  describe('Entity Loading', () => {
    it('should map entity data correctly', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const entities = component.entities();
        expect(entities[0].customDisplayName).toBe('Issues');
        expect(entities[0].customDescription).toBe('Track issues');
        expect(entities[1].customDisplayName).toBe('Work Packages'); // Different from table_name
        expect(entities[1].customDescription).toBeNull();
        done();
      }, 100);
    });

    it('should handle entity loading error', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(throwError(() => new Error('Load error')));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('Failed to load entities');
        expect(component.loading()).toBe(false);
        done();
      }, 100);
    });
  });

  describe('Drag and Drop', () => {
    it('should reorder entities and update sort order', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockEntityManagementService.updateEntitiesOrder.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const event: CdkDragDrop<any> = {
          previousIndex: 0,
          currentIndex: 2,
          item: null as any,
          container: null as any,
          previousContainer: null as any,
          isPointerOverContainer: true,
          distance: { x: 0, y: 0 },
          dropPoint: { x: 0, y: 0 },
          event: null as any
        };

        component.onDrop(event);

        expect(component.entities()[0].table_name).toBe('WorkPackage');
        expect(component.entities()[1].table_name).toBe('Bid');
        expect(component.entities()[2].table_name).toBe('Issue');

        expect(mockEntityManagementService.updateEntitiesOrder).toHaveBeenCalledWith([
          { table_name: 'WorkPackage', sort_order: 0 },
          { table_name: 'Bid', sort_order: 1 },
          { table_name: 'Issue', sort_order: 2 }
        ]);
        done();
      }, 100);
    });

    it('should refresh schema cache after reorder', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockEntityManagementService.updateEntitiesOrder.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const event: CdkDragDrop<any> = {
          previousIndex: 0,
          currentIndex: 1,
          item: null as any,
          container: null as any,
          previousContainer: null as any,
          isPointerOverContainer: true,
          distance: { x: 0, y: 0 },
          dropPoint: { x: 0, y: 0 },
          event: null as any
        };

        component.onDrop(event);

        setTimeout(() => {
          expect(mockSchemaService.refreshCache).toHaveBeenCalled();
          done();
        }, 10);
      }, 100);
    });

    it('should handle reorder error', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockEntityManagementService.updateEntitiesOrder.and.returnValue(
        of({
          success: false,
          error: {
            httpCode: 500,
            details: '',
            hint: '',
            message: 'Update failed',
            humanMessage: 'Update failed'
          }
        })
      );

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const event: CdkDragDrop<any> = {
          previousIndex: 0,
          currentIndex: 1,
          item: null as any,
          container: null as any,
          previousContainer: null as any,
          isPointerOverContainer: true,
          distance: { x: 0, y: 0 },
          dropPoint: { x: 0, y: 0 },
          event: null as any
        };

        component.onDrop(event);

        setTimeout(() => {
          expect(component.error()).toBe('Update failed');
          done();
        }, 10);
      }, 100);
    });
  });

  describe('Metadata Saving', () => {
    it('should save metadata on blur', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockEntityManagementService.upsertEntityMetadata.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const entity = component.entities()[0];
        entity.customDisplayName = 'Updated Issues';
        component.onFieldBlur(entity);

        setTimeout(() => {
          expect(mockEntityManagementService.upsertEntityMetadata).toHaveBeenCalledWith(
            'Issue',
            'Updated Issues',
            'Track issues',
            0,
            false,
            null,
            false,
            null,
            null,
            undefined,  // enable_notes
            undefined,  // supports_recurring
            undefined   // recurring_property_name
          );
          done();
        }, 10);
      }, 100);
    });

    it('should show saved indicator after save completes', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockEntityManagementService.upsertEntityMetadata.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const entity = component.entities()[0];
        component.onFieldBlur(entity);

        // With synchronous mock, save completes immediately
        setTimeout(() => {
          expect(component.isSaving('Issue')).toBe(false);
          expect(component.isSaved('Issue')).toBe(true);
          done();
        }, 10);
      }, 100);
    });

    it('should handle save errors', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockEntityManagementService.upsertEntityMetadata.and.returnValue(
        of({
          success: false,
          error: {
            httpCode: 500,
            details: '',
            hint: '',
            message: 'Save failed',
            humanMessage: 'Save failed'
          }
        })
      );

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const entity = component.entities()[0];
        component.onFieldBlur(entity);

        setTimeout(() => {
          expect(component.error()).toBe('Save failed');
          done();
        }, 10);
      }, 100);
    });
  });

  describe('Helper Methods', () => {
    it('should get correct display name placeholder', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const entity = component.entities()[0];
        expect(component.getDisplayNamePlaceholder(entity)).toBe('Issues');
        done();
      }, 100);
    });

    it('should track saved state', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.isSaved('Issue')).toBe(false);
        component.savedStates().set('Issue', true);
        expect(component.isSaved('Issue')).toBe(true);
        done();
      }, 100);
    });

    it('should track fading state', (done) => {
      mockEntityManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));

      fixture = TestBed.createComponent(EntityManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.isFading('Issue')).toBe(false);
        component.fadingStates().set('Issue', true);
        expect(component.isFading('Issue')).toBe(true);
        done();
      }, 100);
    });
  });
});
