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

export interface SchemaEntityTable {
    display_name: string,
    sort_order: number,
    description: string | null,
    search_fields: string[] | null,
    show_map: boolean,
    map_property_name: string | null,
    show_calendar: boolean,
    calendar_property_name: string | null,
    calendar_color_property: string | null,
    table_name: string,
    insert: boolean,
    select: boolean,
    update: boolean,
    delete: boolean,
    payment_initiation_rpc?: string | null,
    payment_capture_mode?: 'immediate' | 'deferred' | null,
}

export interface ValidationRule {
    type: 'required' | 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'fileType' | 'maxFileSize';
    value?: string;
    message: string;
}

/**
 * File reference returned from files table
 */
export interface FileReference {
    id: string;
    entity_type: string;
    entity_id: string;
    file_name: string;
    file_type: string;
    file_size: number;
    s3_bucket: string;
    s3_key_prefix: string;
    s3_original_key: string;
    s3_thumbnail_small_key?: string;
    s3_thumbnail_medium_key?: string;
    s3_thumbnail_large_key?: string;
    thumbnail_status: 'pending' | 'processing' | 'completed' | 'failed' | 'not_applicable';
    thumbnail_error?: string;
    created_at: string;
    updated_at: string;
}

export interface SchemaEntityProperty {
    table_catalog: string,
    table_schema: string,
    table_name: string,
    column_name: string,
    display_name: string,
    description?: string,
    sort_order: number,
    column_width?: number,
    sortable?: boolean,
    filterable?: boolean,
    column_default: string,
    is_nullable: boolean,
    data_type: string,
    character_maximum_length: number,
    udt_schema: string,
    udt_name: string,
    is_self_referencing: boolean,
    is_identity: boolean,
    is_generated: boolean,
    is_updatable: boolean,
    join_schema: string,
    join_table: string,
    join_column: string,
    geography_type: string,
    show_on_list?: boolean,
    show_on_create?: boolean,
    show_on_edit?: boolean,
    show_on_detail?: boolean,

    type: EntityPropertyType, // Calculated in Schema Service

    // M:M metadata (populated when type === ManyToMany)
    many_to_many_meta?: ManyToManyMeta;

    // Validation rules from metadata
    validation_rules?: ValidationRule[];
}

export enum EntityPropertyType {
    Unknown,
    TextShort,
    TextLong,
    Boolean,
    Date,
    DateTime,
    DateTimeLocal,
    Money,
    IntegerNumber,
    DecimalNumber,
    ForeignKeyName,
    User,
    GeoPoint,
    Color,
    Email,
    Telephone,
    TimeSlot,
    ManyToMany,
    File,
    FileImage,
    FilePDF,
    Payment,
}

/**
 * Payment transaction value from payments.transactions view.
 * Returned when a Payment property type is embedded in entity data.
 */
export interface PaymentValue {
    id: string;  // UUID
    status: 'pending_intent' | 'pending' | 'succeeded' | 'failed' | 'canceled';
    amount: number;
    currency: string;
    display_name: string;
    provider_client_secret?: string;
    error_message?: string;
    created_at: string;
}

/**
 * Valid types for entity property values.
 * Entities can have various column types that map to these TypeScript types.
 */
export type EntityPropertyValue = string | number | boolean | null | object;

export interface EntityData {
    id: number,
    created_at: string,
    updated_at: string,
    display_name: string,
    [key: string]: EntityPropertyValue; // Allow dynamic properties for entity-specific columns
}

/**
 * Metadata for an inverse relationship (back-reference).
 * Describes a relationship where another entity references this entity via foreign key.
 */
export interface InverseRelationshipMeta {
    sourceTable: string;
    sourceTableDisplayName: string;
    sourceColumn: string;
    sourceColumnDisplayName: string;
    showOnDetail: boolean;
    sortOrder: number;
    previewLimit: number;
}

/**
 * Complete inverse relationship data including metadata and fetched records.
 * Used to display related records on the Detail page.
 */
export interface InverseRelationshipData {
    meta: InverseRelationshipMeta;
    totalCount: number;
    previewRecords: EntityData[];
    targetId: string | number;
}

/**
 * Metadata for a many-to-many relationship.
 * Describes one side of a bidirectional M:M relationship via junction table.
 */
export interface ManyToManyMeta {
    // Junction table info
    junctionTable: string;

    // The two entities in the relationship
    sourceTable: string;       // The entity we're viewing/editing
    targetTable: string;       // The related entity (other side)

    // Foreign key columns in junction table
    sourceColumn: string;      // FK to source (e.g., 'issue_id')
    targetColumn: string;      // FK to target (e.g., 'tag_id')

    // Display info for the related entity
    relatedTable: string;           // Same as targetTable (convenience)
    relatedTableDisplayName: string; // Human-readable (e.g., 'Tags')

    // Configuration
    showOnSource: boolean;     // Show this M:M on source entity forms
    showOnTarget: boolean;     // Show this M:M on target entity forms
    displayOrder: number;      // Sort order in property list

    // Optional fields on related table
    relatedTableHasColor: boolean;  // Whether related table has 'color' column
}

/**
 * Complete FK lookup structure for import validation.
 * Supports: ID validation, name-to-ID lookup, and reverse lookup for error messages.
 */
export interface ForeignKeyLookup {
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

/**
 * Represents a single validation error during import.
 */
export interface ImportError {
    row: number;        // Excel row number (1-indexed, includes header)
    column: string;     // Column display name
    value: any;         // The invalid value
    error: string;      // Error message
    errorType: string;  // Error category for grouping
}

/**
 * Summary of all validation errors with grouping and limits.
 */
export interface ValidationErrorSummary {
    totalErrors: number;
    errorsByType: Map<string, number>;    // "Status not found" → 450
    errorsByColumn: Map<string, number>;  // "Status" → 450
    firstNErrors: ImportError[];          // First 100 for UI display
    allErrors: ImportError[];             // All errors for download
}

/**
 * Progress message during validation in Web Worker.
 */
export interface ValidationProgress {
    type: 'progress';
    progress: {
        currentRow: number;
        totalRows: number;
        percentage: number;
        stage: string;
    };
}

/**
 * Completion message from Web Worker validation.
 */
export interface ValidationComplete {
    type: 'complete';
    results: {
        validRows: any[];
        errorSummary: ValidationErrorSummary;
    };
}

/**
 * Cancellation message from Web Worker.
 */
export interface ValidationCancelled {
    type: 'cancelled';
}

/**
 * Error message from Web Worker.
 */
export interface ValidationError {
    type: 'error';
    error: string;
}