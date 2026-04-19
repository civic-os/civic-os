/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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

import { Component, input, signal, inject, output, ChangeDetectionStrategy, effect, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, Observable, of } from 'rxjs';
import { SchemaEntityProperty } from '../../interfaces/entity';
import { DataService } from '../../services/data.service';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { ApiResponse } from '../../interfaces/api';

@Component({
  selector: 'app-many-to-many-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './many-to-many-editor.component.html',
  styleUrl: './many-to-many-editor.component.css'
})
export class ManyToManyEditorComponent {
  // Inputs
  entityId = input.required<number | string>();
  property = input.required<SchemaEntityProperty>();
  currentValues = input.required<any[]>(); // Array of related entities with {id, display_name, color?}
  refreshTrigger = input<number>(0);  // Increment to force refresh from parent

  // State
  isEditing = signal(false);
  workingSelection = signal<number[]>([]);  // IDs selected while editing
  availableOptions = signal<any[]>([]);
  searchTerm = signal('');
  loading = signal(false);
  canEdit = signal(false);
  error = signal<string | undefined>(undefined);

  // Services
  private data = inject(DataService);
  private authService = inject(AuthService);
  private schema = inject(SchemaService);

  // v0.44.0: Resolved options_source_rpc for this M:M property (from metadata.properties)
  private resolvedOptionsSourceRpc = signal<string | null>(null);

  // Output
  relationChanged = output<void>();
  dependencyChanged = output<string>();  // Emits M:M column name after mutation (v0.44.0)

  // Computed
  filteredOptions = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const options = this.availableOptions();

    if (!term) return options;

    return options.filter(opt =>
      opt.display_name.toLowerCase().includes(term)
    );
  });

  pendingChanges = computed(() => {
    if (!this.isEditing()) {
      return { toAdd: [], toRemove: [] };
    }

    const original = new Set(this.currentValues().map(v => v.id));
    const updated = new Set(this.workingSelection());

    const toAdd = Array.from(updated).filter(id => !original.has(id));
    const toRemove = Array.from(original).filter(id => !updated.has(id));

    return { toAdd, toRemove };
  });

  constructor() {
    // Load available options when component initializes
    effect(() => {
      const prop = this.property();
      if (prop?.many_to_many_meta) {
        // v0.44.0: Look up options_source_rpc for this synthetic M:M column.
        // If already set on the property (e.g., from a future SchemaService enrichment), use it.
        // Otherwise, query metadata.properties via RPC for the synthetic column name.
        if (prop.options_source_rpc) {
          this.resolvedOptionsSourceRpc.set(prop.options_source_rpc);
          this.loadAvailableOptions();
        } else {
          this.schema.getM2mOptionsSourceRpc(prop.table_name, prop.column_name).subscribe(rpc => {
            this.resolvedOptionsSourceRpc.set(rpc);
            this.loadAvailableOptions();
          });
        }
        this.checkPermissions();
      }
    });

    // Refresh effect: reload available options when parent triggers refresh
    // Skip initial load (trigger === 0) to avoid double-loading
    effect(() => {
      const trigger = this.refreshTrigger();
      const prop = this.property();

      if (trigger > 0 && prop?.many_to_many_meta) {
        this.loadAvailableOptions();
        this.cancel();  // Exit edit mode if active
      }
    });
  }

  private checkPermissions() {
    const meta = this.property().many_to_many_meta;
    if (!meta) return;

    const hasCreate = this.authService.hasPermission(meta.junctionTable, 'create');
    const hasDelete = this.authService.hasPermission(meta.junctionTable, 'delete');
    this.canEdit.set(hasCreate && hasDelete);
  }

  private loadAvailableOptions() {
    const meta = this.property().many_to_many_meta;
    if (!meta) return;

    const rpc = this.resolvedOptionsSourceRpc();

    if (rpc) {
      // v0.44.0: Use custom RPC for option loading
      this.data.callRpc(rpc, {
        p_id: String(this.entityId()),
        p_depends_on: {}
      }).subscribe({
        next: (options: any[]) => {
          this.availableOptions.set(options);
        },
        error: () => {
          this.availableOptions.set([]);
        }
      });
    } else {
      // Default: query the related table directly
      const fields = meta.relatedTableHasColor
        ? ['id', 'display_name', 'color']
        : ['id', 'display_name'];

      this.data.getData({
        key: meta.relatedTable,
        fields: fields,
        orderField: 'display_name'
      }).subscribe({
        next: (options) => {
          this.availableOptions.set(options);
        },
        error: (err) => {
          console.error('Error loading options:', err);
          this.availableOptions.set([]);
        }
      });
    }
  }

  enterEditMode() {
    // Copy current IDs to working selection
    this.workingSelection.set(this.currentValues().map(v => v.id));
    this.searchTerm.set('');
    this.error.set(undefined);
    this.isEditing.set(true);
  }

  cancel() {
    this.isEditing.set(false);
    this.workingSelection.set([]);
    this.searchTerm.set('');
    this.error.set(undefined);
  }

  toggleSelection(id: number) {
    const current = new Set(this.workingSelection());
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    this.workingSelection.set(Array.from(current));
  }

  save() {
    const meta = this.property().many_to_many_meta;
    if (!meta) return;

    // Calculate diff
    const original = new Set(this.currentValues().map(v => v.id));
    const updated = new Set(this.workingSelection());

    const toAdd = Array.from(updated).filter(id => !original.has(id));
    const toRemove = Array.from(original).filter(id => !updated.has(id));

    // If no changes, just exit edit mode
    if (toAdd.length === 0 && toRemove.length === 0) {
      this.isEditing.set(false);
      return;
    }

    this.executeManyToManyChanges(toAdd, toRemove);
  }

  private executeManyToManyChanges(toAdd: number[], toRemove: number[]) {
    const meta = this.property().many_to_many_meta!;
    const operations: Observable<ApiResponse>[] = [];

    // Add removal operations
    toRemove.forEach(targetId => {
      operations.push(this.data.removeManyToManyRelation(
        this.entityId(),
        meta,
        targetId
      ));
    });

    // Add addition operations
    toAdd.forEach(targetId => {
      operations.push(this.data.addManyToManyRelation(
        this.entityId(),
        meta,
        targetId
      ));
    });

    this.loading.set(true);
    this.error.set(undefined);

    // Execute all operations in parallel
    forkJoin(operations).subscribe({
      next: (results) => {
        const failures = results.filter(r => !r.success);
        const successes = results.filter(r => r.success);

        if (failures.length === 0) {
          // All succeeded
          this.relationChanged.emit();
          if (this.resolvedOptionsSourceRpc()) {
            this.loadAvailableOptions();  // Re-fetch to reflect limits/availability
          }
          this.dependencyChanged.emit(this.property().column_name);
          this.isEditing.set(false);
          this.workingSelection.set([]);
        } else if (successes.length === 0) {
          // All failed
          this.error.set('All changes failed. Please try again.');
        } else {
          // Partial failure
          this.error.set(`${successes.length} changes succeeded, ${failures.length} failed. Refresh to see current state.`);
          this.relationChanged.emit();  // Refresh to show actual state
          if (this.resolvedOptionsSourceRpc()) {
            this.loadAvailableOptions();
          }
          this.dependencyChanged.emit(this.property().column_name);
          this.isEditing.set(false);
          this.workingSelection.set([]);
        }
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error saving changes:', err);
        this.error.set('Failed to save changes');
        this.loading.set(false);
      }
    });
  }
}
