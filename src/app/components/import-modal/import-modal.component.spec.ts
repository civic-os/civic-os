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
import { ImportModalComponent } from './import-modal.component';
import { ImportExportService } from '../../services/import-export.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import {
  SchemaEntityTable,
  SchemaEntityProperty,
  EntityPropertyType,
  ValidationErrorSummary
} from '../../interfaces/entity';

describe('ImportModalComponent', () => {
  let component: ImportModalComponent;
  let fixture: ComponentFixture<ImportModalComponent>;
  let mockImportExportService: jasmine.SpyObj<ImportExportService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockDataService: jasmine.SpyObj<DataService>;

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
      column_name: 'status_id',
      display_name: 'Status',
      type: EntityPropertyType.ForeignKeyName,
      join_table: 'statuses',
      join_column: 'id'
    })
  ];

  beforeEach(async () => {
    mockImportExportService = jasmine.createSpyObj('ImportExportService', [
      'validateFileSize',
      'parseExcelFile',
      'fetchForeignKeyLookups',
      'downloadTemplate',
      'downloadErrorReport'
    ]);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getPropsForCreate']);
    mockDataService = jasmine.createSpyObj('DataService', ['bulkInsert']);

    await TestBed.configureTestingModule({
      imports: [ImportModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ImportExportService, useValue: mockImportExportService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ImportModalComponent);
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

    it('should initialize with choose step', () => {
      expect(component.currentStep()).toBe('choose');
    });

    it('should initialize signals with default values', () => {
      expect(component.selectedFile()).toBeNull();
      expect(component.validationProgress()).toBe(0);
      expect(component.uploadProgress()).toBe(0);
      expect(component.errorMessage()).toBeNull();
      expect(component.errorSummary()).toBeNull();
      expect(component.validRowCount()).toBe(0);
      expect(component.importedCount()).toBe(0);
    });
  });

  describe('Computed Signals', () => {
    it('should compute hasErrors as false when no error summary', () => {
      expect(component.hasErrors()).toBe(false);
    });

    it('should compute hasErrors as true when errors exist', () => {
      const errorSummary: ValidationErrorSummary = {
        totalErrors: 5,
        errorsByType: new Map([['Required', 5]]),
        errorsByColumn: new Map([['Title', 5]]),
        firstNErrors: [],
        allErrors: []
      };
      component.errorSummary.set(errorSummary);

      expect(component.hasErrors()).toBe(true);
    });

    it('should compute hasErrors as false when totalErrors is 0', () => {
      const errorSummary: ValidationErrorSummary = {
        totalErrors: 0,
        errorsByType: new Map(),
        errorsByColumn: new Map(),
        firstNErrors: [],
        allErrors: []
      };
      component.errorSummary.set(errorSummary);

      expect(component.hasErrors()).toBe(false);
    });

    it('should compute canProceedToImport as true when valid rows and no errors', () => {
      component.validRowCount.set(10);
      component.errorSummary.set({
        totalErrors: 0,
        errorsByType: new Map(),
        errorsByColumn: new Map(),
        firstNErrors: [],
        allErrors: []
      });

      expect(component.canProceedToImport()).toBe(true);
    });

    it('should compute canProceedToImport as false when no valid rows', () => {
      component.validRowCount.set(0);
      component.errorSummary.set({
        totalErrors: 0,
        errorsByType: new Map(),
        errorsByColumn: new Map(),
        firstNErrors: [],
        allErrors: []
      });

      expect(component.canProceedToImport()).toBe(false);
    });

    it('should compute canProceedToImport as false when errors exist', () => {
      component.validRowCount.set(10);
      component.errorSummary.set({
        totalErrors: 5,
        errorsByType: new Map([['Required', 5]]),
        errorsByColumn: new Map([['Title', 5]]),
        firstNErrors: [],
        allErrors: []
      });

      expect(component.canProceedToImport()).toBe(false);
    });
  });

  describe('File Selection', () => {
    it('should handle file selection from input', () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const event = {
        target: {
          files: [file]
        }
      } as any;

      mockImportExportService.validateFileSize.and.returnValue({ valid: true });
      mockImportExportService.parseExcelFile.and.returnValue(Promise.resolve({
        success: true,
        data: [{ Title: 'Test' }]
      }));
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProperties));
      mockImportExportService.fetchForeignKeyLookups.and.returnValue(of(new Map()));

      component.onFileSelected(event);

      expect(component.selectedFile()).toBe(file);
    });

    it('should handle file drop', () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const event = {
        preventDefault: jasmine.createSpy('preventDefault'),
        dataTransfer: {
          files: [file]
        }
      } as any;

      mockImportExportService.validateFileSize.and.returnValue({ valid: true });
      mockImportExportService.parseExcelFile.and.returnValue(Promise.resolve({
        success: true,
        data: [{ Title: 'Test' }]
      }));
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProperties));
      mockImportExportService.fetchForeignKeyLookups.and.returnValue(of(new Map()));

      component.onFileDrop(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(component.selectedFile()).toBe(file);
    });

    it('should prevent default on drag over', () => {
      const event = {
        preventDefault: jasmine.createSpy('preventDefault')
      } as any;

      component.onDragOver(event);

      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe('File Validation', () => {
    it('should reject files that are too large', async () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      Object.defineProperty(file, 'size', { value: 15 * 1024 * 1024 }); // 15MB

      mockImportExportService.validateFileSize.and.returnValue({
        valid: false,
        error: 'File too large (15.0MB). Maximum is 10MB.'
      });

      await (component as any).handleFile(file);

      expect(component.errorMessage()).toContain('File too large');
      expect(component.currentStep()).toBe('choose');
    });

    it('should handle Excel parse errors', async () => {
      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      mockImportExportService.validateFileSize.and.returnValue({ valid: true });
      mockImportExportService.parseExcelFile.and.returnValue(Promise.resolve({
        success: false,
        error: 'Failed to parse file'
      }));

      await (component as any).handleFile(file);

      expect(component.errorMessage()).toBe('Failed to parse file');
    });

    it('should reset state when handling new file', async () => {
      // Set some initial state
      component.errorMessage.set('Previous error');
      component.errorSummary.set({
        totalErrors: 5,
        errorsByType: new Map(),
        errorsByColumn: new Map(),
        firstNErrors: [],
        allErrors: []
      });
      component.validRowCount.set(10);

      const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      mockImportExportService.validateFileSize.and.returnValue({ valid: true });
      mockImportExportService.parseExcelFile.and.returnValue(Promise.resolve({
        success: true,
        data: [{ Title: 'Test' }]
      }));
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProperties));
      mockImportExportService.fetchForeignKeyLookups.and.returnValue(of(new Map()));

      await (component as any).handleFile(file);

      expect(component.errorMessage()).toBeNull();
      expect(component.errorSummary()).toBeNull();
      expect(component.validRowCount()).toBe(0);
    });
  });

  describe('Template Download', () => {
    it('should download template successfully', async () => {
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProperties));
      mockImportExportService.downloadTemplate.and.returnValue(Promise.resolve());

      await component.downloadTemplate();

      expect(mockSchemaService.getPropsForCreate).toHaveBeenCalledWith(mockEntity);
      expect(mockImportExportService.downloadTemplate).toHaveBeenCalledWith(mockEntity, mockProperties);
      expect(component.errorMessage()).toBeNull();
    });

    it('should handle template download errors', async () => {
      mockSchemaService.getPropsForCreate.and.returnValue(of(mockProperties));
      mockImportExportService.downloadTemplate.and.returnValue(Promise.reject(new Error('Download failed')));

      await component.downloadTemplate();

      expect(component.errorMessage()).toContain('Template download failed');
      expect(component.errorMessage()).toContain('Download failed');
    });

    it('should handle missing properties error', async () => {
      mockSchemaService.getPropsForCreate.and.returnValue(throwError(() => new Error('Failed to fetch properties')));

      await component.downloadTemplate();

      expect(component.errorMessage()).toContain('Failed to fetch properties');
    });
  });

  describe('Error Report Download', () => {
    it('should download error report', () => {
      const originalData = [{ Title: 'Test' }];
      const errorSummary: ValidationErrorSummary = {
        totalErrors: 1,
        errorsByType: new Map([['Required', 1]]),
        errorsByColumn: new Map([['Title', 1]]),
        firstNErrors: [],
        allErrors: [
          { row: 3, column: 'Title', value: '', error: 'Required field', errorType: 'Required' }
        ]
      };

      (component as any).originalExcelData = originalData;
      component.errorSummary.set(errorSummary);

      component.downloadErrorReport();

      expect(mockImportExportService.downloadErrorReport).toHaveBeenCalledWith(originalData, errorSummary);
    });

    it('should not download when no error summary', () => {
      component.errorSummary.set(null);

      component.downloadErrorReport();

      expect(mockImportExportService.downloadErrorReport).not.toHaveBeenCalled();
    });
  });

  describe('Import Process', () => {
    it('should not proceed with import when no validated data', async () => {
      (component as any).validatedData = [];

      await component.proceedWithImport();

      expect(mockDataService.bulkInsert).not.toHaveBeenCalled();
    });

    it('should not proceed with import when no entityKey', async () => {
      (component as any).validatedData = [{ title: 'Test' }];
      component.entityKey = undefined;

      await component.proceedWithImport();

      expect(mockDataService.bulkInsert).not.toHaveBeenCalled();
    });

    it('should proceed with import and handle success', async () => {
      (component as any).validatedData = [{ title: 'Test' }, { title: 'Test 2' }];

      mockDataService.bulkInsert.and.returnValue(of({
        success: true,
        progress: undefined,
        error: undefined
      }));

      await component.proceedWithImport();

      expect(component.currentStep()).toBe('success');
      expect(component.importedCount()).toBe(2);
      expect(mockDataService.bulkInsert).toHaveBeenCalledWith('issues', [{ title: 'Test' }, { title: 'Test 2' }]);
    });

    it('should handle import error', async () => {
      (component as any).validatedData = [{ title: 'Test' }];

      mockDataService.bulkInsert.and.returnValue(of({
        success: false,
        progress: undefined,
        error: { message: 'Insert failed', humanMessage: 'Insert failed', code: '23505', httpCode: 409 }
      }));

      await component.proceedWithImport();

      expect(component.errorMessage()).toBe('Insert failed');
      expect(component.currentStep()).toBe('results');
    });

    it('should handle progress updates', async () => {
      (component as any).validatedData = [{ title: 'Test' }];

      mockDataService.bulkInsert.and.returnValue(of({
        success: false,
        progress: 50,
        error: undefined
      } as any));

      await component.proceedWithImport();

      expect(component.uploadProgress()).toBe(50);
    });
  });

  describe('Modal Actions', () => {
    it('should emit close event when closing modal', () => {
      spyOn(component.close, 'emit');

      component.closeModal();

      expect(component.close.emit).toHaveBeenCalled();
    });

    it('should emit importSuccess and close on complete', () => {
      spyOn(component.importSuccess, 'emit');
      spyOn(component.close, 'emit');

      component.importedCount.set(25);

      component.completeImport();

      expect(component.importSuccess.emit).toHaveBeenCalledWith(25);
      expect(component.close.emit).toHaveBeenCalled();
    });

    it('should reset state when starting over', () => {
      // Set some state
      component.currentStep.set('results');
      component.selectedFile.set(new File(['test'], 'test.xlsx'));
      component.errorMessage.set('Error');
      component.errorSummary.set({
        totalErrors: 5,
        errorsByType: new Map(),
        errorsByColumn: new Map(),
        firstNErrors: [],
        allErrors: []
      });
      component.validRowCount.set(10);
      (component as any).validatedData = [{ title: 'Test' }];
      (component as any).originalExcelData = [{ Title: 'Test' }];

      component.startOver();

      expect(component.currentStep()).toBe('choose');
      expect(component.selectedFile()).toBeNull();
      expect(component.errorMessage()).toBeNull();
      expect(component.errorSummary()).toBeNull();
      expect(component.validRowCount()).toBe(0);
      expect((component as any).validatedData).toEqual([]);
      expect((component as any).originalExcelData).toEqual([]);
    });
  });

  describe('Lifecycle', () => {
    it('should terminate worker on destroy', () => {
      const mockWorker = {
        terminate: jasmine.createSpy('terminate')
      };
      (component as any).worker = mockWorker;

      component.ngOnDestroy();

      expect(mockWorker.terminate).toHaveBeenCalled();
      expect((component as any).worker).toBeNull();
    });

    it('should not throw when terminating null worker', () => {
      (component as any).worker = null;

      expect(() => component.ngOnDestroy()).not.toThrow();
    });
  });

  describe('Worker Communication (Unit-level)', () => {
    it('should send cancel message to worker', () => {
      const mockWorker = {
        postMessage: jasmine.createSpy('postMessage'),
        terminate: jasmine.createSpy('terminate')
      };
      (component as any).worker = mockWorker;

      component.cancelValidation();

      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
    });

    it('should not throw when canceling with no worker', () => {
      (component as any).worker = null;

      expect(() => component.cancelValidation()).not.toThrow();
    });

    it('should handle worker progress message', () => {
      const message = {
        data: {
          type: 'progress',
          progress: {
            currentRow: 50,
            totalRows: 100,
            percentage: 50,
            stage: 'validating'
          }
        }
      };

      (component as any).handleWorkerMessage(message);

      expect(component.validationProgress()).toBe(50);
    });

    it('should handle worker complete message', () => {
      const mockWorker = {
        terminate: jasmine.createSpy('terminate')
      };
      (component as any).worker = mockWorker;

      const message = {
        data: {
          type: 'complete',
          results: {
            validRows: [{ title: 'Test 1' }, { title: 'Test 2' }],
            errorSummary: {
              totalErrors: 0,
              errorsByType: new Map(),
              errorsByColumn: new Map(),
              firstNErrors: [],
              allErrors: []
            }
          }
        }
      };

      (component as any).handleWorkerMessage(message);

      expect((component as any).validatedData).toEqual([{ title: 'Test 1' }, { title: 'Test 2' }]);
      expect(component.validRowCount()).toBe(2);
      expect(component.currentStep()).toBe('results');
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('should handle worker cancelled message', () => {
      const mockWorker = {
        terminate: jasmine.createSpy('terminate')
      };
      (component as any).worker = mockWorker;

      const message = {
        data: {
          type: 'cancelled'
        }
      };

      (component as any).handleWorkerMessage(message);

      expect(component.currentStep()).toBe('choose');
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('should handle worker error message', () => {
      const mockWorker = {
        terminate: jasmine.createSpy('terminate')
      };
      (component as any).worker = mockWorker;

      const message = {
        data: {
          type: 'error',
          error: 'Validation failed'
        }
      };

      (component as any).handleWorkerMessage(message);

      expect(component.errorMessage()).toBe('Validation failed');
      expect(component.currentStep()).toBe('choose');
      expect(mockWorker.terminate).toHaveBeenCalled();
    });
  });

  describe('Lookup Serialization', () => {
    it('should serialize FK lookups for worker transfer', () => {
      const fkLookups = new Map([
        ['statuses', {
          displayNameToIds: new Map([
            ['open', [1]],
            ['closed', [2]]
          ]),
          validIds: new Set([1, 2]),
          idsToDisplayName: new Map([
            [1, 'Open'],
            [2, 'Closed']
          ])
        }]
      ]);

      const serialized = (component as any).serializeLookups(fkLookups);

      expect(serialized.statuses).toBeDefined();
      expect(serialized.statuses.displayNameToIds).toEqual({ 'open': [1], 'closed': [2] });
      expect(serialized.statuses.validIds).toEqual([1, 2]);
      expect(serialized.statuses.idsToDisplayName).toEqual({ 1: 'Open', 2: 'Closed' });
    });

    it('should handle empty FK lookups', () => {
      const fkLookups = new Map();

      const serialized = (component as any).serializeLookups(fkLookups);

      expect(serialized).toEqual({});
    });
  });
});
