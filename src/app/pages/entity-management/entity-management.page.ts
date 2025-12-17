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


import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { SchemaService } from '../../services/schema.service';
import { EntityManagementService } from '../../services/entity-management.service';
import { SchemaEntityTable } from '../../interfaces/entity';
import { debounceTime, Subject, switchMap, of, map, catchError, forkJoin } from 'rxjs';

interface EntityRow extends SchemaEntityTable {
  customDisplayName: string | null;
  customDescription: string | null;
  geoPointProperties?: string[]; // Available GeoPoint properties for this entity
  timeSlotProperties?: string[]; // Available TimeSlot properties for this entity
}

interface EntityData {
  entities: EntityRow[];
  loading: boolean;
  error?: string;
  isAdmin: boolean;
}

@Component({
  selector: 'app-entity-management',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DragDropModule],
  templateUrl: './entity-management.page.html',
  styleUrl: './entity-management.page.css'
})
export class EntityManagementPage {
  private schemaService = inject(SchemaService);
  private entityManagementService = inject(EntityManagementService);

  // Mutable signals for user interactions
  entities = signal<EntityRow[]>([]);
  error = signal<string | undefined>(undefined); // Mutable for user action errors
  savingStates = signal<Map<string, boolean>>(new Map());
  savedStates = signal<Map<string, boolean>>(new Map()); // Track successful saves
  fadingStates = signal<Map<string, boolean>>(new Map()); // Track fading checkmarks

  private saveSubjects = new Map<string, Subject<void>>();

  // Load all data reactively with toSignal
  private dataLoad = toSignal(
    this.entityManagementService.isAdmin().pipe(
      switchMap(isAdmin => {
        if (!isAdmin) {
          this.error.set('Admin access required');
          return of({
            entities: [],
            loading: false,
            isAdmin: false
          } as EntityData);
        }

        // Use getEntitiesForMenu() to exclude junction tables
        return this.schemaService.getEntitiesForMenu().pipe(
          switchMap(entities => {
            // Load properties for each entity to find GeoPoint fields
            const entityRows: EntityRow[] = (entities || []).map(e => ({
              ...e,
              customDisplayName: e.display_name !== e.table_name ? e.display_name : null,
              customDescription: e.description,
              geoPointProperties: []
            }));

            if (entityRows.length === 0) {
              this.entities.set(entityRows);
              return of({
                entities: entityRows,
                loading: false,
                isAdmin: true
              } as EntityData);
            }

            // Fetch GeoPoint and TimeSlot properties for each entity
            const propertyObservables = entityRows.map(entity =>
              this.schemaService.getPropertiesForEntity(entity).pipe(
                map(properties => {
                  const geoPoints = properties
                    .filter(p => p.geography_type === 'Point')
                    .map(p => p.column_name);
                  const timeSlots = properties
                    .filter(p => p.udt_name === 'time_slot')
                    .map(p => p.column_name);
                  return { ...entity, geoPointProperties: geoPoints, timeSlotProperties: timeSlots };
                }),
                catchError(() => of(entity))
              )
            );

            // Wait for all property fetches
            return forkJoin(propertyObservables).pipe(
              map(entityRowsWithProperties => {
                // Update entities signal
                this.entities.set(entityRowsWithProperties);
                return {
                  entities: entityRowsWithProperties,
                  loading: false,
                  isAdmin: true
                } as EntityData;
              })
            );
          }),
          catchError(() => {
            this.error.set('Failed to load entities');
            return of({
              entities: [],
              loading: false,
              isAdmin: true
            } as EntityData);
          })
        );
      }),
      catchError(() => {
        this.error.set('Failed to verify admin access');
        return of({
          entities: [],
          loading: false,
          isAdmin: false
        } as EntityData);
      })
    ),
    { initialValue: { entities: [], loading: true, isAdmin: false } as EntityData }
  );

  // Expose as computed signals for template
  loading = computed(() => this.dataLoad()?.loading ?? true);
  isAdmin = computed(() => this.dataLoad()?.isAdmin ?? false);

  onDrop(event: CdkDragDrop<EntityRow[]>) {
    const entities = [...this.entities()];
    moveItemInArray(entities, event.previousIndex, event.currentIndex);
    this.entities.set(entities);

    // Update sort_order for all entities based on new positions
    const updates = entities.map((entity, index) => ({
      table_name: entity.table_name,
      sort_order: index
    }));

    this.entityManagementService.updateEntitiesOrder(updates).subscribe({
      next: (response) => {
        if (response.success) {
          // Refresh schema cache to update menu
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

  onDisplayNameChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onDescriptionChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onFieldBlur(entity: EntityRow) {
    // Save immediately when field loses focus
    this.performSave(entity);
  }

  onShowMapChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onMapPropertyChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onShowCalendarChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onCalendarPropertyChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onEnableNotesChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onSupportsRecurringChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  onRecurringPropertyChange(entity: EntityRow) {
    this.saveEntityMetadata(entity);
  }

  hasGeoPointProperties(entity: EntityRow): boolean {
    return (entity.geoPointProperties?.length ?? 0) > 0;
  }

  hasTimeSlotProperties(entity: EntityRow): boolean {
    return (entity.timeSlotProperties?.length ?? 0) > 0;
  }

  private saveEntityMetadata(entity: EntityRow) {
    // Get or create debounce subject for this entity
    if (!this.saveSubjects.has(entity.table_name)) {
      const subject = new Subject<void>();
      this.saveSubjects.set(entity.table_name, subject);

      subject.pipe(debounceTime(1000)).subscribe(() => {
        // Look up current entity from signal to avoid stale closure references
        // (entities array may be replaced when schema refreshes after reordering)
        const currentEntity = this.entities().find(e => e.table_name === entity.table_name);
        if (currentEntity) {
          this.performSave(currentEntity);
        }
      });
    }

    // Trigger debounced save
    this.saveSubjects.get(entity.table_name)!.next();
  }

  private performSave(entity: EntityRow) {
    // Set saving state
    const savingStates = new Map(this.savingStates());
    savingStates.set(entity.table_name, true);
    this.savingStates.set(savingStates);

    // Clear any existing saved and fading states
    const savedStates = new Map(this.savedStates());
    savedStates.delete(entity.table_name);
    this.savedStates.set(savedStates);

    const fadingStates = new Map(this.fadingStates());
    fadingStates.delete(entity.table_name);
    this.fadingStates.set(fadingStates);

    this.entityManagementService.upsertEntityMetadata(
      entity.table_name,
      entity.customDisplayName || null,
      entity.customDescription || null,
      entity.sort_order,
      entity.show_map,
      entity.map_property_name,
      entity.show_calendar,
      entity.calendar_property_name,
      entity.calendar_color_property,
      entity.enable_notes,
      entity.supports_recurring,
      entity.recurring_property_name
    ).subscribe({
      next: (response) => {
        // Clear saving state
        const savingStates = new Map(this.savingStates());
        savingStates.delete(entity.table_name);
        this.savingStates.set(savingStates);

        if (response.success) {
          // Show checkmark
          const savedStates = new Map(this.savedStates());
          savedStates.set(entity.table_name, true);
          this.savedStates.set(savedStates);

          // Start fading after 4 seconds
          setTimeout(() => {
            const fadingStates = new Map(this.fadingStates());
            fadingStates.set(entity.table_name, true);
            this.fadingStates.set(fadingStates);
          }, 4000);

          // Remove checkmark completely after 5 seconds (4s visible + 1s fade)
          setTimeout(() => {
            const savedStates = new Map(this.savedStates());
            savedStates.delete(entity.table_name);
            this.savedStates.set(savedStates);

            const fadingStates = new Map(this.fadingStates());
            fadingStates.delete(entity.table_name);
            this.fadingStates.set(fadingStates);
          }, 5000);

          // Refresh schema cache to update menu
          this.schemaService.refreshCache();
        } else {
          this.error.set(response.error?.humanMessage || 'Failed to save');
        }
      },
      error: () => {
        const savingStates = new Map(this.savingStates());
        savingStates.delete(entity.table_name);
        this.savingStates.set(savingStates);
        this.error.set('Failed to save entity metadata');
      }
    });
  }

  isSaving(tableName: string): boolean {
    return this.savingStates().get(tableName) || false;
  }

  isSaved(tableName: string): boolean {
    return this.savedStates().get(tableName) || false;
  }

  isFading(tableName: string): boolean {
    return this.fadingStates().get(tableName) || false;
  }

  getDisplayNamePlaceholder(entity: EntityRow): string {
    return entity.display_name;
  }
}
