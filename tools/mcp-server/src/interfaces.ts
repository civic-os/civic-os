/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Interfaces for the Civic OS MCP server. The metadata model (entities,
 * properties, actions, conditions, constraint messages) is @civic-os/core's;
 * only the shapes the MCP server alone needs are declared here.
 */

// ============================================================================
// Schema Metadata Types (core model, under the names the tools use)
// ============================================================================

export type {
  SchemaEntityTable as SchemaEntity,
  SchemaEntityProperty as SchemaProperty,
  EntityAction as SchemaEntityAction,
  EntityActionParam,
  EntityActionResult,
  ActionCondition,
  SimpleCondition,
  OrCondition,
  AndCondition,
  ConstraintMessage,
} from '@civic-os/core';

// ============================================================================
// Status & Category (the bulk `statuses` / `categories` views carry entity_type)
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

/** Row returned by `rpc/get_status_transitions_for_entity` (same source as the frontend). */
export interface StatusTransition {
  id: number;
  entity_type: string;
  from_status_id: number;
  from_display_name: string;
  to_status_id: number;
  to_display_name: string;
  on_transition_rpc: string | null;
  display_name: string | null;
  description: string | null;
  sort_order: number;
  is_enabled: boolean;
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
  /** null for an empty range (PostgREST sends "*" in place of from-to) */
  from: number | null;
  to: number | null;
  /** null when PostgREST did not count ("0-24/*") */
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
