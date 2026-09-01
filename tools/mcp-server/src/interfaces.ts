/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Shared interfaces for the Civic OS MCP server.
 * Simplified subset of the Angular frontend's entity.ts — only what the MCP server needs.
 */

// ============================================================================
// Schema Metadata Types (from PostgREST schema views)
// ============================================================================

/** Entity metadata from schema_entities view */
export interface SchemaEntity {
  display_name: string;
  table_name: string;
  description: string | null;
  sort_order: number;

  // CRUD permissions (filtered by JWT role)
  insert: boolean;
  select: boolean;
  update: boolean;
  delete: boolean;

  // Feature flags
  show_in_sidebar?: boolean;
  show_map?: boolean;
  map_property_name?: string | null;
  show_calendar?: boolean;
  calendar_property_name?: string | null;
  enable_notes?: boolean;
  supports_recurring?: boolean;
  is_view?: boolean;
  is_rich_junction?: boolean;
  guided_form_key?: string | null;
  payment_initiation_rpc?: string | null;

  // Search configuration
  fulltext_search_column?: string | null;
  substring_search_column?: string | null;
}

/** Property metadata from schema_properties view */
export interface SchemaProperty {
  table_name: string;
  column_name: string;
  display_name: string;
  description?: string;
  data_type: string;
  udt_name: string;
  udt_schema: string;
  sort_order: number;
  column_width?: number;

  // FK metadata
  join_schema: string;
  join_table: string;
  join_column: string;
  geography_type: string;

  // Column characteristics
  is_nullable: boolean;
  is_updatable: boolean;
  is_identity: boolean;
  is_generated: boolean;
  is_self_referencing: boolean;
  column_default: string;

  // Visibility flags
  show_on_list?: boolean;
  show_on_create?: boolean;
  show_on_edit?: boolean;
  show_on_detail?: boolean;
  sortable?: boolean;
  filterable?: boolean;

  // Type discriminators
  status_entity_type?: string;
  category_entity_type?: string;
  is_recurring?: boolean;

  // FK configuration
  options_source_rpc?: string;
  depends_on_columns?: string[];
  fk_search_modal?: boolean;
  options_filter_column?: string;
  show_inline?: boolean;

  // Validation rules from metadata
  validation_rules?: Array<{ type: string; value?: string; message: string }>;

  // Computed by MCP server
  type?: EntityPropertyType;
}

/** Property type enum — mirrors Angular frontend's EntityPropertyType */
export enum EntityPropertyType {
  Unknown = 0,
  TextShort = 1,
  TextLong = 2,
  Boolean = 3,
  Date = 4,
  DateTime = 5,
  DateTimeLocal = 6,
  Money = 7,
  IntegerNumber = 8,
  DecimalNumber = 9,
  ForeignKeyName = 10,
  User = 11,
  GeoPoint = 12,
  Color = 13,
  Email = 14,
  Telephone = 15,
  TimeSlot = 16,
  ManyToMany = 17,
  File = 18,
  FileImage = 19,
  FilePDF = 20,
  Payment = 21,
  Status = 22,
  Category = 23,
  RecurringTimeSlot = 24,
  PhotoGallery = 25,
  GeoPolygon = 26,
  Markdown = 27,
}

// ============================================================================
// Entity Actions (from schema_entity_actions view)
// ============================================================================

/** Condition for action visibility/enablement */
export type ActionCondition = SimpleCondition | OrCondition | AndCondition;

export interface SimpleCondition {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'is_null' | 'is_not_null';
  value?: unknown;
}

export interface OrCondition {
  or: ActionCondition[];
}

export interface AndCondition {
  and: ActionCondition[];
}

/** Entity action from schema_entity_actions view */
export interface SchemaEntityAction {
  id: number;
  table_name: string;
  action_name: string;
  display_name: string;
  description?: string;
  rpc_function: string;
  icon?: string;
  button_style: string;
  sort_order: number;
  requires_confirmation: boolean;
  confirmation_message?: string;
  visibility_condition?: ActionCondition;
  enabled_condition?: ActionCondition;
  disabled_tooltip?: string;
  default_success_message?: string;
  default_navigate_to?: string;
  refresh_after_action: boolean;
  show_on_detail: boolean;
  can_execute: boolean;
  parameters: EntityActionParam[];
}

/** Action parameter definition */
export interface EntityActionParam {
  id: number;
  param_name: string;
  display_name: string;
  param_type: string;
  required: boolean;
  sort_order: number;
  placeholder?: string;
  default_value?: string;
  join_table?: string;
  join_column?: string;
  status_entity_type?: string;
  category_entity_type?: string;
  options_source_rpc?: string;
  depends_on_params?: string[];
}

/** RPC result from entity actions */
export interface EntityActionResult {
  success: boolean;
  message?: string;
  navigate_to?: string;
  refresh?: boolean;
  data?: unknown;
}

// ============================================================================
// Status & Category
// ============================================================================

export interface StatusOption {
  id: number;
  display_name: string;
  color: string | null;
  entity_type: string;
  is_initial?: boolean;
  is_terminal?: boolean;
  status_key?: string;
}

export interface CategoryOption {
  id: number;
  display_name: string;
  color: string | null;
  entity_type: string;
}

export interface StatusTransition {
  from_status_id: number;
  to_status_id: number;
  entity_type: string;
}

// ============================================================================
// Constraint Messages
// ============================================================================

export interface ConstraintMessage {
  constraint_name: string;
  table_name: string;
  column_name: string | null;
  error_message: string;
}

// ============================================================================
// PostgREST Types
// ============================================================================

/** PostgREST error response body */
export interface PostgRESTError {
  message: string;
  details: string | null;
  hint: string | null;
  code: string;
}

/** Parsed response from PostgREST with headers */
export interface PostgRESTResponse<T = unknown> {
  data: T;
  status: number;
  contentRange?: ContentRange;
}

export interface ContentRange {
  from: number;
  to: number;
  total: number | null;
}

// ============================================================================
// MCP Tool Input Types
// ============================================================================

export interface FilterInput {
  field: string;
  operator: string;
  value: unknown;
}

// ============================================================================
// Schema Cache Version
// ============================================================================

export interface SchemaCacheVersion {
  cache_name: string;
  version: string;
}
