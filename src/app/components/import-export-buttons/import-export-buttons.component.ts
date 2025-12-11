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

import { Component, Input, Output, EventEmitter, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SchemaEntityTable, SchemaEntityProperty, EntityNote } from '../../interfaces/entity';
import { FilterCriteria } from '../../interfaces/query';
import { ImportExportService } from '../../services/import-export.service';
import { SchemaService } from '../../services/schema.service';
import { NotesService } from '../../services/notes.service';
import { ImportModalComponent } from '../import-modal/import-modal.component';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-import-export-buttons',
  imports: [CommonModule, FormsModule, ImportModalComponent],
  templateUrl: './import-export-buttons.component.html',
  styleUrl: './import-export-buttons.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImportExportButtonsComponent {
  private importExportService = inject(ImportExportService);
  private schemaService = inject(SchemaService);
  private notesService = inject(NotesService);

  @Input({ required: true }) entity!: SchemaEntityTable;
  @Input() entityKey?: string;
  @Input() currentFilters?: FilterCriteria[];
  @Input() searchQuery?: string;
  @Input() sortColumn?: string;
  @Input() sortDirection?: 'asc' | 'desc';

  @Output() importComplete = new EventEmitter<number>();

  public isExporting = signal<boolean>(false);
  public showImportModal = signal<boolean>(false);

  // Export options modal state
  public showExportModal = signal<boolean>(false);
  public includeNotes = signal<boolean>(true);

  /**
   * Handle export button click.
   * If entity has notes enabled, show options modal.
   * Otherwise, export directly.
   * @returns Promise that resolves when export completes (for direct exports)
   */
  onExport(): Promise<void> | void {
    if (this.isExporting()) return;

    // If entity has notes enabled, show modal with options
    if (this.entity.enable_notes) {
      this.includeNotes.set(true); // Default to checked
      this.showExportModal.set(true);
    } else {
      // No notes, export directly
      return this.executeExport(false);
    }
  }

  /**
   * Close export options modal.
   */
  closeExportModal() {
    this.showExportModal.set(false);
  }

  /**
   * Confirm export from modal and start the export process.
   * @returns Promise that resolves when export completes
   */
  confirmExport(): Promise<void> {
    this.showExportModal.set(false);
    return this.executeExport(this.includeNotes());
  }

  /**
   * Execute the export process with optional notes.
   * @param includeNotes Whether to include notes as a second worksheet
   */
  private async executeExport(includeNotes: boolean) {
    this.isExporting.set(true);

    try {
      // Fetch properties for list view (includes all exportable fields)
      const properties = await this.schemaService.getPropertiesForEntity(this.entity).toPromise();

      if (!properties) {
        throw new Error('Failed to fetch properties');
      }

      const result = await this.importExportService.exportToExcel(
        this.entity,
        properties,
        this.currentFilters,
        this.searchQuery,
        this.sortColumn,
        this.sortDirection,
        includeNotes ? this.notesService : undefined
      );

      if (!result.success) {
        alert(result.error || 'Export failed');
      }
    } catch (error) {
      console.error('Export error:', error);
      alert(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      this.isExporting.set(false);
    }
  }

  /**
   * Handle import button click.
   * Opens import modal.
   */
  onImport() {
    this.showImportModal.set(true);
  }

  /**
   * Handle import modal close.
   */
  onImportModalClose() {
    this.showImportModal.set(false);
  }

  /**
   * Handle import completion.
   */
  onImportSuccess(count: number) {
    this.showImportModal.set(false);
    this.importComplete.emit(count);
  }
}
