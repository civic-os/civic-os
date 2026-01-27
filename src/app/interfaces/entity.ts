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
    // Notes configuration (v0.16.0)
    enable_notes?: boolean,
    // Recurring configuration (v0.19.0)
    supports_recurring?: boolean,
    recurring_property_name?: string | null,
    // Virtual Entity flag (v0.28.0)
    // True when entity is backed by a VIEW with INSTEAD OF triggers
    is_view?: boolean,
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

    // Status type configuration (v0.15.0)
    // When present, indicates this is a Status type column
    status_entity_type?: string;

    // Recurring time slot configuration (v0.19.0)
    // When true and udt_name is 'time_slot', enables recurring series UI
    is_recurring?: boolean;
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
    Status,
    RecurringTimeSlot,  // v0.19.0 - TimeSlot with recurring series support
}

/**
 * Status value from metadata.statuses table.
 * Returned when a Status property type is embedded in entity data via PostgREST.
 */
export interface StatusValue {
    id: number;
    display_name: string;
    color: string | null;  // hex_color, nullable
}

/**
 * Entity note from metadata.entity_notes table.
 * Notes are polymorphic - one table serves all entities.
 * Added in v0.16.0.
 */
export interface EntityNote {
    id: number;
    entity_type: string;
    entity_id: string;
    author_id: string;
    author?: { id: string; display_name: string; full_name?: string | null };  // Embedded via PostgREST select
    content: string;
    note_type: 'note' | 'system';
    is_internal: boolean;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

/**
 * Payment transaction value from payments.transactions view.
 * Returned when a Payment property type is embedded in entity data.
 *
 * @property status - Original payment status (for auditing)
 * @property effective_status - Display status accounting for refunds (use this for UI)
 */
export interface PaymentValue {
    id: string;  // UUID
    status: 'pending_intent' | 'pending' | 'succeeded' | 'failed' | 'canceled';
    effective_status: 'pending_intent' | 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded' | 'partially_refunded' | 'refund_pending';
    amount: number;           // Base amount (original pricing)
    processing_fee: number;   // Processing fee amount
    total_amount: number;     // Total charged to Stripe (amount + processing_fee)
    max_refundable: number;   // Maximum refundable amount (respects fee_refundable)
    currency: string;
    display_name: string;
    provider_client_secret?: string;
    error_message?: string;
    created_at: string;
    // Processing fee configuration at time of payment (for auditing/receipts)
    fee_percent?: number;     // Fee percentage applied (e.g., 2.9 for 2.9%)
    fee_flat_cents?: number;  // Flat fee in cents (e.g., 30 for $0.30)
    fee_refundable: boolean;  // Whether fee was refundable at payment time
    // Aggregated refund data (supports multiple refunds per transaction)
    total_refunded: number;  // Sum of succeeded refund amounts
    refund_count: number;    // Number of succeeded refunds
    pending_refund_count: number;  // Number of pending refunds
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

// ============================================================================
// STATIC TEXT SYSTEM (v0.17.0)
// ============================================================================

/**
 * Static text block from metadata.static_text table.
 * Displayed on Detail/Edit/Create pages alongside regular properties.
 * Uses full markdown rendering via ngx-markdown.
 *
 * Added in v0.17.0.
 */
export interface StaticText {
    /** Discriminator for type guards in RenderableItem union */
    itemType: 'static_text';

    /** Primary key */
    id: number;

    /** Target entity table name */
    table_name: string;

    /** Markdown content (full markdown support) */
    content: string;

    /** Position relative to properties (lower = earlier) */
    sort_order: number;

    /** Width in grid columns: 1 = half, 2 = full */
    column_width: number;

    /** Show on Detail pages */
    show_on_detail: boolean;

    /** Show on Create pages */
    show_on_create: boolean;

    /** Show on Edit pages */
    show_on_edit: boolean;
}

/**
 * Property with itemType discriminator added for RenderableItem union.
 * Used when merging properties with static text for unified rendering.
 */
export type PropertyItem = SchemaEntityProperty & { itemType: 'property' };

/**
 * Union type for items that can be rendered on Detail/Edit/Create pages.
 * Includes both database properties and static text blocks.
 *
 * Use type guards `isStaticText()` and `isProperty()` to discriminate.
 */
export type RenderableItem = PropertyItem | StaticText;

/**
 * Type guard to check if a renderable item is static text.
 *
 * @example
 * ```typescript
 * @for (item of renderables; track trackRenderable(item)) {
 *   @if (isStaticText(item)) {
 *     <app-static-text [staticText]="item"></app-static-text>
 *   } @else {
 *     <app-display-property [property]="item"></app-display-property>
 *   }
 * }
 * ```
 */
export function isStaticText(item: RenderableItem): item is StaticText {
    return item.itemType === 'static_text';
}

/**
 * Type guard to check if a renderable item is a property.
 */
export function isProperty(item: RenderableItem): item is PropertyItem {
    return item.itemType === 'property';
}

// ============================================================================
// ENTITY ACTIONS SYSTEM (v0.18.0)
// ============================================================================

/**
 * Condition for evaluating visibility or enablement of an action button.
 * Evaluated against the current record data.
 *
 * @example
 * ```typescript
 * // Button enabled only when status_id equals 1 (Pending)
 * { field: 'status_id', operator: 'eq', value: 1 }
 *
 * // Button visible when status is NOT Cancelled
 * { field: 'status_id', operator: 'ne', value: 4 }
 *
 * // Button enabled when status is one of [1, 2]
 * { field: 'status_id', operator: 'in', value: [1, 2] }
 * ```
 */
export interface ActionCondition {
    /** Field name to evaluate from the record data */
    field: string;
    /** Comparison operator */
    operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'is_null' | 'is_not_null';
    /** Value to compare against (not used for is_null/is_not_null) */
    value?: any;
}

/**
 * Entity action configuration from metadata.entity_actions table.
 * Represents a button on the Detail page that executes an RPC.
 *
 * Added in v0.18.0.
 */
export interface EntityAction {
    /** Primary key */
    id: number;

    /** Target entity table name */
    table_name: string;

    /** Unique action identifier within the entity */
    action_name: string;

    /** Button label */
    display_name: string;

    /** Optional description (shown in tooltips) */
    description?: string;

    /** PostgreSQL RPC function to call */
    rpc_function: string;

    /** Material icon name */
    icon?: string;

    /** DaisyUI 5 button style (color modifier) */
    button_style: 'primary' | 'secondary' | 'accent' | 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'ghost';

    /** Display order (lower = earlier) */
    sort_order: number;

    /** Whether to show confirmation modal before executing */
    requires_confirmation: boolean;

    /** Message shown in confirmation modal */
    confirmation_message?: string;

    /** Condition for button visibility (null = always visible) */
    visibility_condition?: ActionCondition;

    /** Condition for button enablement (null = always enabled, true = enabled) */
    enabled_condition?: ActionCondition;

    /** Tooltip shown when button is disabled */
    disabled_tooltip?: string;

    /** Default success message (RPC can override) */
    default_success_message?: string;

    /** Path to navigate to after success (RPC can override) */
    default_navigate_to?: string;

    /** Whether to refresh data after action completes */
    refresh_after_action: boolean;

    /** Whether this action appears on Detail pages */
    show_on_detail: boolean;

    /** Whether current user can execute this action (from view) */
    can_execute: boolean;
}

/**
 * Result returned from an entity action RPC.
 * RPCs should return JSONB matching this structure.
 *
 * @example
 * ```sql
 * RETURN jsonb_build_object(
 *   'success', true,
 *   'message', 'Request approved!',
 *   'refresh', true
 * );
 * ```
 */
export interface EntityActionResult {
    /** Whether the action succeeded */
    success: boolean;

    /** Message to display (overrides default_success_message) */
    message?: string;

    /** Path to navigate to (overrides default_navigate_to) */
    navigate_to?: string;

    /** Whether to refresh data (overrides refresh_after_action) */
    refresh?: boolean;

    /** Additional data returned by the RPC */
    data?: any;
}

// ============================================================================
// RECURRING TIME SLOT SYSTEM (v0.19.0)
// ============================================================================

/**
 * Series group - logical container for recurring schedule versions.
 * What users see as "one recurring event" in the UI.
 * Added in v0.19.0.
 */
export interface SeriesGroup {
    id: number;
    display_name: string;
    description?: string | null;
    color?: string | null;
    created_by?: string | null;
    created_at: string;
    updated_at: string;

    // Summary stats (from view)
    version_count?: number;
    started_on?: string;
    entity_table?: string;
    current_version?: SeriesVersionSummary;
    active_instance_count?: number;
    exception_count?: number;
    status?: 'active' | 'needs_attention' | 'ended';

    // Expanded detail data (from detail endpoint)
    versions?: SeriesVersionSummary[];
    total_instances?: number;
    upcoming_instances?: Array<{
        id: number;
        entity_id?: number;
        occurrence_date: string;
        is_exception: boolean;
    }>;

    // Embedded instances from view (added in v0.19.0)
    instances?: SeriesInstanceSummary[];
}

/**
 * Summary of a series instance embedded in the group view.
 * Added in v0.19.0.
 */
export interface SeriesInstanceSummary {
    id: number;
    series_id: number;
    occurrence_date: string;
    entity_table: string;
    entity_id: number | null;
    is_exception: boolean;
    exception_type?: string | null;
    exception_reason?: string | null;
}

/**
 * Summary of the current series version (embedded in SeriesGroup).
 */
export interface SeriesVersionSummary {
    series_id: number;
    rrule: string;
    rrule_description?: string;
    dtstart: string;
    duration: string;
    status: string;
    expanded_until?: string;
    terminated_at?: string;
    instance_count?: number;
    /** Entity template (JSONB from database) - included in current_version from view */
    entity_template?: Record<string, any>;
}

/**
 * Series - RRULE definition and entity template.
 * Multiple series can belong to one group (after splits).
 * Added in v0.19.0.
 */
export interface Series {
    id: number;
    group_id?: number | null;
    version_number: number;
    effective_from: string;
    effective_until?: string | null;
    entity_table: string;
    entity_template: Record<string, any>;
    rrule: string;
    dtstart: string;
    duration: string;
    timezone?: string | null;
    time_slot_property: string;
    status: 'active' | 'paused' | 'needs_attention' | 'ended';
    expanded_until?: string | null;
    created_by?: string | null;
    created_at: string;
    template_updated_at?: string | null;
    template_updated_by?: string | null;
}

/**
 * Series instance - junction record mapping series to entity.
 * Tracks exceptions and cancellations.
 * Added in v0.19.0.
 */
export interface SeriesInstance {
    id: number;
    series_id: number;
    occurrence_date: string;
    entity_table: string;
    entity_id?: number | null;
    is_exception: boolean;
    exception_type?: 'modified' | 'rescheduled' | 'cancelled' | 'conflict_skipped' | null;
    original_time_slot?: string | null;
    exception_reason?: string | null;
    exception_at?: string | null;
    exception_by?: string | null;
    created_at: string;
}

/**
 * Series membership info returned by get_series_membership RPC.
 * Used to detect if an entity record is part of a series.
 * Added in v0.19.0.
 */
export interface SeriesMembership {
    is_member: boolean;
    series_id?: number;
    group_id?: number;
    group_name?: string;
    group_color?: string;
    occurrence_date?: string;
    is_exception?: boolean;
    exception_type?: string;
    original_template?: Record<string, any>;
}

/**
 * Conflict info returned by preview_recurring_conflicts RPC.
 * Shows which occurrences have conflicts before creating a series.
 * Added in v0.19.0.
 */
export interface ConflictInfo {
    occurrence_index: number;
    occurrence_start: string;
    occurrence_end: string;
    has_conflict: boolean;
    conflicting_id?: number;
    conflicting_display?: string;
}

/**
 * Result returned by create_recurring_series RPC.
 */
export interface CreateSeriesResult {
    success: boolean;
    group_id?: number;
    series_id?: number;
    message: string;
}

/**
 * Edit scope options for series members.
 * Determines how edits/deletes affect the series.
 */
export type SeriesEditScope = 'this_only' | 'this_and_future' | 'all';

/**
 * RRULE frequency options for UI.
 */
export type RRuleFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/**
 * Day of week constants for RRULE BYDAY parameter.
 */
export type RRuleDayOfWeek = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

/**
 * RRULE configuration for UI builder component.
 */
export interface RRuleConfig {
    frequency: RRuleFrequency;
    interval: number;
    byDay?: RRuleDayOfWeek[];
    byMonthDay?: number[];
    byMonth?: number[];
    bySetPos?: number[];  // Position in set: 1-5 (1st-5th), -1 (last). Used with BYDAY for "2nd Tuesday" patterns.
    count?: number;
    until?: string;
}