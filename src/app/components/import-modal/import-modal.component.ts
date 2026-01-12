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

import {
  Component,
  Input,
  Output,
  EventEmitter,
  inject,
  signal,
  computed,
  OnDestroy,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SchemaEntityTable, SchemaEntityProperty, ValidationErrorSummary } from '../../interfaces/entity';
import { ImportExportService } from '../../services/import-export.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { CosModalComponent } from '../cos-modal/cos-modal.component';

/**
 * Import workflow steps:
 * - choose: File selection screen (drag-drop or click to browse)
 * - validating: Web Worker processing with progress bar
 * - results: Validation results with error summary and "Proceed" button
 * - importing: Bulk insert to PostgREST with progress bar
 * - success: Import complete with record count
 */
type ImportStep = 'choose' | 'validating' | 'results' | 'importing' | 'success';

/**
 * ImportModalComponent - Multi-step import wizard with Web Worker validation.
 *
 * Architecture:
 * 1. User selects Excel file (drag-drop or file picker)
 * 2. File is parsed with SheetJS (xlsx library)
 * 3. Validation runs in Web Worker (background thread, non-blocking)
 * 4. Results displayed with error summary and grouping
 * 5. User can download error report or proceed with valid rows
 * 6. Bulk insert to PostgREST (all-or-nothing transaction)
 * 7. Success message with record count
 *
 * State Management:
 * - Uses Angular signals for reactive state (OnPush change detection)
 * - currentStep signal controls which UI screen is displayed
 * - Progress signals track validation and upload progress
 * - Error signals display user-friendly messages
 *
 * Worker Communication:
 * - Main thread spawns worker with validation task
 * - Worker sends progress messages (percentage updates)
 * - Worker sends complete message with validated rows and errors
 * - Main thread can send cancel message to terminate early
 *
 * @see src/app/workers/import-validation.worker.ts - Background validation logic
 * @see src/app/services/import-export.service.ts - Excel parsing and FK lookup
 * @see docs/development/IMPORT_EXPORT.md - Complete architecture documentation
 */
@Component({
  selector: 'app-import-modal',
  imports: [CommonModule, CosModalComponent],
  templateUrl: './import-modal.component.html',
  styleUrl: './import-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImportModalComponent implements OnDestroy {
  private importExportService = inject(ImportExportService);
  private schemaService = inject(SchemaService);
  private dataService = inject(DataService);

  @Input({ required: true }) entity!: SchemaEntityTable;
  @Input() entityKey?: string;
  @Output() close = new EventEmitter<void>();
  @Output() importSuccess = new EventEmitter<number>();

  // Modal is always open when component exists (parent conditionally renders)
  public isOpen = signal(true);

  // State signals
  public currentStep = signal<ImportStep>('choose');
  public selectedFile = signal<File | null>(null);
  public validationProgress = signal<number>(0);
  public uploadProgress = signal<number>(0);
  public errorMessage = signal<string | null>(null);
  public errorSummary = signal<ValidationErrorSummary | null>(null);
  public validRowCount = signal<number>(0);
  public importedCount = signal<number>(0);

  // Computed properties
  public hasErrors = computed(() => {
    const summary = this.errorSummary();
    return summary !== null && summary.totalErrors > 0;
  });

  public canProceedToImport = computed(() => {
    return this.validRowCount() > 0 && !this.hasErrors();
  });

  // Worker reference
  private worker: Worker | null = null;
  private validatedData: any[] = [];
  private originalExcelData: any[] = [];

  ngOnDestroy(): void {
    this.terminateWorker();
  }

  /**
   * Handle file selection from file input
   */
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.handleFile(input.files[0]);
    }
  }

  /**
   * Handle file drop
   */
  onFileDrop(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      this.handleFile(event.dataTransfer.files[0]);
    }
  }

  /**
   * Prevent default drag behavior
   */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  /**
   * Handle file validation and parsing
   */
  private async handleFile(file: File): Promise<void> {
    // Reset state
    this.errorMessage.set(null);
    this.errorSummary.set(null);
    this.validRowCount.set(0);

    // Validate file size
    const sizeCheck = this.importExportService.validateFileSize(file);
    if (!sizeCheck.valid) {
      this.errorMessage.set(sizeCheck.error || 'File too large');
      return;
    }

    // Set selected file
    this.selectedFile.set(file);

    // Parse Excel file
    const parseResult = await this.importExportService.parseExcelFile(file);
    if (!parseResult.success || !parseResult.data) {
      this.errorMessage.set(parseResult.error || 'Failed to parse file');
      return;
    }

    this.originalExcelData = parseResult.data;

    // Start validation
    this.startValidation(parseResult.data);
  }

  /**
   * Start validation using Web Worker.
   *
   * This method orchestrates the background validation process:
   * 1. Fetch entity properties (for type info and validation rules)
   * 2. Build FK lookup maps (for hybrid ID/name validation)
   * 3. Serialize lookups (convert Maps/Sets to plain objects for worker transfer)
   * 4. Spawn Web Worker with module type
   * 5. Send validation task message with data + metadata
   * 6. Set up message handlers (progress, complete, error, cancelled)
   *
   * The worker runs in a separate thread, preventing UI blocking during
   * validation of large datasets (1000+ rows).
   *
   * @param data Raw Excel data (array of objects with display_name keys)
   * @throws If property fetch or FK lookup fetch fails
   *
   * @see import-validation.worker.ts - Worker implementation
   * @see serializeLookups() - Converts Maps/Sets for structured clone transfer
   * @see handleWorkerMessage() - Processes worker responses
   */
  private async startValidation(data: any[]): Promise<void> {
    this.currentStep.set('validating');
    this.validationProgress.set(0);

    try {
      // Fetch properties and FK lookups
      const properties = await this.schemaService.getPropsForCreate(this.entity).toPromise();
      if (!properties) {
        throw new Error('Failed to fetch properties');
      }

      const fkLookups = await this.importExportService.fetchForeignKeyLookups(properties).toPromise();
      if (!fkLookups) {
        throw new Error('Failed to fetch FK lookups');
      }

      // Convert Maps/Sets to plain objects for worker transfer
      const serializedLookups = this.serializeLookups(fkLookups);

      // Create and start worker
      this.worker = new Worker(new URL('../../workers/import-validation.worker', import.meta.url), {
        type: 'module'
      });

      this.worker.onmessage = (event) => this.handleWorkerMessage(event);
      this.worker.onerror = (error) => {
        console.error('Worker error:', error);
        this.errorMessage.set('Validation failed: Worker error');
        this.currentStep.set('choose');
        this.terminateWorker();
      };

      // Send validation task
      this.worker.postMessage({
        type: 'validate',
        data: {
          rows: data,
          properties: properties,
          fkLookups: serializedLookups,
          entityKey: this.entityKey
        }
      });
    } catch (error) {
      console.error('Validation error:', error);
      this.errorMessage.set(`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.currentStep.set('choose');
    }
  }

  /**
   * Serialize FK lookup Maps/Sets for worker transfer (structured clone algorithm).
   *
   * Web Workers use the structured clone algorithm for message passing, which
   * does NOT support Map or Set objects. We must convert to plain objects/arrays.
   *
   * Transformation:
   * - Map<string, ForeignKeyLookup> → { [tableName]: { ... } }
   * - lookup.displayNameToIds (Map) → Object.fromEntries()
   * - lookup.validIds (Set) → Array.from()
   * - lookup.idsToDisplayName (Map) → Object.fromEntries()
   *
   * The worker will use these plain objects for validation without needing
   * to reconstruct Map/Set instances.
   *
   * @param fkLookups FK lookup maps from ImportExportService.fetchForeignKeyLookups()
   * @returns Plain object structure compatible with structured clone
   */
  private serializeLookups(fkLookups: Map<string, any>): any {
    const serialized: any = {};
    fkLookups.forEach((lookup, tableName) => {
      serialized[tableName] = {
        displayNameToIds: Object.fromEntries(lookup.displayNameToIds),
        validIds: Array.from(lookup.validIds),
        idsToDisplayName: Object.fromEntries(lookup.idsToDisplayName)
      };
    });
    return serialized;
  }

  /**
   * Handle messages from Web Worker.
   *
   * Message Types:
   * - progress: { type: 'progress', progress: { currentRow, totalRows, percentage, stage } }
   *   → Update validationProgress signal to show progress bar
   *
   * - complete: { type: 'complete', results: { validRows, errorSummary } }
   *   → Store validated data, update error summary, navigate to results screen
   *
   * - cancelled: { type: 'cancelled' }
   *   → Reset to file selection screen, terminate worker
   *
   * - error: { type: 'error', error: 'message' }
   *   → Display error message, reset to file selection screen
   *
   * All message handlers update signals which trigger OnPush change detection
   * via async pipe in the template.
   *
   * @param event MessageEvent from worker with typed data property
   */
  private handleWorkerMessage(event: MessageEvent): void {
    const message = event.data;

    switch (message.type) {
      case 'progress':
        this.validationProgress.set(message.progress.percentage);
        break;

      case 'complete':
        this.validatedData = message.results.validRows;
        this.errorSummary.set(message.results.errorSummary);
        this.validRowCount.set(message.results.validRows.length);
        this.currentStep.set('results');
        this.terminateWorker();
        break;

      case 'cancelled':
        this.currentStep.set('choose');
        this.terminateWorker();
        break;

      case 'error':
        this.errorMessage.set(message.error);
        this.currentStep.set('choose');
        this.terminateWorker();
        break;
    }
  }

  /**
   * Cancel validation
   */
  cancelValidation(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'cancel' });
    }
  }

  /**
   * Terminate worker
   */
  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * Download template
   */
  async downloadTemplate(): Promise<void> {
    try {
      const properties = await this.schemaService.getPropsForCreate(this.entity).toPromise();
      if (!properties) {
        throw new Error('Failed to fetch properties');
      }

      await this.importExportService.downloadTemplate(this.entity, properties);
    } catch (error) {
      console.error('Template download error:', error);
      this.errorMessage.set(`Template download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Download error report
   */
  downloadErrorReport(): void {
    const summary = this.errorSummary();
    if (!summary) return;

    this.importExportService.downloadErrorReport(this.originalExcelData, summary);
  }

  /**
   * Proceed with import - bulk insert validated rows to database.
   *
   * PostgREST Bulk Insert Behavior:
   * - All-or-nothing transaction (if ANY row fails, NONE are inserted)
   * - Requires all objects to have identical keys (PGRST102 constraint)
   * - Returns 201 Created on success with inserted rows
   * - Returns 400/409/500 on error with detailed message
   *
   * Error Handling:
   * - If bulk insert fails, display error message and return to results screen
   * - User can download error report to diagnose issue
   * - Common errors: FK constraint violation, CHECK constraint failure, unique violation
   *
   * Success Flow:
   * - Navigate to success screen with import count
   * - User clicks "Done" to close modal and emit importSuccess event
   * - Parent component (ListPage) refreshes data to show new records
   *
   * @throws Never throws - all errors handled with user-friendly messages
   *
   * @see DataService.bulkInsert() - Observable with progress updates
   * @see ErrorService.parseToHuman() - Converts PostgreSQL errors to friendly messages
   */
  async proceedWithImport(): Promise<void> {
    if (this.validatedData.length === 0 || !this.entityKey) return;

    this.currentStep.set('importing');
    this.uploadProgress.set(0);

    try {
      // Subscribe to bulk insert with progress tracking
      this.dataService.bulkInsert(this.entityKey, this.validatedData).subscribe({
        next: (response) => {
          if (response.progress !== undefined) {
            // Progress update
            this.uploadProgress.set(response.progress);
          } else if (response.success) {
            // Import complete
            this.importedCount.set(this.validatedData.length);
            this.currentStep.set('success');
          } else if (response.error) {
            // Error occurred - display message to user and return to results screen
            this.errorMessage.set(response.error.humanMessage || 'Import failed');
            this.currentStep.set('results');
          }
        },
        error: (error) => {
          console.error('Import error:', error);
          this.errorMessage.set(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          this.currentStep.set('results');
        }
      });
    } catch (error) {
      console.error('Import error:', error);
      this.errorMessage.set(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.currentStep.set('results');
    }
  }

  /**
   * Complete import and close modal
   */
  completeImport(): void {
    const count = this.importedCount();
    this.importSuccess.emit(count);
    this.close.emit();
  }

  /**
   * Close modal
   */
  closeModal(): void {
    this.terminateWorker();
    this.close.emit();
  }

  /**
   * Reset to choose step
   */
  startOver(): void {
    this.currentStep.set('choose');
    this.selectedFile.set(null);
    this.errorMessage.set(null);
    this.errorSummary.set(null);
    this.validRowCount.set(0);
    this.validatedData = [];
    this.originalExcelData = [];
  }
}
