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

import { Component, input, Output, EventEmitter, signal, computed, inject, effect, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EntityPropertyType, SchemaEntityProperty } from '../../interfaces/entity';
import { FilterCriteria } from '../../interfaces/query';
import { DataService } from '../../services/data.service';
import { SchemaService } from '../../services/schema.service';

interface FilterState {
  [column: string]: any;
}

interface FilterOption {
  id: any;
  display_name: string;
}

// Static payment status options for filtering
const PAYMENT_STATUS_OPTIONS: FilterOption[] = [
  { id: 'pending_intent', display_name: 'Pending Intent' },
  { id: 'pending', display_name: 'Pending' },
  { id: 'succeeded', display_name: 'Succeeded' },
  { id: 'failed', display_name: 'Failed' },
  { id: 'canceled', display_name: 'Canceled' },
  { id: 'refunded', display_name: 'Refunded' },
  { id: 'partially_refunded', display_name: 'Partially Refunded' },
];

@Component({
  selector: 'app-filter-bar',
  imports: [CommonModule, FormsModule],
  templateUrl: './filter-bar.component.html',
  styleUrl: './filter-bar.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FilterBarComponent {
  private dataService = inject(DataService);
  private schemaService = inject(SchemaService);

  properties = input<SchemaEntityProperty[]>([]);
  entityKey = input<string | undefined>(undefined);
  currentFilters = input<FilterCriteria[]>([]);
  @Output() filtersChange = new EventEmitter<FilterCriteria[]>();

  public isExpanded = signal(false);
  public filterState = signal<FilterState>({});
  public filterOptions = signal<Map<string, FilterOption[]>>(new Map());

  private previousEntityKey?: string;

  // Property type enum exposed to template
  public EntityPropertyType = EntityPropertyType;

  // Count active filters that match filterable columns
  // Range filters (gte+lte pairs) count as one filter
  public activeFilterCount = computed(() => {
    const filters = this.currentFilters();
    const filterableColumns = new Set(this.properties().map(p => p.column_name));

    // Filter to only filterable columns
    const relevantFilters = filters.filter(f => filterableColumns.has(f.column));

    // Group filters by column name
    const columnGroups = new Map<string, FilterCriteria[]>();
    relevantFilters.forEach(filter => {
      if (!columnGroups.has(filter.column)) {
        columnGroups.set(filter.column, []);
      }
      columnGroups.get(filter.column)!.push(filter);
    });

    // Count: range pairs (gte+lte together) count as 1
    let count = 0;
    columnGroups.forEach(filtersForColumn => {
      const operators = filtersForColumn.map(f => f.operator);
      const hasGte = operators.includes('gte');
      const hasLte = operators.includes('lte');

      if (hasGte && hasLte) {
        // This column has both gte and lte - that's a range filter
        // Count it as 1, plus any other filters on this column
        count += 1;
        if (filtersForColumn.length > 2) {
          count += filtersForColumn.length - 2;
        }
      } else {
        // No range pair - count all filters normally
        count += filtersForColumn.length;
      }
    });

    return count;
  });

  // Calculate max width based on number of filterable properties
  // Each column is 250px, gap is 16px, padding is 32px total
  public dropdownMaxWidth = computed(() => {
    const propCount = this.properties().length;
    const columns = Math.min(propCount, 4); // Cap at 4 columns
    const columnWidth = 250;
    const gapWidth = 16;
    const paddingWidth = 32;

    const width = (columnWidth * columns) + (gapWidth * (columns - 1)) + paddingWidth;
    return `${width}px`;
  });

  // Calculate grid columns string
  public gridColumns = computed(() => {
    const propCount = this.properties().length;
    const columns = Math.min(propCount, 4); // Cap at 4 columns
    return `repeat(${columns}, 250px)`;
  });

  // Load FK, User, Status, and Payment filter options when properties change
  private _loadOptionsEffect = effect(() => {
    const props = this.properties(); // Read signal value
    if (props && props.length > 0) {
      props.forEach(prop => {
        if (prop.type === EntityPropertyType.ForeignKeyName && prop.join_table) {
          this.loadFilterOptions(prop.column_name, prop.join_table);
        } else if (prop.type === EntityPropertyType.User) {
          this.loadFilterOptions(prop.column_name, 'civic_os_users');
        } else if (prop.type === EntityPropertyType.Status && prop.status_entity_type) {
          // Status type: load options via RPC filtered by entity_type
          this.loadStatusOptions(prop.column_name, prop.status_entity_type);
        } else if (prop.type === EntityPropertyType.Payment) {
          // Payment type uses static status options (not from database)
          const options = this.filterOptions();
          options.set(prop.column_name, PAYMENT_STATUS_OPTIONS);
          this.filterOptions.set(new Map(options));
        }
      });
    }
  });

  // Clear filter state when entity changes
  private _clearOnEntityChange = effect(() => {
    const key = this.entityKey(); // Read signal value

    // Only clear if entityKey actually changed (not on first init)
    if (this.previousEntityKey !== undefined && key !== this.previousEntityKey) {
      this.filterState.set({});
      this.filterOptions.set(new Map());
      this.isExpanded.set(false);
    }

    // Track the current key for next comparison
    this.previousEntityKey = key;
  });

  // Sync currentFilters input → filterState (for URL loading/external changes)
  // This is the reverse transformation of onFilterChange()
  private _syncFiltersToState = effect(() => {
    const filters = this.currentFilters();
    const props = this.properties();

    if (!props || props.length === 0) {
      return; // Wait for properties to load
    }

    // Build new filter state from criteria
    const newState: FilterState = {};

    filters.forEach(filter => {
      const prop = props.find(p => p.column_name === filter.column);
      if (!prop) return; // Skip filters for unknown columns

      switch (prop.type) {
        case EntityPropertyType.IntegerNumber:
        case EntityPropertyType.Money:
          // Reverse transformation: gte → column_min, lte → column_max
          if (filter.operator === 'gte') {
            newState[`${filter.column}_min`] = filter.value;
          } else if (filter.operator === 'lte') {
            newState[`${filter.column}_max`] = filter.value;
          }
          break;

        case EntityPropertyType.DateTime:
        case EntityPropertyType.DateTimeLocal:
        case EntityPropertyType.Date:
          // Reverse transformation: gte → column_start, lte → column_end
          if (filter.operator === 'gte') {
            newState[`${filter.column}_start`] = filter.value;
          } else if (filter.operator === 'lte') {
            newState[`${filter.column}_end`] = filter.value;
          }
          break;

        case EntityPropertyType.ForeignKeyName:
        case EntityPropertyType.User:
        case EntityPropertyType.Status:
          // Reverse transformation: in:(1,2,3) → [1, 2, 3] or ["uuid1", "uuid2"]
          if (filter.operator === 'in') {
            const match = filter.value.match(/\(([^)]+)\)/);
            if (match) {
              const ids = match[1].split(',');
              // For FK and Status, convert to numbers; for User (UUID), keep as strings
              newState[filter.column] = prop.type === EntityPropertyType.User
                ? ids.map((id: string) => id.trim())
                : ids.map((id: string) => Number(id.trim()));
            }
          }
          break;

        case EntityPropertyType.Payment:
          // Reverse transformation for embedded resource filter
          // Filter column is "column.effective_status", need to extract base column
          if (filter.column === `${prop.column_name}.effective_status` && filter.operator === 'in') {
            const match = filter.value.match(/\(([^)]+)\)/);
            if (match) {
              const statuses = match[1].split(',').map((s: string) => s.trim());
              newState[prop.column_name] = statuses;
            }
          }
          break;

        case EntityPropertyType.Boolean:
          // Reverse transformation: is:true → 'true', is:false → 'false'
          if (filter.operator === 'is') {
            newState[filter.column] = filter.value;
          }
          break;
      }
    });

    this.filterState.set(newState);
  });

  private loadFilterOptions(columnName: string, tableName: string) {
    this.dataService.getData({
      key: tableName,
      fields: ['id', 'display_name'],
      orderField: 'display_name',
      orderDirection: 'asc'
    }).subscribe(data => {
      const options = this.filterOptions();
      options.set(columnName, data as FilterOption[]);
      this.filterOptions.set(new Map(options));
    });
  }

  private loadStatusOptions(columnName: string, entityType: string) {
    // Use SchemaService's cached status retrieval
    this.schemaService.getStatusesForEntity(entityType).subscribe(statusOptions => {
      const options = this.filterOptions();
      options.set(columnName, statusOptions.map(s => ({
        id: s.id,
        display_name: s.display_name
      })));
      this.filterOptions.set(new Map(options));
    });
  }

  public toggleExpanded() {
    this.isExpanded.set(!this.isExpanded());
  }

  public onFilterChange() {
    // Build filter criteria from current state
    const criteria: FilterCriteria[] = [];
    const state = this.filterState();

    this.properties().forEach(prop => {
      switch (prop.type) {
        case EntityPropertyType.ForeignKeyName:
        case EntityPropertyType.User:
        case EntityPropertyType.Status:
          // Checkbox multi-select: use 'in' operator
          const value = state[prop.column_name];
          if (Array.isArray(value) && value.length > 0) {
            criteria.push({
              column: prop.column_name,
              operator: 'in',
              value: `(${value.join(',')})`
            });
          }
          break;

        case EntityPropertyType.Payment:
          // Payment status filter: use embedded resource filtering
          // PostgREST syntax: column.effective_status=in.(value1,value2)
          const paymentStatuses = state[prop.column_name];
          if (Array.isArray(paymentStatuses) && paymentStatuses.length > 0) {
            criteria.push({
              column: `${prop.column_name}.effective_status`,
              operator: 'in',
              value: `(${paymentStatuses.join(',')})`
            });
          }
          break;

        case EntityPropertyType.Boolean:
          // Boolean: use 'is' operator
          const boolValue = state[prop.column_name];
          if (boolValue !== null && boolValue !== undefined && boolValue !== 'all' && boolValue !== '') {
            criteria.push({
              column: prop.column_name,
              operator: 'is',
              value: boolValue
            });
          }
          break;

        case EntityPropertyType.DateTime:
        case EntityPropertyType.DateTimeLocal:
        case EntityPropertyType.Date:
          // Date range: split into start/end
          const startKey = `${prop.column_name}_start`;
          const endKey = `${prop.column_name}_end`;
          if (state[startKey]) {
            criteria.push({
              column: prop.column_name,
              operator: 'gte',
              value: state[startKey]
            });
          }
          if (state[endKey]) {
            criteria.push({
              column: prop.column_name,
              operator: 'lte',
              value: state[endKey]
            });
          }
          break;

        case EntityPropertyType.IntegerNumber:
        case EntityPropertyType.Money:
          // Numeric range: split into min/max
          const minKey = `${prop.column_name}_min`;
          const maxKey = `${prop.column_name}_max`;
          if (state[minKey] !== null && state[minKey] !== undefined && state[minKey] !== '') {
            criteria.push({
              column: prop.column_name,
              operator: 'gte',
              value: state[minKey]
            });
          }
          if (state[maxKey] !== null && state[maxKey] !== undefined && state[maxKey] !== '') {
            criteria.push({
              column: prop.column_name,
              operator: 'lte',
              value: state[maxKey]
            });
          }
          break;
      }
    });

    this.filtersChange.emit(criteria);
  }

  public toggleOption(columnName: string, optionId: any) {
    const state = this.filterState();
    const currentValues = state[columnName] || [];

    let newValues: any[];
    if (currentValues.includes(optionId)) {
      // Remove if already selected
      newValues = currentValues.filter((id: any) => id !== optionId);
    } else {
      // Add if not selected
      newValues = [...currentValues, optionId];
    }

    // Update state
    const newState = { ...state };
    if (newValues.length === 0) {
      // Remove the property entirely if array is empty
      delete newState[columnName];
    } else {
      newState[columnName] = newValues;
    }
    this.filterState.set(newState);

    this.onFilterChange();
  }

  public isOptionSelected(columnName: string, optionId: any): boolean {
    const state = this.filterState();
    const currentValues = state[columnName] || [];
    return currentValues.includes(optionId);
  }

  public onDateChange(event: Event, key: string) {
    const input = event.target as HTMLInputElement;
    const newState = { ...this.filterState() };
    newState[key] = input.value;
    this.filterState.set(newState);
    this.onFilterChange();
  }

  public onNumberChange(event: Event, key: string) {
    const input = event.target as HTMLInputElement;
    const newState = { ...this.filterState() };
    newState[key] = input.value ? Number(input.value) : '';
    this.filterState.set(newState);
    this.onFilterChange();
  }

  public clearAllFilters() {
    this.filterState.set({});
    this.filtersChange.emit([]);
  }

  public getFilterOptions(columnName: string): FilterOption[] {
    return this.filterOptions().get(columnName) || [];
  }
}
