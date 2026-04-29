/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export interface GuidedFormStatusOption {
  id: number;
  status_key: string;
  display_name: string;
  color: string;
}

export interface GuidedFormDefinition {
  guided_form_key: string;
  description: string | null;
  parent_table: string;
  ownership_column: string | null;
  lock_on_submit: boolean;
  on_submit_rpc: string | null;
  review_intro_text: string | null;
  precondition_rpc: string | null;
  auto_submit_on_all_skipped: boolean;
  is_enabled: boolean;
  status_options: GuidedFormStatusOption[];
}

export interface GuidedFormStep {
  id: number;
  guided_form_key: string;
  step_key: string;
  display_name: string;
  description: string | null;
  step_table: string;
  parent_fk_column: string | null;
  step_order: number;
  can_skip: boolean;
  track_key: string | null;
  conditions: GuidedFormCondition[];
}

export interface GuidedFormCondition {
  id: number;
  condition_type: 'skip_if' | 'require_if';
  field: string;
  operator: 'eq' | 'neq' | 'is_null' | 'is_not_null';
  value: string | null;
}

export interface GuidedFormProgressEntry {
  id: number;
  guided_form_key: string;
  parent_id: number;
  step_key: string;
  completed_at: string;
  completed_by: string | null;
  submitted_at: string | null;
  created_at: string;
}

export interface EffectiveGuidedFormStep extends GuidedFormStep {
  isSkipped: boolean;
  isCompleted: boolean;
  isRequired: boolean;
  recordId?: number | string;
}

/**
 * Full guided form context returned by get_guided_form_context() RPC.
 * Contains everything the frontend needs to render a guided form page
 * in a single round-trip — definition, steps, progress, parent status,
 * and step record IDs.
 */
export interface GuidedFormContext {
  definition: GuidedFormDefinition;
  steps: GuidedFormStep[];
  progress: GuidedFormProgressEntry[];
  status_options: GuidedFormStatusOption[];
  parent_status_id: number | null;
  parent_status_key: string | null;
  parent_id: number;
  record_id: number;
  is_child_step: boolean;
  step_key: string | null;
  step_record_ids: Record<string, number>;
}
