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
import { CreateSeriesWizardComponent } from './create-series-wizard.component';
import { SchemaService } from '../../services/schema.service';
import { RecurringService } from '../../services/recurring.service';
import { EntityPropertyType, SchemaEntityProperty } from '../../interfaces/entity';
import { createMockProperty, createMockEntity } from '../../testing';
import { of } from 'rxjs';

describe('CreateSeriesWizardComponent', () => {
  let component: CreateSeriesWizardComponent;
  let fixture: ComponentFixture<CreateSeriesWizardComponent>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockRecurringService: jasmine.SpyObj<RecurringService>;

  // Mock properties for testing template field visibility
  const mockProperties: SchemaEntityProperty[] = [
    createMockProperty({
      table_name: 'test_entity',
      column_name: 'id',
      type: EntityPropertyType.IntegerNumber,
      display_name: 'ID',
      show_on_create: false,
      show_on_edit: false
    }),
    createMockProperty({
      table_name: 'test_entity',
      column_name: 'time_slot',
      type: EntityPropertyType.TimeSlot,
      display_name: 'Time Slot',
      show_on_create: true,
      show_on_edit: true
    }),
    createMockProperty({
      table_name: 'test_entity',
      column_name: 'title',
      type: EntityPropertyType.TextShort,
      display_name: 'Title',
      show_on_create: true,
      show_on_edit: true
    }),
    createMockProperty({
      table_name: 'test_entity',
      column_name: 'description',
      type: EntityPropertyType.TextLong,
      display_name: 'Description',
      show_on_create: true,
      show_on_edit: true
    }),
    createMockProperty({
      table_name: 'test_entity',
      column_name: 'status_id',
      type: EntityPropertyType.ForeignKeyName,
      display_name: 'Status',
      show_on_create: true,
      show_on_edit: false // Only visible on create, not edit
    }),
    createMockProperty({
      table_name: 'test_entity',
      column_name: 'manager_id',
      type: EntityPropertyType.User,
      display_name: 'Manager',
      show_on_create: false,
      show_on_edit: true // Only visible on edit, not create
    }),
    createMockProperty({
      table_name: 'test_entity',
      column_name: 'internal_notes',
      type: EntityPropertyType.TextLong,
      display_name: 'Internal Notes',
      show_on_create: false,
      show_on_edit: false // Hidden in both contexts
    })
  ];

  beforeEach(async () => {
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getProperties']);
    mockRecurringService = jasmine.createSpyObj('RecurringService', [
      'describeRRule',
      'createSeries'
    ]);

    mockSchemaService.getProperties.and.returnValue(of(mockProperties));
    mockRecurringService.describeRRule.and.returnValue('Weekly');

    await TestBed.configureTestingModule({
      imports: [CreateSeriesWizardComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: RecurringService, useValue: mockRecurringService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(CreateSeriesWizardComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('templateProperties computed', () => {
    beforeEach(() => {
      // Simulate entity selection and schema loading
      component.entityProperties.set(mockProperties);
      component.timeSlotPropertyName.set('time_slot');
    });

    it('should include properties with show_on_edit=true', () => {
      const templateProps = component.templateProperties();
      const managerProp = templateProps.find(p => p.column_name === 'manager_id');

      expect(managerProp).toBeTruthy();
      expect(managerProp?.show_on_edit).toBe(true);
    });

    it('should include properties with show_on_create=true', () => {
      const templateProps = component.templateProperties();
      const statusProp = templateProps.find(p => p.column_name === 'status_id');

      expect(statusProp).toBeTruthy();
      expect(statusProp?.show_on_create).toBe(true);
    });

    it('should include properties visible in either create or edit context', () => {
      const templateProps = component.templateProperties();
      const titleProp = templateProps.find(p => p.column_name === 'title');
      const descProp = templateProps.find(p => p.column_name === 'description');

      expect(titleProp).toBeTruthy();
      expect(descProp).toBeTruthy();
    });

    it('should exclude properties hidden in both create and edit contexts', () => {
      const templateProps = component.templateProperties();
      const internalNotesProp = templateProps.find(p => p.column_name === 'internal_notes');

      expect(internalNotesProp).toBeUndefined();
    });

    it('should exclude the time slot property', () => {
      const templateProps = component.templateProperties();
      const timeSlotProp = templateProps.find(p => p.column_name === 'time_slot');

      expect(timeSlotProp).toBeUndefined();
    });

    it('should exclude id column (hidden in both contexts)', () => {
      // The ID is excluded via show_on_create=false AND show_on_edit=false
      const templateProps = component.templateProperties();
      const idProp = templateProps.find(p => p.column_name === 'id');

      expect(idProp).toBeUndefined();
    });
  });

  describe('buildTemplateForm', () => {
    it('should create form controls for properties visible in either context', () => {
      component.timeSlotPropertyName.set('time_slot');

      // Call the method indirectly via onEntityTypeChange
      component.infoForm.patchValue({ entity_table: 'test_entity' });
      component.availableEntities = [
        createMockEntity({
          table_name: 'test_entity',
          display_name: 'Test Entity',
          recurring_property_name: 'time_slot'
        }) as any
      ];

      mockSchemaService.getProperties.and.returnValue(of(mockProperties));
      component.onEntityTypeChange();

      // Check form has expected controls
      expect(component.templateForm.contains('title')).toBe(true);
      expect(component.templateForm.contains('description')).toBe(true);
      expect(component.templateForm.contains('status_id')).toBe(true); // show_on_create=true
      expect(component.templateForm.contains('manager_id')).toBe(true); // show_on_edit=true
    });

    it('should NOT create form controls for properties hidden in both contexts', () => {
      component.timeSlotPropertyName.set('time_slot');
      component.infoForm.patchValue({ entity_table: 'test_entity' });
      component.availableEntities = [
        createMockEntity({
          table_name: 'test_entity',
          display_name: 'Test Entity',
          recurring_property_name: 'time_slot'
        }) as any
      ];

      mockSchemaService.getProperties.and.returnValue(of(mockProperties));
      component.onEntityTypeChange();

      // internal_notes has show_on_create=false AND show_on_edit=false
      expect(component.templateForm.contains('internal_notes')).toBe(false);
    });

    it('should NOT create form control for time slot property', () => {
      component.timeSlotPropertyName.set('time_slot');
      component.infoForm.patchValue({ entity_table: 'test_entity' });
      component.availableEntities = [
        createMockEntity({
          table_name: 'test_entity',
          display_name: 'Test Entity',
          recurring_property_name: 'time_slot'
        }) as any
      ];

      mockSchemaService.getProperties.and.returnValue(of(mockProperties));
      component.onEntityTypeChange();

      // Time slot is managed by the recurrence system, not the template
      expect(component.templateForm.contains('time_slot')).toBe(false);
    });
  });
});
