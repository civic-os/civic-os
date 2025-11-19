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
import { DashboardWidget, FilteredListWidgetConfig } from '../../../interfaces/dashboard';
import { DisplayPropertyComponent } from '../../display-property/display-property.component';
import { DataService } from '../../../services/data.service';
import { SchemaService } from '../../../services/schema.service';
import { SchemaEntityProperty, EntityData } from '../../../interfaces/entity';
import { DataQuery } from '../../../interfaces/query';

/**
 * Filtered List Widget Component
 *
 * Displays filtered entity records in a compact table format.
 * Clicking a row navigates to the detail page.
 *
 * Phase 2 implementation - basic functionality without auto-refresh.
 */
@Component({
  selector: 'app-filtered-list-widget',
  imports: [CommonModule, DisplayPropertyComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './filtered-list-widget.component.html',
  styleUrl: './filtered-list-widget.component.css'
})
export class FilteredListWidgetComponent {
  // Widget configuration from parent dashboard
  widget = input.required<DashboardWidget>();

  // Typed configuration (extract from JSONB config)
  config = computed<FilteredListWidgetConfig>(() => {
    const cfg = this.widget().config as FilteredListWidgetConfig;

    // Provide defaults for optional fields
    return {
      ...cfg,
      filters: cfg.filters ?? [],
      orderBy: cfg.orderBy ?? 'id',
      orderDirection: cfg.orderDirection ?? 'desc',
      limit: cfg.limit ?? 10,
      showColumns: cfg.showColumns ?? ['display_name']
    };
  });

  private dataService = inject(DataService);
  private schemaService = inject(SchemaService);
  private router = inject(Router);

  // Signals for component state
  isLoading = signal(true);
  error = signal<string | null>(null);
  properties = signal<SchemaEntityProperty[]>([]);
  records = signal<any[]>([]);

  // Computed signal for query parameters (derives from input signals)
  // Note: fields will be populated in the effect after fetching properties
  private queryParams = computed(() => {
    const cfg = this.config();
    const entityKey = this.widget().entity_key;

    if (!entityKey) {
      return null;
    }

    // Build query object (fields added in effect)
    return {
      key: entityKey,
      fields: [], // Populated in effect using propertyToSelectString
      filters: cfg.filters,
      orderField: cfg.orderBy,
      orderDirection: cfg.orderDirection as 'asc' | 'desc' | undefined
    } as DataQuery;
  });

  // Effect to fetch data and properties when query params change
  constructor() {
    effect(() => {
      const params = this.queryParams();
      const cfg = this.config();

      if (!params) {
        this.records.set([]);
        this.isLoading.set(false);
        return;
      }

      this.isLoading.set(true);
      this.error.set(null);

      // First fetch properties to build proper select strings
      this.schemaService.getProperties().subscribe({
        next: (allProps: SchemaEntityProperty[]) => {
          const entityProps = allProps.filter(p => p.table_name === params.key);
          this.properties.set(entityProps);

          // Build select strings using propertyToSelectString for proper foreign key expansion
          const showCols = cfg.showColumns || [];
          const propsToSelect = entityProps.filter(p =>
            p.column_name === 'id' || showCols.includes(p.column_name)
          );
          const columns = propsToSelect.map(p => SchemaService.propertyToSelectString(p));

          // Build query with proper select strings
          const query: DataQuery = {
            ...params,
            fields: columns
          };

          // Fetch filtered data with proper column expansion
          this.dataService.getData(query).subscribe({
            next: (response: EntityData[]) => {
              this.records.set(response);
              this.isLoading.set(false);
            },
            error: (err: any) => {
              console.error('Filtered list widget error:', err);
              this.error.set('Failed to load data');
              this.records.set([]);
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
   * Get property metadata for a column
   */
  getProperty(columnName: string): SchemaEntityProperty | undefined {
    return this.properties().find(p => p.column_name === columnName);
  }

  /**
   * Navigate to detail page when row is clicked
   */
  onRowClick(recordId: number): void {
    const entityKey = this.widget().entity_key || (this.config() as any).entityKey;
    this.router.navigate(['/view', entityKey, recordId]);
  }

  /**
   * Get display label for column
   */
  getColumnLabel(columnName: string): string {
    const property = this.getProperty(columnName);
    return property?.display_name || columnName;
  }
}
