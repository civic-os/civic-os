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

/// <reference lib="webworker" />

import * as chrono from 'chrono-node';

/**
 * CRITICAL: EntityPropertyType Enum Duplication
 *
 * This enum is duplicated from src/app/interfaces/entity.ts because Web Workers
 * run in a separate thread context and CANNOT import from the main application thread.
 *
 * IMPORTANT MAINTENANCE NOTES:
 * 1. This enum MUST be kept in sync with EntityPropertyType in entity.ts
 * 2. Any changes to EntityPropertyType in entity.ts MUST be mirrored here
 * 3. Failure to sync will cause validation errors for new property types
 * 4. Consider using a build-time script to automate synchronization in the future
 *
 * Why this duplication is necessary:
 * - Web Workers execute in isolated contexts (no shared memory)
 * - Workers cannot use ES6 imports (module resolution is limited)
 * - Attempting to import causes runtime errors: "Cannot use import statement outside a module"
 * - The worker needs property type constants for type-specific validation logic
 *
 * Alternative approaches considered:
 * - Dynamic import(): Not supported in worker contexts
 * - SharedArrayBuffer: Overkill for simple enum values
 * - Message passing: Would add complexity and performance overhead
 * - Build-time code injection: Would require custom webpack configuration
 *
 * @see src/app/interfaces/entity.ts - Source of truth for EntityPropertyType
 * @see docs/development/IMPORT_EXPORT.md - Architecture documentation
 */
const EntityPropertyType = {
  Unknown: 0,
  TextShort: 1,
  TextLong: 2,
  Boolean: 3,
  Date: 4,
  DateTime: 5,
  DateTimeLocal: 6,
  Money: 7,
  IntegerNumber: 8,
  DecimalNumber: 9,
  ForeignKeyName: 10,
  User: 11,
  GeoPoint: 12,
  Color: 13,
  Email: 14,
  Telephone: 15,
  TimeSlot: 16,
  ManyToMany: 17,
  File: 18,
  FileImage: 19,
  FilePDF: 20,
  Payment: 21,
  Status: 22,
  RecurringTimeSlot: 23
};

interface ImportError {
  row: number;
  column: string;
  value: any;
  error: string;
  errorType: string;
}

interface ValidationErrorSummary {
  totalErrors: number;
  errorsByType: Map<string, number>;
  errorsByColumn: Map<string, number>;
  firstNErrors: ImportError[];
  allErrors: ImportError[];
}

/**
 * Cancellation flag - set to true when main thread sends 'cancel' message.
 * Checked during validation loop to allow early termination.
 */
let cancelled = false;

/**
 * Main message handler for Web Worker.
 *
 * Receives two message types:
 * - 'cancel': Stops validation in progress and sends 'cancelled' response
 * - 'validate': Starts validation with provided data, properties, and FK lookups
 *
 * @listens message
 */
addEventListener('message', ({ data }) => {
  if (data.type === 'cancel') {
    cancelled = true;
    postMessage({ type: 'cancelled' });
    return;
  }

  if (data.type === 'validate') {
    cancelled = false;
    validateData(data.data);
  }
});

/**
 * Core validation function - processes import rows with chunked progress updates.
 *
 * Validation Pipeline:
 * 1. Iterate through all rows from Excel file
 * 2. For each property in each row:
 *    a. Skip M:M properties (not yet supported for import)
 *    b. Skip system columns (id, created_at, updated_at)
 *    c. Handle NULL values (set null for nullable fields, error for required fields)
 *    d. Validate type-specific constraints (text length, number range, FK lookup, etc.)
 * 3. Build validatedRow with column_name keys (not display_name)
 * 4. Ensure ALL rows have identical keys (PostgREST PGRST102 requirement)
 * 5. Send progress updates every N rows (chunked to avoid flooding main thread)
 * 6. Build error summary with type grouping and column grouping
 * 7. Send completion message with valid rows and error summary
 *
 * CRITICAL: PostgREST bulk insert requires all objects to have identical keys.
 * Even nullable fields must be present with null values (line 145-147).
 *
 * @param params Object containing:
 *   - rows: Array of raw Excel data (display_name as keys)
 *   - properties: Array of SchemaEntityProperty objects
 *   - fkLookups: Serialized FK lookup maps (displayNameToIds, validIds, idsToDisplayName)
 *   - entityKey: Table name for the entity being imported
 *
 * @fires progress - Sends validation progress percentage updates
 * @fires complete - Sends validation results (valid rows and error summary)
 * @fires cancelled - Sends cancellation acknowledgment
 */
function validateData(params: any): void {
  const { rows, properties, fkLookups, entityKey } = params;

  const validRows: any[] = [];
  const allErrors: ImportError[] = [];
  const errorsByType = new Map<string, number>();
  const errorsByColumn = new Map<string, number>();

  const totalRows = rows.length;
  const chunkSize = totalRows > 1000 ? 100 : 10;

  for (let i = 0; i < totalRows; i++) {
    if (cancelled) {
      postMessage({ type: 'cancelled' });
      return;
    }

    const row = rows[i];
    const rowNumber = i + 3; // +3 for 1-indexed, hint row, and header row
    const rowErrors: ImportError[] = [];

    const validatedRow: any = {};

    // Validate each property
    for (const prop of properties) {
      // Skip M:M properties (not supported for import)
      if (prop.type === EntityPropertyType.ManyToMany) {
        continue;
      }

      // Skip File/Payment properties (system-managed, require upload/payment workflows)
      if (prop.type === EntityPropertyType.File ||
          prop.type === EntityPropertyType.FileImage ||
          prop.type === EntityPropertyType.FilePDF ||
          prop.type === EntityPropertyType.Payment) {
        continue;
      }

      // Skip system columns (id, created_at, updated_at)
      if (['id', 'created_at', 'updated_at'].includes(prop.column_name)) {
        continue;
      }

      const displayName = prop.display_name;

      // TimeSlot properties read from TWO columns: (Start) and (End)
      if (prop.type === EntityPropertyType.TimeSlot) {
        const startCol = displayName + ' (Start)';
        const endCol = displayName + ' (End)';
        const startValue = row[startCol];
        const endValue = row[endCol];

        // NULL handling for TimeSlot
        const startEmpty = startValue === null || startValue === undefined || startValue === '';
        const endEmpty = endValue === null || endValue === undefined || endValue === '';

        if (startEmpty && endEmpty) {
          if (!prop.is_nullable) {
            rowErrors.push({
              row: rowNumber,
              column: startCol,
              value: '',
              error: 'This field is required',
              errorType: 'Required field missing'
            });
          } else {
            validatedRow[prop.column_name] = null;
          }
          continue;
        }

        // Both must be provided if either is
        if (startEmpty || endEmpty) {
          rowErrors.push({
            row: rowNumber,
            column: startEmpty ? startCol : endCol,
            value: startEmpty ? startValue : endValue,
            error: 'Both start and end times are required for a time slot',
            errorType: 'TimeSlot incomplete'
          });
          continue;
        }

        // Validate and combine TimeSlot
        try {
          const validatedValue = validateTimeSlot(startValue, endValue, rowNumber, displayName, rowErrors);
          if (validatedValue !== undefined) {
            validatedRow[prop.column_name] = validatedValue;
          }
        } catch (error) {
          rowErrors.push({
            row: rowNumber,
            column: displayName,
            value: `${startValue} - ${endValue}`,
            error: error instanceof Error ? error.message : 'TimeSlot validation error',
            errorType: 'TimeSlot error'
          });
        }
        continue;
      }

      const value = row[displayName];

      // NULL handling
      if (value === null || value === undefined || value === '') {
        if (!prop.is_nullable) {
          rowErrors.push({
            row: rowNumber,
            column: displayName,
            value: value,
            error: 'This field is required',
            errorType: 'Required field missing'
          });
        } else {
          // Add null value to ensure consistent keys across all rows
          // PostgREST bulk insert requires all objects to have identical keys
          validatedRow[prop.column_name] = null;
        }
        continue;
      }

      // Type-specific validation
      try {
        const validatedValue = validateProperty(prop, value, fkLookups, rowNumber, displayName, rowErrors);
        if (validatedValue !== undefined) {
          validatedRow[prop.column_name] = validatedValue;
        }
      } catch (error) {
        rowErrors.push({
          row: rowNumber,
          column: displayName,
          value: value,
          error: error instanceof Error ? error.message : 'Validation error',
          errorType: 'Validation error'
        });
      }
    }

    // If no errors, add to valid rows
    if (rowErrors.length === 0) {
      validRows.push(validatedRow);
    } else {
      allErrors.push(...rowErrors);

      // Track error stats
      rowErrors.forEach(err => {
        errorsByType.set(err.errorType, (errorsByType.get(err.errorType) || 0) + 1);
        errorsByColumn.set(err.column, (errorsByColumn.get(err.column) || 0) + 1);
      });
    }

    // Send progress updates
    if (i % chunkSize === 0 || i === totalRows - 1) {
      const percentage = Math.round(((i + 1) / totalRows) * 100);
      postMessage({
        type: 'progress',
        progress: {
          currentRow: i + 1,
          totalRows: totalRows,
          percentage: percentage,
          stage: 'Validating'
        }
      });
    }
  }

  // Build summary
  const errorSummary: ValidationErrorSummary = {
    totalErrors: allErrors.length,
    errorsByType: errorsByType,
    errorsByColumn: errorsByColumn,
    firstNErrors: allErrors.slice(0, 100),
    allErrors: allErrors
  };

  // Send completion
  postMessage({
    type: 'complete',
    results: {
      validRows: validRows,
      errorSummary: errorSummary
    }
  });
}

/**
 * Route property validation to type-specific validator function.
 *
 * Acts as a dispatcher that delegates to specialized validation functions
 * based on the property's EntityPropertyType.
 *
 * @param prop Property metadata (type, validation_rules, join_table, etc.)
 * @param value Raw value from Excel cell
 * @param fkLookups FK lookup maps for foreign key validation
 * @param rowNumber Excel row number (for error reporting)
 * @param displayName Property display name (for error messages)
 * @param rowErrors Array to collect validation errors
 * @returns Validated and transformed value ready for database insertion
 */
function validateProperty(
  prop: any,
  value: any,
  fkLookups: any,
  rowNumber: number,
  displayName: string,
  rowErrors: ImportError[]
): any {
  switch (prop.type) {
    case EntityPropertyType.TextShort:
    case EntityPropertyType.TextLong:
      return validateText(prop, value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.IntegerNumber:
      return validateInteger(prop, value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.Money:
      return validateMoney(prop, value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.Boolean:
      return validateBoolean(value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.Date:
    case EntityPropertyType.DateTime:
    case EntityPropertyType.DateTimeLocal:
      return validateDateTime(prop, value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.ForeignKeyName:
    case EntityPropertyType.User:
    case EntityPropertyType.Status:
      return validateForeignKey(prop, value, fkLookups, rowNumber, displayName, rowErrors);

    case EntityPropertyType.GeoPoint:
      return validateGeoPoint(value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.Color:
      return validateColor(value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.Email:
      return validateEmail(value, rowNumber, displayName, rowErrors);

    case EntityPropertyType.Telephone:
      return validateTelephone(value, rowNumber, displayName, rowErrors);

    default:
      return value;
  }
}

function validateText(prop: any, value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): string {
  const str = String(value).trim();

  // Validation rules
  if (prop.validation_rules) {
    for (const rule of prop.validation_rules) {
      if (rule.type === 'minLength' && str.length < parseInt(rule.value)) {
        rowErrors.push({
          row: rowNumber,
          column: displayName,
          value: value,
          error: rule.message || `Must be at least ${rule.value} characters`,
          errorType: 'Text length error'
        });
      }
      if (rule.type === 'maxLength' && str.length > parseInt(rule.value)) {
        rowErrors.push({
          row: rowNumber,
          column: displayName,
          value: value,
          error: rule.message || `Must be at most ${rule.value} characters`,
          errorType: 'Text length error'
        });
      }
      if (rule.type === 'pattern' && !new RegExp(rule.value).test(str)) {
        rowErrors.push({
          row: rowNumber,
          column: displayName,
          value: value,
          error: rule.message || 'Invalid format',
          errorType: 'Pattern mismatch'
        });
      }
    }
  }

  return str;
}

function validateInteger(prop: any, value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): number {
  const num = parseInt(String(value));

  if (isNaN(num)) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Must be a valid number',
      errorType: 'Invalid number'
    });
    return 0;
  }

  // Validation rules
  if (prop.validation_rules) {
    for (const rule of prop.validation_rules) {
      if (rule.type === 'min' && num < parseFloat(rule.value)) {
        rowErrors.push({
          row: rowNumber,
          column: displayName,
          value: value,
          error: rule.message || `Must be at least ${rule.value}`,
          errorType: 'Number range error'
        });
      }
      if (rule.type === 'max' && num > parseFloat(rule.value)) {
        rowErrors.push({
          row: rowNumber,
          column: displayName,
          value: value,
          error: rule.message || `Must be at most ${rule.value}`,
          errorType: 'Number range error'
        });
      }
    }
  }

  return num;
}

function validateMoney(prop: any, value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): number {
  const num = parseFloat(String(value).replace(/[^0-9.-]/g, ''));

  if (isNaN(num)) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Must be a valid monetary value',
      errorType: 'Invalid money'
    });
    return 0;
  }

  return num;
}

function validateBoolean(value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): boolean {
  const str = String(value).toLowerCase().trim();

  if (['true', 'yes', '1', 'y'].includes(str)) return true;
  if (['false', 'no', '0', 'n'].includes(str)) return false;

  rowErrors.push({
    row: rowNumber,
    column: displayName,
    value: value,
    error: 'Must be true/false or yes/no',
    errorType: 'Invalid boolean'
  });
  return false;
}

/**
 * Convert Excel serial date number to JavaScript Date.
 *
 * Excel stores dates as floating-point numbers representing days since
 * January 1, 1900 (with a leap year bug for 1900). The decimal portion
 * represents the time of day.
 *
 * Examples:
 * - 45991.729166666664 = Nov 30, 2025 5:30 PM
 * - 45991.833333333333 = Nov 30, 2025 8:00 PM
 *
 * @param serial Excel serial date number
 * @returns JavaScript Date object
 */
function excelSerialToDate(serial: number): Date {
  // Excel epoch is January 1, 1900, but Excel incorrectly treats 1900 as a leap year
  // Days 1-59 are Jan 1 - Feb 28, 1900
  // Day 60 is the phantom Feb 29, 1900 (doesn't exist)
  // Days 61+ need adjustment
  // JavaScript epoch is January 1, 1970

  // Excel serial 1 = Jan 1, 1900
  // But we need to account for the Excel leap year bug (day 60 = Feb 29, 1900 which doesn't exist)
  const excelEpoch = new Date(Date.UTC(1899, 11, 30)); // Dec 30, 1899 (Excel day 0)

  // Split into days and fractional time
  const days = Math.floor(serial);
  const timeFraction = serial - days;

  // Calculate the date
  const date = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);

  // Add the time component (fraction of day in milliseconds)
  const timeMs = Math.round(timeFraction * 24 * 60 * 60 * 1000);
  date.setTime(date.getTime() + timeMs);

  return date;
}

/**
 * Check if a string looks like an Excel serial date number.
 *
 * Excel serial dates are positive numbers, typically in the range:
 * - 1 = Jan 1, 1900
 * - 44197 = Jan 1, 2021
 * - 45658 = Jan 1, 2025
 * - 73050 = Dec 31, 2099
 *
 * We check for numbers in a reasonable range (1900-2100) to avoid
 * misinterpreting other numeric values.
 */
function isExcelSerialDate(value: string): boolean {
  const num = parseFloat(value);
  if (isNaN(num)) return false;

  // Check if it's a pure number (no letters or special chars except decimal point)
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return false;

  // Excel serial dates for years 1900-2100 are roughly 1 to 73415
  // We use a slightly wider range to be safe
  return num >= 1 && num <= 100000;
}

/**
 * Parse date/time with flexible format support using chrono-node.
 *
 * Accepts many human-readable date formats:
 * - ISO: 2025-11-30T20:00:00, 2025-11-30 20:00:00
 * - US: 11/30/2025 8:00 PM, 11/30/25 8pm
 * - Natural: Nov 30, 2025 8pm, November 30 at 8pm
 * - Relative: tomorrow 3pm, next Monday 9am
 * - Excel serial: 45991.729166666664 (Nov 30, 2025 5:30 PM)
 *
 * Uses chrono-node library for natural language parsing with fallback
 * to native Date for standard ISO formats, and Excel serial date conversion.
 *
 * @param input Raw date/time string from Excel cell
 * @returns Parsed Date object, or null if parsing failed
 */
function parseFlexibleDate(input: string): Date | null {
  const trimmed = input.trim();

  // Check for Excel serial date format FIRST (before chrono misinterprets it)
  if (isExcelSerialDate(trimmed)) {
    const serial = parseFloat(trimmed);
    return excelSerialToDate(serial);
  }

  // Try chrono-node for natural language and various formats
  const chronoResult = chrono.parseDate(trimmed);
  if (chronoResult) {
    return chronoResult;
  }

  // Fallback to native Date for ISO formats chrono might miss
  const nativeDate = new Date(trimmed);
  if (!isNaN(nativeDate.getTime())) {
    return nativeDate;
  }

  return null;
}

function validateDateTime(prop: any, value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): string {
  const str = String(value).trim();

  // Try flexible parsing with chrono-node
  const date = parseFlexibleDate(str);
  if (!date) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Could not parse date/time. Examples: "2025-11-30 20:00", "11/30/25 8pm", "Nov 30, 2025 8:00 PM"',
      errorType: 'Invalid datetime'
    });
    return str;
  }

  // Format based on type
  if (prop.type === EntityPropertyType.Date) {
    return date.toISOString().split('T')[0];
  } else if (prop.type === EntityPropertyType.DateTimeLocal) {
    return date.toISOString();
  } else {
    // DateTime - no timezone
    return date.toISOString().replace('Z', '').replace('.000', '');
  }
}

/**
 * Validate TimeSlot (tstzrange) by combining start and end datetimes.
 *
 * Accepts two datetime values (from split columns) and combines them into
 * PostgreSQL tstzrange format: ["start","end")
 *
 * Uses flexible date parsing via chrono-node to accept various formats:
 * - ISO: 2025-11-30T20:00:00, 2025-11-30 20:00:00
 * - US: 11/30/2025 8:00 PM, 11/30/25 8pm
 * - Natural: Nov 30, 2025 8pm, November 30 at 8pm
 *
 * Validation:
 * 1. Both values must parse as valid dates
 * 2. End must be after start
 *
 * @param startValue Start datetime from Excel
 * @param endValue End datetime from Excel
 * @param rowNumber Excel row number (for error reporting)
 * @param displayName Property display name (for error messages)
 * @param rowErrors Array to collect validation errors
 * @returns PostgreSQL tstzrange string, or undefined if validation failed
 */
function validateTimeSlot(
  startValue: any,
  endValue: any,
  rowNumber: number,
  displayName: string,
  rowErrors: ImportError[]
): string | undefined {
  const startStr = String(startValue).trim();
  const endStr = String(endValue).trim();

  // Parse dates with flexible format support
  const startDate = parseFlexibleDate(startStr);
  const endDate = parseFlexibleDate(endStr);

  // Validate start
  if (!startDate) {
    rowErrors.push({
      row: rowNumber,
      column: displayName + ' (Start)',
      value: startValue,
      error: 'Could not parse start date/time. Examples: "2025-11-30 20:00", "11/30/25 8pm", "Nov 30, 2025 8:00 PM"',
      errorType: 'Invalid datetime'
    });
    return undefined;
  }

  // Validate end
  if (!endDate) {
    rowErrors.push({
      row: rowNumber,
      column: displayName + ' (End)',
      value: endValue,
      error: 'Could not parse end date/time. Examples: "2025-11-30 20:00", "11/30/25 8pm", "Nov 30, 2025 8:00 PM"',
      errorType: 'Invalid datetime'
    });
    return undefined;
  }

  // Validate end > start
  if (endDate <= startDate) {
    rowErrors.push({
      row: rowNumber,
      column: displayName + ' (End)',
      value: endValue,
      error: 'End time must be after start time',
      errorType: 'TimeSlot range error'
    });
    return undefined;
  }

  // Format as PostgreSQL tstzrange: ["start","end")
  // Use ISO format with timezone for proper storage
  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();

  return `["${startISO}","${endISO}")`;
}

/**
 * Validate foreign key with hybrid ID/name lookup (FK Hybrid Display approach).
 *
 * Accepts EITHER:
 * - Direct ID values (e.g., 5 or "a1b2c3d4-uuid")
 * - Display names (case-insensitive, e.g., "John Doe" → ID lookup)
 *
 * This enables flexible data entry:
 * - Power users can use IDs for precision
 * - Regular users can use human-readable names
 * - Export → Edit → Import workflow preserves both ID and Name columns
 *
 * Validation Logic:
 * 1. Check if value is a valid ID (direct match in validIds Set)
 * 2. If not ID, perform case-insensitive name lookup in displayNameToIds Map
 * 3. If name matches multiple IDs, error (ambiguous - user must use ID)
 * 4. If name matches one ID, return that ID
 * 5. If no match, error (not found)
 *
 * @param prop Property metadata (join_table, join_column, type)
 * @param value Raw value from Excel (ID or display name)
 * @param fkLookups FK lookup maps from main thread
 * @param rowNumber Excel row number (for error reporting)
 * @param displayName Property display name (for error messages)
 * @param rowErrors Array to collect validation errors
 * @returns Validated ID value, or null if validation failed
 *
 * @see docs/development/IMPORT_EXPORT.md - FK Hybrid Display architecture
 */
function validateForeignKey(
  prop: any,
  value: any,
  fkLookups: any,
  rowNumber: number,
  displayName: string,
  rowErrors: ImportError[]
): any {
  // Determine lookup table name based on property type:
  // - User: always 'civic_os_users'
  // - Status: 'status_<entity_type>' (e.g., 'status_issues') for entity-specific statuses
  // - FK: the join_table directly
  let tableName: string;
  if (prop.type === EntityPropertyType.User) {
    tableName = 'civic_os_users';
  } else if (prop.type === EntityPropertyType.Status) {
    tableName = `status_${prop.status_entity_type}`;
  } else {
    tableName = prop.join_table;
  }
  const lookup = fkLookups[tableName];

  if (!lookup) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'FK lookup not available',
      errorType: 'System error'
    });
    return null;
  }

  // Check if value is an ID
  if (lookup.validIds.includes(value)) {
    return value;
  }

  // Try name lookup (case-insensitive)
  const nameKey = String(value).toLowerCase().trim();
  const ids = lookup.displayNameToIds[nameKey];

  if (!ids || ids.length === 0) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: `"${value}" not found in ${displayName}`,
      errorType: `${displayName} not found`
    });
    return null;
  }

  if (ids.length > 1) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: `"${value}" matches multiple ${displayName} entries. Use ID instead.`,
      errorType: `Duplicate ${displayName}`
    });
    return null;
  }

  return ids[0];
}

function validateGeoPoint(value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): string {
  const str = String(value).trim();

  // Check if already in WKT format
  if (str.startsWith('POINT(')) {
    return `SRID=4326;${str}`;
  }

  // Parse lat,lng format
  const parts = str.split(',').map(p => p.trim());
  if (parts.length !== 2) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Must be in format: latitude,longitude (e.g., 42.36,-71.06)',
      errorType: 'Invalid geopoint'
    });
    return str;
  }

  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);

  if (isNaN(lat) || isNaN(lng)) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Latitude and longitude must be valid numbers',
      errorType: 'Invalid geopoint'
    });
    return str;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Latitude must be between -90 and 90, longitude between -180 and 180',
      errorType: 'Invalid geopoint'
    });
    return str;
  }

  // Convert to WKT (note: WKT is lng,lat not lat,lng)
  return `SRID=4326;POINT(${lng} ${lat})`;
}

function validateColor(value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): string {
  const str = String(value).trim().toUpperCase();

  // Check hex color format
  if (!/^#[0-9A-F]{6}$/.test(str)) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Must be in format #RRGGBB (e.g., #3B82F6)',
      errorType: 'Invalid color'
    });
    return str;
  }

  return str;
}

/**
 * Validate email address using RFC 5322 simplified pattern.
 *
 * Accepts standard email formats like:
 * - user@example.com
 * - john.doe@company.co.uk
 * - test+tag@domain.org
 *
 * @param value Raw value from Excel cell
 * @param rowNumber Excel row number (for error reporting)
 * @param displayName Property display name (for error messages)
 * @param rowErrors Array to collect validation errors
 * @returns Validated email address (trimmed, lowercase)
 */
function validateEmail(value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): string {
  const str = String(value).trim().toLowerCase();

  // RFC 5322 simplified email validation (matches PostgreSQL email_address domain)
  const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  if (!emailPattern.test(str)) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Must be a valid email address (e.g., user@example.com)',
      errorType: 'Invalid email'
    });
    return str;
  }

  return str;
}

/**
 * Validate US phone number (10 digits, no formatting).
 *
 * Accepts various input formats and strips to 10 digits:
 * - 5551234567 (preferred format)
 * - (555) 123-4567
 * - 555-123-4567
 * - 555.123.4567
 *
 * @param value Raw value from Excel cell
 * @param rowNumber Excel row number (for error reporting)
 * @param displayName Property display name (for error messages)
 * @param rowErrors Array to collect validation errors
 * @returns 10-digit phone number string (digits only)
 */
function validateTelephone(value: any, rowNumber: number, displayName: string, rowErrors: ImportError[]): string {
  const str = String(value).trim();

  // Strip all non-digit characters
  const digits = str.replace(/\D/g, '');

  // Must be exactly 10 digits (US phone number)
  if (digits.length !== 10) {
    rowErrors.push({
      row: rowNumber,
      column: displayName,
      value: value,
      error: 'Must be a 10-digit US phone number (e.g., 5551234567 or (555) 123-4567)',
      errorType: 'Invalid phone number'
    });
    return digits;
  }

  return digits;
}
