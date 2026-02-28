# Import/Export Feature Specification

## Overview

This document specifies the implementation of Excel import/export functionality for Civic OS list views. The feature enables users to export data to spreadsheets for analysis and bulk-import records from Excel files with comprehensive validation.

**Related Documentation:**
- `docs/INTEGRATOR_GUIDE.md` - Integrator overview, use cases, and configuration
- `CLAUDE.md` - Brief feature mention for developers

**Key Features:**
- Export entire datasets (including system fields) to Excel
- Import records from Excel with FK name-to-ID resolution
- Permission-based access control (import requires CREATE permission)
- Case-insensitive FK lookups with duplicate detection
- Performance-optimized validation using Web Workers
- Comprehensive error reporting with limits and grouping
- File size and memory safety limits

## Implementation Status

### ✅ Completed Features (Version 1.0 - October 2025)

**Core Export:**
- ✅ Export with safety limits (MAX_EXPORT_ROWS = 50,000)
- ✅ Dual-column FK export (ID + display name)
- ✅ Filter, search, and sort preservation
- ✅ System field inclusion (id, created_at, updated_at)
- ✅ GeoPoint export as lat,lng format
- ✅ M:M export as comma-separated names (read-only)
- ✅ Property sorting by sort_order
- ✅ Exclusion of generated columns (civic_os_text_search)

**Core Import:**
- ✅ Template generation with hints and reference sheets
- ✅ File size validation (MAX_FILE_SIZE = 10MB)
- ✅ Web Worker background validation (non-blocking UI)
- ✅ FK hybrid lookup (accept IDs or names)
- ✅ Case-insensitive name matching
- ✅ Duplicate name detection with ambiguity errors
- ✅ System column ignoring (id, created_at, updated_at)
- ✅ Type validation for all EntityPropertyTypes
- ✅ Validation rule enforcement (from metadata.validations)
- ✅ NULL handling with type-specific empty string rules
- ✅ PostgREST bulk insert with all-or-nothing transaction
- ✅ Error reporting with grouping and limits (first 100 shown)
- ✅ Error report download (Excel with Errors column)
- ✅ Progress reporting with adaptive chunking
- ✅ Cancellation support during validation
- ✅ UUID validation for User fields

**Entity Notes Export (v0.16.0 - December 2025):**
- ✅ **Notes Worksheet Export**: Entities with `enable_notes=true` show "Include notes" checkbox modal on export
- ✅ **Author Full Name**: Notes export displays author's `full_name` with fallback to `display_name`
- ✅ **User Column Full Name**: All User columns now export `full_name` (previously only `display_name`)
- ✅ **Markdown Stripping**: Note content is stripped of markdown formatting for clean Excel output

**Recent Bug Fixes (October 2025):**
- ✅ **PGRST102 Fix**: Nullable fields now set to null instead of being skipped, ensuring all rows have identical keys for PostgREST bulk insert
- ✅ **Error Display**: Fixed error handling to show user-friendly messages when import fails after validation
- ✅ **M:M Template Exclusion**: Many-to-many properties excluded from import templates (not yet supported for direct import)
- ✅ **Button Styling**: Import/Export/Filter buttons now have consistent sizing and alignment
- ✅ **Related Records Navigation**: Fixed "View All" button navigation for large relationships (>1000 records)
- ✅ **Metadata Preservation**: Fixed `upsert_entity_metadata()` to preserve existing search_fields when NULL is passed

**Custom Import Mode (v0.31.0 - February 2026):**
- ✅ **CustomImportConfig abstraction**: Pluggable column definitions, submit logic, and template generation
- ✅ **Inline validation**: Type-specific validators (email, phone, boolean, comma-list) without Web Worker
- ✅ **Partial success handling**: Three-outcome display for RPCs with per-row error reporting
- ✅ **User import**: First consumer — bulk user provisioning from User Management page
- ✅ **Template generation**: `generateUserImportTemplate()` with Available Roles reference sheet

**Inline Documentation (October 2025):**
- ✅ Comprehensive JSDoc comments added to all implementation files
- ✅ EntityPropertyType enum duplication in worker thoroughly documented
- ✅ Web Worker architecture and message passing explained
- ✅ FK hybrid lookup strategy documented with examples
- ✅ Structured clone serialization notes for Map/Set transfer

### 🚧 Not Yet Implemented

**Many-to-Many Import:**
- ❌ M:M properties in main entity templates (use junction table import instead)
- ✅ **Workaround Available**: Power users can import to junction tables directly using dual FK hybrid lookup

**Advanced Features (Planned for Future):**
See [Future Enhancements](#future-enhancements) section below for:
- Server-side validation RPC (for datasets > 1,000 rows)
- Update mode (edit existing records via ID)
- CSV format support
- Import history and audit log
- Scheduled imports
- Async/RPC validators (uniqueness checks, cross-field validation)
- Fuzzy matching for FK lookups (typo suggestions)
- Row-by-row fallback mode (granular error reporting after bulk insert failure)
- Data transformation scripts

### 📋 Known Limitations

1. **All-or-Nothing Transactions**: PostgREST bulk insert is transactional. If ANY row fails database constraints (even after validation passes), the ENTIRE import is rejected. Users must fix all errors and re-upload.

2. **M:M Import**: Many-to-many relationships cannot be imported via main entity. Power users must import directly to junction tables.

3. **File Size Limit**: 10MB maximum file size. Larger datasets must be split into batches.

4. **Export Row Limit**: 50,000 rows maximum. Larger exports must use filters to reduce size.

5. **No Update Mode**: Import only supports INSERT operations. Cannot update existing records by ID.

## Technology Stack

### SheetJS (xlsx) Library

**Chosen Library**: SheetJS Community Edition version 0.20.3+

**Rationale:**
- Official Angular integration documentation (Angular 2-20+)
- Most mature and widely adopted Excel library for JavaScript
- Simple API for both reading and writing spreadsheets
- Good performance for typical datasets (< 10,000 rows)
- No known security vulnerabilities in recent versions (0.20.3+)
- Free and open source (Apache 2.0 license)

**Installation:**
```bash
npm i --save https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

**Basic Usage:**
```typescript
import { read, utils, writeFileXLSX } from 'xlsx';

// Reading
const workbook = read(fileData);
const rows = utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

// Writing
const worksheet = utils.json_to_sheet(data);
const workbook = utils.book_new();
utils.book_append_sheet(workbook, worksheet, 'Data');
writeFileXLSX(workbook, 'export.xlsx');
```

### PostgREST Bulk Insert

PostgREST supports efficient bulk inserts via JSON array POST:

```http
POST /table_name
Content-Type: application/json

[
  { "column1": "value1", "column2": "value2" },
  { "column1": "value3", "column2": "value4" }
]
```

**Benefits:**
- Single HTTP request
- Single SQL INSERT statement
- Atomic operation (all-or-nothing with transaction rollback)
- Efficient for batch operations (100s-1000s of rows)

**CRITICAL LIMITATION - All-or-Nothing Transactions:**

⚠️ **PostgREST bulk insert is TRANSACTIONAL** - if ANY row fails database constraints (even after client-side validation passes), the **ENTIRE import will be rejected**. No rows will be inserted.

Common reasons for rejection:
- Unique constraint violations (duplicate keys)
- Check constraint violations (business rules)
- Foreign key constraint violations (race conditions)
- NOT NULL violations (edge cases not caught by validation)

**User Guidance:**
When errors occur after validation, display this warning:
```
⚠️ Import Failed - All-or-Nothing Transaction

The database rejected the import due to constraint violations.
Even though validation passed, one or more rows violated database rules.

Common issues:
• Duplicate values in unique fields
• Race condition (referenced record was deleted)
• Business rule violations

Action: Download the error details, fix ALL errors, and re-upload the entire file.
```

**Future Enhancement:** Implement row-by-row fallback mode:
1. Try bulk insert (fast path)
2. If fails, retry row-by-row to identify specific failures
3. Report which rows succeeded/failed
4. Much slower but provides granular error reporting

## Foreign Key Mapping Strategy

### Column Naming Convention

**IMPORTANT: Use display names for all column headers** to maintain user-friendliness.

Export headers:
- FK ID column: `"Status"` (property.display_name)
- FK display column: `"Status (Name)"` (property.display_name + " (Name)")

Example export:
```
Title          | Status | Status (Name) | Priority | Assigned To | Assigned To (Name)
Fix login bug  | 3      | In Progress   | 2        | a1b2c3...   | John Doe
Add dark mode  | 1      | Open          | 3        | d4e5f6...   | Jane Smith
```

Import mapping: Build `Map<display_name, property>` to convert headers back to schema.

### Export: Dual-Column Approach

For every foreign key field (including User fields), export TWO columns:
1. **ID column**: The actual foreign key value (integer or UUID)
2. **Display column**: The human-readable name

**Benefits:**
- Users can edit either column in spreadsheet
- ID column ensures precision (no ambiguity)
- Display column improves readability
- Hybrid import strategy maximizes flexibility

### Import: Hybrid Priority (ID First)

When importing, handle three scenarios with **ID prioritized over display name**:

```typescript
// Example for FK field "Status"
const idValue = row['Status'];           // ID column
const displayValue = row['Status (Name)']; // Display name column

if (idValue && displayValue) {
  // Scenario 1: Both columns present
  // Priority: Use ID, ignore display_name
  // Rationale: ID is unambiguous, name might be hand-typed/modified
  finalData.status_id = validateAndConvertId(idValue, fkLookup);

} else if (idValue) {
  // Scenario 2: ID only
  // Validate ID exists in reference data
  finalData.status_id = validateAndConvertId(idValue, fkLookup);

} else if (displayValue) {
  // Scenario 3: Display name only
  // Lookup ID via case-insensitive name matching with duplicate detection
  const ids = fkLookup.displayNameToIds.get(displayValue.toLowerCase().trim());

  if (!ids || ids.length === 0) {
    throw new ValidationError(`"${displayValue}" not found in Status`);
  } else if (ids.length > 1) {
    throw new ValidationError(
      `Ambiguous value "${displayValue}" matches multiple records (IDs: ${ids.join(', ')}). ` +
      `Please use the "Status" column (ID) instead.`
    );
  }

  finalData.status_id = ids[0]; // Single match - safe
}
```

### Foreign Key Lookup Data Structure

**CRITICAL FIX**: Use a comprehensive data structure that supports both ID validation and name lookup:

```typescript
/**
 * Complete FK lookup structure.
 * Supports: ID validation, name-to-ID lookup, and reverse lookup for error messages.
 */
interface ForeignKeyLookup {
  // Name-to-IDs mapping (handles duplicates)
  // Key: lowercase display_name, Value: array of matching IDs
  displayNameToIds: Map<string, (number | string)[]>;

  // Fast ID existence check
  // Contains all valid IDs for this FK field
  validIds: Set<number | string>;

  // Reverse lookup for error messages
  // Key: ID, Value: display_name (original casing)
  idsToDisplayName: Map<number | string, string>;
}
```

**Building the lookup:**
```typescript
function buildForeignKeyLookup(
  referenceData: { id: number | string; display_name: string }[]
): ForeignKeyLookup {
  const lookup: ForeignKeyLookup = {
    displayNameToIds: new Map(),
    validIds: new Set(),
    idsToDisplayName: new Map()
  };

  referenceData.forEach(item => {
    // Add to validIds set
    lookup.validIds.add(item.id);

    // Add to reverse lookup
    lookup.idsToDisplayName.set(item.id, item.display_name);

    // Add to name-to-IDs map (case-insensitive key)
    const key = item.display_name.toLowerCase().trim();
    if (!lookup.displayNameToIds.has(key)) {
      lookup.displayNameToIds.set(key, []);
    }
    lookup.displayNameToIds.get(key)!.push(item.id);
  });

  return lookup;
}
```

**ID Validation:**
```typescript
function validateForeignKeyId(
  idValue: number | string,
  lookup: ForeignKeyLookup,
  fieldLabel: string
): number | string {
  if (!lookup.validIds.has(idValue)) {
    throw new ValidationError(
      `${fieldLabel} ID "${idValue}" does not exist. ` +
      `Please check the "${fieldLabel} Options" reference sheet for valid IDs.`
    );
  }
  return idValue;
}
```

**Name Lookup with Duplicate Detection:**
```typescript
function lookupForeignKeyId(
  displayName: string,
  lookup: ForeignKeyLookup,
  fieldLabel: string,
  columnName: string
): number | string {
  const key = displayName.toLowerCase().trim();
  const ids = lookup.displayNameToIds.get(key);

  // Not found
  if (!ids || ids.length === 0) {
    throw new ValidationError(
      `"${displayName}" not found in ${fieldLabel}. ` +
      `Please check spelling or use the "${columnName}" column with a valid ID.`
    );
  }

  // Ambiguous (duplicates)
  if (ids.length > 1) {
    const displayNames = ids.map(id => lookup.idsToDisplayName.get(id) || id).join(', ');
    throw new ValidationError(
      `Ambiguous value "${displayName}" matches multiple records (IDs: ${ids.join(', ')}). ` +
      `The "${fieldLabel}" field has duplicate names. ` +
      `Please use the "${columnName}" column (ID) instead to specify the exact record.`
    );
  }

  // Single match - safe to use
  return ids[0];
}
```

### User Type Columns (UUID Foreign Keys)

**IMPORTANT: User columns work IDENTICALLY to FK columns** with the hybrid lookup approach. The only difference is data type:
- **FK columns**: Integer IDs (int4/int8)
- **User columns**: UUID IDs (uuid)

**UUID Validation:**
```typescript
function validateUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

// In validation logic
if (prop.type === EntityPropertyType.User && idValue) {
  if (typeof idValue === 'string' && !validateUUID(idValue)) {
    throw new ValidationError(
      `${prop.display_name} must be a valid UUID, got: ${idValue}`
    );
  }
  // Then validate UUID exists in validIds set
  if (!userLookup.validIds.has(idValue)) {
    throw new ValidationError(`${prop.display_name} ID "${idValue}" does not exist`);
  }
}
```

**User column export/import is identical to FK columns:**
- Export: `"Assigned To"` (UUID) and `"Assigned To (Name)"` (display name)
- Import: Hybrid lookup with case-insensitive name matching and duplicate detection

### Case-Insensitive Matching Rules

- Convert both stored names and user input to lowercase: `.toLowerCase()`
- Trim whitespace from both: `.trim()`
- Handles variations: "In Progress", "in progress", " IN PROGRESS ", "IN PROGRESS"

## NULL Handling

**Explicit rules for NULL value interpretation:**

```typescript
/**
 * Parse nullable values with explicit NULL handling.
 */
function parseNullableValue(value: any, property: SchemaEntityProperty): any {
  // Explicit NULL markers (case-insensitive)
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase();
    if (upper === 'NULL' || upper === '') {
      // Empty string handling depends on field type
      if (upper === '' && !property.is_nullable) {
        // Empty string on required field - validation error
        throw new ValidationError(`${property.display_name} is required`);
      }

      // Text fields can have empty strings
      if (property.type === EntityPropertyType.TextShort ||
          property.type === EntityPropertyType.TextLong) {
        return upper === 'NULL' ? null : ''; // "NULL" → null, "" → ""
      }

      // Other types: empty or "NULL" → null
      return null;
    }
  }

  return value;
}
```

**Summary:**
- `null` / `undefined` / `"NULL"` (case-insensitive) → `null`
- `""` (empty string) → depends on type:
  - Text fields: `""` is valid empty string (if nullable)
  - Other fields: `null`
- Required fields with null → validation error

## Export Feature

### Scope

**Export ALL data** (not just importable fields):
- System fields: `id`, `created_at`, `updated_at`
- All entity columns (including generated/identity fields)
- FK fields: Both ID and display_name columns
- User fields: Both UUID and display_name columns
- Computed fields where applicable

**Rationale**: Export is for data analysis, backup, and reporting - not exclusively for re-import.

### User Permissions

**No permission check required** - any user who can view the list can export it. This follows the principle: "If you can see it, you can export it."

### Filtering & Sorting

Export respects the user's current view state:
- **Search query**: If user searched for "urgent", export only matching records
- **Filters**: If user filtered by status, export only filtered records
- **Sort order**: Export in the same order as displayed (if sorted)
- **Pagination**: Ignored - export ALL matching records (not just current page)

### Memory Safety Limits

**CRITICAL: Check dataset size before export to prevent browser crashes**

```typescript
const MAX_EXPORT_ROWS = 50000; // Safety limit for browser memory

async exportToExcel() {
  // 1. Get total count first (lightweight query)
  const { totalCount } = await this.data.getDataPaginated({
    ...query,
    pagination: { page: 1, pageSize: 1 }
  });

  // 2. Check against limit
  if (totalCount > MAX_EXPORT_ROWS) {
    this.toast.error(
      `Export too large (${totalCount.toLocaleString()} rows). ` +
      `Maximum is ${MAX_EXPORT_ROWS.toLocaleString()}. ` +
      `Please use filters to reduce the dataset size.`
    );
    return;
  }

  // 3. Warn for large exports
  if (totalCount > 10000) {
    this.toast.warning(
      `Large export (${totalCount.toLocaleString()} rows) may take a minute. ` +
      `Please wait...`
    );
  }

  // 4. Proceed with export
  const allData = await this.fetchAllDataForExport();
  // ... continue export logic
}
```

### UI

**Button Location**: List page toolbar, next to the "Add" button

**Button HTML:**
```html
<button class="btn btn-secondary" (click)="onExport()">
  <span class="material-symbols-outlined">download</span>
  <span class="hidden sm:inline">Export</span>
</button>
```

**Filename Format**: `{entity_display_name}_{YYYY-MM-DD_HHmmss}.xlsx`
- Example: `Issues_2025-10-15_143022.xlsx`
- Timestamp ensures uniqueness and helps with version tracking

**User Experience**:
- No modal - instant download trigger
- Brief loading indicator if data fetch takes > 500ms
- Success toast notification: "Exported 127 issues to Excel"

### Implementation Details

**High-Level Flow:**
```typescript
async exportToExcel() {
  // 1. Check row count (safety limit)
  const { totalCount } = await this.getRowCount();
  if (totalCount > MAX_EXPORT_ROWS) {
    this.showError('Dataset too large');
    return;
  }

  // 2. Fetch ALL data (remove pagination, keep filters/search/sort)
  const allData = await this.fetchAllDataForExport();

  // 3. Get ALL properties (not just create-visible)
  const properties = await this.schema.getPropertiesForEntity(this.entity);

  // 4. Transform data to flat structure with FK display columns
  const exportData = this.transformForExport(allData, properties);

  // 5. Generate Excel workbook
  const worksheet = XLSX.utils.json_to_sheet(exportData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, this.entity.display_name);

  // 6. Trigger download
  const filename = `${this.entity.display_name}_${this.getTimestamp()}.xlsx`;
  XLSX.writeFileXLSX(workbook, filename);

  // 7. Show success toast
  this.toast.success(`Exported ${allData.length} ${this.entity.display_name.toLowerCase()}`);
}
```

**FK and User Display Column Generation:**
```typescript
transformForExport(data: any[], properties: SchemaEntityProperty[]): any[] {
  return data.map(row => {
    const exportRow: any = {};

    properties.forEach(prop => {
      // Regular columns - copy as-is
      exportRow[prop.display_name] = row[prop.column_name];

      // FK columns - add display column
      if (prop.type === EntityPropertyType.ForeignKeyName) {
        const fkData = row[prop.column_name];

        // PostgREST returns embedded object: {id: 3, display_name: "In Progress"}
        if (fkData && typeof fkData === 'object') {
          exportRow[prop.display_name] = fkData.id;
          exportRow[prop.display_name + ' (Name)'] = fkData.display_name;
        } else {
          exportRow[prop.display_name] = fkData; // Just the ID
        }
      }

      // User columns - identical to FK handling (UUID instead of int)
      if (prop.type === EntityPropertyType.User) {
        const userData = row[prop.column_name];
        if (userData && typeof userData === 'object') {
          exportRow[prop.display_name] = userData.id; // UUID
          exportRow[prop.display_name + ' (Name)'] = userData.display_name;
        } else {
          exportRow[prop.display_name] = userData; // Just the UUID
        }
      }

      // GeoPoint - export as lat,lng (user-friendly format)
      if (prop.type === EntityPropertyType.GeoPoint) {
        const wkt = row[prop.column_name];
        if (wkt && typeof wkt === 'string') {
          exportRow[prop.display_name] = formatAsLatLng(wkt); // "42.36,-71.06"
        }
      }

      // M:M relationships - export as comma-separated display names (read-only)
      if (prop.type === EntityPropertyType.ManyToMany) {
        const junctionData = row[prop.column_name];
        if (Array.isArray(junctionData)) {
          const meta = prop.many_to_many_meta!;
          const names = junctionData
            .map(item => item[meta.relatedTable]?.display_name)
            .filter(name => name);
          exportRow[prop.display_name] = names.join(', ');
        }
      }
    });

    return exportRow;
  });
}

/**
 * Convert WKT to lat,lng format for user-friendly spreadsheet editing.
 * Input: "POINT(-71.0589 42.3601)" (WKT format: lng lat)
 * Output: "42.3601,-71.0589" (user format: lat,lng)
 */
function formatAsLatLng(wkt: string): string {
  const match = wkt.match(/POINT\(([^ ]+) ([^ ]+)\)/);
  if (!match) return wkt; // Fallback to original

  const lng = parseFloat(match[1]);
  const lat = parseFloat(match[2]);

  return `${lat},${lng}`; // lat,lng format
}
```

## Import Feature

### User Permissions

**Permission Check**: Only show "Import" button if `entity.insert === true`

Import requires CREATE permission on the entity. Users without this permission should not see the import button.

```typescript
// In template
@if (entity.insert) {
  <button class="btn btn-primary" (click)="openImportModal()">
    <span class="material-symbols-outlined">upload</span>
    <span class="hidden sm:inline">Import</span>
  </button>
}
```

### File Size Limits

**CRITICAL: Check file size before parsing to prevent browser crashes**

```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

onFileSelected(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];

  if (!file) return;

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    this.error.set(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). ` +
      `Maximum size is 10MB. ` +
      `Please split your data into smaller batches (e.g., 5,000 rows per file).`
    );
    return;
  }

  this.selectedFile.set(file);
  this.startValidation();
}
```

### Handling System Columns During Import

**CRITICAL: Ignore system/generated columns** to allow re-importing exported files.

Export includes `id`, `created_at`, `updated_at` (for data analysis).
Import template excludes these (uses `getPropsForCreate()`).

**Solution: Silently ignore known system columns**

```typescript
// Build header-to-property map
const headerMap = new Map<string, SchemaEntityProperty>();
properties.forEach(prop => {
  headerMap.set(prop.display_name, prop);

  // FK/User fields also accept "(Name)" suffix variant
  if (prop.type === EntityPropertyType.ForeignKeyName ||
      prop.type === EntityPropertyType.User) {
    headerMap.set(prop.display_name + ' (Name)', { ...prop, isDisplayColumn: true });
  }
});

// Ignore system columns during import
const IGNORED_COLUMNS = new Set([
  'id', 'ID', 'Id',
  'created_at', 'Created At', 'Created',
  'updated_at', 'Updated At', 'Updated'
]);

// Validate headers
const fileHeaders = Object.keys(rawData[0] || {});
const unknownColumns = fileHeaders.filter(h =>
  !headerMap.has(h) && !IGNORED_COLUMNS.has(h)
);

if (unknownColumns.length > 0) {
  console.warn(`Unknown columns will be ignored: ${unknownColumns.join(', ')}`);
  // Don't error - just skip these columns
}
```

### UI Flow: Multi-Step Modal

The import process uses a DaisyUI modal with 5 distinct steps. Each step is shown based on the current state.

#### Step 1: Choose Action (Initial State)

```
╔═══════════════════════════════════════════════════════════════════╗
║  Import Issues                                            [×]      ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Import data from an Excel spreadsheet (.xlsx, .xls, .csv)      ║
║  Maximum file size: 10MB                                         ║
║                                                                   ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │  📄 Download Template                                  │     ║
║  │                                                         │     ║
║  │  Get a blank spreadsheet with the correct column       │     ║
║  │  headers and format hints. Includes a reference sheet  │     ║
║  │  with valid values for dropdown fields.                │     ║
║  │                                                         │     ║
║  │         [📥 Download issues_template.xlsx]             │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │  📤 Upload Your File                                   │     ║
║  │                                                         │     ║
║  │  Select a file to import. We'll validate the data      │     ║
║  │  before importing.                                      │     ║
║  │                                                         │     ║
║  │         [📁 Choose File]  No file selected             │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║                                        [Cancel]                  ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Component State:**
```typescript
interface ImportModalState {
  step: 'choose' | 'validating' | 'results' | 'preview' | 'importing' | 'success';
  file?: File;
  validationProgress?: {
    currentRow: number;
    totalRows: number;
    stage: 'types' | 'fk_lookup' | 'validation_rules' | 'duplicates';
  };
  validationResults?: {
    validRows: any[];
    errorSummary: ValidationErrorSummary;
  };
  importProgress?: {
    imported: number;
    total: number;
  };
}
```

#### Step 2: Validation in Progress

```
╔═══════════════════════════════════════════════════════════════════╗
║  Import Issues                                            [×]      ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  File: issues_import_2025-10-15.xlsx (127 rows)                 ║
║                                                                   ║
║  Validating Import Data...                                       ║
║                                                                   ║
║  ┌──────────────────────────────────────────────────────┐       ║
║  │  [████████████████░░░░░░░░░] 72%                     │       ║
║  └──────────────────────────────────────────────────────┘       ║
║                                                                   ║
║  Processing row 91 of 127                                        ║
║  • Checking required fields...                ✓                  ║
║  • Validating data types...                   ✓                  ║
║  • Looking up foreign key references...       ⏳                 ║
║  • Checking validation rules...               -                  ║
║                                                                   ║
║                                        [Cancel Validation]       ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Cancellation Support:**
```typescript
cancelValidation() {
  this.validationWorker?.postMessage({ type: 'cancel' });
  this.validationWorker?.terminate();
  this.step.set('choose');
  this.validationProgress.set(undefined);
}

// In worker
let cancelled = false;
self.addEventListener('message', (event) => {
  if (event.data.type === 'cancel') {
    cancelled = true;
  }
});

// Check in validation loop
if (cancelled) {
  self.postMessage({ type: 'cancelled' });
  return;
}
```

#### Step 3a: Validation Results (With Errors)

**ERROR DISPLAY WITH LIMITS AND GROUPING:**

```
╔═══════════════════════════════════════════════════════════════════╗
║  Import Issues                                            [×]      ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Validation Results                                              ║
║                                                                   ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │  ⚠️  Found 1,234 errors in 892 rows                    │     ║
║  │                                                         │     ║
║  │  ✅ 4,108 rows are valid and ready to import          │     ║
║  │  ❌ 892 rows have errors                               │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║  Error Summary (by type):                                        ║
║  • Status not found: 450 occurrences                            ║
║  • Priority out of range: 384 occurrences                       ║
║  • Description required: 400 occurrences                        ║
║                                                                   ║
║  First 10 errors:                                                ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │ Row │ Column      │ Error                              │     ║
║  ├─────┼─────────────┼────────────────────────────────────┤     ║
║  │  12 │ Status      │ "Complted" not found               │     ║
║  │  45 │ Priority    │ Value must be between 1 and 5      │     ║
║  │  67 │ Description │ Required field is empty            │     ║
║  │  89 │ Status      │ "Pending" not found                │     ║
║  │ ... │ ...         │ ...                                │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║  [📥 Download Full Error Report (all 1,234 errors)]             ║
║                                                                   ║
║  What would you like to do?                                      ║
║  ○ Fix errors and re-upload file                                ║
║  ○ Import 4,108 valid rows and skip the 892 with errors        ║
║                                                                   ║
║                            [Cancel]  [Import Valid Rows] →      ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Error Summary Structure:**
```typescript
interface ValidationErrorSummary {
  totalErrors: number;
  errorsByType: Map<string, number>; // "Status not found" → 450
  errorsByColumn: Map<string, number>; // "Status" → 450
  firstNErrors: ImportError[]; // First 100 for display
  allErrors: ImportError[]; // All errors for download
}

interface ImportError {
  row: number;
  column: string;
  value: any;
  error: string;
  errorType: string; // For grouping
}
```

**Error Report Download**: Generate Excel file with:
- All original data
- Additional "Errors" column with concatenated error messages
- Conditional formatting: Error rows highlighted in red
- Filter enabled on Errors column
- Summary sheet with error statistics

#### Step 3b: Validation Results (No Errors - Preview)

```
╔═══════════════════════════════════════════════════════════════════╗
║  Import Issues                                            [×]      ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Ready to Import                                                 ║
║                                                                   ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │  ✅ All 127 rows validated successfully!               │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║  Preview (first 5 rows):                                         ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │ Title              │ Status      │ Priority │ Assignee  │     ║
║  ├────────────────────┼─────────────┼──────────┼───────────┤     ║
║  │ Fix login bug      │ In Progress │ 2        │ John Doe  │     ║
║  │ Add dark mode      │ Open        │ 3        │ Jane Smith│     ║
║  │ Update docs        │ Completed   │ 1        │ Bob Wilson│     ║
║  │ Refactor API       │ Open        │ 4        │ Alice Lee │     ║
║  │ Security audit     │ In Progress │ 5        │ John Doe  │     ║
║  │ ...                │ ...         │ ...      │ ...       │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║  Note: Foreign key and user names have been resolved to IDs      ║
║                                                                   ║
║  ⚠️ Import is all-or-nothing. If any row fails database         ║
║     constraints, the entire import will be rejected.             ║
║                                                                   ║
║                                        [Cancel]  [Import] →      ║
╚═══════════════════════════════════════════════════════════════════╝
```

#### Step 4: Import in Progress

```
╔═══════════════════════════════════════════════════════════════════╗
║  Import Issues                                            [×]      ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Importing Records...                                            ║
║                                                                   ║
║  ┌──────────────────────────────────────────────────────┐       ║
║  │  [████████████████████████░░] 87%                    │       ║
║  └──────────────────────────────────────────────────────┘       ║
║                                                                   ║
║  Uploading data to server...                                     ║
║                                                                   ║
║  Please wait while we save your data to the database.            ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Implementation Note**: Show progress based on HTTP upload progress events

#### Step 5: Success

```
╔═══════════════════════════════════════════════════════════════════╗
║  Import Complete                                          [×]      ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │                      ✅ Success!                        │     ║
║  │                                                         │     ║
║  │       Successfully imported 127 issues                 │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║  The list will refresh automatically to show your new records.   ║
║                                                                   ║
║                                                 [Close]           ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Post-Import Actions:**
- Emit `importComplete` event to parent (ListPage)
- Parent refreshes data (re-fetch with current filters)
- Auto-close modal after 2 seconds OR user clicks Close
- Show success toast notification

### Template Generation

The template is a pre-formatted Excel file that users download, fill in, and re-upload.

**Sheet 1: Data Entry**

Header Row (Row 1):
- Column labels from `property.display_name`
- Example: `Title`, `Description`, `Status`, `Priority`, `Assigned To`

Hint Row (Row 2 - Frozen, styled gray):
- Type hints and constraints
- Examples:
  - Text field: "Text (max 200 chars)"
  - Number field: "Number between 1-5"
  - FK field: "Select from Reference sheet or use ID"
  - Date field: "Format: YYYY-MM-DD"
  - Boolean field: "Enter: true/false or yes/no"
  - GeoPoint field: "Format: latitude,longitude (e.g., 42.3601,-71.0589)"

**Sheet 2: Reference Data**

For each FK/User field, include a reference table:

```
Status Options:
ID | Name
1  | Open
2  | In Progress
3  | Completed
4  | Closed

Assigned To Options:
ID                                   | Name
a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6 | John Doe
b2c3d4e5-f6g7-h8i9-j0k1-l2m3n4o5p6q7 | Jane Smith

⚠️ Warning: Some fields may have duplicate names (e.g., multiple "Active" statuses).
If you encounter ambiguity errors during import, use the ID column instead of the Name column.
```

**Implementation:**
```typescript
async downloadTemplate() {
  const properties = await this.schema.getPropsForCreate(this.entity);

  // Build header and hint rows
  const headers: any = {};
  const hints: any = {};

  properties.forEach(prop => {
    headers[prop.display_name] = ''; // Empty cell
    hints[prop.display_name] = this.getHintForProperty(prop);
  });

  // Create data sheet
  const dataSheet = XLSX.utils.json_to_sheet([headers, hints], { skipHeader: true });

  // Freeze hint row (row 2)
  dataSheet['!freeze'] = { xSplit: 0, ySplit: 2 };

  // Style hint row (gray background, italic)
  // Note: Styling requires xlsx-style or similar library

  // Create workbook
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Import Data');

  // Add reference sheets for FK and User fields
  const referenceProps = properties.filter(p =>
    p.type === EntityPropertyType.ForeignKeyName ||
    p.type === EntityPropertyType.User
  );

  for (const prop of referenceProps) {
    const refData = await this.fetchReferenceData(prop);
    const refSheet = XLSX.utils.json_to_sheet(refData);
    XLSX.utils.book_append_sheet(workbook, refSheet, `${prop.display_name} Options`);
  }

  // Add warning note to first reference sheet
  if (referenceProps.length > 0) {
    // Append warning row (implementation depends on library capabilities)
  }

  // Download
  XLSX.writeFileXLSX(workbook, `${this.entity.table_name}_template.xlsx`);
}

getHintForProperty(prop: SchemaEntityProperty): string {
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
```

### Validation Pipeline

Validation occurs in a **Web Worker** to avoid blocking the UI. The worker receives raw file data and returns validated rows + error summary.

**Validation Steps:**

1. **Schema Validation**: Check all required columns are present
2. **Type Validation**: Verify data types match schema
3. **FK/User Validation**: Lookup IDs from display names, detect duplicates
4. **Validation Rules**: Apply metadata.validations constraints
5. **Uniqueness Check**: Detect duplicate values within imported data (if applicable)

**Adaptive Progress Reporting:**
```typescript
// Adjust chunk size based on dataset size for optimal progress updates
function getProgressChunkSize(totalRows: number): number {
  if (totalRows < 500) return 10;   // Update every 10 rows
  if (totalRows < 5000) return 100;  // Update every 100 rows
  return 500;                        // Update every 500 rows
}
```

**Web Worker Interface:**
```typescript
// Main thread sends
interface ValidationRequest {
  rawData: any[];
  properties: SchemaEntityProperty[];
  fkLookups: Map<string, ForeignKeyLookup>; // Updated structure
  validationRules: Map<string, ValidationRule[]>;
}

// Worker sends back
interface ValidationResponse {
  validRows: any[];
  errorSummary: ValidationErrorSummary;
}

interface ValidationErrorSummary {
  totalErrors: number;
  errorsByType: Map<string, number>;
  errorsByColumn: Map<string, number>;
  firstNErrors: ImportError[]; // First 100
  allErrors: ImportError[];    // All errors
}

interface ImportError {
  row: number;
  column: string;
  value: any;
  error: string;
  errorType: string;
}
```

**Validation Logic (Pseudo-code):**
```typescript
// In Web Worker
async function validateImportData(request: ValidationRequest): Promise<ValidationResponse> {
  const { rawData, properties, fkLookups, validationRules } = request;
  const validRows: any[] = [];
  const allErrors: ImportError[] = [];
  const errorTypeCounter = new Map<string, number>();
  const errorColumnCounter = new Map<string, number>();

  const CHUNK_SIZE = getProgressChunkSize(rawData.length);
  let cancelled = false;

  for (let i = 0; i < rawData.length; i++) {
    if (cancelled) break;

    const row = rawData[i];
    const validatedRow: any = {};
    const rowErrors: ImportError[] = [];

    // Update progress every chunk
    if (i % CHUNK_SIZE === 0) {
      postMessage({
        type: 'progress',
        progress: {
          currentRow: i,
          totalRows: rawData.length,
          stage: 'validating'
        }
      });
    }

    // Build header-to-property map with ignored columns
    const headerMap = buildHeaderMap(properties);
    const IGNORED_COLUMNS = new Set(['id', 'ID', 'created_at', 'updated_at', ...]);

    // Validate each property
    for (const [header, prop] of headerMap.entries()) {
      if (IGNORED_COLUMNS.has(header)) continue;

      const value = row[header];

      try {
        // Step 1: NULL handling
        const parsedValue = parseNullableValue(value, prop);

        // Step 2: Type validation
        const typedValue = validateAndTransformType(parsedValue, prop);

        // Step 3: FK/User validation
        if (prop.type === EntityPropertyType.ForeignKeyName ||
            prop.type === EntityPropertyType.User) {
          const fkValue = validateForeignKeyOrUser(
            row,
            prop,
            fkLookups.get(prop.join_table)
          );
          validatedRow[prop.column_name] = fkValue;
        } else {
          validatedRow[prop.column_name] = typedValue;
        }

        // Step 4: Validation rules (use stored error messages)
        const rules = validationRules.get(prop.column_name) || [];
        rules.forEach(rule => {
          if (!validateRule(typedValue, rule)) {
            // Use rule.message (stored in metadata.validations)
            throw new ValidationError(rule.message);
          }
        });

      } catch (error) {
        const importError: ImportError = {
          row: i + 2, // +2 because Excel is 1-indexed and row 1 is header
          column: prop.display_name,
          value: value,
          error: error.message,
          errorType: categorizeError(error)
        };

        rowErrors.push(importError);

        // Update counters
        errorTypeCounter.set(
          importError.errorType,
          (errorTypeCounter.get(importError.errorType) || 0) + 1
        );
        errorColumnCounter.set(
          importError.column,
          (errorColumnCounter.get(importError.column) || 0) + 1
        );
      }
    }

    // Collect results
    if (rowErrors.length === 0) {
      validRows.push(validatedRow);
    } else {
      allErrors.push(...rowErrors);
    }
  }

  // Build error summary
  const errorSummary: ValidationErrorSummary = {
    totalErrors: allErrors.length,
    errorsByType: errorTypeCounter,
    errorsByColumn: errorColumnCounter,
    firstNErrors: allErrors.slice(0, 100), // First 100 for UI display
    allErrors: allErrors // All errors for download
  };

  return { validRows, errorSummary };
}
```

### Data Type Transformations

**Import Transformations (Spreadsheet → Database):**

| Property Type | Input Format | Transformation | Output Format |
|---------------|--------------|----------------|---------------|
| TextShort | String | Trim, validate length | String |
| TextLong | String | Trim | String |
| IntegerNumber | Number or string | Parse int, validate range | Number |
| Money | Number or "$123.45" | Strip currency, parse float | Number |
| Boolean | "true", "yes", "1" | Case-insensitive parse | Boolean |
| Date | "2025-01-15" or Excel serial | Parse to Date | "2025-01-15" |
| DateTime | "2025-01-15 14:30" | Parse to ISO 8601 (no TZ) | "2025-01-15T14:30:00" |
| DateTimeLocal | "2025-01-15 14:30" | Parse to ISO 8601 in UTC | "2025-01-15T14:30:00Z" |
| **GeoPoint** | **"42.36,-71.06" or WKT** | **Parse both formats** | **"SRID=4326;POINT(-71.06 42.36)"** |
| Color | "#3B82F6" or "3B82F6" | Normalize, validate hex | "#3B82F6" |
| ForeignKeyName | ID or display name | Hybrid lookup | Number (ID) |
| User | UUID or display name | Hybrid lookup + UUID validation | String (UUID) |

**GeoPoint Import (Symmetric with Export):**
```typescript
/**
 * Parse GeoPoint from user-friendly lat,lng OR WKT format.
 * Accepts both formats for maximum flexibility.
 */
function parseGeoPoint(value: string): string {
  if (!value || typeof value !== 'string') {
    throw new ValidationError('GeoPoint value is required');
  }

  // Format 1: "lat,lng" (e.g., "42.3601,-71.0589")
  if (/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(value.trim())) {
    const [lat, lng] = value.split(',').map(s => parseFloat(s.trim()));

    if (isNaN(lat) || isNaN(lng)) {
      throw new ValidationError('Invalid lat,lng format');
    }

    if (lat < -90 || lat > 90) {
      throw new ValidationError('Latitude must be between -90 and 90');
    }

    if (lng < -180 || lng > 180) {
      throw new ValidationError('Longitude must be between -180 and 180');
    }

    return `SRID=4326;POINT(${lng} ${lat})`; // WKT uses lng,lat order
  }

  // Format 2: WKT "POINT(lng lat)" (from re-imported export)
  if (value.trim().startsWith('POINT(')) {
    // Validate WKT format
    const match = value.match(/POINT\(([^ ]+) ([^ ]+)\)/);
    if (!match) {
      throw new ValidationError('Invalid WKT POINT format');
    }

    return `SRID=4326;${value.trim()}`;
  }

  throw new ValidationError(
    'GeoPoint must be either "lat,lng" (e.g., 42.36,-71.06) or WKT format "POINT(lng lat)"'
  );
}
```

**Export Transformations (Database → Spreadsheet):**

| Property Type | Database Format | Transformation | Output Format |
|---------------|-----------------|----------------|---------------|
| DateTime | "2025-01-15T14:30:00" | ISO string (Excel auto-formats) | "2025-01-15T14:30:00" |
| DateTimeLocal | "2025-01-15T14:30:00Z" | ISO string | "2025-01-15T14:30:00Z" |
| Money | "$123.45" | Keep as-is | "$123.45" |
| Boolean | true/false | Keep as-is | TRUE/FALSE |
| **GeoPoint** | **"POINT(-71.06 42.36)"** | **Convert to lat,lng** | **"42.36,-71.06"** |
| Color | "#3B82F6" | Hex string | "#3B82F6" |

## Many-to-Many Relationships

**Export M:M (Read-Only):**
Export M:M relationships in main entity as comma-separated display names for informational purposes:

```typescript
// In transformForExport()
if (prop.type === EntityPropertyType.ManyToMany) {
  const junctionData = row[prop.column_name];
  if (Array.isArray(junctionData)) {
    const meta = prop.many_to_many_meta!;
    const names = junctionData
      .map(item => item[meta.relatedTable]?.display_name)
      .filter(name => name);
    exportRow[prop.display_name] = names.join(', '); // "Urgent, Backend, High Priority"
  }
}
```

**Import M:M (Power User Approach):**
To import M:M relationships, **import directly to the junction table** using the hybrid ID/name lookup for BOTH FK columns.

Example: Importing `issue_tags` junction table:

| Issue | Issue (Name) | Tag | Tag (Name) |
|-------|--------------|-----|------------|
| 42 | Fix bug | 3 | Urgent |
| 42 | Fix bug | 7 | Backend |
| 58 | Add feature | 12 | Frontend |

The import process works automatically:
1. Hybrid lookup resolves "Fix bug" → `issue_id = 42`
2. Hybrid lookup resolves "Urgent" → `tag_id = 3`
3. Insert: `{issue_id: 42, tag_id: 3, created_at: NOW()}`

**Benefits:**
- No special M:M handling needed
- Reuses existing FK hybrid lookup logic
- Power users can manage M:M relationships via spreadsheet

**Documentation Note:**
Add to user guide:
```
To import many-to-many relationships (e.g., assigning tags to issues):

1. Import directly to the junction table (e.g., issue_tags)
2. Use either IDs or names for both foreign key columns
3. Example: "Issue" column can be issue ID (42) or name ("Fix bug")
4. Example: "Tag" column can be tag ID (3) or name ("Urgent")

This is a power user feature for bulk-managing relationships.
```

## Performance Optimization

### Problem: UI Blocking

Validation is CPU-intensive for large files:
- 5,000 rows × 20 columns = 100,000 cells to process
- Type checking, regex matching, date parsing
- FK lookups across multiple reference tables
- Can block UI for 5-10 seconds on large files

### Solution: Web Worker Architecture

**Web Workers** run validation in a background thread, keeping the UI responsive.

**Architecture:**
```
Main Thread                      Web Worker Thread
───────────                      ─────────────────
1. User uploads file
2. Check file size (< 10MB)
3. Read file with SheetJS
4. Fetch FK reference data
5. Build ForeignKeyLookup maps
6. Send to worker          ───→  7. Receive data
                                 8. Validate in chunks
                                 9. Send progress updates
10. Update UI progress bar ←───
                                 11. Send results
12. Receive results        ←───
13. Show preview/errors
```

**Benefits:**
- UI stays responsive during validation
- Progress bar shows real-time updates
- User can cancel long-running validation
- Scales to 10,000+ rows without freezing

**Web Worker Communication:**
```typescript
// main.ts - Create worker
const worker = new Worker(new URL('./import-validation.worker', import.meta.url));

// Send validation request
worker.postMessage({
  type: 'validate',
  data: {
    rawData: parsedRows,
    properties: properties,
    fkLookups: fkLookups, // ForeignKeyLookup structure
    validationRules: validationRules
  }
});

// Listen for messages
worker.addEventListener('message', (event) => {
  if (event.data.type === 'progress') {
    this.validationProgress.set(event.data.progress);
  } else if (event.data.type === 'complete') {
    this.validationResults.set(event.data.results);
    this.step.set('results');
  } else if (event.data.type === 'cancelled') {
    this.step.set('choose');
  } else if (event.data.type === 'error') {
    this.handleValidationError(event.data.error);
  }
});
```

### Chunked Processing

Process rows in adaptive chunks to allow progress updates:

```typescript
// In Web Worker
const CHUNK_SIZE = getProgressChunkSize(rawData.length);

for (let i = 0; i < rawData.length; i += CHUNK_SIZE) {
  if (cancelled) break;

  const chunk = rawData.slice(i, Math.min(i + CHUNK_SIZE, rawData.length));

  // Validate chunk
  chunk.forEach((row, index) => {
    // ... validation logic ...
  });

  // Send progress update
  postMessage({
    type: 'progress',
    progress: {
      currentRow: Math.min(i + CHUNK_SIZE, rawData.length),
      totalRows: rawData.length,
      percentage: Math.round((i + CHUNK_SIZE) / rawData.length * 100),
      stage: 'validating'
    }
  });

  // Yield to event loop (prevent worker lockup)
  await new Promise(resolve => setTimeout(resolve, 0));
}
```

### FK Lookup Optimization

**Batched Fetching:**
```typescript
// Fetch all FK and User reference data in parallel (not sequential)
const referenceProps = properties.filter(p =>
  p.type === EntityPropertyType.ForeignKeyName ||
  p.type === EntityPropertyType.User
);

const fkDataRequests = referenceProps.map(prop =>
  this.data.getData({
    key: prop.join_table,
    fields: [prop.join_column, 'display_name']
  }).pipe(
    map(data => ({ property: prop, data }))
  )
);

// Wait for all FK data
const fkResults = await forkJoin(fkDataRequests).toPromise();

// Build lookup maps
const fkLookups = new Map<string, ForeignKeyLookup>();
fkResults.forEach(result => {
  const lookup = buildForeignKeyLookup(result.data);
  fkLookups.set(result.property.join_table, lookup);
});
```

**Single Lookup Structure per FK Field:**
- Build once before validation starts
- Reuse for all 5,000 rows
- O(1) lookup time per cell (Set for ID check, Map for name lookup)

**Memory Usage:**
- Typical FK table: 100 records
- ForeignKeyLookup structure: ~50 bytes per record
- 100 records = 5 KB per FK field
- 10 FK fields = 50 KB total
- Negligible compared to raw file data (1 MB+)

### Performance Targets

| Scenario | Target Time | Bottleneck |
|----------|-------------|------------|
| 100 rows, 10 columns | < 1 second | Network (FK fetch) |
| 1,000 rows, 10 columns | < 3 seconds | Validation logic |
| 5,000 rows, 20 columns | < 10 seconds | Validation logic |
| 10,000 rows, 20 columns | < 30 seconds | Validation logic |

**Note**: Import (POST) time depends on network and database speed. Expect 1-5 seconds for 1,000 rows.

## Component Architecture

### New Components

**1. ImportExportButtonsComponent**

Location: `src/app/components/import-export-buttons/`

Purpose: Toolbar buttons for list page

Props:
- `entity: SchemaEntityTable` - Current entity
- `entityKey: string` - Table name
- `currentFilters: FilterCriteria[]` - Active filters for export
- `searchQuery?: string` - Active search for export

Events:
- `exportTriggered()` - User clicked export (handled by parent)
- `importComplete(count: number)` - Import finished, refresh list

Template:
```html
<div class="flex gap-2">
  <!-- Export button - always visible if user can view -->
  <button class="btn btn-secondary" (click)="onExport()">
    <span class="material-symbols-outlined">download</span>
    <span class="hidden sm:inline">Export</span>
  </button>

  <!-- Import button - only if user has INSERT permission -->
  @if (entity.insert) {
    <button class="btn btn-primary" (click)="openImportModal()">
      <span class="material-symbols-outlined">upload</span>
      <span class="hidden sm:inline">Import</span>
    </button>
  }
</div>
```

**2. ImportModalComponent**

Location: `src/app/components/import-modal/`

Purpose: Multi-step import wizard supporting two modes:
- **Entity mode**: Schema-driven validation via Web Worker (for List page imports)
- **Custom mode**: Pluggable validation and submission via `CustomImportConfig` (for specialized imports like User Management)

Props:
- `entity?: SchemaEntityTable` - Current entity (optional when using custom mode)
- `entityKey?: string` - Table name (optional when using custom mode)
- `customImport?: CustomImportConfig` - Custom import configuration (see Custom Import Mode below)
- `visible: boolean` - Modal visibility

Events:
- `importComplete(count: number)` - Import succeeded
- `close()` - User cancelled or closed modal

State:
```typescript
export class ImportModalComponent {
  // Modal step state
  step = signal<'choose' | 'validating' | 'results' | 'preview' | 'importing' | 'success'>('choose');

  // File upload
  selectedFile = signal<File | undefined>(undefined);

  // Validation progress
  validationProgress = signal<{
    currentRow: number;
    totalRows: number;
    percentage: number;
    stage: string;
  } | undefined>(undefined);

  // Validation results
  validationResults = signal<{
    validRows: any[];
    errorSummary: ValidationErrorSummary;
  } | undefined>(undefined);

  // Import progress
  importProgress = signal<{
    imported: number;
    total: number;
    percentage: number;
  } | undefined>(undefined);

  // Web Worker
  private validationWorker?: Worker;

  // Cancellation support
  cancelValidation() {
    this.validationWorker?.postMessage({ type: 'cancel' });
    this.validationWorker?.terminate();
    this.step.set('choose');
  }
}
```

**3. ImportValidationWorker**

Location: `src/app/workers/import-validation.worker.ts`

Purpose: Background validation logic

Interface:
```typescript
// Input message
interface ValidationMessage {
  type: 'validate' | 'cancel';
  data?: {
    rawData: any[];
    properties: SchemaEntityProperty[];
    fkLookups: Map<string, ForeignKeyLookup>;
    validationRules: Map<string, ValidationRule[]>;
  };
}

// Output messages
interface ProgressMessage {
  type: 'progress';
  progress: {
    currentRow: number;
    totalRows: number;
    percentage: number;
    stage: string;
  };
}

interface CompleteMessage {
  type: 'complete';
  results: {
    validRows: any[];
    errorSummary: ValidationErrorSummary;
  };
}

interface CancelledMessage {
  type: 'cancelled';
}

interface ErrorMessage {
  type: 'error';
  error: string;
}
```

### New Service

**ImportExportService**

Location: `src/app/services/import-export.service.ts`

Methods:
```typescript
@Injectable({ providedIn: 'root' })
export class ImportExportService {

  /**
   * Export data to Excel file with safety checks.
   * Checks row count limit, fetches all data, generates Excel.
   */
  async exportToExcel(
    entityKey: string,
    properties: SchemaEntityProperty[],
    filters?: FilterCriteria[],
    searchQuery?: string,
    sortColumn?: string,
    sortDirection?: 'asc' | 'desc'
  ): Promise<void>;

  /**
   * Generate and download blank import template.
   * Includes header row, hint row, and reference sheets for FK fields.
   */
  async downloadTemplate(
    entity: SchemaEntityTable,
    properties: SchemaEntityProperty[]
  ): Promise<void>;

  /**
   * Fetch all FK and User reference data for validation.
   * Returns Map<join_table, ForeignKeyLookup>
   */
  fetchForeignKeyLookups(
    properties: SchemaEntityProperty[]
  ): Observable<Map<string, ForeignKeyLookup>>;

  /**
   * Validate imported data using Web Worker.
   * Returns Observable that emits progress and final results.
   */
  validateImportData(
    rawData: any[],
    properties: SchemaEntityProperty[],
    fkLookups: Map<string, ForeignKeyLookup>
  ): Observable<ValidationProgress | ValidationComplete>;

  /**
   * Transform validated data to API format.
   * Converts display_name headers to database column_names.
   */
  transformForApi(
    validatedData: any[],
    properties: SchemaEntityProperty[]
  ): any[];

  /**
   * Generate error report Excel file.
   * Includes all rows with Errors column showing validation failures.
   * Conditional formatting highlights error rows.
   */
  downloadErrorReport(
    originalData: any[],
    errorSummary: ValidationErrorSummary
  ): void;
}
```

### Modified Services

**DataService** - Add bulk insert method:

```typescript
/**
 * Bulk insert records via PostgREST.
 * Posts array of objects as JSON.
 * IMPORTANT: This is an all-or-nothing transaction.
 *
 * @param entity Table name
 * @param data Array of records to insert
 * @returns Observable of API response with progress events
 */
bulkInsert(entity: string, data: any[]): Observable<ApiResponse> {
  return this.http.post(
    environment.postgrestUrl + entity,
    data,
    {
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      // Track upload progress for large datasets
      reportProgress: true,
      observe: 'events'
    }
  ).pipe(
    // Filter for UploadProgress and Response events
    filter(event =>
      event.type === HttpEventType.UploadProgress ||
      event.type === HttpEventType.Response
    ),
    map(event => {
      if (event.type === HttpEventType.UploadProgress) {
        // Emit progress event
        const progress = Math.round(
          (event.loaded / (event.total || event.loaded)) * 100
        );
        return { success: false, progress }; // Interim response
      } else {
        // Final response
        return { success: true, body: (event as any).body };
      }
    }),
    catchError(err => this.parseApiError(err))
  );
}
```

### Modified Components

**ListPage** - Add import/export buttons:

Template changes (`list.page.html`):
```html
<!-- Add after search/filter bar, before table -->
<app-import-export-buttons
  [entity]="entity"
  [entityKey]="entityKey"
  [currentFilters]="filtersSignal()"
  [searchQuery]="searchControl.value"
  (importComplete)="onImportComplete($event)">
</app-import-export-buttons>
```

Component changes (`list.page.ts`):
```typescript
onImportComplete(count: number) {
  // Refresh list to show new records
  this.data$.pipe(take(1)).subscribe();

  // Show success toast
  this.toast.success(`Successfully imported ${count} ${this.entity.display_name.toLowerCase()}`);
}
```

## Files Structure

### New Files
```
src/app/
├── components/
│   ├── import-export-buttons/
│   │   ├── import-export-buttons.component.ts
│   │   ├── import-export-buttons.component.html
│   │   └── import-export-buttons.component.css
│   └── import-modal/
│       ├── import-modal.component.ts
│       ├── import-modal.component.html
│       └── import-modal.component.css
├── interfaces/
│   └── import.ts                          # CustomImportConfig types (v0.31.0+)
├── services/
│   └── import-export.service.ts
└── workers/
    └── import-validation.worker.ts
```

### Modified Files
```
src/app/
├── pages/
│   └── list/
│       ├── list.page.html (add buttons component)
│       └── list.page.ts (add import handler)
└── services/
    └── data.service.ts (add bulkInsert method)

package.json (add SheetJS dependency)
angular.json (configure Web Worker support)
tsconfig.worker.json (new file for worker compilation)
```

### Configuration Changes

**package.json:**
```json
{
  "dependencies": {
    "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
  }
}
```

**angular.json** (enable Web Workers):
```json
{
  "projects": {
    "civic-os-frontend": {
      "architect": {
        "build": {
          "options": {
            "webWorkerTsConfig": "tsconfig.worker.json"
          }
        }
      }
    }
  }
}
```

**tsconfig.worker.json** (new file):
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./out-tsc/worker",
    "lib": [
      "ES2022",
      "WebWorker"
    ],
    "types": []
  },
  "include": [
    "src/**/*.worker.ts"
  ]
}
```

## Custom Import Mode (v0.31.0+)

The ImportModalComponent supports a **custom import mode** via the `CustomImportConfig` interface, allowing any page to reuse the import wizard without requiring a `SchemaEntityTable`. This enables importing data that goes through RPCs rather than direct PostgREST table inserts.

### When to Use Custom Import

Use custom import when:
- Data is submitted via an RPC function (not a direct table insert)
- The RPC supports **partial success** (some rows succeed, some fail)
- Validation rules are simple and don't require FK lookups or Web Worker processing
- The dataset is small (< 100 rows typically)

For schema-driven entity imports with FK resolution, continue using the standard entity mode.

### Interface

Types are defined in `src/app/interfaces/import.ts`:

- **`ImportColumn`** - Column definition with `name`, `key`, `required`, and `type` (`text`, `email`, `phone`, `boolean`, `comma-list`)
- **`CustomImportConfig`** - Configuration object with `title`, `columns`, `submit` function, and `generateTemplate` function
- **`CustomImportResult`** - Submit result with `success`, `importedCount`, `errorCount`, and optional `errors` array
- **`CustomImportError`** - Per-row error with `index`, optional `identifier`, and `error` message

### Validation

Custom mode validates inline (no Web Worker) using type-specific rules:
- `email`: RFC 5322 regex, lowercased
- `phone`: Strips non-digits, requires exactly 10 digits
- `boolean`: Accepts `true/false/yes/no/1/0/y/n` (case-insensitive)
- `comma-list`: Splits by comma, trims whitespace, returns `string[]`
- `text`: Trimmed, no special validation

### Partial Success Handling

Unlike entity imports (PostgREST all-or-nothing), custom imports support three outcomes:
1. **Full success** (`errorCount === 0`): Shows success step with imported count
2. **Partial success** (`errorCount > 0 && importedCount > 0`): Shows success count + error table
3. **Full failure** (`importedCount === 0`): Shows error table only

### Usage Example (User Management Page)

```typescript
userImportConfig: CustomImportConfig = {
  title: 'Import Users',
  columns: [
    { name: 'Email', key: 'email', required: true, type: 'email' },
    { name: 'First Name', key: 'first_name', required: true, type: 'text' },
    // ...
    { name: 'Roles', key: 'roles', required: false, type: 'comma-list' },
  ],
  submit: (rows) => this.submitUserImport(rows),
  generateTemplate: () => this.importExportService.generateUserImportTemplate(this.manageableRoles())
};
```

Template in parent component:
```html
<app-import-modal [customImport]="userImportConfig"
  (close)="showImportModal.set(false)"
  (importSuccess)="onImportSuccess($event)">
</app-import-modal>
```

## Error Handling

### Import Error Types

**1. File Format Errors**
- Invalid file type (not .xlsx/.xls/.csv)
- Corrupted file
- Empty file
- File too large (> 10MB)

**2. Schema Errors**
- Missing required columns
- Unknown columns (warn, don't block - allow exported file re-import)

**3. Type Validation Errors**
- Non-numeric value in number field
- Invalid date format
- Invalid boolean value
- Invalid color format (not hex)
- Invalid GeoPoint format
- Invalid UUID format (User fields)

**4. FK/User Validation Errors**
- FK/User ID not found in reference table
- FK/User display name not found (typo)
- Ambiguous FK/User display name (duplicates)

**5. Validation Rule Errors**
- Required field empty
- Value below min or above max
- String too short or too long
- Pattern mismatch (regex) - **use stored error message from metadata**

**6. Database Errors (Post-Validation)**
- Unique constraint violation
- Foreign key constraint violation (race condition)
- Check constraint violation - **translate to friendly message via metadata.constraint_messages**
- Permission denied (RLS)

### Error Messages

**CRITICAL: Always use stored error messages from metadata for validation rules**

```typescript
// GOOD: Use stored message from ValidationRule
const rule = validationRules.find(r => r.type === 'pattern');
if (rule && !value.match(rule.value)) {
  throw new ValidationError(rule.message);
  // Example: "SKU must be format: ABC-1234 (3 letters, dash, 4 numbers)"
}

// BAD: Generate generic message
throw new ValidationError(`Value must match pattern: ${rule.value}`);
// Example: "Value must match pattern: ^[A-Z]{3}-\d{4}$" (confusing!)
```

**User-Friendly Error Message Examples:**

```typescript
// Good: Actionable guidance
"The Status value '999' doesn't exist. Please use a valid Status ID from the reference sheet."

// Good: Specific
"Priority must be a number between 1 and 5. You entered '10'."

// Good: Helpful suggestion (future: fuzzy matching)
"'Complted' not found in Status field. Did you mean 'Completed'?"

// Good: Clear ambiguity resolution
"Ambiguous value 'Active' matches multiple records (IDs: 1, 2). The 'Status' field has duplicate names. Please use the 'Status' column (ID) instead."

// Good: UUID format validation
"Assigned To must be a valid UUID. Got: 'john-doe' (did you mean to use the 'Assigned To (Name)' column instead?)"
```

### Partial Import Handling

When validation finds errors, give user two options:

**Option 1: Fix and Re-upload**
- Download error report (Excel with Errors column)
- Fix errors in spreadsheet
- Re-upload corrected file

**Option 2: Import Valid Rows Only**
- Skip error rows
- Import only validated rows
- Show count: "Imported 4,108 of 5,000 rows (892 skipped)"
- Error report still available for download

**IMPORTANT WARNING: All-or-Nothing Transaction**

If import fails after validation due to database constraints:
- Display clear error message explaining transactional nature
- Emphasize that user must fix ALL errors and re-upload entire file
- Suggest downloading error details to identify issues

## Testing Strategy

### Unit Tests

**FK Lookup Logic with Updated Structure:**
```typescript
describe('buildForeignKeyLookup', () => {
  it('should create comprehensive lookup structure', () => {
    const data = [
      { id: 1, display_name: 'Active' },
      { id: 2, display_name: 'Inactive' }
    ];

    const lookup = buildForeignKeyLookup(data);

    // Test displayNameToIds
    expect(lookup.displayNameToIds.get('active')).toEqual([1]);
    expect(lookup.displayNameToIds.get('inactive')).toEqual([2]);

    // Test validIds
    expect(lookup.validIds.has(1)).toBe(true);
    expect(lookup.validIds.has(2)).toBe(true);
    expect(lookup.validIds.has(999)).toBe(false);

    // Test idsToDisplayName (preserves original casing)
    expect(lookup.idsToDisplayName.get(1)).toBe('Active');
    expect(lookup.idsToDisplayName.get(2)).toBe('Inactive');
  });

  it('should detect duplicate display names', () => {
    const data = [
      { id: 1, display_name: 'Active' },
      { id: 2, display_name: 'Active' }, // Duplicate!
      { id: 3, display_name: 'Inactive' }
    ];

    const lookup = buildForeignKeyLookup(data);

    expect(lookup.displayNameToIds.get('active')).toEqual([1, 2]); // Both IDs
    expect(lookup.validIds.size).toBe(3); // All IDs present
  });
});

describe('validateForeignKeyId', () => {
  it('should validate ID exists', () => {
    const lookup = buildForeignKeyLookup([
      { id: 1, display_name: 'Active' }
    ]);

    expect(() => {
      validateForeignKeyId(999, lookup, 'Status')
    }).toThrow(/ID "999" does not exist/);

    expect(validateForeignKeyId(1, lookup, 'Status')).toBe(1);
  });
});

describe('lookupForeignKeyId', () => {
  it('should lookup ID from display name (case-insensitive)', () => {
    const lookup = buildForeignKeyLookup([
      { id: 1, display_name: 'Active' },
      { id: 2, display_name: 'Inactive' }
    ]);

    expect(lookupForeignKeyId('Active', lookup, 'Status', 'status_id')).toBe(1);
    expect(lookupForeignKeyId('ACTIVE', lookup, 'Status', 'status_id')).toBe(1);
    expect(lookupForeignKeyId(' active ', lookup, 'Status', 'status_id')).toBe(1);
  });

  it('should throw error for ambiguous names', () => {
    const lookup = buildForeignKeyLookup([
      { id: 1, display_name: 'Active' },
      { id: 2, display_name: 'Active' }
    ]);

    expect(() => {
      lookupForeignKeyId('Active', lookup, 'Status', 'status_id')
    }).toThrow(/Ambiguous value.*IDs: 1, 2/);
  });

  it('should throw error for unknown names', () => {
    const lookup = buildForeignKeyLookup([
      { id: 1, display_name: 'Active' }
    ]);

    expect(() => {
      lookupForeignKeyId('Unknown', lookup, 'Status', 'status_id')
    }).toThrow(/"Unknown" not found/);
  });
});
```

**Data Type Transformations:**
```typescript
describe('transformValueForImport', () => {
  it('should parse boolean values (case-insensitive)', () => {
    expect(transformBoolean('true')).toBe(true);
    expect(transformBoolean('TRUE')).toBe(true);
    expect(transformBoolean('yes')).toBe(true);
    expect(transformBoolean('1')).toBe(true);
    expect(transformBoolean('false')).toBe(false);
    expect(transformBoolean('no')).toBe(false);
    expect(transformBoolean('0')).toBe(false);
  });

  it('should parse GeoPoint from lat,lng', () => {
    const result = transformGeoPoint('42.3601,-71.0589');
    expect(result).toBe('SRID=4326;POINT(-71.0589 42.3601)');
  });

  it('should parse GeoPoint from WKT (re-imported export)', () => {
    const result = transformGeoPoint('POINT(-71.0589 42.3601)');
    expect(result).toBe('SRID=4326;POINT(-71.0589 42.3601)');
  });

  it('should validate GeoPoint bounds', () => {
    expect(() => transformGeoPoint('95,-71')).toThrow(/Latitude must be between -90 and 90/);
    expect(() => transformGeoPoint('42,200')).toThrow(/Longitude must be between -180 and 180/);
  });

  it('should normalize hex colors', () => {
    expect(transformColor('3B82F6')).toBe('#3B82F6');
    expect(transformColor('#3b82f6')).toBe('#3B82F6');
  });

  it('should validate UUIDs', () => {
    expect(validateUUID('a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6')).toBe(true);
    expect(validateUUID('not-a-uuid')).toBe(false);
  });
});

describe('NULL handling', () => {
  it('should parse NULL markers', () => {
    const prop = { is_nullable: true, type: EntityPropertyType.IntegerNumber };
    expect(parseNullableValue(null, prop)).toBe(null);
    expect(parseNullableValue(undefined, prop)).toBe(null);
    expect(parseNullableValue('NULL', prop)).toBe(null);
    expect(parseNullableValue('null', prop)).toBe(null);
  });

  it('should handle empty strings based on type', () => {
    const textProp = { is_nullable: true, type: EntityPropertyType.TextShort };
    expect(parseNullableValue('', textProp)).toBe('');

    const numberProp = { is_nullable: true, type: EntityPropertyType.IntegerNumber };
    expect(parseNullableValue('', numberProp)).toBe(null);
  });
});
```

### Integration Tests

**Export → Import Roundtrip:**
```typescript
describe('Export/Import Integration', () => {
  it('should successfully roundtrip data including system fields', async () => {
    // 1. Create test records
    const originalData = [
      { title: 'Test Issue 1', status_id: 1, priority: 2 },
      { title: 'Test Issue 2', status_id: 2, priority: 3 }
    ];

    await bulkInsert('issues', originalData);

    // 2. Export to Excel (includes id, created_at, updated_at)
    const excelFile = await exportToExcel('issues', [], undefined);

    // 3. Re-import from Excel (should ignore system columns)
    const importResults = await importFromExcel(excelFile, 'issues');

    // 4. Verify
    expect(importResults.validRows.length).toBe(2);
    expect(importResults.errorSummary.totalErrors).toBe(0);
  });

  it('should handle large dataset exports with safety limits', async () => {
    // Test that export enforces MAX_EXPORT_ROWS limit
    // Mock dataset with 60,000 rows
    // Verify error is shown
  });

  it('should reject oversized files during import', () => {
    // Test file size limit (10MB)
    // Create mock 15MB file
    // Verify error is shown before parsing
  });
});
```

### Manual Testing Checklist

**Performance Tests:**
- [ ] Import 100 rows - completes in < 1 second
- [ ] Import 1,000 rows - completes in < 3 seconds
- [ ] Import 5,000 rows - completes in < 10 seconds
- [ ] Import 10,000 rows - completes in < 30 seconds
- [ ] UI stays responsive during validation
- [ ] Progress bar updates smoothly
- [ ] Cancellation works mid-validation

**Safety Limit Tests:**
- [ ] Export 60,000 rows - shows error
- [ ] Upload 15MB file - shows error before parsing
- [ ] Upload 8MB file - succeeds

**Error Handling Tests:**
- [ ] Upload invalid file type (.pdf) - shows error
- [ ] Upload empty file - shows error
- [ ] Upload file with missing columns - shows specific errors
- [ ] Upload file with FK typo - suggests correction (future)
- [ ] Upload file with duplicate FK names - shows ambiguity error with IDs
- [ ] Partial import (some valid, some error rows) - works correctly
- [ ] Large error dataset (1,000+ errors) - shows grouped summary + first 100

**Edge Cases:**
- [ ] Import with all required fields only - succeeds
- [ ] Import with optional fields blank - succeeds
- [ ] Import with FK ID column only - succeeds
- [ ] Import with FK display column only - succeeds
- [ ] Import with both FK columns - uses ID (ignores display name)
- [ ] Import with User UUID column only - validates UUID format
- [ ] Import with User display column only - case-insensitive lookup
- [ ] Export and re-import preserves all data (system columns ignored)
- [ ] GeoPoint roundtrip: lat,lng → WKT → lat,lng
- [ ] Import junction table directly (M:M power user feature)

**Transaction Failure Tests:**
- [ ] Import data that passes validation but fails unique constraint - shows all-or-nothing error
- [ ] Import data that fails check constraint - shows friendly message from metadata.constraint_messages

## Test Coverage (October 2025)

### Overview

**Status**: ✅ **98 passing tests** across 3 test files

The import/export feature has comprehensive unit test coverage for all core functionality including:
- Service methods (Excel generation, file parsing, FK lookups, template generation, validation)
- Component lifecycle (file handling, modal state management, worker communication)
- Error handling (file size, validation errors, network errors, worker errors)
- Edge cases (null values, type coercion, async timing)

### Test Files

#### 1. import-export.service.spec.ts (38 tests)

**Test Categories:**
- **FK Lookup Building** (6 tests): displayNameToIds map creation, validIds set population, idsToDisplayName reverse lookup, case-insensitive keys, duplicate name detection, empty data handling
- **Export Functionality** (7 tests): Property filtering, select string building, success/error paths, count limit enforcement, filter/search/sort preservation
- **Template Generation** (7 tests): Property fetching, FK lookup integration, headers/hints generation, reference sheet creation, success/error handling
- **File Parsing** (6 tests): Excel parsing, file size validation, oversized file rejection, empty file handling, parse error handling
- **Validation Integration** (6 tests): File size checks, parse result validation, error message formatting
- **Error Reporting** (6 tests): Error report generation, summary building, download triggering

**Key Testing Patterns:**
```typescript
// Mock service dependencies
mockSchemaService = jasmine.createSpyObj('SchemaService', ['getPropertiesForEntity', 'getPropsForCreate']);
mockDataService = jasmine.createSpyObj('DataService', ['getDataPaginated', 'getData']);

// Test FK lookup structure
it('should build FK lookup with all three maps', () => {
  const fkData = [
    { id: 1, display_name: 'Active' },
    { id: 2, display_name: 'Inactive' }
  ];

  service.fetchForeignKeyLookups(mockProperties).subscribe(result => {
    const lookup = result.get('statuses');

    // Verify displayNameToIds (case-insensitive)
    expect(lookup.displayNameToIds['active']).toEqual([1]);

    // Verify validIds (fast ID check)
    expect(lookup.validIds).toContain(1);

    // Verify idsToDisplayName (reverse lookup)
    expect(lookup.idsToDisplayName[1]).toBe('Active');
  });
});

// Test export with filters
it('should pass filters and search to export', async () => {
  const filters = [{ column: 'status_id', operator: 'eq', value: '1' }];
  const searchQuery = 'urgent';

  await service.exportToExcel(mockEntity, mockProperties, filters, searchQuery);

  expect(mockDataService.getDataPaginated).toHaveBeenCalledWith(
    jasmine.objectContaining({
      filters: filters,
      searchQuery: searchQuery
    })
  );
});
```

#### 2. import-modal.component.spec.ts (38 tests)

**Test Categories:**
- **Component Creation** (3 tests): Instance creation, default step ('choose'), signal initialization
- **Computed Signals** (5 tests): hasErrors() computation, canProceedToImport() logic with valid/invalid/error combinations
- **File Selection** (3 tests): onFileSelected() from input, onFileDrop() with drag-drop, onDragOver() preventDefault
- **File Validation** (3 tests): Reject oversized files, handle parse errors, reset state on new file selection
- **Template Download** (3 tests): Success path, error handling, missing properties handling
- **Error Report Download** (2 tests): Download with error summary, skip when no errors
- **Import Process** (5 tests): Skip with no data/entityKey, success handling with count, error display and step reset, progress updates
- **Modal Actions** (3 tests): Close event emission, import success with count, start over state reset
- **Lifecycle** (2 tests): Terminate worker on destroy, null worker safety
- **Worker Communication** (5 tests): Cancel message sending, progress message handling, complete message processing, cancelled message handling, error message handling
- **Lookup Serialization** (2 tests): Map/Set to Object/Array conversion for structured clone, empty lookups handling

**Key Testing Patterns:**
```typescript
// Test computed signals
it('should compute hasErrors correctly', () => {
  component.errorSummary.set(null);
  expect(component.hasErrors()).toBe(false);

  component.errorSummary.set({ totalErrors: 0 });
  expect(component.hasErrors()).toBe(false);

  component.errorSummary.set({ totalErrors: 5 });
  expect(component.hasErrors()).toBe(true);
});

// Test worker message handling (without spawning actual worker)
it('should handle progress messages from worker', () => {
  const progressMessage = {
    type: 'progress',
    progress: { currentRow: 50, totalRows: 100, percentage: 50, stage: 'validating' }
  };

  // Directly call message handler
  (component as any).handleWorkerMessage({ data: progressMessage });

  expect(component.validationProgress()).toBe(50);
});

// Test async file handling
it('should handle file selection and start validation', async () => {
  const mockFile = new File(['test'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  mockImportExportService.validateFileSize.and.returnValue({ valid: true });
  mockImportExportService.parseExcelFile.and.returnValue(Promise.resolve({ success: true, data: [{title: 'Test'}] }));

  const event = { target: { files: [mockFile] } } as any;
  component.onFileSelected(event);

  await fixture.whenStable();

  expect(component.selectedFile()).toBe(mockFile);
  expect(component.currentStep()).toBe('validating');
});

// Test lookup serialization for worker transfer
it('should serialize Map/Set to plain objects for worker', () => {
  const fkLookups = new Map();
  fkLookups.set('statuses', {
    displayNameToIds: new Map([['active', [1, 2]]]),
    validIds: new Set([1, 2, 3]),
    idsToDisplayName: new Map([[1, 'Active']])
  });

  const serialized = (component as any).serializeLookups(fkLookups);

  expect(serialized.statuses.displayNameToIds).toEqual({ 'active': [1, 2] });
  expect(serialized.statuses.validIds).toEqual([1, 2, 3]);
  expect(serialized.statuses.idsToDisplayName).toEqual({ '1': 'Active' });
});
```

#### 3. import-export-buttons.component.spec.ts (22 tests)

**Test Categories:**
- **Component Creation** (2 tests): Instance creation, default signal values (isExporting: false, showImportModal: false)
- **Export Functionality** (11 tests):
  - Success scenarios (property fetching, service calls)
  - Parameter passing (filters, search, sort)
  - Loading state management (isExporting signal)
  - Guard against double-export (prevent concurrent exports)
  - Error handling (service errors, missing properties, promise rejections)
- **Import Modal** (5 tests): Open modal, close modal, success event emission with count
- **Input Bindings** (4 tests): Entity, filters, search query, sort parameters

**Key Testing Patterns:**
```typescript
// Test loading state timing
it('should set isExporting during export', async () => {
  mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));

  let resolveExport: (value: any) => void;
  const exportPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
    resolveExport = resolve;
  });
  mockImportExportService.exportToExcel.and.returnValue(exportPromise);

  const exportCall = component.onExport();

  // Wait a tick for async operations to start
  await Promise.resolve();

  expect(component.isExporting()).toBe(true);

  // Complete the export
  resolveExport!({ success: true });
  await exportCall;

  expect(component.isExporting()).toBe(false);
});

// Test parameter passing
it('should pass filters to export', async () => {
  const filters: FilterCriteria[] = [{ column: 'status_id', operator: 'eq', value: '1' }];
  component.currentFilters = filters;

  mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
  mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

  await component.onExport();

  expect(mockImportExportService.exportToExcel).toHaveBeenCalledWith(
    mockEntity,
    mockProperties,
    filters, // Filters passed through
    undefined,
    undefined,
    undefined
  );
});

// Test error handling
it('should handle missing properties error', async () => {
  mockSchemaService.getPropertiesForEntity.and.returnValue(of(null as any));

  spyOn(window, 'alert');
  spyOn(console, 'error');

  await component.onExport();

  expect(console.error).toHaveBeenCalledWith('Export error:', jasmine.any(Error));
  expect(window.alert).toHaveBeenCalledWith('Export failed: Failed to fetch properties');
  expect(component.isExporting()).toBe(false);
});
```

### Worker Testing Strategy

**Decision: Component-Level Testing Instead of Direct Worker Testing**

We chose to test the worker integration at the **component level** rather than spawning actual Web Workers in tests. This approach provides:

**Benefits:**
1. **Speed**: No worker instantiation overhead (workers are async and slow to spin up)
2. **Simplicity**: Direct method calls instead of complex message passing
3. **Reliability**: No flaky timing issues or race conditions
4. **Coverage**: Tests all message handling paths without worker complexity
5. **Maintainability**: Easier to debug and update tests

**How It Works:**
```typescript
// Instead of spawning a worker:
// const worker = new Worker(new URL('...', import.meta.url));
// worker.postMessage({ type: 'validate', data: {...} });

// We directly test the message handler:
it('should handle complete message from worker', () => {
  const completeMessage = {
    type: 'complete',
    results: {
      validRows: [{title: 'Test 1'}, {title: 'Test 2'}],
      errorSummary: { totalErrors: 0, errorsByType: new Map(), errorsByColumn: new Map(), firstNErrors: [], allErrors: [] }
    }
  };

  // Directly invoke the handler (no worker needed)
  (component as any).handleWorkerMessage({ data: completeMessage });

  expect(component.currentStep()).toBe('results');
  expect(component.validRowCount()).toBe(2);
  expect((component as any).validatedData.length).toBe(2);
});
```

**What We Test:**
- ✅ Worker message handling (progress, complete, error, cancelled)
- ✅ Worker lifecycle (termination on destroy, null safety)
- ✅ Message structure and data flow
- ✅ Component state updates in response to worker messages
- ✅ Lookup serialization for worker transfer (Map/Set → Object/Array)

**What We Don't Test:**
- ❌ Actual worker instantiation (`new Worker(...)`)
- ❌ Worker thread execution (`worker.postMessage()` → worker code runs)
- ❌ Cross-thread communication timing

**Why This Is Sufficient:**
- The worker **business logic** (validation algorithms) can be unit tested separately if needed
- The component **integration logic** (message handling, state management) is fully covered
- The worker **communication protocol** (message types, data structures) is verified
- Production worker functionality has been validated through manual testing and real usage

**Future Enhancement:**
If worker logic becomes more complex, we could:
1. Extract validation logic to a pure function (no worker dependency)
2. Unit test the validation function directly
3. Keep the worker as a thin wrapper that just calls the function

This would allow testing validation algorithms without any async/worker overhead.

### Test Execution

**Running Tests:**
```bash
# Run all import/export tests together
npm test -- --no-watch --include='**/import-*.spec.ts'

# Run individual test file
npm test -- --no-watch --include='**/import-export.service.spec.ts'
npm test -- --no-watch --include='**/import-modal.component.spec.ts'
npm test -- --no-watch --include='**/import-export-buttons.component.spec.ts'
```

**Results:**
```
TOTAL: 98 SUCCESS

Breakdown:
- ImportExportService: 38 tests ✅
- ImportModalComponent: 38 tests ✅
- ImportExportButtonsComponent: 22 tests ✅
```

**Common Test Patterns:**

1. **Mock Service Dependencies:**
```typescript
beforeEach(() => {
  mockSchemaService = jasmine.createSpyObj('SchemaService', ['getPropertiesForEntity', 'getPropsForCreate']);
  mockDataService = jasmine.createSpyObj('DataService', ['getData', 'bulkInsert']);
  mockImportExportService = jasmine.createSpyObj('ImportExportService', ['exportToExcel', 'validateFileSize', 'parseExcelFile']);

  TestBed.configureTestingModule({
    imports: [ComponentUnderTest],
    providers: [
      provideZonelessChangeDetection(),
      { provide: SchemaService, useValue: mockSchemaService },
      { provide: DataService, useValue: mockDataService },
      { provide: ImportExportService, useValue: mockImportExportService }
    ]
  });
});
```

2. **Test Async Operations:**
```typescript
it('should handle async export', async () => {
  mockSchemaService.getPropertiesForEntity.and.returnValue(of(mockProperties));
  mockImportExportService.exportToExcel.and.returnValue(Promise.resolve({ success: true }));

  await component.onExport();

  expect(component.isExporting()).toBe(false);
  expect(mockImportExportService.exportToExcel).toHaveBeenCalled();
});
```

3. **Test Error Handling:**
```typescript
it('should handle errors gracefully', async () => {
  mockSchemaService.getPropertiesForEntity.and.returnValue(throwError(() => new Error('Network error')));

  spyOn(window, 'alert');
  spyOn(console, 'error');

  await component.onExport();

  expect(console.error).toHaveBeenCalledWith('Export error:', jasmine.any(Error));
  expect(window.alert).toHaveBeenCalledWith(jasmine.stringContaining('Export failed'));
});
```

4. **Test Signal Updates:**
```typescript
it('should update signals correctly', () => {
  expect(component.isExporting()).toBe(false);

  component.isExporting.set(true);

  expect(component.isExporting()).toBe(true);
});
```

5. **Test Computed Signals:**
```typescript
it('should compute canProceedToImport', () => {
  component.validRowCount.set(0);
  component.errorSummary.set(null);

  expect(component.canProceedToImport()).toBe(false);

  component.validRowCount.set(10);

  expect(component.canProceedToImport()).toBe(true);
});
```

### Coverage Gaps (Intentional)

**Not Tested (Acceptable):**
1. **Actual Worker Execution**: Worker business logic runs in production but not in tests (component-level testing is sufficient)
2. **SheetJS Library**: Third-party library, assumed to work correctly
3. **Browser File API**: File selection, drag-drop, download triggers (requires manual E2E testing)
4. **PostgREST API**: Integration with backend (requires integration tests)

**Manual Testing Required:**
- Large file imports (5,000+ rows) - performance validation
- Browser compatibility (Chrome, Firefox, Safari, Edge)
- File upload edge cases (corrupted files, non-Excel files)
- Complete user workflows (export → edit → re-import)

### Next Steps for Testing

**Potential Enhancements:**
1. **E2E Tests**: Use Cypress or Playwright to test complete user workflows
2. **Performance Tests**: Benchmark validation speed with large datasets
3. **Integration Tests**: Test against real PostgREST API with test database
4. **Worker Logic Tests**: Extract validation algorithms to pure functions and unit test them
5. **Visual Regression Tests**: Ensure modal UI renders correctly across browsers

**Current Status**: ✅ Unit test coverage is comprehensive and sufficient for core functionality

## Future Enhancements

### Phase 2: Advanced Features

**1. Server-Side Validation RPC**
- For imports > 1,000 rows, offer server-side validation
- PostgreSQL function does validation with temp table
- Much faster for large datasets (database-native type checking)
- Reduces client-side memory usage
- Returns validation errors as JSONB array

**2. Update Mode (Edit Existing Records)**
- If `id` column present in import, update instead of insert
- Validate ID exists
- Require UPDATE permission
- Show diff preview before applying
- Use PATCH instead of POST

**3. CSV Format Support**
- Accept .csv files in addition to .xlsx
- Parse with PapaParse or similar library
- Simpler format for programmatic generation
- Faster parsing for very large files

**4. Import History & Audit Log**
- Track all imports in `metadata.import_history` table
- Store: user, timestamp, entity, row count, error count, status
- Allow viewing past imports
- Allow reverting imports (if records unchanged)

**5. Scheduled Imports**
- Allow uploading file to be imported at specific time
- Useful for maintenance windows
- Email notification on completion
- Cron-like scheduling interface

**6. Import from URL**
- Accept URL to .xlsx file
- Fetch and validate server-side
- Useful for automated imports from other systems
- Supports authenticated endpoints

### Phase 3: Advanced Validation

**1. Async/RPC Validators**
- Check uniqueness constraints via database query
- Cross-field validation (e.g., end_date > start_date)
- Custom validation functions (PostgreSQL RPC)
- Business rule validation

**2. Fuzzy Matching for FK Lookups**
- Use Levenshtein distance for typo detection
- Suggest corrections: "Did you mean 'Completed'?"
- Confidence threshold for auto-correction
- Show top 3 suggestions in error message

**3. Row-by-Row Fallback Mode**
- After bulk insert failure, retry row-by-row
- Identify exactly which rows failed
- Import successful rows
- Detailed failure report
- Much slower but provides granular error reporting

**4. Data Transformation Scripts**
- Allow admins to define custom transformations
- Example: Auto-uppercase certain fields
- Example: Parse phone numbers to standard format
- JavaScript-based transformation functions
- Applied during validation phase

---

**Document Version**: 2.1
**Last Updated**: 2025-10-15
**Author**: Implementation Planning Session
**Status**: ✅ IMPLEMENTED - Core functionality complete, ready for extensions

## Changelog

### Version 2.3 (2026-02-27) - CUSTOM IMPORT MODE
- **Added Custom Import Mode** (`CustomImportConfig`) enabling any page to reuse ImportModalComponent for non-entity imports
- **Interfaces**: `ImportColumn`, `CustomImportConfig`, `CustomImportResult`, `CustomImportError` in `src/app/interfaces/import.ts`
- **Inline validation**: Type-specific validators (email, phone, boolean, comma-list) run synchronously instead of via Web Worker
- **Partial success**: Three-outcome handling (full success, partial success, full failure) for RPCs that process rows individually
- **First consumer**: User Management page bulk user import via `bulk_provision_users` RPC
- **Template generation**: `ImportExportService.generateUserImportTemplate()` with Available Roles reference sheet
- **Files added**: `src/app/interfaces/import.ts`
- **Files modified**: `import-modal.component.ts/html`, `import-export.service.ts`, `user-management.service.ts`, `user-management.page.ts`
- **Test coverage**: ~30 new tests across 4 spec files

### Version 2.2 (2025-10-15) - TEST COVERAGE
- **Added Test Coverage section** documenting comprehensive unit test implementation
- **Documented Worker Testing Strategy** explaining component-level approach vs direct worker testing
- **Test Results**: 98 passing tests across 3 test files
  - import-export.service.spec.ts: 38 tests
  - import-modal.component.spec.ts: 38 tests
  - import-export-buttons.component.spec.ts: 22 tests
- **Test Categories**: Service methods, component lifecycle, worker communication, error handling, file validation

### Version 2.1 (2025-10-15) - STATUS UPDATE
- **Added Implementation Status section** with completed features, bug fixes, and known limitations
- **Documented recent bug fixes**: PGRST102, error display, M:M template exclusion, button styling, navigation, metadata preservation
- **Documented inline code documentation**: JSDoc comments, worker enum duplication, architecture explanations
- **Clarified future enhancements** vs completed features
- **Updated document status** from "Ready for Implementation" to "IMPLEMENTED - Core functionality complete"

### Version 2.0 (2025-10-15) - DESIGN SPECIFICATION
- **CRITICAL FIX #1**: Updated FK lookup to use ForeignKeyLookup structure (displayNameToIds, validIds, idsToDisplayName)
- **CRITICAL FIX #2**: Standardized column naming to use display names for headers
- **CRITICAL FIX #3**: Added system column ignoring during import (id, created_at, updated_at)
- **CRITICAL FIX #4**: Documented PostgREST all-or-nothing transaction behavior with warnings
- **CRITICAL FIX #5**: Added explicit NULL handling specification
- **CRITICAL FIX #6**: Clarified User columns use identical hybrid lookup logic (with UUID validation)
- **CRITICAL FIX #7**: Made GeoPoint export/import symmetric (both use lat,lng format)
- **CRITICAL FIX #8**: Added error display limits and grouping (100 errors max in UI)
- **CRITICAL FIX #9**: Added export memory safety limits (MAX_EXPORT_ROWS)
- **CRITICAL FIX #10**: Added import file size limits (MAX_FILE_SIZE = 10MB)
- Added validation cancellation support
- Added adaptive progress reporting
- Updated M:M section to mention junction table import approach
- Added emphasis on using stored error messages from metadata.validations
- Improved error message examples throughout

### Version 1.0 (2025-10-15) - INITIAL DESIGN
- Initial specification document
