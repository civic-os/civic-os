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

import { Component, input, computed, inject, ChangeDetectionStrategy, signal, effect, untracked } from '@angular/core';

import { Router } from '@angular/router';
import { DashboardWidget, MapWidgetConfig } from '../../../interfaces/dashboard';
import { GeoPointMapComponent, MapMarker } from '../../geo-point-map/geo-point-map.component';
import { GeoPolygonMapComponent, resolveColor } from '../../geo-polygon-map/geo-polygon-map.component';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { EntityData, EntityPropertyType, MapPolygon, SchemaEntityProperty } from '../../../interfaces/entity';
import { DataQuery } from '../../../interfaces/query';
import { TranslationService } from '../../../services/translation.service';
import { keyFilterMessage } from '../../../utils/key-filter-message';
import { map, Subscription, switchMap } from 'rxjs';

/**
 * Map Widget Component
 *
 * Displays filtered entity records with geography columns on an interactive map.
 * Supports clustering, filtering, and navigation to detail pages.
 *
 * Phase 2 implementation - basic functionality without auto-refresh.
 */
import { LoadingIndicatorComponent } from '../../loading-indicator/loading-indicator.component';
@Component({
  selector: 'app-map-widget',
  imports: [LoadingIndicatorComponent, GeoPointMapComponent, GeoPolygonMapComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './map-widget.component.html',
  styleUrl: './map-widget.component.css'
})
export class MapWidgetComponent {
  // Widget configuration from parent dashboard
  widget = input.required<DashboardWidget>();

  // Typed configuration (extract from JSONB config)
  config = computed<MapWidgetConfig>(() => {
    const cfg = this.widget().config as MapWidgetConfig;

    // Provide defaults for optional fields
    return {
      ...cfg,
      maxMarkers: cfg.maxMarkers ?? 500,
      enableClustering: cfg.enableClustering ?? false,
      clusterRadius: cfg.clusterRadius ?? 50,
      filters: cfg.filters ?? [],
      showColumns: cfg.showColumns ?? ['display_name']
    };
  });

  private dataService = inject(DataService);
  private schemaService = inject(SchemaService);
  private router = inject(Router);
  private translation = inject(TranslationService);

  // Computed signal for query parameters (derives from input signals)
  // Note: fields will be populated in the effect after fetching properties
  private queryParams = computed(() => {
    const cfg = this.config();
    const entityKey = this.widget().entity_key;

    if (!entityKey || !cfg.mapPropertyName) {
      return null;
    }

    // Build query object (fields added in effect)
    return {
      key: entityKey,
      fields: [], // Populated in effect using propertyToSelectString
      filters: cfg.filters
    } as DataQuery;
  });

  // Signals for component state
  markers = signal<MapMarker[]>([]);
  mapPolygons = signal<MapPolygon[]>([]);
  isPolygonMode = signal(false);
  isLoading = signal(true);
  error = signal<string | null>(null);

  // Entity display name (e.g. "Participants"), used to give clustered markers a
  // descriptive accessible name like "15 Participants" instead of a bare count (a11y).
  entityDisplayName = signal<string>('');

  // Effect to fetch data when query params change
  constructor() {
    // Independent of the data-fetching effect below: resolves the entity's
    // display name whenever the widget's entity changes.
    effect((onCleanup) => {
      const entityKey = this.widget().entity_key;

      if (!entityKey) {
        this.entityDisplayName.set('');
        return;
      }

      // untracked: getEntity() reads the entities signal; the subscription already follows it
      const sub = untracked(() => this.schemaService.getEntity(entityKey).subscribe({
        next: (entity) => this.entityDisplayName.set(entity?.display_name ?? ''),
        error: () => this.entityDisplayName.set('')
      }));
      onCleanup(() => sub.unsubscribe());
    });

    effect((onCleanup) => {
      const params = this.queryParams();
      const cfg = this.config();

      if (!params) {
        this.markers.set([]);
        this.isLoading.set(false);
        return;
      }

      this.isLoading.set(true);
      this.error.set(null);

      // Holds this run's requests: a re-run or destroy cancels them, so a stale response
      // can never overwrite the markers of a newer load.
      const load = new Subscription();
      onCleanup(() => load.unsubscribe());

      // untracked: the services read signals of their own (getProperties() reads the entities
      // signal while its cache is cold). Tracked, they would re-run this effect when the schema
      // finishes loading and send every widget's request twice.
      // First fetch properties to build proper select strings and resolve key filters
      untracked(() => load.add(this.schemaService.getProperties().pipe(
        switchMap((allProps: SchemaEntityProperty[]) => {
          const entityProps = allProps.filter(p => p.table_name === params.key);
          return this.schemaService.resolveWidgetFilters(cfg.filters, entityProps).pipe(
            map(filters => ({ entityProps, filters }))
          );
        })
      ).subscribe({
        next: ({ entityProps, filters }) => {
          // Detect if map property is GeoPolygon
          const mapProp = entityProps.find(p => p.column_name === cfg.mapPropertyName);
          const polygonMode = mapProp?.type === EntityPropertyType.GeoPolygon;
          this.isPolygonMode.set(polygonMode);

          // Build columns to fetch: map property + display name + show columns + colorProperty
          const columnNames = [
            'id',
            'display_name',
            cfg.mapPropertyName,
            ...(cfg.showColumns || [])
          ];
          if (cfg.colorProperty) {
            columnNames.push(cfg.colorProperty);
          }
          const uniqueColumns = [...new Set(columnNames)];

          // Filter properties and build select strings
          const propsToSelect = entityProps.filter(p => uniqueColumns.includes(p.column_name));
          const columns = propsToSelect.map(p => SchemaService.propertyToSelectString(p));

          // Add computed WKT field for geography column
          columns.push(`${cfg.mapPropertyName}_text`);

          // Build query with proper select strings
          const query: DataQuery = {
            ...params,
            fields: columns,
            filters
          };

          // Fetch filtered data
          load.add(this.dataService.getData(query).subscribe({
            next: (response: EntityData[]) => {
              if (polygonMode) {
                this.mapPolygons.set(this.transformToPolygons(response, cfg.mapPropertyName, cfg.colorProperty));
                this.markers.set([]);
              } else {
                this.markers.set(this.transformToMarkers(response, cfg.mapPropertyName));
                this.mapPolygons.set([]);
              }
              this.isLoading.set(false);
            },
            error: (err: any) => {
              console.error('Map widget error:', err);
              this.error.set(err.message || this.translation.get('dashboard.error_load_map'));
              this.markers.set([]);
              this.mapPolygons.set([]);
              this.isLoading.set(false);
            }
          }));
        },
        error: (err: any) => {
          console.error('Error loading properties:', err);
          this.error.set(keyFilterMessage(err, this.translation) ?? this.translation.get('dashboard.error_load_schema'));
          this.markers.set([]);
          this.mapPolygons.set([]);
          this.isLoading.set(false);
        }
      })));
    });
  }

  /**
   * Transform entity records to MapMarker format
   */
  private transformToMarkers(records: any[], mapPropertyName: string): MapMarker[] {
    if (!records || records.length === 0) {
      return [];
    }

    const wktField = `${mapPropertyName}_text`;

    return records
      .filter(record => record[wktField]) // Filter out records without geography
      .map(record => ({
        id: record.id,
        name: record.display_name || `Record ${record.id}`,
        wkt: record[wktField]
      }));
  }

  /**
   * Transform entity records to MapPolygon format for polygon mode
   */
  private transformToPolygons(records: any[], mapPropertyName: string, colorProperty?: string): MapPolygon[] {
    if (!records || records.length === 0) return [];

    const wktField = `${mapPropertyName}_text`;

    return records
      .filter(record => record[wktField])
      .map(record => ({
        id: record.id,
        name: record.display_name || `Record ${record.id}`,
        wkt: record[wktField],
        color: colorProperty ? resolveColor(record[colorProperty]) : undefined
      }));
  }

  /**
   * Handle marker click - navigate to detail page
   */
  onMarkerClick(markerId: number): void {
    const entityKey = this.widget().entity_key || this.config().entityKey;
    this.router.navigate(['/view', entityKey, markerId]);
  }
}
