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
import { SchemaEntityTable, SchemaEntityProperty, StaticText } from '../../interfaces/entity';
import { ApiResponse } from '../../interfaces/api';
import { debounceTime, Subject, switchMap, of, map, catchError, Observable, combineLatest } from 'rxjs';

interface PropertyRow extends SchemaEntityProperty {
  itemType: 'property';
  customDisplayName: string | null;
  customDescription: string | null;
  customColumnWidth: number | null;
  expanded: boolean;
}

/**
 * Static text row for display in the Property Management page.
 * Allows sort_order arrangement alongside properties.
 * @since v0.17.0
 */
interface StaticTextRow extends StaticText {
  expanded: boolean;
}

/**
 * Union type for items in the Property Management list.
 * Includes both properties and static text for unified sort_order management.
 */
type ManageableItem = PropertyRow | StaticTextRow;

/**
 * Type guard to check if item is a property row.
 */
function isPropertyRow(item: ManageableItem): item is PropertyRow {
  return item.itemType === 'property';
}

/**
 * Type guard to check if item is a static text row.
 */
function isStaticTextRow(item: ManageableItem): item is StaticTextRow {
  return item.itemType === 'static_text';
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
  /**
   * Combined list of properties and static text items.
   * Both types can be drag-dropped to reorder by sort_order.
   * @since v0.17.0 - Extended to include static text
   */
  items = signal<ManageableItem[]>([]);
  error = signal<string | undefined>(undefined);
  savingStates = signal<Map<string, boolean>>(new Map());
  savedStates = signal<Map<string, boolean>>(new Map());
  fadingStates = signal<Map<string, boolean>>(new Map());

  // Expose type guards to template
  protected readonly isPropertyRow = isPropertyRow;
  protected readonly isStaticTextRow = isStaticTextRow;

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
      this.items.set([]);
      return;
    }

    this.loading.set(true);
    this.error.set(undefined);

    // Fetch both properties and static text in parallel
    combineLatest([
      this.schemaService.getPropertiesForEntityFresh(entity),
      this.schemaService.getStaticTextForEntity(entity.table_name)
    ]).subscribe({
      next: ([props, staticTexts]) => {
        // Map properties to PropertyRow
        const propertyRows: PropertyRow[] = props.map(p => ({
          ...p,
          itemType: 'property' as const,
          customDisplayName: p.display_name !== this.getDefaultDisplayName(p.column_name) ? p.display_name : null,
          customDescription: p.description || null,
          customColumnWidth: p.column_width || null,
          expanded: false
        }));

        // Map static texts to StaticTextRow
        const staticTextRows: StaticTextRow[] = staticTexts.map(st => ({
          ...st,
          expanded: false
        }));

        // Combine and sort by sort_order
        const allItems: ManageableItem[] = [...propertyRows, ...staticTextRows];
        allItems.sort((a, b) => a.sort_order - b.sort_order);

        this.items.set(allItems);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load items');
        this.loading.set(false);
      }
    });
  }

  onDrop(event: CdkDragDrop<ManageableItem[]>) {
    const items = [...this.items()];
    moveItemInArray(items, event.previousIndex, event.currentIndex);
    this.items.set(items);

    // Separate updates by type
    const propertyUpdates = items
      .filter(isPropertyRow)
      .map((property, _index) => {
        // Find actual index in combined array for sort_order
        const actualIndex = items.indexOf(property);
        return {
          table_name: property.table_name,
          column_name: property.column_name,
          sort_order: actualIndex
        };
      });

    const staticTextUpdates = items
      .filter(isStaticTextRow)
      .map((staticText, _index) => {
        // Find actual index in combined array for sort_order
        const actualIndex = items.indexOf(staticText);
        return {
          id: staticText.id,
          sort_order: actualIndex
        };
      });

    // Update both tables
    const propertyUpdate$ = propertyUpdates.length > 0
      ? this.propertyManagementService.updatePropertiesOrder(propertyUpdates)
      : of({ success: true } as ApiResponse);

    const staticTextUpdate$ = staticTextUpdates.length > 0
      ? this.propertyManagementService.updateStaticTextOrder(staticTextUpdates)
      : of({ success: true } as ApiResponse);

    combineLatest([propertyUpdate$, staticTextUpdate$]).subscribe({
      next: ([propResponse, staticResponse]) => {
        if (propResponse.success && staticResponse.success) {
          // Refresh schema cache to update forms
          this.schemaService.refreshCache();
          this.schemaService.refreshStaticTextCache();
        } else {
          const errorMsg = propResponse.error?.humanMessage || staticResponse.error?.humanMessage || 'Failed to update order';
          this.error.set(errorMsg);
        }
      },
      error: () => {
        this.error.set('Failed to update order');
      }
    });
  }

  toggleExpanded(item: ManageableItem) {
    const items = this.items();
    const index = isPropertyRow(item)
      ? items.findIndex(i => isPropertyRow(i) && i.table_name === item.table_name && i.column_name === item.column_name)
      : items.findIndex(i => isStaticTextRow(i) && i.id === item.id);

    if (index !== -1) {
      const updated = [...items];
      updated[index] = { ...updated[index], expanded: !updated[index].expanded };
      this.items.set(updated);
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

  /**
   * Generate a unique key for any manageable item.
   * Properties use table.column, static text uses st_id.
   */
  private getItemKey(item: ManageableItem): string {
    if (isPropertyRow(item)) {
      return `${item.table_name}.${item.column_name}`;
    } else {
      return `st_${item.id}`;
    }
  }

  private getPropertyKey(property: PropertyRow): string {
    return `${property.table_name}.${property.column_name}`;
  }

  isSaving(item: ManageableItem): boolean {
    return this.savingStates().get(this.getItemKey(item)) || false;
  }

  isSaved(item: ManageableItem): boolean {
    return this.savedStates().get(this.getItemKey(item)) || false;
  }

  isFading(item: ManageableItem): boolean {
    return this.fadingStates().get(this.getItemKey(item)) || false;
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Static Text Save Methods (v0.17.0)
  // ─────────────────────────────────────────────────────────────────────────────

  onStaticTextVisibilityChange(staticText: StaticTextRow) {
    this.saveStaticTextMetadata(staticText);
  }

  onStaticTextColumnWidthChange(staticText: StaticTextRow) {
    this.saveStaticTextMetadata(staticText);
  }

  onStaticTextFieldBlur(staticText: StaticTextRow) {
    this.performStaticTextSave(staticText);
  }

  private saveStaticTextMetadata(staticText: StaticTextRow) {
    const key = this.getItemKey(staticText);

    // Get or create debounce subject for this static text
    if (!this.saveSubjects.has(key)) {
      const subject = new Subject<void>();
      this.saveSubjects.set(key, subject);

      subject.pipe(debounceTime(1000)).subscribe(() => {
        this.performStaticTextSave(staticText);
      });
    }

    // Trigger debounced save
    this.saveSubjects.get(key)!.next();
  }

  private performStaticTextSave(staticText: StaticTextRow) {
    const key = this.getItemKey(staticText);

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

    this.propertyManagementService.updateStaticText(
      staticText.id,
      staticText.column_width,
      staticText.show_on_detail,
      staticText.show_on_create,
      staticText.show_on_edit
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

          // Remove checkmark completely after 5 seconds
          setTimeout(() => {
            const savedStates = new Map(this.savedStates());
            savedStates.delete(key);
            this.savedStates.set(savedStates);

            const fadingStates = new Map(this.fadingStates());
            fadingStates.delete(key);
            this.fadingStates.set(fadingStates);
          }, 5000);

          // Refresh static text cache to update forms
          this.schemaService.refreshStaticTextCache();
        } else {
          this.error.set(response.error?.humanMessage || 'Failed to save');
        }
      },
      error: () => {
        const savingStates = new Map(this.savingStates());
        savingStates.delete(key);
        this.savingStates.set(savingStates);
        this.error.set('Failed to save static text settings');
      }
    });
  }
}
