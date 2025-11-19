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

import { Component, input, computed, inject, ChangeDetectionStrategy, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { DashboardWidget, MapWidgetConfig } from '../../../interfaces/dashboard';
import { GeoPointMapComponent, MapMarker } from '../../geo-point-map/geo-point-map.component';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { EntityData, SchemaEntityProperty } from '../../../interfaces/entity';
import { DataQuery } from '../../../interfaces/query';

/**
 * Map Widget Component
 *
 * Displays filtered entity records with geography columns on an interactive map.
 * Supports clustering, filtering, and navigation to detail pages.
 *
 * Phase 2 implementation - basic functionality without auto-refresh.
 */
@Component({
  selector: 'app-map-widget',
  imports: [CommonModule, GeoPointMapComponent],
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
  isLoading = signal(true);
  error = signal<string | null>(null);

  // Effect to fetch data when query params change
  constructor() {
    effect(() => {
      const params = this.queryParams();
      const cfg = this.config();

      if (!params) {
        this.markers.set([]);
        this.isLoading.set(false);
        return;
      }

      this.isLoading.set(true);
      this.error.set(null);

      // First fetch properties to build proper select strings
      this.schemaService.getProperties().subscribe({
        next: (allProps: SchemaEntityProperty[]) => {
          const entityProps = allProps.filter(p => p.table_name === params.key);

          // Build columns to fetch: map property + display name + show columns
          const columnNames = [
            'id',
            'display_name',
            cfg.mapPropertyName,
            ...(cfg.showColumns || [])
          ];
          const uniqueColumns = [...new Set(columnNames)];

          // Filter properties and build select strings
          const propsToSelect = entityProps.filter(p => uniqueColumns.includes(p.column_name));
          const columns = propsToSelect.map(p => SchemaService.propertyToSelectString(p));

          // Add computed WKT field for geography column
          columns.push(`${cfg.mapPropertyName}_text`);

          // Build query with proper select strings
          const query: DataQuery = {
            ...params,
            fields: columns
          };

          // Fetch filtered data
          this.dataService.getData(query).subscribe({
            next: (response: EntityData[]) => {
              this.markers.set(this.transformToMarkers(response, cfg.mapPropertyName));
              this.isLoading.set(false);
            },
            error: (err: any) => {
              console.error('Map widget error:', err);
              this.error.set(err.message || 'Failed to load map data');
              this.markers.set([]);
              this.isLoading.set(false);
            }
          });
        },
        error: (err: any) => {
          console.error('Error loading properties:', err);
          this.error.set('Failed to load schema');
          this.isLoading.set(false);
        }
      });
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
   * Handle marker click - navigate to detail page
   */
  onMarkerClick(markerId: number): void {
    const entityKey = this.widget().entity_key || this.config().entityKey;
    this.router.navigate(['/view', entityKey, markerId]);
  }
}
