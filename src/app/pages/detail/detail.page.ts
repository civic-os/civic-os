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


import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { Observable, map, mergeMap, of, combineLatest, debounceTime, distinctUntilChanged } from 'rxjs';
import { SchemaEntityProperty, SchemaEntityTable, EntityPropertyType, InverseRelationshipData } from '../../interfaces/entity';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';

import { CommonModule } from '@angular/common';
import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { ManyToManyEditorComponent } from '../../components/many-to-many-editor/many-to-many-editor.component';
import { Subject, startWith } from 'rxjs';
import { tap } from 'rxjs/operators';

@Component({
    selector: 'app-detail',
    templateUrl: './detail.page.html',
    styleUrl: './detail.page.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
    CommonModule,
    RouterModule,
    DisplayPropertyComponent,
    ManyToManyEditorComponent
]
})
export class DetailPage {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private schema = inject(SchemaService);
  private data = inject(DataService);

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  // Refresh trigger for M:M changes
  private refreshTrigger$ = new Subject<void>();

  // Delete modal state
  showDeleteModal = signal(false);
  deleteLoading = signal(false);
  deleteError = signal<string | undefined>(undefined);

  public entityKey?: string;
  public entityId?: string;
  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(mergeMap(p => {
    this.entityKey = p['entityKey'];
    this.entityId = p['entityId'];
    if(p['entityKey']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined);
    }
  }));
  public properties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(mergeMap(e => {
    if(e) {
      let props = this.schema.getPropsForDetail(e);
      return props;
    } else {
      return of([]);
    }
  }));

  // Separate regular properties from M:M properties
  public regularProps$: Observable<SchemaEntityProperty[]> = this.properties$.pipe(
    map(props => props.filter(p => p.type !== EntityPropertyType.ManyToMany))
  );

  public manyToManyProps$: Observable<SchemaEntityProperty[]> = this.properties$.pipe(
    map(props => props.filter(p => p.type === EntityPropertyType.ManyToMany))
  );

  public data$: Observable<any> = combineLatest([this.properties$, this.refreshTrigger$.pipe(startWith(null))]).pipe(
    // Batch synchronous emissions during initialization
    debounceTime(0),
    // Skip emissions when properties haven't changed (ignore refresh trigger changes)
    distinctUntilChanged((prev, curr) => {
      const [prevProps, _] = prev;
      const [currProps, __] = curr;
      return prevProps?.length === currProps?.length;
    }),
    mergeMap(([props, _]) => {
    if(props && props.length > 0 && this.entityKey) {
      let columns = props
        .map(x => SchemaService.propertyToSelectString(x));
      return this.data.getData({key: this.entityKey, fields: columns, entityId: this.entityId})
        .pipe(map(results => {
          const data = results[0];

          // Transform M:M junction data to flat arrays of related entities
          props.forEach(p => {
            if (p.type === EntityPropertyType.ManyToMany && p.many_to_many_meta) {
              const dataAny = data as any;
              const junctionData = dataAny[p.column_name] || [];
              dataAny[p.column_name] = DataService.transformManyToManyData(
                junctionData,
                p.many_to_many_meta.relatedTable
              );
            }
          });

          return data;
        }));
    } else {
      return of(undefined);
    }
  }));

  // Fetch inverse relationships (entities that reference this entity)
  public inverseRelationships$: Observable<InverseRelationshipData[]> =
    combineLatest([
      this.entity$,
      this.data$
    ]).pipe(
      // Batch synchronous emissions during initialization
      debounceTime(0),
      // Skip emissions when entity or data ID haven't changed
      distinctUntilChanged((prev, curr) => {
        return prev[0]?.table_name === curr[0]?.table_name &&
               prev[1]?.id === curr[1]?.id;
      }),
      mergeMap(([entity, data]) => {
        if (!entity || !data) return of([]);

        // Get inverse relationship metadata
        return this.schema.getInverseRelationships(entity.table_name).pipe(
          mergeMap(relationships => {
            // Fetch data for each relationship in parallel
            const dataObservables = relationships.map(meta =>
              this.data.getInverseRelationshipData(meta, data.id)
            );

            return dataObservables.length > 0
              ? combineLatest(dataObservables)
              : of([]);
          })
        );
      }),
      // Filter out relationships with zero count
      map(relationships => relationships.filter(r => r.totalCount > 0)),
      // Sort by entity sort_order
      mergeMap(relationships =>
        this.schema.getEntities().pipe(
          map(entities => {
            return relationships.sort((a, b) => {
              const entityA = entities.find(e => e.table_name === a.meta.sourceTable);
              const entityB = entities.find(e => e.table_name === b.meta.sourceTable);
              return (entityA?.sort_order || 0) - (entityB?.sort_order || 0);
            });
          })
        )
      )
    );

  // Threshold for showing preview vs "View all" only
  readonly LARGE_RELATIONSHIP_THRESHOLD = 20;

  // Refresh data after M:M changes
  refreshData() {
    this.refreshTrigger$.next();
  }

  // Delete modal methods
  openDeleteModal() {
    this.deleteError.set(undefined);
    this.showDeleteModal.set(true);
  }

  closeDeleteModal() {
    this.showDeleteModal.set(false);
  }

  confirmDelete() {
    if (!this.entityKey || !this.entityId) return;

    this.deleteError.set(undefined);
    this.deleteLoading.set(true);

    this.data.deleteData(this.entityKey, this.entityId).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          // Navigate back to list view on success
          this.router.navigate(['/view', this.entityKey]);
        } else {
          this.deleteError.set(response.error?.humanMessage || 'Failed to delete record');
        }
      },
      error: (err) => {
        this.deleteLoading.set(false);
        this.deleteError.set('Failed to delete record. Please try again.');
      }
    });
  }
}
