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

/**
 * A function from the schema_functions view (v0.29.0: includes source_code).
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
 */
export interface EntityEffect {
  table: string;
  effect: string;
  auto_detected: boolean;
  description: string | null;
}

/**
 * A code object returned by get_entity_source_code() RPC.
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
 */
export interface EntitySourceCodeResponse {
  code_objects: CodeObject[];
  hidden_code_count: number;
}

/**
 * Pre-parsed AST from parsed_source_code view (populated by Go worker).
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
