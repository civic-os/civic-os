/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from src/app/interfaces; PostgREST payloads are untyped JSON and tightening `any` would change the public types (SDK P1.4+). */

/**
 * A function from the schema_functions view (v0.29.0: includes source_code).
 *
 * @consumer app
 */
export interface SchemaFunction {
  function_name: string;
  schema_name: string;
  display_name: string;
  description: string | null;
  category: string | null;
  parameters: any | null;
  returns_type: string;
  returns_description: string | null;
  is_idempotent: boolean;
  minimum_role: string | null;
  entity_effects: EntityEffect[];
  hidden_effects_count: number;
  is_registered: boolean;
  has_active_schedule: boolean;
  can_execute: boolean;
  source_code: string | null;
  language: string | null;
  /** Pre-parsed AST JSON from server-side pg_query_go parsing. */
  ast_json?: any | null;
}

/**
 * A trigger from the schema_triggers view (v0.29.0: includes source columns).
 *
 * @consumer app
 */
export interface SchemaTrigger {
  trigger_name: string;
  table_name: string;
  schema_name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: string[];
  function_name: string;
  display_name: string;
  description: string | null;
  purpose: string | null;
  is_enabled: boolean;
  is_registered: boolean;
  entity_effects: EntityEffect[];
  hidden_effects_count: number;
  trigger_definition: string | null;
  function_source: string | null;
}

/**
 * An entity effect (used in both functions and triggers).
 *
 * @consumer typed SchemaFunction
 */
export interface EntityEffect {
  table: string;
  effect: string;
  auto_detected: boolean;
  description: string | null;
}

/**
 * A code object returned by get_entity_source_code() RPC.
 *
 * @consumer app
 */
export interface CodeObject {
  object_type: CodeObjectType;
  object_name: string;
  display_name: string;
  description: string | null;
  source_code: string;
  language: string;
  related_table: string;
  category: string;
  /** Pre-parsed AST JSON from server-side pg_query_go parsing (null if not parsed or parse failed). */
  ast_json?: any | null;
  /** Parse error message if server-side parsing failed. */
  parse_error?: string | null;
}

/** @consumer app */
export type CodeObjectType =
  | 'function'
  | 'trigger_function'
  | 'view_definition'
  | 'trigger_definition'
  | 'rls_policy'
  | 'check_constraint'
  | 'column_default'
  | 'domain_definition';

/**
 * Response from get_entity_source_code() RPC.
 *
 * @consumer app
 */
export interface EntitySourceCodeResponse {
  code_objects: CodeObject[];
  hidden_code_count: number;
}

/**
 * Pre-parsed AST from parsed_source_code view (populated by Go worker).
 *
 * @consumer app
 */
export interface ParsedSourceCode {
  schema_name: string;
  object_name: string;
  object_type: 'function' | 'view';
  language: string;
  ast_json: any | null;
  parse_error: string | null;
  parsed_at: string;
}

/**
 * An RLS policy from schema_rls_policies view (admin-only).
 *
 * @consumer app
 */
export interface SchemaRlsPolicy {
  schema_name: string;
  table_name: string;
  policy_name: string;
  permissive: string;
  roles: string[];
  command: string;
  using_expression: string | null;
  with_check_expression: string | null;
}
