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

import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of } from 'rxjs';
import { read, utils, writeFileXLSX } from 'xlsx';
import { DataService } from './data.service';
import { SchemaService } from './schema.service';
import {
  EntityPropertyType,
  SchemaEntityProperty,
  SchemaEntityTable,
  ForeignKeyLookup,
  ValidationErrorSummary,
  ImportError
} from '../interfaces/entity';
import { FilterCriteria } from '../interfaces/query';

/**
 * Service for Excel import/export functionality.
 * Handles data transformation, FK lookup, validation, and SheetJS operations.
 */
@Injectable({
  providedIn: 'root'
})
export class ImportExportService {
  private data = inject(DataService);
  private schema = inject(SchemaService);

  // Safety limits
  private readonly MAX_EXPORT_ROWS = 50000;
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  /**
   * Export entity data to Excel with safety checks.
   * Includes all fields (system columns, FK display names, etc.)
   *
   * @param entity Entity to export
   * @param properties Properties for the entity
   * @param filters Active filters
   * @param searchQuery Active search
   * @param sortColumn Sort column
   * @param sortDirection Sort direction
   * @returns Promise that resolves when export completes
   */
  async exportToExcel(
    entity: SchemaEntityTable,
    properties: SchemaEntityProperty[],
    filters?: FilterCriteria[],
    searchQuery?: string,
    sortColumn?: string,
    sortDirection?: 'asc' | 'desc'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Check row count (safety limit)
      const { totalCount } = await this.data.getDataPaginated({
        key: entity.table_name,
        fields: ['id'],
        filters: filters,
        searchQuery: searchQuery,
        pagination: { page: 1, pageSize: 1 }
      }).toPromise() || { totalCount: 0 };

      if (totalCount > this.MAX_EXPORT_ROWS) {
        return {
          success: false,
          error: `Export too large (${totalCount.toLocaleString()} rows). Maximum is ${this.MAX_EXPORT_ROWS.toLocaleString()}. Please use filters to reduce the dataset size.`
        };
      }

      // 2. Prepare properties: filter out generated columns and sort by sort_order
      const exportProperties = properties
        .filter(p => p.column_name !== 'civic_os_text_search') // Exclude generated tsvector column
        .sort((a, b) => a.sort_order - b.sort_order);

      // 3. Fetch ALL data (remove pagination)
      const columns = exportProperties.map(p => SchemaService.propertyToSelectString(p));

      // Build order field
      let orderField: string | undefined = undefined;
      if (sortColumn && sortDirection) {
        const sortProperty = exportProperties.find(p => p.column_name === sortColumn);
        if (sortProperty) {
          orderField = this.buildOrderField(sortProperty);
        }
      }

      const allData = await this.data.getData({
        key: entity.table_name,
        fields: columns,
        searchQuery: searchQuery,
        orderField: orderField,
        orderDirection: sortDirection,
        filters: filters
      }).toPromise() || [];

      // 4. Transform data for export (add FK display columns)
      const exportData = this.transformForExport(allData, exportProperties);

      // 5. Generate Excel workbook
      const worksheet = utils.json_to_sheet(exportData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, entity.display_name);

      // 6. Trigger download
      const timestamp = this.getTimestamp();
      const filename = `${entity.display_name}_${timestamp}.xlsx`;
      writeFileXLSX(workbook, filename);

      return { success: true };
    } catch (error) {
      console.error('Export error:', error);
      return {
        success: false,
        error: `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Build PostgREST order field for sorting.
   */
  private buildOrderField(property: SchemaEntityProperty): string {
    if (property.type === EntityPropertyType.ForeignKeyName) {
      return `${property.column_name}(display_name)`;
    }
    if (property.type === EntityPropertyType.User) {
      return `${property.column_name}(display_name)`;
    }
    return property.column_name;
  }

  /**
   * Transform data for export by adding FK display columns.
   */
  private transformForExport(data: any[], properties: SchemaEntityProperty[]): any[] {
    return data.map(row => {
      const exportRow: any = {};

      properties.forEach(prop => {
        // Regular columns - copy with display name as key
        const value = row[prop.column_name];

        // FK columns - add both ID and display name columns
        if (prop.type === EntityPropertyType.ForeignKeyName) {
          if (value && typeof value === 'object' && 'id' in value) {
            exportRow[prop.display_name] = value.id;
            exportRow[prop.display_name + ' (Name)'] = value.display_name;
          } else {
            exportRow[prop.display_name] = value; // Just the ID
          }
        }
        // User columns - identical to FK (UUID instead of int)
        else if (prop.type === EntityPropertyType.User) {
          if (value && typeof value === 'object' && 'id' in value) {
            exportRow[prop.display_name] = value.id;
            exportRow[prop.display_name + ' (Name)'] = value.display_name;
          } else {
            exportRow[prop.display_name] = value;
          }
        }
        // GeoPoint - export as lat,lng
        else if (prop.type === EntityPropertyType.GeoPoint) {
          if (value && typeof value === 'string') {
            exportRow[prop.display_name] = this.formatAsLatLng(value);
          } else {
            exportRow[prop.display_name] = value;
          }
        }
        // M:M - export as comma-separated names (read-only)
        else if (prop.type === EntityPropertyType.ManyToMany) {
          const junctionData = value;
          if (Array.isArray(junctionData) && prop.many_to_many_meta) {
            const meta = prop.many_to_many_meta;
            const names = junctionData
              .map(item => item[meta.relatedTable]?.display_name)
              .filter(name => name);
            exportRow[prop.display_name] = names.join(', ');
          } else {
            exportRow[prop.display_name] = '';
          }
        }
        // All other types - copy as-is
        else {
          exportRow[prop.display_name] = value;
        }
      });

      return exportRow;
    });
  }

  /**
   * Convert WKT to lat,lng format for spreadsheet editing.
   * Input: "POINT(-71.0589 42.3601)" (WKT: lng lat)
   * Output: "42.3601,-71.0589" (user format: lat,lng)
   */
  private formatAsLatLng(wkt: string): string {
    const match = wkt.match(/POINT\(([^ ]+) ([^ ]+)\)/);
    if (!match) return wkt;

    const lng = parseFloat(match[1]);
    const lat = parseFloat(match[2]);

    return `${lat},${lng}`;
  }

  /**
   * Generate timestamp for filename.
   * Format: YYYY-MM-DD_HHmmss
   */
  private getTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}_${hours}${minutes}${seconds}`;
  }

  /**
   * Generate and download blank import template.
   * Includes header row, hint row, and reference sheets for FK fields.
   */
  async downloadTemplate(
    entity: SchemaEntityTable,
    properties: SchemaEntityProperty[]
  ): Promise<void> {
    // Sort and filter properties (exclude generated columns and M:M)
    const templateProperties = properties
      .filter(p => p.column_name !== 'civic_os_text_search') // Exclude generated tsvector column
      .filter(p => p.type !== EntityPropertyType.ManyToMany) // M:M import not yet supported
      .sort((a, b) => a.sort_order - b.sort_order);

    // Build hint and header rows
    // Row 1: Hints (guide text)
    // Row 2: Column headers (where user enters data)
    const hints: any = {};
    const headers: any = {};

    templateProperties.forEach(prop => {
      hints[prop.display_name] = this.getHintForProperty(prop);
      headers[prop.display_name] = prop.display_name; // Actual column name
    });

    // Create data sheet: hints first, then headers
    const dataSheet = utils.json_to_sheet([hints, headers], { skipHeader: true });

    // Create workbook
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, dataSheet, 'Import Data');

    // Add reference sheets for FK and User fields
    const referenceProps = templateProperties.filter(p =>
      p.type === EntityPropertyType.ForeignKeyName ||
      p.type === EntityPropertyType.User
    );

    for (const prop of referenceProps) {
      const refData = await this.fetchReferenceData(prop);
      const refSheet = utils.json_to_sheet(refData);
      utils.book_append_sheet(workbook, refSheet, `${prop.display_name} Options`);
    }

    // Download
    const filename = `${entity.table_name}_template.xlsx`;
    writeFileXLSX(workbook, filename);
  }

  /**
   * Get hint text for property type.
   */
  private getHintForProperty(prop: SchemaEntityProperty): string {
    switch (prop.type) {
      case EntityPropertyType.TextShort:
        return prop.character_maximum_length
          ? `Text (max ${prop.character_maximum_length} chars)`
          : 'Text';

      case EntityPropertyType.IntegerNumber:
        const rules = prop.validation_rules || [];
        const min = rules.find(r => r.type === 'min')?.value;
        const max = rules.find(r => r.type === 'max')?.value;
        return min && max ? `Number between ${min}-${max}` : 'Number';

      case EntityPropertyType.ForeignKeyName:
      case EntityPropertyType.User:
        return `Select from "${prop.display_name} Options" sheet or use ID`;

      case EntityPropertyType.Date:
        return 'Format: YYYY-MM-DD';

      case EntityPropertyType.DateTime:
      case EntityPropertyType.DateTimeLocal:
        return 'Format: YYYY-MM-DD HH:mm:ss';

      case EntityPropertyType.Boolean:
        return 'Enter: true/false or yes/no';

      case EntityPropertyType.GeoPoint:
        return 'Format: latitude,longitude (e.g., 42.3601,-71.0589)';

      case EntityPropertyType.Color:
        return 'Format: #RRGGBB (e.g., #3B82F6)';

      default:
        return '';
    }
  }

  /**
   * Fetch reference data for FK or User field.
   */
  private async fetchReferenceData(prop: SchemaEntityProperty): Promise<any[]> {
    try {
      const tableName = prop.type === EntityPropertyType.User
        ? 'civic_os_users'
        : prop.join_table;

      const columnName = prop.type === EntityPropertyType.User
        ? 'id'
        : prop.join_column;

      const data = await this.data.getData({
        key: tableName,
        fields: [columnName, 'display_name']
      }).toPromise() || [];

      return data.map(item => ({
        'ID': (item as any)[columnName],
        'Name': item.display_name
      }));
    } catch (error) {
      console.error(`Error fetching reference data for ${prop.display_name}:`, error);
      return [];
    }
  }

  /**
   * Fetch all FK and User reference data for validation (FK Hybrid Lookup).
   *
   * Builds comprehensive lookup maps to enable both ID-based and name-based
   * foreign key validation during import. This allows users to use either:
   * - Direct IDs (precise but not user-friendly)
   * - Display names (user-friendly but requires case-insensitive lookup)
   *
   * Process:
   * 1. Filter properties to FK and User types only
   * 2. For each FK property, fetch all records (id + display_name)
   * 3. Build ForeignKeyLookup structure with three maps:
   *    - displayNameToIds: Map<lowercase_name, id[]> for name→ID lookup
   *    - validIds: Set<id> for direct ID validation
   *    - idsToDisplayName: Map<id, name> for error messages
   * 4. Use forkJoin to fetch all FK data in parallel (performance optimization)
   * 5. Return Map<table_name, ForeignKeyLookup> keyed by join_table or 'civic_os_users'
   *
   * Example ForeignKeyLookup structure:
   * ```typescript
   * {
   *   displayNameToIds: Map {
   *     'john doe' => [123],
   *     'jane smith' => [456]
   *   },
   *   validIds: Set { 123, 456 },
   *   idsToDisplayName: Map {
   *     123 => 'John Doe',
   *     456 => 'Jane Smith'
   *   }
   * }
   * ```
   *
   * @param properties Array of entity properties (only FK and User types processed)
   * @returns Observable<Map<table_name, ForeignKeyLookup>> - Lookup maps keyed by table name
   *
   * @see buildForeignKeyLookup() - Constructs the ForeignKeyLookup structure
   * @see import-validation.worker.ts:validateForeignKey() - Uses these lookups
   */
  fetchForeignKeyLookups(
    properties: SchemaEntityProperty[]
  ): Observable<Map<string, ForeignKeyLookup>> {
    const referenceProps = properties.filter(p =>
      p.type === EntityPropertyType.ForeignKeyName ||
      p.type === EntityPropertyType.User
    );

    if (referenceProps.length === 0) {
      return of(new Map());
    }

    const requests = referenceProps.map(prop =>
      this.data.getData({
        key: prop.type === EntityPropertyType.User ? 'civic_os_users' : prop.join_table,
        fields: [
          prop.type === EntityPropertyType.User ? 'id' : prop.join_column,
          'display_name'
        ]
      }).pipe(
        map(data => ({
          property: prop,
          data: data,
          tableName: prop.type === EntityPropertyType.User ? 'civic_os_users' : prop.join_table
        }))
      )
    );

    return forkJoin(requests).pipe(
      map(results => {
        const lookupMap = new Map<string, ForeignKeyLookup>();

        results.forEach(result => {
          const lookup = this.buildForeignKeyLookup(
            result.data,
            result.property.type === EntityPropertyType.User
          );
          lookupMap.set(result.tableName, lookup);
        });

        return lookupMap;
      })
    );
  }

  /**
   * Build comprehensive ForeignKeyLookup structure with bidirectional maps.
   *
   * Creates three optimized lookup structures:
   * 1. **displayNameToIds**: Case-insensitive name → ID(s) lookup
   *    - Key: lowercase trimmed display name
   *    - Value: Array of IDs (handles duplicate names)
   *    - Purpose: User enters "John Doe" → find ID
   *
   * 2. **validIds**: Set of all valid IDs
   *    - Purpose: Fast O(1) direct ID validation
   *    - Handles both integer IDs (ForeignKeyName) and UUIDs (User)
   *
   * 3. **idsToDisplayName**: ID → name reverse lookup
   *    - Purpose: Error messages ("ID 123 refers to 'John Doe'")
   *
   * Duplicate Name Handling:
   * - If multiple records have same display_name, all IDs stored in array
   * - Worker validation detects length > 1 and errors: "Use ID instead"
   * - Ensures data integrity when names are ambiguous
   *
   * Performance:
   * - All lookups are O(1) with Map/Set
   * - Case-insensitive via .toLowerCase() (not locale-aware)
   * - Trimming handles accidental whitespace from Excel
   *
   * @param referenceData Array of { id, display_name } objects from database
   * @param isUser True if User property (UUID id), false if ForeignKeyName (int id)
   * @returns ForeignKeyLookup with three optimized lookup structures
   *
   * @see ForeignKeyLookup interface in entity.ts
   */
  private buildForeignKeyLookup(
    referenceData: any[],
    isUser: boolean
  ): ForeignKeyLookup {
    const lookup: ForeignKeyLookup = {
      displayNameToIds: new Map(),
      validIds: new Set(),
      idsToDisplayName: new Map()
    };

    referenceData.forEach(item => {
      const id = isUser ? item.id : item[Object.keys(item).find(k => k !== 'display_name') || 'id'];
      const displayName = item.display_name;

      // Add to validIds set
      lookup.validIds.add(id);

      // Add to reverse lookup
      lookup.idsToDisplayName.set(id, displayName);

      // Add to name-to-IDs map (case-insensitive key)
      const key = displayName.toLowerCase().trim();
      if (!lookup.displayNameToIds.has(key)) {
        lookup.displayNameToIds.set(key, []);
      }
      lookup.displayNameToIds.get(key)!.push(id);
    });

    return lookup;
  }

  /**
   * Check file size before parsing.
   */
  validateFileSize(file: File): { valid: boolean; error?: string } {
    if (file.size > this.MAX_FILE_SIZE) {
      return {
        valid: false,
        error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 10MB. Please split your data into smaller batches.`
      };
    }
    return { valid: true };
  }

  /**
   * Parse Excel file and return raw data.
   * Templates have hints in row 1 and headers in row 2.
   * User data starts from row 3.
   */
  async parseExcelFile(file: File): Promise<{ success: boolean; data?: any[]; error?: string }> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = read(arrayBuffer);
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

      // Skip row 1 (hints) and use row 2 as headers
      // range: 1 means start parsing from row 2 (0-indexed)
      const data = utils.sheet_to_json(firstSheet, { range: 1 });

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: `Failed to parse file: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Generate error report Excel file.
   */
  downloadErrorReport(
    originalData: any[],
    errorSummary: ValidationErrorSummary
  ): void {
    // Create error map for lookup
    const errorMap = new Map<number, string>();
    errorSummary.allErrors.forEach(err => {
      const key = err.row;
      const existing = errorMap.get(key) || '';
      errorMap.set(key, existing + (existing ? '; ' : '') + `${err.column}: ${err.error}`);
    });

    // Add Errors column to original data
    const dataWithErrors = originalData.map((row, index) => {
      const rowNumber = index + 3; // +3 for 1-indexing, hint row, and header
      return {
        ...row,
        'Errors': errorMap.get(rowNumber) || ''
      };
    });

    // Create workbook
    const worksheet = utils.json_to_sheet(dataWithErrors);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, 'Data with Errors');

    // Add summary sheet
    const summaryData = [
      { Metric: 'Total Errors', Value: errorSummary.totalErrors },
      { Metric: 'Rows with Errors', Value: new Set(errorSummary.allErrors.map(e => e.row)).size },
      { Metric: '', Value: '' },
      { Metric: 'Errors by Type', Value: '' },
      ...Array.from(errorSummary.errorsByType.entries()).map(([type, count]) => ({
        Metric: type,
        Value: count
      }))
    ];
    const summarySheet = utils.json_to_sheet(summaryData);
    utils.book_append_sheet(workbook, summarySheet, 'Summary');

    // Download
    const timestamp = this.getTimestamp();
    writeFileXLSX(workbook, `import_errors_${timestamp}.xlsx`);
  }
}
