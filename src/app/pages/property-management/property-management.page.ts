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


import { Component, inject, signal, computed, effect, ChangeDetectionStrategy } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { SchemaService } from '../../services/schema.service';
import { PropertyManagementService } from '../../services/property-management.service';
import { SchemaEntityTable, SchemaEntityProperty } from '../../interfaces/entity';
import { debounceTime, Subject, switchMap, of, map, catchError, Observable } from 'rxjs';

interface PropertyRow extends SchemaEntityProperty {
  customDisplayName: string | null;
  customDescription: string | null;
  customColumnWidth: number | null;
  expanded: boolean;
}

interface PropertyData {
  properties: PropertyRow[];
  loading: boolean;
  error?: string;
}

interface AdminCheckData {
  isAdmin: boolean;
  loading: boolean;
  error?: string;
}

@Component({
  selector: 'app-property-management',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DragDropModule],
  templateUrl: './property-management.page.html',
  styleUrl: './property-management.page.css'
})
export class PropertyManagementPage {
  private schemaService = inject(SchemaService);
  private propertyManagementService = inject(PropertyManagementService);

  // Mutable signals for user interactions
  selectedEntity = signal<SchemaEntityTable | undefined>(undefined);
  properties = signal<PropertyRow[]>([]);
  error = signal<string | undefined>(undefined);
  savingStates = signal<Map<string, boolean>>(new Map());
  savedStates = signal<Map<string, boolean>>(new Map());
  fadingStates = signal<Map<string, boolean>>(new Map());

  private saveSubjects = new Map<string, Subject<void>>();

  // Load entities for dropdown (excluding junction tables)
  entities = toSignal(
    this.schemaService.getEntitiesForMenu(),
    { initialValue: [] }
  );

  // Check if user is admin with proper loading state
  private adminCheckData = toSignal(
    this.propertyManagementService.isAdmin().pipe(
      map(isAdmin => ({ isAdmin, loading: false } as AdminCheckData)),
      catchError(() => {
        return of({
          isAdmin: false,
          loading: false,
          error: 'Failed to verify admin access'
        } as AdminCheckData);
      })
    ),
    { initialValue: { isAdmin: false, loading: true } as AdminCheckData }
  );

  isAdmin = computed(() => this.adminCheckData()?.isAdmin ?? false);
  adminLoading = computed(() => this.adminCheckData()?.loading ?? true);
  adminError = computed(() => this.adminCheckData()?.error);
  loading = signal(false);

  // Auto-select first entity when entities load
  private _autoSelectFirstEntity = effect(() => {
    const entities = this.entities();
    const selected = this.selectedEntity();

    // Only auto-select if entities loaded and no entity is currently selected
    if (entities && entities.length > 0 && !selected) {
      this.selectedEntity.set(entities[0]);
      this.onEntityChange();
    }
  });

  onEntityChange() {
    const entity = this.selectedEntity();
    if (!entity) {
      this.properties.set([]);
      return;
    }

    this.loading.set(true);
    this.error.set(undefined);

    this.schemaService.getPropertiesForEntityFresh(entity).subscribe({
      next: (props) => {
        const propertyRows: PropertyRow[] = props.map(p => ({
          ...p,
          customDisplayName: p.display_name !== this.getDefaultDisplayName(p.column_name) ? p.display_name : null,
          customDescription: p.description || null,
          customColumnWidth: p.column_width || null,
          expanded: false
        }));
        // Sort by sort_order
        propertyRows.sort((a, b) => a.sort_order - b.sort_order);
        this.properties.set(propertyRows);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load properties');
        this.loading.set(false);
      }
    });
  }

  onDrop(event: CdkDragDrop<PropertyRow[]>) {
    const properties = [...this.properties()];
    moveItemInArray(properties, event.previousIndex, event.currentIndex);
    this.properties.set(properties);

    // Update sort_order for all properties based on new positions
    const updates = properties.map((property, index) => ({
      table_name: property.table_name,
      column_name: property.column_name,
      sort_order: index
    }));

    this.propertyManagementService.updatePropertiesOrder(updates).subscribe({
      next: (response) => {
        if (response.success) {
          // Refresh schema cache to update forms
          this.schemaService.refreshCache();
        } else {
          this.error.set(response.error?.humanMessage || 'Failed to update order');
        }
      },
      error: () => {
        this.error.set('Failed to update order');
      }
    });
  }

  toggleExpanded(property: PropertyRow) {
    const properties = this.properties();
    const index = properties.findIndex(p =>
      p.table_name === property.table_name && p.column_name === property.column_name
    );

    if (index !== -1) {
      const updated = [...properties];
      updated[index] = { ...updated[index], expanded: !updated[index].expanded };
      this.properties.set(updated);
    }
  }

  onDisplayNameChange(property: PropertyRow) {
    this.savePropertyMetadata(property);
  }

  onDescriptionChange(property: PropertyRow) {
    this.savePropertyMetadata(property);
  }

  onColumnWidthChange(property: PropertyRow) {
    this.savePropertyMetadata(property);
  }

  onVisibilityChange(property: PropertyRow) {
    this.savePropertyMetadata(property);
  }

  onFieldBlur(property: PropertyRow) {
    // Save immediately when field loses focus
    this.performSave(property);
  }

  private savePropertyMetadata(property: PropertyRow) {
    const key = this.getPropertyKey(property);

    // Get or create debounce subject for this property
    if (!this.saveSubjects.has(key)) {
      const subject = new Subject<void>();
      this.saveSubjects.set(key, subject);

      subject.pipe(debounceTime(1000)).subscribe(() => {
        this.performSave(property);
      });
    }

    // Trigger debounced save
    this.saveSubjects.get(key)!.next();
  }

  private performSave(property: PropertyRow) {
    const key = this.getPropertyKey(property);

    // Set saving state
    const savingStates = new Map(this.savingStates());
    savingStates.set(key, true);
    this.savingStates.set(savingStates);

    // Clear any existing saved and fading states
    const savedStates = new Map(this.savedStates());
    savedStates.delete(key);
    this.savedStates.set(savedStates);

    const fadingStates = new Map(this.fadingStates());
    fadingStates.delete(key);
    this.fadingStates.set(fadingStates);

    this.propertyManagementService.upsertPropertyMetadata(
      property.table_name,
      property.column_name,
      property.customDisplayName || null,
      property.customDescription || null,
      property.sort_order,
      property.customColumnWidth,
      property.sortable ?? true,
      property.filterable ?? false,
      property.show_on_list ?? true,
      property.show_on_create ?? true,
      property.show_on_edit ?? true,
      property.show_on_detail ?? true
    ).subscribe({
      next: (response) => {
        // Clear saving state
        const savingStates = new Map(this.savingStates());
        savingStates.delete(key);
        this.savingStates.set(savingStates);

        if (response.success) {
          // Show checkmark
          const savedStates = new Map(this.savedStates());
          savedStates.set(key, true);
          this.savedStates.set(savedStates);

          // Start fading after 4 seconds
          setTimeout(() => {
            const fadingStates = new Map(this.fadingStates());
            fadingStates.set(key, true);
            this.fadingStates.set(fadingStates);
          }, 4000);

          // Remove checkmark completely after 5 seconds (4s visible + 1s fade)
          setTimeout(() => {
            const savedStates = new Map(this.savedStates());
            savedStates.delete(key);
            this.savedStates.set(savedStates);

            const fadingStates = new Map(this.fadingStates());
            fadingStates.delete(key);
            this.fadingStates.set(fadingStates);
          }, 5000);

          // Refresh schema cache to update forms
          this.schemaService.refreshCache();
        } else {
          this.error.set(response.error?.humanMessage || 'Failed to save');
        }
      },
      error: () => {
        const savingStates = new Map(this.savingStates());
        savingStates.delete(key);
        this.savingStates.set(savingStates);
        this.error.set('Failed to save property metadata');
      }
    });
  }

  private getPropertyKey(property: PropertyRow): string {
    return `${property.table_name}.${property.column_name}`;
  }

  isSaving(property: PropertyRow): boolean {
    return this.savingStates().get(this.getPropertyKey(property)) || false;
  }

  isSaved(property: PropertyRow): boolean {
    return this.savedStates().get(this.getPropertyKey(property)) || false;
  }

  isFading(property: PropertyRow): boolean {
    return this.fadingStates().get(this.getPropertyKey(property)) || false;
  }

  getDisplayNamePlaceholder(property: PropertyRow): string {
    return this.getDefaultDisplayName(property.column_name);
  }

  private getDefaultDisplayName(columnName: string): string {
    // Replicate the default display name logic from schema_properties view
    return columnName.split('_').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  }

  getPropertyTypeLabel(property: PropertyRow): string {
    const typeLabels: { [key: number]: string } = {
      0: 'Unknown',
      1: 'Text (Short)',
      2: 'Text (Long)',
      3: 'Boolean',
      4: 'Date',
      5: 'Date Time',
      6: 'Date Time (Local)',
      7: 'Money',
      8: 'Integer',
      9: 'Decimal',
      10: 'Foreign Key',
      11: 'User',
      12: 'Geo Point',
      13: 'Color',
      14: 'Email',
      15: 'Telephone',
      16: 'Time Slot',
      17: 'Many-to-Many',
      18: 'File',
      19: 'Image',
      20: 'PDF',
      21: 'Payment',
      22: 'Status'
    };
    return typeLabels[property.type] || 'Unknown';
  }

  /**
   * Check if property is an auto-managed timestamp field.
   * These fields are managed by database triggers and cannot be edited by users.
   */
  isSystemTimestamp(property: PropertyRow): boolean {
    return property.column_name === 'created_at' || property.column_name === 'updated_at';
  }

  isFilterableType(property: PropertyRow): boolean {
    // Exclude system fields from filtering
    const systemFields = ['id', 'created_at', 'updated_at', 'civic_os_text_search'];
    if (systemFields.includes(property.column_name)) {
      return false;
    }

    // Only show filterable checkbox for supported property types
    const filterableTypes = [
      10, // ForeignKeyName
      5,  // DateTime
      6,  // DateTimeLocal
      4,  // Date
      3,  // Boolean
      8,  // IntegerNumber
      7,  // Money
      11, // User
      22  // Status
    ];
    return filterableTypes.includes(property.type);
  }

  compareEntities(entity1: SchemaEntityTable, entity2: SchemaEntityTable): boolean {
    return entity1 && entity2 ? entity1.table_name === entity2.table_name : entity1 === entity2;
  }
}
