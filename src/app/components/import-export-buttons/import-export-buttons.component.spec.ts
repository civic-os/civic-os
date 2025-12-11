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
import { of, throwError } from 'rxjs';
import { ImportExportButtonsComponent } from './import-export-buttons.component';
import { ImportExportService } from '../../services/import-export.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { NotesService } from '../../services/notes.service';
import {
  SchemaEntityTable,
  SchemaEntityProperty,
  EntityPropertyType
} from '../../interfaces/entity';
import { FilterCriteria } from '../../interfaces/query';

describe('ImportExportButtonsComponent', () => {
  let component: ImportExportButtonsComponent;
  let fixture: ComponentFixture<ImportExportButtonsComponent>;
  let mockImportExportService: jasmine.SpyObj<ImportExportService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockNotesService: jasmine.SpyObj<NotesService>;

  // Helper function to create mock properties
  const createMockProperty = (overrides: Partial<SchemaEntityProperty>): SchemaEntityProperty => ({
    table_catalog: 'civic_os',
    table_schema: 'public',
    table_name: 'issues',
    column_name: 'test_column',
    display_name: 'Test Column',
    sort_order: 1,
    column_default: '',
    is_nullable: false,
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
    type: EntityPropertyType.TextShort,
    validation_rules: [],
    ...overrides
  });

  const mockEntity: SchemaEntityTable = {
    table_name: 'issues',
    display_name: 'Issues',
    select: true,
    insert: true,
    update: true,
    delete: true,
    search_fields: ['title'],
    sort_order: 1,
    description: 'Test entity',
    show_map: false,
    map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null
  };

  const mockProperties: SchemaEntityProperty[] = [
    createMockProperty({
      column_name: 'title',
      display_name: 'Title',
      type: EntityPropertyType.TextShort
    }),
    createMockProperty({
      column_name: 'description',
      display_name: 'Description',
      type: EntityPropertyType.TextLong
    })
  ];

  beforeEach(async () => {
    mockImportExportService = jasmine.createSpyObj('ImportExportService', [
      'exportToExcel',
      'validateFileSize',
      'parseExcelFile',
      'fetchForeignKeyLookups',
      'downloadTemplate',
      'downloadErrorReport'
    ]);
    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getPropertiesForEntity',
      'getPropsForCreate'
    ]);
    mockDataService = jasmine.createSpyObj('DataService', ['bulkInsert']);
    mockNotesService = jasmine.createSpyObj('NotesService', [
      'getNotes',
      'getNotesForEntities',
      'createNote',
      'updateNote',
      'deleteNote'
    ]);

    await TestBed.configureTestingModule({
      imports: [ImportExportButtonsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ImportExportService, useValue: mockImportExportService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService },
        { provide: NotesService, useValue: mockNotesService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ImportExportButtonsComponent);
    component = fixture.componentInstance;

    // Set required inputs
    component.entity = mockEntity;
    component.entityKey = 'issues';

    fixture.detectChanges();
  });

  describe('Component Creation', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });

    it('should initialize with default signal values', () => {
      expect(component.isExporting()).toBe(false);
      expect(component.showImportModal()).toBe(false);
      expect(component.showExportModal()).toBe(false);
      expect(component.includeNotes()).toBe(true);
    });
  });

  describe('Export Functionality', () => {
    it('should export directly when entity does not have notes enabled', async () => {
      // Entity without enable_notes should export directly (no modal)
      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

      await component.onExport();

      expect(component.showExportModal()).toBe(false);
      expect(mockSchemaService.getPropertiesForEntity).toHaveBeenCalledWith(mockEntity);
      expect(mockImportExportService.exportToExcel).toHaveBeenCalledWith(
        mockEntity,
        mockProperties,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined // no notes service passed
      );
      expect(component.isExporting()).toBe(false);
    });

    it('should pass filters to export', async () => {
      const filters: FilterCriteria[] = [
        { column: 'status_id', operator: 'eq', value: '1' }
      ];
      component.currentFilters = filters;

      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

      await component.onExport();

      expect(mockImportExportService.exportToExcel).toHaveBeenCalledWith(
        mockEntity,
        mockProperties,
        filters,
        undefined,
        undefined,
        undefined,
        undefined
      );
    });

    it('should pass search query to export', async () => {
      component.searchQuery = 'test search';

      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

      await component.onExport();

      expect(mockImportExportService.exportToExcel).toHaveBeenCalledWith(
        mockEntity,
        mockProperties,
        undefined,
        'test search',
        undefined,
        undefined,
        undefined
      );
    });

    it('should pass sort parameters to export', async () => {
      component.sortColumn = 'created_at';
      component.sortDirection = 'desc';

      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

      await component.onExport();

      expect(mockImportExportService.exportToExcel).toHaveBeenCalledWith(
        mockEntity,
        mockProperties,
        undefined,
        undefined,
        'created_at',
        'desc',
        undefined
      );
    });

    it('should set isExporting during export', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));

      let resolveExport: (value: any) => void;
      const exportPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
        resolveExport = resolve;
      });
      mockImportExportService.exportToExcel.and.returnValue(exportPromise);

      const exportCall = component.onExport();

      // Wait a tick for async operations to start
      await Promise.resolve();

      expect(component.isExporting()).toBe(true);

      // Complete the export
      resolveExport!({ success: true });
      await exportCall;

      expect(component.isExporting()).toBe(false);
    });

    it('should not start export if already exporting', async () => {
      component.isExporting.set(true);

      await component.onExport();

      expect(mockSchemaService.getPropertiesForEntity).not.toHaveBeenCalled();
      expect(mockImportExportService.exportToExcel).not.toHaveBeenCalled();
    });

    it('should handle export service error', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({
        success: false,
        error: 'Export too large (100,000 rows)'
      }));

      spyOn(window, 'alert');

      await component.onExport();

      expect(window.alert).toHaveBeenCalledWith('Export too large (100,000 rows)');
      expect(component.isExporting()).toBe(false);
    });

    it('should handle missing properties error', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of(null as any));

      spyOn(window, 'alert');
      spyOn(console, 'error');

      await component.onExport();

      expect(console.error).toHaveBeenCalledWith('Export error:', jasmine.any(Error));
      expect(window.alert).toHaveBeenCalledWith('Export failed: Failed to fetch properties');
      expect(component.isExporting()).toBe(false);
    });

    it('should handle schema service error', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(throwError(() => new Error('Network error')));

      spyOn(window, 'alert');
      spyOn(console, 'error');

      await component.onExport();

      expect(console.error).toHaveBeenCalledWith('Export error:', jasmine.any(Error));
      expect(window.alert).toHaveBeenCalledWith(jasmine.stringContaining('Export failed'));
      expect(component.isExporting()).toBe(false);
    });

    it('should handle export service promise rejection', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.reject(new Error('Excel generation failed')));

      spyOn(window, 'alert');
      spyOn(console, 'error');

      await component.onExport();

      expect(console.error).toHaveBeenCalledWith('Export error:', jasmine.any(Error));
      expect(window.alert).toHaveBeenCalledWith('Export failed: Excel generation failed');
      expect(component.isExporting()).toBe(false);
    });

    it('should reset isExporting even on error', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(throwError(() => new Error('Error')));

      spyOn(window, 'alert');
      spyOn(console, 'error');

      component.isExporting.set(false);

      await component.onExport();

      expect(component.isExporting()).toBe(false);
    });
  });

  describe('Import Modal', () => {
    it('should open import modal on import button click', () => {
      component.onImport();

      expect(component.showImportModal()).toBe(true);
    });

    it('should close import modal', () => {
      component.showImportModal.set(true);

      component.onImportModalClose();

      expect(component.showImportModal()).toBe(false);
    });

    it('should handle import success', () => {
      spyOn(component.importComplete, 'emit');

      component.showImportModal.set(true);

      component.onImportSuccess(25);

      expect(component.showImportModal()).toBe(false);
      expect(component.importComplete.emit).toHaveBeenCalledWith(25);
    });

    it('should emit importComplete with correct count', () => {
      spyOn(component.importComplete, 'emit');

      component.onImportSuccess(150);

      expect(component.importComplete.emit).toHaveBeenCalledWith(150);
    });

    it('should close modal on import success', () => {
      component.showImportModal.set(true);

      component.onImportSuccess(10);

      expect(component.showImportModal()).toBe(false);
    });
  });

  describe('Input Bindings', () => {
    it('should accept entity input', () => {
      const testEntity: SchemaEntityTable = {
        ...mockEntity,
        table_name: 'test_table',
        display_name: 'Test Table'
      };

      component.entity = testEntity;

      expect(component.entity.table_name).toBe('test_table');
      expect(component.entity.display_name).toBe('Test Table');
    });

    it('should accept optional filters input', () => {
      const filters: FilterCriteria[] = [
        { column: 'status_id', operator: 'eq', value: '1' }
      ];

      component.currentFilters = filters;

      expect(component.currentFilters).toEqual(filters);
    });

    it('should accept optional search query input', () => {
      component.searchQuery = 'test search';

      expect(component.searchQuery).toBe('test search');
    });

    it('should accept optional sort parameters', () => {
      component.sortColumn = 'created_at';
      component.sortDirection = 'desc';

      expect(component.sortColumn).toBe('created_at');
      expect(component.sortDirection).toBe('desc');
    });
  });

  describe('Export Modal (Notes-Enabled Entities)', () => {
    const entityWithNotes: SchemaEntityTable = {
      ...mockEntity,
      table_name: 'reservations',
      display_name: 'Reservations',
      enable_notes: true
    };

    beforeEach(() => {
      component.entity = entityWithNotes;
      fixture.detectChanges();
    });

    it('should show export modal when entity has notes enabled', () => {
      component.onExport();

      expect(component.showExportModal()).toBe(true);
      expect(component.includeNotes()).toBe(true); // Default to checked
    });

    it('should close export modal', () => {
      component.showExportModal.set(true);

      component.closeExportModal();

      expect(component.showExportModal()).toBe(false);
    });

    it('should export with notes when includeNotes is checked', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

      component.includeNotes.set(true);
      await component.confirmExport();

      expect(component.showExportModal()).toBe(false);
      expect(mockImportExportService.exportToExcel).toHaveBeenCalledWith(
        entityWithNotes,
        mockProperties,
        undefined,
        undefined,
        undefined,
        undefined,
        mockNotesService // notes service passed when includeNotes is true
      );
    });

    it('should export without notes when includeNotes is unchecked', async () => {
      mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
      mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

      component.includeNotes.set(false);
      await component.confirmExport();

      expect(mockImportExportService.exportToExcel).toHaveBeenCalledWith(
        entityWithNotes,
        mockProperties,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined // no notes service when unchecked
      );
    });

    it('should not start export if already exporting', () => {
      component.isExporting.set(true);

      component.onExport();

      expect(component.showExportModal()).toBe(false);
      expect(mockSchemaService.getPropertiesForEntity).not.toHaveBeenCalled();
    });

    it('should reset includeNotes to true each time modal opens', () => {
      // First open - should default to true
      component.onExport();
      expect(component.includeNotes()).toBe(true);

      // User unchecks it
      component.includeNotes.set(false);
      component.closeExportModal();

      // Open again - should reset to true
      component.onExport();
      expect(component.includeNotes()).toBe(true);
    });
  });
});
