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
import { PropertyManagementPage } from './property-management.page';
import { SchemaService } from '../../services/schema.service';
import { PropertyManagementService } from '../../services/property-management.service';
import { of, throwError } from 'rxjs';
import { CdkDragDrop } from '@angular/cdk/drag-drop';
import { EntityPropertyType, SchemaEntityProperty } from '../../interfaces/entity';

describe('PropertyManagementPage', () => {
  let component: PropertyManagementPage;
  let fixture: ComponentFixture<PropertyManagementPage>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockPropertyManagementService: jasmine.SpyObj<PropertyManagementService>;

  const mockEntities = [
    { table_name: 'Issue', display_name: 'Issues', description: 'Track issues', search_fields: null, sort_order: 0, insert: true, select: true, update: true, delete: true, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null },
    { table_name: 'WorkPackage', display_name: 'Work Packages', description: null, search_fields: null, sort_order: 1, insert: true, select: true, update: true, delete: true, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null }
  ];

  const mockProperties: SchemaEntityProperty[] = [
    {
      table_catalog: 'civic_os_db',
      table_schema: 'public',
      table_name: 'Issue',
      column_name: 'title',
      display_name: 'Title',
      description: 'Issue title',
      sort_order: 0,
      column_width: 200,
      sortable: true,
      column_default: '',
      is_nullable: false,
      data_type: 'character varying',
      character_maximum_length: 255,
      udt_schema: 'pg_catalog',
      udt_name: 'varchar',
      is_self_referencing: false,
      is_identity: false,
      is_generated: false,
      is_updatable: true,
      join_schema: '',
      join_table: '',
      join_column: '',
      geography_type: '',
      show_on_list: true,
      show_on_create: true,
      show_on_edit: true,
      show_on_detail: true,
      type: EntityPropertyType.TextShort
    },
    {
      table_catalog: 'civic_os_db',
      table_schema: 'public',
      table_name: 'Issue',
      column_name: 'description',
      display_name: 'Description',
      description: undefined,
      sort_order: 1,
      column_width: undefined,
      sortable: true,
      column_default: '',
      is_nullable: true,
      data_type: 'text',
      character_maximum_length: 0,
      udt_schema: 'pg_catalog',
      udt_name: 'text',
      is_self_referencing: false,
      is_identity: false,
      is_generated: false,
      is_updatable: true,
      join_schema: '',
      join_table: '',
      join_column: '',
      geography_type: '',
      show_on_list: true,
      show_on_create: true,
      show_on_edit: true,
      show_on_detail: true,
      type: EntityPropertyType.TextLong
    }
  ];

  beforeEach(async () => {
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getEntitiesForMenu', 'getPropertiesForEntityFresh', 'refreshCache']);
    mockPropertyManagementService = jasmine.createSpyObj('PropertyManagementService', [
      'isAdmin',
      'upsertPropertyMetadata',
      'updatePropertiesOrder'
    ]);

    await TestBed.configureTestingModule({
      imports: [PropertyManagementPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: PropertyManagementService, useValue: mockPropertyManagementService }
      ]
    })
    .compileComponents();
  });

  it('should create', () => {
    // Set up mocks before creating component
    mockPropertyManagementService.isAdmin.and.returnValue(of(false));
    mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

    fixture = TestBed.createComponent(PropertyManagementPage);
    component = fixture.componentInstance;

    expect(component).toBeTruthy();
  });

  describe('Admin Access Check', () => {
    it('should set adminLoading to false after admin check completes', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        // After admin check completes, adminLoading should be false
        expect(component.adminLoading()).toBe(false);
        expect(component.isAdmin()).toBe(true);
        expect(component.adminError()).toBeUndefined();
        done();
      }, 100);
    });

    it('should allow access when user is admin', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.isAdmin()).toBe(true);
        expect(component.error()).toBeUndefined();
        done();
      }, 100);
    });

    it('should deny access when user is not admin', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(false));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.isAdmin()).toBe(false);
        done();
      }, 100);
    });

    it('should handle admin check error', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(throwError(() => new Error('Network error')));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.adminError()).toBe('Failed to verify admin access');
        expect(component.isAdmin()).toBe(false);
        expect(component.adminLoading()).toBe(false);
        done();
      }, 100);
    });
  });

  describe('Entity Selection', () => {
    it('should load properties when entity is selected', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

        setTimeout(() => {
          expect(component.properties().length).toBe(2);
          expect(component.properties()[0].column_name).toBe('title');
          expect(component.loading()).toBe(false);
          done();
        }, 10);
      }, 100);
    });

    it('should clear properties when no entity is selected', () => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;

      component.selectedEntity.set(undefined);
      component.onEntityChange();

      expect(component.properties().length).toBe(0);
    });

    it('should handle property loading error', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(throwError(() => new Error('Load error')));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

        setTimeout(() => {
          expect(component.error()).toBe('Failed to load properties');
          expect(component.loading()).toBe(false);
          done();
        }, 10);
      }, 100);
    });
  });

  describe('Property Expansion', () => {
    it('should toggle property expansion', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

        setTimeout(() => {
          const property = component.properties()[0];
          expect(property.expanded).toBe(false);

          component.toggleExpanded(property);
          expect(component.properties()[0].expanded).toBe(true);

          component.toggleExpanded(property);
          expect(component.properties()[0].expanded).toBe(false);
          done();
        }, 10);
      }, 100);
    });
  });

  describe('Drag and Drop', () => {
    it('should reorder properties and update sort order', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));
      mockPropertyManagementService.updatePropertiesOrder.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

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

          expect(component.properties()[0].column_name).toBe('description');
          expect(component.properties()[1].column_name).toBe('title');

          expect(mockPropertyManagementService.updatePropertiesOrder).toHaveBeenCalledWith([
            { table_name: 'Issue', column_name: 'description', sort_order: 0 },
            { table_name: 'Issue', column_name: 'title', sort_order: 1 }
          ]);
          done();
        }, 10);
      }, 100);
    });

    it('should refresh schema cache after reorder', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));
      mockPropertyManagementService.updatePropertiesOrder.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

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
        }, 10);
      }, 100);
    });
  });

  describe('Metadata Saving', () => {
    it('should save metadata on blur', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));
      mockPropertyManagementService.upsertPropertyMetadata.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

        setTimeout(() => {
          const property = component.properties()[0];
          property.customDisplayName = 'Updated Title';
          component.onFieldBlur(property);

          setTimeout(() => {
            expect(mockPropertyManagementService.upsertPropertyMetadata).toHaveBeenCalledWith(
              'Issue',
              'title',
              'Updated Title',
              'Issue title',
              0,
              200,
              true,
              false,  // filterable defaults to false when undefined
              true,
              true,
              true,
              true
            );
            done();
          }, 10);
        }, 10);
      }, 100);
    });

    it('should show saved indicator after save completes', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));
      mockPropertyManagementService.upsertPropertyMetadata.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

        setTimeout(() => {
          const property = component.properties()[0];
          component.onFieldBlur(property);

          setTimeout(() => {
            expect(component.isSaving(property)).toBe(false);
            expect(component.isSaved(property)).toBe(true);
            done();
          }, 10);
        }, 10);
      }, 100);
    });

    it('should refresh schema cache but NOT reload properties after save', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));
      mockPropertyManagementService.upsertPropertyMetadata.and.returnValue(of({ success: true }));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        component.selectedEntity.set(mockEntities[0]);
        component.onEntityChange();

        setTimeout(() => {
          // Reset the call count after initial load
          mockSchemaService.refreshCache.calls.reset();
          (mockSchemaService.getPropertiesForEntityFresh as jasmine.Spy).calls.reset();

          const property = component.properties()[0];
          property.customDisplayName = 'New Name';
          component.onFieldBlur(property);

          setTimeout(() => {
            // Should call refreshCache
            expect(mockSchemaService.refreshCache).toHaveBeenCalled();

            // Should NOT reload properties (no additional call to getPropertiesForEntityFresh)
            expect(mockSchemaService.getPropertiesForEntityFresh).not.toHaveBeenCalled();

            // Local state should still have the updated value via ngModel
            expect(component.properties()[0].customDisplayName).toBe('New Name');
            done();
          }, 10);
        }, 10);
      }, 150);
    });
  });

  describe('Auto-Select First Entity', () => {
    it('should auto-select first entity when entities load', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        // Should auto-select first entity
        expect(component.selectedEntity()).toBeDefined();
        expect(component.selectedEntity()?.table_name).toBe('Issue');
        expect(component.properties().length).toBe(2);
        done();
      }, 150);
    });

    it('should not auto-select if entity already selected', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(mockProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;

      // Manually set entity before initialization
      component.selectedEntity.set(mockEntities[1]);

      fixture.detectChanges();

      setTimeout(() => {
        // Should keep the manually selected entity
        expect(component.selectedEntity()?.table_name).toBe('WorkPackage');
        done();
      }, 150);
    });

    it('should handle empty entities array gracefully', (done) => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.selectedEntity()).toBeUndefined();
        expect(component.properties().length).toBe(0);
        done();
      }, 150);
    });
  });

  describe('Property Sorting', () => {
    it('should sort properties by sort_order in ascending order', (done) => {
      const unsortedProperties = [
        { ...mockProperties[1], sort_order: 2 },  // description with sort_order 2
        { ...mockProperties[0], sort_order: 1 }   // title with sort_order 1
      ];

      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(unsortedProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const properties = component.properties();
        expect(properties.length).toBe(2);
        // Should be sorted by sort_order
        expect(properties[0].column_name).toBe('title');      // sort_order 1
        expect(properties[1].column_name).toBe('description'); // sort_order 2
        done();
      }, 150);
    });

    it('should maintain sort after properties are loaded', (done) => {
      const unsortedProperties = [
        { ...mockProperties[1], sort_order: 5 },
        { ...mockProperties[0], sort_order: 3 }
      ];

      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of(mockEntities));
      mockSchemaService.getPropertiesForEntityFresh.and.returnValue(of(unsortedProperties));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;
      fixture.detectChanges();

      setTimeout(() => {
        const properties = component.properties();
        expect(properties[0].sort_order).toBe(3);
        expect(properties[1].sort_order).toBe(5);
        expect(properties[0].sort_order).toBeLessThan(properties[1].sort_order);
        done();
      }, 150);
    });
  });

  describe('compareEntities()', () => {
    it('should return true for entities with same table_name', () => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;

      const entity1 = { ...mockEntities[0] };
      const entity2 = { ...mockEntities[0] };

      expect(component.compareEntities(entity1, entity2)).toBe(true);
    });

    it('should return false for entities with different table_name', () => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;

      expect(component.compareEntities(mockEntities[0], mockEntities[1])).toBe(false);
    });

    it('should handle null/undefined entities', () => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;

      expect(component.compareEntities(null as any, null as any)).toBe(true);
      expect(component.compareEntities(undefined as any, undefined as any)).toBe(true);
      expect(component.compareEntities(mockEntities[0], null as any)).toBe(false);
      expect(component.compareEntities(null as any, mockEntities[0])).toBe(false);
    });
  });

  describe('Helper Methods', () => {
    it('should get correct property type label', () => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;

      const property = {
        ...mockProperties[0],
        customDisplayName: null,
        customDescription: null,
        customColumnWidth: null,
        expanded: false
      };
      expect(component.getPropertyTypeLabel(property)).toBe('Text (Short)');

      property.type = EntityPropertyType.ForeignKeyName;
      expect(component.getPropertyTypeLabel(property)).toBe('Foreign Key');
    });

    it('should get correct display name placeholder', () => {
      mockPropertyManagementService.isAdmin.and.returnValue(of(true));
      mockSchemaService.getEntitiesForMenu.and.returnValue(of([]));

      fixture = TestBed.createComponent(PropertyManagementPage);
      component = fixture.componentInstance;

      const property = {
        ...mockProperties[0],
        customDisplayName: null,
        customDescription: null,
        customColumnWidth: null,
        expanded: false
      };
      expect(component.getDisplayNamePlaceholder(property)).toBe('Title');
    });
  });
});
