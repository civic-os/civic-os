import type { Mock } from "vitest";
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
import { SchemaEntityTable, SchemaEntityProperty, EntityPropertyType, ValidationErrorSummary } from '../../interfaces/entity';
import { CustomImportConfig, ImportColumn } from '../../interfaces/import';
import { TranslationService } from '../../services/translation.service';
import { EN_TRANSLATIONS } from '../../i18n/en.translations';
import { readFileSync } from 'node:fs';

describe('ImportModalComponent', () => {
    let component: ImportModalComponent;
    let fixture: ComponentFixture<ImportModalComponent>;
    let mockImportExportService: any;
    let mockSchemaService: any;
    let mockDataService: any;
    let mockTranslationService: any;

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
        mockImportExportService = {
            validateFileSize: vi.fn().mockName("ImportExportService.validateFileSize"),
            parseExcelFile: vi.fn().mockName("ImportExportService.parseExcelFile"),
            fetchForeignKeyLookups: vi.fn().mockName("ImportExportService.fetchForeignKeyLookups"),
            downloadTemplate: vi.fn().mockName("ImportExportService.downloadTemplate"),
            downloadErrorReport: vi.fn().mockName("ImportExportService.downloadErrorReport")
        };
        mockSchemaService = {
            getPropsForCreate: vi.fn().mockName("SchemaService.getPropsForCreate")
        };
        mockDataService = {
            bulkInsert: vi.fn().mockName("DataService.bulkInsert"),
            bulkInsertJunctions: vi.fn().mockName("DataService.bulkInsertJunctions")
        };
        mockTranslationService = {
            get: vi.fn().mockName("TranslationService.get"),
            version: () => 1
        };
        mockTranslationService.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
            (EN_TRANSLATIONS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (m: string, k: string) => params?.[k] !== undefined ? String(params[k]) : m));

        await TestBed.configureTestingModule({
            imports: [ImportModalComponent],
            providers: [
                provideZonelessChangeDetection(),
                { provide: ImportExportService, useValue: mockImportExportService },
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: mockDataService },
                { provide: TranslationService, useValue: mockTranslationService }
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

            mockImportExportService.validateFileSize.mockReturnValue({ valid: true });
            mockImportExportService.parseExcelFile.mockResolvedValue({
                success: true,
                data: [{ Title: 'Test' }]
            });
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProperties));
            mockImportExportService.fetchForeignKeyLookups.mockReturnValue(of(new Map()));

            component.onFileSelected(event);

            expect(component.selectedFile()).toBe(file);
        });

        it('should handle file drop', () => {
            const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const event = {
                preventDefault: vi.fn().mockName('preventDefault'),
                dataTransfer: {
                    files: [file]
                }
            } as any;

            mockImportExportService.validateFileSize.mockReturnValue({ valid: true });
            mockImportExportService.parseExcelFile.mockResolvedValue({
                success: true,
                data: [{ Title: 'Test' }]
            });
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProperties));
            mockImportExportService.fetchForeignKeyLookups.mockReturnValue(of(new Map()));

            component.onFileDrop(event);

            expect(event.preventDefault).toHaveBeenCalled();
            expect(component.selectedFile()).toBe(file);
        });

        it('should prevent default on drag over', () => {
            const event = {
                preventDefault: vi.fn().mockName('preventDefault')
            } as any;

            component.onDragOver(event);

            expect(event.preventDefault).toHaveBeenCalled();
        });
    });

    describe('File Validation', () => {
        it('should reject files that are too large', async () => {
            const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            Object.defineProperty(file, 'size', { value: 15 * 1024 * 1024 }); // 15MB

            mockImportExportService.validateFileSize.mockReturnValue({
                valid: false,
                errorKey: 'import_modal.error_file_too_large_size',
                errorParams: { size: '15.0', max: 10 }
            });

            await (component as any).handleFile(file);

            expect(component.errorMessage()).toBe('File too large (15.0MB). Maximum size is 10MB. Please split your data into smaller batches.');
            expect(component.currentStep()).toBe('choose');
        });

        it('should handle Excel parse errors', async () => {
            const file = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            mockImportExportService.validateFileSize.mockReturnValue({ valid: true });
            mockImportExportService.parseExcelFile.mockResolvedValue({
                success: false,
                error: 'Failed to parse file'
            });

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

            mockImportExportService.validateFileSize.mockReturnValue({ valid: true });
            mockImportExportService.parseExcelFile.mockResolvedValue({
                success: true,
                data: [{ Title: 'Test' }]
            });
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProperties));
            mockImportExportService.fetchForeignKeyLookups.mockReturnValue(of(new Map()));

            await (component as any).handleFile(file);

            expect(component.errorMessage()).toBeNull();
            expect(component.errorSummary()).toBeNull();
            expect(component.validRowCount()).toBe(0);
        });
    });

    describe('Template Download', () => {
        it('should download template successfully', async () => {
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProperties));
            mockImportExportService.downloadTemplate.mockResolvedValue();

            await component.downloadTemplate();

            expect(mockSchemaService.getPropsForCreate).toHaveBeenCalledWith(mockEntity);
            expect(mockImportExportService.downloadTemplate).toHaveBeenCalledWith(mockEntity, mockProperties);
            expect(component.errorMessage()).toBeNull();
        });

        it('should handle template download errors', async () => {
            mockSchemaService.getPropsForCreate.mockReturnValue(of(mockProperties));
            mockImportExportService.downloadTemplate.mockRejectedValue(new Error('Download failed'));

            await component.downloadTemplate();

            expect(component.errorMessage()).toContain('Template download failed');
            expect(component.errorMessage()).toContain('Download failed');
        });

        it('should handle missing properties error', async () => {
            mockSchemaService.getPropsForCreate.mockReturnValue(throwError(() => new Error('Failed to fetch properties')));

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

            mockDataService.bulkInsert.mockReturnValue(of({
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

            mockDataService.bulkInsert.mockReturnValue(of({
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

            mockDataService.bulkInsert.mockReturnValue(of({
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
            vi.spyOn(component.close, 'emit').mockReturnValue(undefined);

            component.closeModal();

            expect(component.close.emit).toHaveBeenCalled();
        });

        it('should emit importSuccess and close on complete', () => {
            vi.spyOn(component.importSuccess, 'emit').mockReturnValue(undefined);
            vi.spyOn(component.close, 'emit').mockReturnValue(undefined);

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
                terminate: vi.fn().mockName('terminate')
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
                postMessage: vi.fn().mockName('postMessage'),
                terminate: vi.fn().mockName('terminate')
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
                terminate: vi.fn().mockName('terminate')
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

        describe('worker error messages (issue #170)', () => {
            const complete = (allErrors: any[]) => ({
                data: {
                    type: 'complete',
                    results: {
                        validRows: [],
                        errorSummary: { totalErrors: allErrors.length, errorsByColumn: new Map(), allErrors }
                    }
                }
            });

            it('should translate keyed worker errors with their parameters and group by translated type', () => {
                (component as any).handleWorkerMessage(complete([
                    { row: 3, column: 'Title', value: 'ab', errorKey: 'import_validation.err_min_length', errorParams: { n: 5 }, errorTypeKey: 'import_validation.type_text_length' },
                    { row: 4, column: 'Title', value: 'a', errorKey: 'import_validation.err_min_length', errorParams: { n: 5 }, errorTypeKey: 'import_validation.type_text_length' },
                    { row: 5, column: 'Client', value: 'zed', errorKey: 'import_validation.err_fk_not_found', errorParams: { value: 'zed', column: 'Client' }, errorTypeKey: 'import_validation.type_fk_not_found', errorTypeParams: { column: 'Client' } }
                ]));

                const summary = component.errorSummary()!;
                expect(summary.allErrors[0].error).toBe('Must be at least 5 characters');
                expect(summary.allErrors[0].errorType).toBe('Text length error');
                expect(summary.allErrors[2].error).toBe('"zed" not found in Client');
                expect(summary.allErrors[2].errorType).toBe('Client not found');
                expect(summary.errorsByType.get('Text length error')).toBe(2);
                expect(summary.errorsByType.get('Client not found')).toBe(1);
                expect(summary.errorsByColumn.get('Title')).toBe(2);
                expect(summary.firstNErrors).toHaveLength(3);
                expect(summary.totalErrors).toBe(3);
            });

            it('should render a worker error in the active locale', () => {
                const german: Record<string, string> = {
                    'import_validation.err_min_length': 'Muss mindestens {{n}} Zeichen lang sein',
                    'import_validation.type_text_length': 'Fehler bei der Textlänge'
                };
                mockTranslationService.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
                    (german[key] ?? key).replace(/\{\{(\w+)\}\}/g, (m: string, k: string) => params?.[k] !== undefined ? String(params[k]) : m));

                (component as any).handleWorkerMessage(complete([
                    { row: 3, column: 'Title', value: 'ab', errorKey: 'import_validation.err_min_length', errorParams: { n: 5 }, errorTypeKey: 'import_validation.type_text_length' }
                ]));
                fixture.detectChanges();

                const html = (fixture.nativeElement as HTMLElement).textContent!;
                expect(html).toContain('Muss mindestens 5 Zeichen lang sein');
                expect(html).not.toContain('Must be at least');
                expect(component.errorSummary()!.errorsByType.get('Fehler bei der Textlänge')).toBe(1);
            });

            it('should show a validation rule message verbatim without translating it', () => {
                mockTranslationService.get.mockClear();

                (component as any).handleWorkerMessage(complete([
                    { row: 3, column: 'Title', value: 'ab', error: 'Titles need five letters', errorTypeKey: 'import_validation.type_text_length' }
                ]));

                expect(component.errorSummary()!.allErrors[0].error).toBe('Titles need five letters');
                const keys = mockTranslationService.get.mock.calls.map((c: any[]) => c[0]);
                expect(keys).toEqual(['import_validation.type_text_length']);
            });

            it('should carry the error type of an Error thrown in the worker as a translated key', () => {
                (component as any).handleWorkerMessage(complete([
                    { row: 3, column: 'Slot', value: 'x - y', error: 'boom', errorTypeKey: 'import_validation.type_timeslot_error' }
                ]));

                const [err] = component.errorSummary()!.allErrors;
                expect(err.error).toBe('boom');
                expect(err.errorType).toBe('TimeSlot error');
            });

            it('should keep every key the worker can emit in the bundled English strings', () => {
                const src = readFileSync('src/app/workers/import-validation.worker.ts', 'utf8');
                const used = [...src.matchAll(/(?:msg|typeMsg|ruleMsg|thrownMsg)\((?:[^,()]+, )?'((?:err|type)_\w+)'/g)].map(m => 'import_validation.' + m[1]);
                expect(used.length).toBeGreaterThan(40);
                for (const key of used) {
                    expect(EN_TRANSLATIONS[key], key).toBeTruthy();
                }
            });
        });

        it('should handle worker cancelled message', () => {
            const mockWorker = {
                terminate: vi.fn().mockName('terminate')
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
                terminate: vi.fn().mockName('terminate')
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

    // =========================================================================
    // Custom Import Mode Tests
    // =========================================================================

    describe('Custom Import Mode', () => {
        const mockColumns: ImportColumn[] = [
            { name: 'Email', key: 'email', required: true, type: 'email' },
            { name: 'First Name', key: 'first_name', required: true, type: 'text' },
            { name: 'Last Name', key: 'last_name', required: true, type: 'text' },
            { name: 'Phone', key: 'phone', required: false, type: 'phone' },
            { name: 'Roles', key: 'roles', required: false, type: 'comma-list' },
            { name: 'Send Welcome Email', key: 'send_welcome_email', required: false, type: 'boolean' },
            { name: 'Send Welcome SMS', key: 'send_welcome_sms', required: false, type: 'boolean' }
        ];

        let mockCustomImport: CustomImportConfig;

        beforeEach(() => {
            mockCustomImport = {
                title: 'Import Users',
                columns: mockColumns,
                submit: vi.fn().mockName('submit').mockReturnValue(of({
                    success: true, importedCount: 2, errorCount: 0, errors: []
                })),
                generateTemplate: vi.fn().mockName('generateTemplate')
            };
            component.customImport = mockCustomImport;
        });

        describe('Inline Validation', () => {
            it('should validate required fields and report missing values', () => {
                const data = [{ 'Email': '', 'First Name': '', 'Last Name': 'Doe' }];
                (component as any).runCustomValidation(data);

                const summary = component.errorSummary();
                expect(summary).toBeTruthy();
                expect(summary!.totalErrors).toBe(2); // Email + First Name
            });

            it('should validate email format and report invalid emails', () => {
                const data = [{ 'Email': 'not-an-email', 'First Name': 'Jane', 'Last Name': 'Doe' }];
                (component as any).runCustomValidation(data);

                const summary = component.errorSummary();
                expect(summary!.totalErrors).toBe(1);
                expect(summary!.firstNErrors[0].error).toContain('email');
            });

            it('should accept valid email format', () => {
                const data = [{ 'Email': 'jane@example.com', 'First Name': 'Jane', 'Last Name': 'Doe' }];
                (component as any).runCustomValidation(data);

                expect(component.validRowCount()).toBe(1);
                expect((component as any).validatedData[0].email).toBe('jane@example.com');
            });

            it('should validate phone format (strip non-digits, check 10 digits)', () => {
                const data = [
                    { 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B', 'Phone': '12345' }
                ];
                (component as any).runCustomValidation(data);

                expect(component.errorSummary()!.totalErrors).toBe(1);
                expect(component.errorSummary()!.firstNErrors[0].error).toContain('10 digits');
            });

            it('should accept phone with formatting like (555) 123-4567', () => {
                const data = [
                    { 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B', 'Phone': '(555) 123-4567' }
                ];
                (component as any).runCustomValidation(data);

                expect(component.validRowCount()).toBe(1);
                expect((component as any).validatedData[0].phone).toBe('5551234567');
            });

            it('should validate boolean values (true/false/yes/no/1/0)', () => {
                const data = [
                    { 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B', 'Send Welcome Email': 'maybe' }
                ];
                (component as any).runCustomValidation(data);

                expect(component.errorSummary()!.totalErrors).toBe(1);
            });

            it('should map boolean edge cases: TRUE, Yes, 1, y', () => {
                const testCases = ['TRUE', 'Yes', '1', 'y'];
                for (const val of testCases) {
                    const data = [{ 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B', 'Send Welcome Email': val }];
                    (component as any).runCustomValidation(data);
                    expect((component as any).validatedData[0].send_welcome_email, `Expected ${val} to map to true`).toBe(true);
                }
            });

            it('should map boolean false cases: FALSE, No, 0, n', () => {
                const testCases = ['FALSE', 'No', '0', 'n'];
                for (const val of testCases) {
                    const data = [{ 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B', 'Send Welcome Email': val }];
                    (component as any).runCustomValidation(data);
                    expect((component as any).validatedData[0].send_welcome_email, `Expected ${val} to map to false`).toBe(false);
                }
            });

            it('should parse comma-list into string arrays', () => {
                const data = [
                    { 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B', 'Roles': 'user,editor' }
                ];
                (component as any).runCustomValidation(data);

                expect((component as any).validatedData[0].roles).toEqual(['user', 'editor']);
            });

            it('should trim whitespace from comma-list items', () => {
                const data = [
                    { 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B', 'Roles': 'user , editor , admin' }
                ];
                (component as any).runCustomValidation(data);

                expect((component as any).validatedData[0].roles).toEqual(['user', 'editor', 'admin']);
            });

            it('should set null for empty optional fields', () => {
                const data = [
                    { 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B' }
                ];
                (component as any).runCustomValidation(data);

                expect((component as any).validatedData[0].phone).toBeNull();
                expect((component as any).validatedData[0].roles).toBeNull();
                expect((component as any).validatedData[0].send_welcome_email).toBeNull();
            });

            it('should transition to results step after validation', () => {
                const data = [{ 'Email': 'a@test.com', 'First Name': 'A', 'Last Name': 'B' }];
                (component as any).runCustomValidation(data);

                expect(component.currentStep()).toBe('results');
            });

            it('should build ValidationErrorSummary with correct totals', () => {
                const data = [
                    { 'Email': 'bad', 'First Name': '', 'Last Name': 'Doe' },
                    { 'Email': '', 'First Name': 'Jane', 'Last Name': '' }
                ];
                (component as any).runCustomValidation(data);

                const summary = component.errorSummary()!;
                expect(summary.totalErrors).toBe(4);
                expect(summary.errorsByType.get('Required')).toBe(3);
                expect(summary.errorsByType.get('Invalid format')).toBe(1);
            });

            it('should handle empty file (no data rows)', () => {
                (component as any).runCustomValidation([]);

                expect(component.validRowCount()).toBe(0);
                expect(component.currentStep()).toBe('results');
            });
        });

        describe('Custom Template', () => {
            it('should call customImport.generateTemplate when customImport is set', async () => {
                await component.downloadTemplate();

                expect(mockCustomImport.generateTemplate).toHaveBeenCalled();
            });

            it('should not call schemaService when customImport is set', async () => {
                await component.downloadTemplate();

                expect(mockSchemaService.getPropsForCreate).not.toHaveBeenCalled();
            });
        });

        describe('Custom Submit', () => {
            it('should call customImport.submit with validated data', async () => {
                (component as any).validatedData = [{ email: 'a@test.com', first_name: 'A', last_name: 'B' }];

                await component.proceedWithImport();

                expect(mockCustomImport.submit).toHaveBeenCalledWith([
                    { email: 'a@test.com', first_name: 'A', last_name: 'B' }
                ]);
            });

            it('should handle full success result (go to success step)', async () => {
                (component as any).validatedData = [{ email: 'a@test.com' }];

                await component.proceedWithImport();

                expect(component.currentStep()).toBe('success');
                expect(component.importedCount()).toBe(2);
            });

            it('should handle full failure result (show error on results step)', async () => {
                (mockCustomImport.submit as Mock).mockReturnValue(of({
                    success: false, importedCount: 0, errorCount: 2,
                    errors: [
                        { index: 1, identifier: 'a@test.com', error: 'Duplicate email' },
                        { index: 2, identifier: 'b@test.com', error: 'Invalid role' }
                    ]
                }));
                (component as any).validatedData = [{ email: 'a@test.com' }];

                await component.proceedWithImport();

                expect(component.currentStep()).toBe('results');
                expect(component.errorMessage()).toContain('all 2 rows');
            });

            it('should handle partial success (set partialSuccessCount, show error table)', async () => {
                (mockCustomImport.submit as Mock).mockReturnValue(of({
                    success: false, importedCount: 1, errorCount: 1,
                    errors: [{ index: 2, identifier: 'b@test.com', error: 'Duplicate email' }]
                }));
                (component as any).validatedData = [{ email: 'a@test.com' }, { email: 'b@test.com' }];

                await component.proceedWithImport();

                expect(component.currentStep()).toBe('results');
                expect(component.partialSuccessCount()).toBe(1);
                expect(component.errorSummary()!.totalErrors).toBe(1);
            });

            it('should not call dataService.bulkInsert in custom mode', async () => {
                (component as any).validatedData = [{ email: 'a@test.com' }];

                await component.proceedWithImport();

                expect(mockDataService.bulkInsert).not.toHaveBeenCalled();
            });
        });

        describe('Entity input optional', () => {
            it('should work without entity when customImport is provided', () => {
                component.entity = undefined;

                expect(component).toBeTruthy();
                expect(component.currentStep()).toBe('choose');
            });
        });

        describe('Start Over', () => {
            it('should reset partialSuccessCount on startOver', () => {
                component.partialSuccessCount.set(5);

                component.startOver();

                expect(component.partialSuccessCount()).toBe(0);
            });

            it('should reset M:M state on startOver', () => {
                (component as any).m2mDataList = [{ col: [1, 2] }];
                (component as any).m2mProperties = [{ column_name: 'col' }];

                component.startOver();

                expect((component as any).m2mDataList).toEqual([]);
                expect((component as any).m2mProperties).toEqual([]);
            });
        });
    });

    describe('M:M Two-Phase Import', () => {
        const m2mMeta = {
            junctionTable: 'partner_service_categories',
            sourceTable: 'partners',
            targetTable: 'service_categories',
            sourceColumn: 'partner_id',
            targetColumn: 'service_category_id',
            relatedTable: 'service_categories',
            relatedTableDisplayName: 'Service Categories',
            showOnSource: true,
            showOnTarget: true,
            displayOrder: 100,
            relatedTableHasColor: false,
            extraColumns: []
        };

        it('should handle worker output with M:M data', () => {
            const message = {
                data: {
                    type: 'complete',
                    results: {
                        validRows: [
                            { rowData: { display_name: 'Test' }, m2mData: { service_categories: [1, 2] } },
                            { rowData: { display_name: 'Test2' }, m2mData: { service_categories: [] } }
                        ],
                        errorSummary: { totalErrors: 0, errorsByType: new Map(), errorsByColumn: new Map(), firstNErrors: [], allErrors: [] },
                        hasM2m: true,
                        m2mProperties: [{ column_name: 'service_categories', many_to_many_meta: m2mMeta }]
                    }
                }
            };

            (component as any).handleWorkerMessage(message);

            expect((component as any).validatedData).toEqual([
                { display_name: 'Test' },
                { display_name: 'Test2' }
            ]);
            expect((component as any).m2mDataList).toEqual([
                { service_categories: [1, 2] },
                { service_categories: [] }
            ]);
            expect((component as any).m2mProperties.length).toBe(1);
            expect(component.validRowCount()).toBe(2);
        });

        it('should handle worker output without M:M (backward compat)', () => {
            const message = {
                data: {
                    type: 'complete',
                    results: {
                        validRows: [{ display_name: 'Test' }],
                        errorSummary: { totalErrors: 0, errorsByType: new Map(), errorsByColumn: new Map(), firstNErrors: [], allErrors: [] },
                        hasM2m: false,
                        m2mProperties: []
                    }
                }
            };

            (component as any).handleWorkerMessage(message);

            expect((component as any).validatedData).toEqual([{ display_name: 'Test' }]);
            expect((component as any).m2mDataList).toEqual([]);
        });

        it('should call bulkInsertJunctions after Phase 1 success with M:M data', () => {
            (component as any).validatedData = [{ display_name: 'Test' }];
            (component as any).m2mDataList = [{ service_categories: [1, 3] }];
            (component as any).m2mProperties = [{ column_name: 'service_categories', many_to_many_meta: m2mMeta }];

            mockDataService.bulkInsertJunctions.mockReturnValue(of({ success: true, body: null }));

            const insertedRows = [{ id: 42, display_name: 'Test' }];
            (component as any).insertM2mJunctions(insertedRows);

            expect(mockDataService.bulkInsertJunctions).toHaveBeenCalledWith('partner_service_categories', [
                { partner_id: 42, service_category_id: 1 },
                { partner_id: 42, service_category_id: 3 }
            ]);
            expect(component.currentStep()).toBe('success');
        });

        it('should skip Phase 2 when no M:M data has values', () => {
            (component as any).validatedData = [{ display_name: 'Test' }];
            (component as any).m2mDataList = [{ service_categories: [] }];
            (component as any).m2mProperties = [{ column_name: 'service_categories', many_to_many_meta: m2mMeta }];

            const insertedRows = [{ id: 42, display_name: 'Test' }];
            (component as any).insertM2mJunctions(insertedRows);

            expect(mockDataService.bulkInsertJunctions).not.toHaveBeenCalled();
            expect(component.currentStep()).toBe('success');
        });

        it('should show partial success when Phase 2 fails', () => {
            (component as any).validatedData = [{ display_name: 'Test' }];
            (component as any).m2mDataList = [{ service_categories: [1] }];
            (component as any).m2mProperties = [{ column_name: 'service_categories', many_to_many_meta: m2mMeta }];

            mockDataService.bulkInsertJunctions.mockReturnValue(of({
                success: false,
                error: { httpCode: 409, message: 'duplicate key', humanMessage: 'Duplicate record' }
            }));

            const insertedRows = [{ id: 42, display_name: 'Test' }];
            (component as any).insertM2mJunctions(insertedRows);

            // Should still show success (main rows imported), with error message about M:M
            expect(component.currentStep()).toBe('success');
            expect(component.importedCount()).toBe(1);
            expect(component.errorMessage()).toContain('relationship associations failed');
        });
    });
    describe('Translated strings (issue #103)', () => {
        const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
        const customImport = (itemLabel?: string): CustomImportConfig => ({
            title: 'Import Users',
            columns: [],
            itemLabel,
            submit: vi.fn().mockName('submit'),
            generateTemplate: vi.fn().mockName('generateTemplate')
        } as unknown as CustomImportConfig);

        it('should only use import_modal keys that exist in the bundled English translations', () => {
            const used = [
                'col_identifier', 'rows_one', 'rows_other', 'partial_success_one', 'partial_success_other',
                'partial_failed', 'confirm_import_one', 'confirm_import_other', 'importing_items',
                'success_items_one', 'success_items_other', 'error_file_too_large', 'error_parse_failed',
                'error_unknown', 'error_worker', 'error_validation_failed', 'error_template_failed',
                'error_import_failed', 'error_import_failed_plain', 'error_all_rows_failed',
                'error_associations_partial', 'error_associations_failed', 'err_required', 'err_invalid_email',
                'err_phone_digits', 'err_boolean', 'type_required', 'type_invalid_format', 'type_server_error'
            ];
            for (const k of used) {
                expect(EN_TRANSLATIONS['import_modal.' + k]).toBeTruthy();
            }
        });

        it('should render the confirm message with _other for several rows and _one for a single row', () => {
            component.customImport = customImport('users');
            component.validRowCount.set(3);
            component.currentStep.set('results');
            fixture.detectChanges();
            expect(text()).toContain('This will import 3 users.');
            const keys = mockTranslationService.get.mock.calls.map((c: any[]) => c[0]);
            expect(keys).toContain('import_modal.confirm_import_other');

            component.validRowCount.set(1);
            component.customImport = customImport('user');
            fixture.detectChanges();
            expect(mockTranslationService.get.mock.calls.map((c: any[]) => c[0])).toContain('import_modal.confirm_import_one');
            expect(text()).toContain('This will import 1 user.');
        });

        it('should fall back to a translated row label when the integrator gives no itemLabel', () => {
            component.customImport = customImport();
            expect(component.itemLabelFor(1)).toBe('row');
            expect(component.itemLabelFor(2)).toBe('rows');
        });

        it('should render the success and importing messages from keys', () => {
            component.customImport = customImport('users');
            component.validRowCount.set(2);
            component.importedCount.set(2);
            component.currentStep.set('importing');
            fixture.detectChanges();
            expect(text()).toContain('Importing 2 users...');

            component.currentStep.set('success');
            fixture.detectChanges();
            expect(text()).toContain('Successfully imported 2 users!');
        });

        it('should render the error table headers and partial-success messages from keys', () => {
            component.customImport = customImport('users');
            component.partialSuccessCount.set(1);
            component.errorSummary.set({
                totalErrors: 2,
                errorsByType: new Map(),
                errorsByColumn: new Map(),
                firstNErrors: [{ row: 3, column: 'a@b.c', value: 'a@b.c', error: 'dup', errorType: 'Server error' }],
                allErrors: []
            } as ValidationErrorSummary);
            component.currentStep.set('results');
            fixture.detectChanges();
            const t = text();
            expect(t).toContain('1 user created successfully.');
            expect(t).toContain('2 failed with errors:');
            expect(t).toContain('Row');
            expect(t).toContain('Identifier');
            expect(t).toContain('Error');
        });

        it('should key row-level validation errors and error types', () => {
            component.customImport = {
                ...customImport('users'),
                columns: [
                    { name: 'Email', key: 'email', type: 'email', required: true },
                    { name: 'Name', key: 'name', type: 'text', required: true }
                ]
            } as unknown as CustomImportConfig;
            (component as any).runCustomValidation([{ 'Email': 'nope', 'Name': 'A' }, { 'Email': 'a@b.co', 'Name': '' }]);
            const errors = component.errorSummary()!.allErrors;
            expect(errors[0].error).toBe('Invalid email format');
            expect(errors[0].errorType).toBe('Invalid format');
            expect(errors[1].error).toBe('Name is required');
            expect(errors[1].errorType).toBe('Required');
        });

        it('should pass a thrown error message as the detail parameter', () => {
            expect((component as any).errorDetail(new Error('boom'))).toBe('boom');
            expect((component as any).errorDetail('x')).toBe('Unknown error');
        });
    });
});
