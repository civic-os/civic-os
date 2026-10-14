/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Hand-built metadata rows (the `_synthetic` golden variant) for branches that
 * no example instance exercises. They go through the SAME loadSchema() path as
 * the raw fixtures, so every schema.* / transforms / data.m2m artifact is also
 * generated for them. Each row is named after the branch it covers; keep rows
 * minimal. Branch list: schema.service.ts getPropertyType, getColumnSpan,
 * getPreviewMode, detectJunctionTables / detectParentHops, ensureStructuralProps,
 * getPropsFor* filters, getFormValidatorsForProperty; GuidedFormService.
 */
import { listAllVariants, Variant } from './golden-io';

type Row = Record<string, any>;

const ENTITY_DEFAULTS: Row = {
  calendar_color_property: null, calendar_property_name: null, delete: true, description: null, enable_notes: false,
  fulltext_search_column: null, guided_form_key: null, insert: true, is_rich_junction: false, is_view: false,
  map_color_property: null, map_property_name: null, payment_capture_mode: null, payment_initiation_rpc: null,
  recurring_property_name: null, search_fields: null, select: true, show_calendar: false, show_in_sidebar: true,
  show_map: false, sort_order: 0, substring_search_column: null, supports_recurring: false, update: true,
};

const PROP_DEFAULTS: Row = {
  category_entity_type: null, character_maximum_length: null, column_default: null, column_width: null,
  data_type: 'text', depends_on_columns: null, description: null, filterable: false, fk_search_modal: false,
  geography_type: null, is_generated: false, is_identity: false, is_nullable: true, is_recurring: false,
  is_self_referencing: false, is_updatable: true, join_column: null, join_schema: null, join_table: null,
  options_filter_column: null, options_source_rpc: null, show_inline: false, show_on_create: true,
  show_on_detail: true, show_on_edit: true, show_on_list: true, sort_order: 10, sortable: true,
  status_entity_type: null, table_catalog: 'civic_os_db', table_schema: 'public', udt_name: 'text',
  udt_schema: 'pg_catalog', validation_rules: [],
};

const entity = (table_name: string, o: Row = {}): Row => ({ ...ENTITY_DEFAULTS, display_name: table_name, table_name, ...o });

let order = 0;
const prop = (table_name: string, column_name: string, o: Row = {}): Row =>
  ({ ...PROP_DEFAULTS, display_name: column_name, table_name, column_name, sort_order: (order += 10), ...o });

const idProp = (t: string) => prop(t, 'id', { udt_name: 'int4', data_type: 'integer', is_identity: true, is_updatable: false, show_on_create: false, show_on_edit: false });
const displayName = (t: string) => prop(t, 'display_name', { is_nullable: false });
const fk = (t: string, col: string, target: string, o: Row = {}) =>
  prop(t, col, { udt_name: 'int4', data_type: 'integer', join_schema: 'public', join_table: target, join_column: 'id', is_nullable: false, ...o });
const rule = (type: string, value?: any) => ({ type, message: `${type} message`, ...(value === undefined ? {} : { value }) });

function build() {
  order = 0;
  const entities: Row[] = [];
  const props: Row[] = [];
  const m2m: Row[] = [];
  const addEntity = (name: string, o: Row = {}, withBasics = true) => {
    entities.push(entity(name, { sort_order: entities.length, ...o }));
    if (withBasics) props.push(idProp(name), displayName(name));
  };

  // ---- every getPropertyType branch ---------------------------------------
  addEntity('syn_types', { show_map: true, map_property_name: 'geo_point_map_only' });
  const T = 'syn_types';
  const t = (col: string, o: Row = {}) => props.push(prop(T, col, o));
  // Status / Category: int4 and int8, and the negative cases that fall through
  t('status_int4', { udt_name: 'int4', join_schema: 'public', join_table: 'statuses', join_column: 'id', status_entity_type: 'syn_status' });
  t('status_int8', { udt_name: 'int8', join_schema: 'public', join_table: 'statuses', join_column: 'id', status_entity_type: 'syn_status' });
  t('status_no_join_column_is_integer', { udt_name: 'int4', status_entity_type: 'syn_status' });
  t('status_text_udt_is_textlong', { udt_name: 'text', join_column: 'id', status_entity_type: 'syn_status' });
  t('category_int4', { udt_name: 'int4', join_schema: 'public', join_table: 'categories', join_column: 'id', category_entity_type: 'syn_cat' });
  t('category_int8', { udt_name: 'int8', join_schema: 'public', join_table: 'categories', join_column: 'id', category_entity_type: 'syn_cat' });
  t('category_no_join_column_is_integer', { udt_name: 'int8', category_entity_type: 'syn_cat' });
  t('status_wins_over_category', { udt_name: 'int4', join_schema: 'public', join_table: 'statuses', join_column: 'id', status_entity_type: 'syn_status', category_entity_type: 'syn_cat' });
  // uuid system types
  const uuidFk = (col: string, table: string, o: Row = {}) => t(col, { udt_name: 'uuid', data_type: 'uuid', join_table: table, join_column: 'id', join_schema: 'public', ...o });
  uuidFk('file_plain', 'files');
  uuidFk('file_image', 'files', { validation_rules: [rule('fileType', 'image/*')] });
  uuidFk('file_image_png', 'files', { validation_rules: [rule('fileType', 'image/png')] });
  uuidFk('file_pdf', 'files', { validation_rules: [rule('fileType', 'application/pdf')] });
  uuidFk('file_other_type', 'files', { validation_rules: [rule('fileType', 'text/csv')] });
  uuidFk('file_empty_type', 'files', { validation_rules: [rule('fileType', '')] });
  uuidFk('file_max_size_only', 'files', { validation_rules: [rule('maxFileSize', '1000')] });
  uuidFk('user_fk', 'civic_os_users');
  uuidFk('payment_view', 'payment_transactions');
  uuidFk('payment_transactions_payments_schema', 'transactions', { join_schema: 'payments' });
  uuidFk('transactions_public_schema_is_unknown', 'transactions');
  uuidFk('photo_gallery', 'photo_galleries');
  uuidFk('system_table_without_branch_is_unknown', 'statuses');
  t('uuid_plain_is_unknown', { udt_name: 'uuid', data_type: 'uuid' });
  uuidFk('uuid_fk_to_entity_is_unknown', 'syn_parent');
  // foreign key
  t('fk_int4', { udt_name: 'int4', join_schema: 'public', join_table: 'syn_parent', join_column: 'id' });
  t('fk_int8', { udt_name: 'int8', join_schema: 'public', join_table: 'syn_parent', join_column: 'id' });
  t('fk_non_public_schema', { udt_name: 'int4', join_schema: 'metadata', join_table: 'syn_parent', join_column: 'id' });
  // geography
  t('geo_polygon', { udt_name: 'geography', geography_type: 'Polygon', data_type: 'USER-DEFINED' });
  t('geo_point', { udt_name: 'geography', geography_type: 'Point', data_type: 'USER-DEFINED' });
  t('geo_linestring_is_unknown', { udt_name: 'geography', geography_type: 'LineString', data_type: 'USER-DEFINED' });
  t('geo_null_type_is_unknown', { udt_name: 'geography', data_type: 'USER-DEFINED' });
  t('geo_point_map_only', { udt_name: 'geography', geography_type: 'Point', data_type: 'USER-DEFINED', show_on_list: false });
  // scalars
  const scalar = (col: string, udt: string, o: Row = {}) => t(col, { udt_name: udt, ...o });
  scalar('timestamp_datetime', 'timestamp');
  scalar('timestamptz_datetimelocal', 'timestamptz');
  scalar('date_date', 'date');
  scalar('bool_boolean', 'bool');
  scalar('int4_integer', 'int4');
  scalar('int8_integer', 'int8');
  scalar('int2_is_unknown', 'int2');
  scalar('money_money', 'money');
  scalar('numeric_decimal', 'numeric');
  scalar('float4_decimal', 'float4');
  scalar('float8_decimal', 'float8');
  scalar('hex_color_color', 'hex_color');
  scalar('email_address_email', 'email_address');
  scalar('phone_number_telephone', 'phone_number');
  scalar('time_slot_plain', 'time_slot');
  scalar('time_slot_recurring', 'time_slot', { is_recurring: true });
  scalar('markdown_default_span', 'markdown');
  scalar('markdown_custom_span', 'markdown', { column_width: 1 });
  scalar('varchar_textshort', 'varchar');
  scalar('text_textlong', 'text');
  scalar('jsonb_is_unknown', 'jsonb');
  scalar('bpchar_is_unknown', 'bpchar');
  scalar('tsvector_is_unknown', 'tsvector');
  // column span and default-value branches
  t('span_width_1_textlong', { udt_name: 'text', column_width: 1 });
  t('span_width_2_textshort', { udt_name: 'varchar', column_width: 2 });
  t('span_width_3_custom', { udt_name: 'varchar', column_width: 3 });
  t('span_width_zero_falls_to_default', { udt_name: 'text', column_width: 0 });

  // ---- view-filter flags ----------------------------------------------------
  const F = 'syn_flags';
  addEntity(F);
  const f = (col: string, o: Row = {}) => props.push(prop(F, col, { udt_name: 'varchar', ...o }));
  f('created_at', { udt_name: 'timestamptz', is_updatable: false, show_on_create: false, show_on_edit: false });
  f('updated_at', { udt_name: 'timestamptz', is_updatable: true });
  f('hidden_everywhere', { show_on_list: false, show_on_detail: false, show_on_create: false, show_on_edit: false });
  f('hidden_list_only', { show_on_list: false });
  f('hidden_edit_only', { show_on_edit: false });
  f('hidden_create_only', { show_on_create: false });
  f('hidden_detail_only', { show_on_detail: false });
  f('not_updatable', { is_updatable: false });
  f('generated', { is_generated: true });
  f('identity_col', { is_identity: true });
  f('status_id', { udt_name: 'int4', join_schema: 'public', join_table: 'statuses', join_column: 'id', status_entity_type: 'syn_status', show_on_list: false, show_on_detail: false, show_on_edit: false, filterable: true });
  f('submitted_at', { udt_name: 'timestamptz', show_on_list: false, show_on_detail: false, show_on_edit: false, is_updatable: false });
  f('show_flag_null_is_visible', { show_on_list: null, show_on_detail: null, show_on_create: null, show_on_edit: null });
  // filterable per supported/unsupported type
  const filt = (col: string, udt: string, o: Row = {}) => props.push(prop(F, col, { udt_name: udt, filterable: true, ...o }));
  filt('filter_fk', 'int4', { join_schema: 'public', join_table: 'syn_parent', join_column: 'id' });
  filt('filter_user', 'uuid', { join_schema: 'public', join_table: 'civic_os_users', join_column: 'id' });
  filt('filter_category', 'int4', { join_schema: 'public', join_table: 'categories', join_column: 'id', category_entity_type: 'syn_cat' });
  for (const [c, u] of [['filter_datetime', 'timestamp'], ['filter_datetimelocal', 'timestamptz'], ['filter_date', 'date'], ['filter_bool', 'bool'], ['filter_int', 'int4'], ['filter_money', 'money'], ['filter_text_unsupported', 'text'], ['filter_decimal_unsupported', 'numeric'], ['filter_email_unsupported', 'email_address']]) filt(c, u);
  f('filterable_false_int', { udt_name: 'int4', filterable: false });

  // ---- validators: every rule type, value shapes, ordering, nullability ------
  const V = 'syn_validators';
  addEntity(V);
  const v = (col: string, rules: Row[], o: Row = {}) => props.push(prop(V, col, { udt_name: 'varchar', validation_rules: rules, ...o }));
  v('required_rule_nullable', [rule('required')]);
  v('not_nullable_only', [], { is_nullable: false });
  v('not_nullable_plus_required', [rule('required')], { is_nullable: false });
  v('min_max_int', [rule('min', '1'), rule('max', '5')], { udt_name: 'int4' });
  v('min_max_decimal', [rule('min', '0.01'), rule('max', '99.99')], { udt_name: 'numeric' });
  v('min_zero_string', [rule('min', '0')], { udt_name: 'int4' });
  v('min_zero_number_is_ignored', [rule('min', 0)], { udt_name: 'int4' });
  v('min_negative', [rule('min', '-10')], { udt_name: 'int4' });
  v('min_empty_value_ignored', [rule('min', '')], { udt_name: 'int4' });
  v('min_missing_value_ignored', [rule('min')], { udt_name: 'int4' });
  v('min_not_numeric', [rule('min', 'abc')], { udt_name: 'int4' });
  v('minlength_maxlength', [rule('minLength', '2'), rule('maxLength', '5')]);
  v('minlength_one', [rule('minLength', '1')]);
  v('maxlength_zero_string', [rule('maxLength', '0')]);
  v('pattern_ten_digits', [rule('pattern', '^\\d{10}$')]);
  v('pattern_email_like', [rule('pattern', '^[^@\\s]+@[^@\\s]+$')]);
  v('pattern_unanchored', [rule('pattern', '[A-Z]{3}')]);
  v('duplicate_min_rules', [rule('min', '1'), rule('min', '10')], { udt_name: 'int4' });
  v('everything', [rule('required'), rule('min', '1'), rule('max', '9'), rule('minLength', '1'), rule('maxLength', '3'), rule('pattern', '^[0-9]+$')], { is_nullable: false });
  v('ignored_rule_types_only', [rule('fileType', 'image/*'), rule('maxFileSize', '5'), rule('unknownType')]);

  // ---- inverse relationships: preview mode, grouping, system-table exclusion --
  addEntity('syn_parent', {}, true);
  addEntity('syn_child_display_name', {}, true);
  props.push(fk('syn_child_display_name', 'parent_id', 'syn_parent'));
  addEntity('syn_child_id_only', {}, false);
  props.push(idProp('syn_child_id_only'), fk('syn_child_id_only', 'parent_id', 'syn_parent'), prop('syn_child_id_only', 'name', { udt_name: 'varchar' }));
  addEntity('syn_child_count_only', {}, false);
  props.push(fk('syn_child_count_only', 'parent_id', 'syn_parent'), prop('syn_child_count_only', 'name', { udt_name: 'varchar' }));
  addEntity('syn_child_two_fks_one_parent', {}, true);
  props.push(fk('syn_child_two_fks_one_parent', 'parent_a_id', 'syn_parent'), fk('syn_child_two_fks_one_parent', 'parent_b_id', 'syn_parent'), prop('syn_child_two_fks_one_parent', 'note', { udt_name: 'varchar' }));
  addEntity('syn_child_three_fks', {}, true);
  props.push(fk('syn_child_three_fks', 'a_id', 'syn_parent'), fk('syn_child_three_fks', 'b_id', 'syn_child_display_name'), fk('syn_child_three_fks', 'c_id', 'syn_child_id_only'));
  addEntity('syn_self_ref', {}, true);
  props.push(fk('syn_self_ref', 'parent_id', 'syn_self_ref', { is_self_referencing: true }));

  // ---- junctions: pure, color, rich, rich-not-flagged, parent hop, ambiguous hop, no display_name ----
  addEntity('syn_left', {}, true);
  addEntity('syn_right', {}, true);
  props.push(prop('syn_right', 'color', { udt_name: 'hex_color', data_type: 'USER-DEFINED' }));
  addEntity('syn_jn_pure', {}, false);
  props.push(fk('syn_jn_pure', 'left_id', 'syn_left'), fk('syn_jn_pure', 'right_id', 'syn_right'),
    prop('syn_jn_pure', 'created_at', { udt_name: 'timestamptz' }));
  addEntity('syn_extra', {}, true);
  addEntity('syn_jn_rich', { is_rich_junction: true }, false);
  props.push(fk('syn_jn_rich', 'left_id', 'syn_left'), fk('syn_jn_rich', 'extra_id', 'syn_extra'),
    prop('syn_jn_rich', 'quantity', { udt_name: 'int4' }),
    prop('syn_jn_rich', 'hidden_note', { udt_name: 'text', show_on_create: false, show_on_edit: false }),
    prop('syn_jn_rich', 'edit_only_note', { udt_name: 'text', show_on_create: false }));
  addEntity('syn_jn_not_flagged_rich', {}, false);
  props.push(fk('syn_jn_not_flagged_rich', 'left_id', 'syn_left'), fk('syn_jn_not_flagged_rich', 'extra_id', 'syn_extra'), prop('syn_jn_not_flagged_rich', 'quantity', { udt_name: 'int4' }));
  addEntity('syn_jn_user', {}, false);
  props.push(fk('syn_jn_user', 'left_id', 'syn_left'), prop('syn_jn_user', 'user_id', { udt_name: 'uuid', join_schema: 'public', join_table: 'civic_os_users', join_column: 'id' }));
  // parent hop: junction -> syn_nodn (no display_name) -> single displayable parent
  addEntity('syn_grandparent', {}, true);
  addEntity('syn_nodn', {}, false);
  props.push(idProp('syn_nodn'), fk('syn_nodn', 'grandparent_id', 'syn_grandparent'));
  addEntity('syn_jn_hop', {}, false);
  props.push(fk('syn_jn_hop', 'left_id', 'syn_left'), fk('syn_jn_hop', 'nodn_id', 'syn_nodn'));
  // ambiguous hop: two displayable parents -> left -> nodn_ambiguous yields no M:M. The table itself (id + two FKs) is detected as a junction (gp1 <-> extra).
  addEntity('syn_nodn_ambiguous', {}, false);
  props.push(idProp('syn_nodn_ambiguous'), fk('syn_nodn_ambiguous', 'gp1_id', 'syn_grandparent'), fk('syn_nodn_ambiguous', 'gp2_id', 'syn_extra'));
  addEntity('syn_jn_hop_ambiguous', {}, false);
  props.push(fk('syn_jn_hop_ambiguous', 'left_id', 'syn_left'), fk('syn_jn_hop_ambiguous', 'nodn_id', 'syn_nodn_ambiguous'));
  // no display_name and no hop candidates: left -> dead_end yields no M:M; the reverse direction (dead_end -> left) still does
  addEntity('syn_nodn_dead_end', {}, false);
  props.push(idProp('syn_nodn_dead_end'));
  addEntity('syn_jn_dead_end', {}, false);
  props.push(fk('syn_jn_dead_end', 'left_id', 'syn_left'), fk('syn_jn_dead_end', 'dead_id', 'syn_nodn_dead_end'));
  // junction hidden from sidebar via flag only, entity listed in menu check
  addEntity('syn_hidden_sidebar', { show_in_sidebar: false }, true);
  addEntity('syn_view_summary', { is_view: true, insert: false, update: false, delete: false }, false);
  props.push(prop('syn_view_summary', 'display_name', { udt_name: 'text' }), prop('syn_view_summary', 'total', { udt_name: 'int4' }));

  // schema_m2m_properties overrides (metadata flags merged into virtual props)
  m2m.push(
    { table_name: 'syn_left', column_name: 'syn_jn_pure_m2m', display_name: 'Pure override', sort_order: 5, column_width: 1, show_on_list: false, show_on_create: false, show_on_edit: true, show_on_detail: false, show_inline: true, fk_search_modal: true, options_source_rpc: 'syn_rpc', depends_on_columns: ['a'], options_filter_column: 'flt' },
    { table_name: 'syn_left', column_name: 'syn_jn_rich_m2m', display_name: null, sort_order: null, column_width: null, show_on_list: true, show_on_create: true, show_on_edit: true, show_on_detail: true, show_inline: false, fk_search_modal: false, options_source_rpc: null, depends_on_columns: null, options_filter_column: null },
    { table_name: 'syn_left', column_name: 'syn_jn_hop_m2m', display_name: null, sort_order: null, column_width: null, show_on_list: true, show_on_create: true, show_on_edit: true, show_on_detail: true, show_inline: false, fk_search_modal: true, options_source_rpc: null, depends_on_columns: null, options_filter_column: null },
  );

  const staticText: Row[] = [
    { id: 1, table_name: 'syn_types', content: 'all pages', sort_order: 15, column_width: 2, show_on_detail: true, show_on_create: true, show_on_edit: true },
    { id: 2, table_name: 'syn_types', content: 'detail only', sort_order: 5, column_width: 1, show_on_detail: true, show_on_create: false, show_on_edit: false },
    { id: 3, table_name: 'syn_types', content: 'create only', sort_order: 25, column_width: 1, show_on_detail: false, show_on_create: true, show_on_edit: false },
    { id: 4, table_name: 'syn_types', content: 'edit only', sort_order: 35, column_width: 2, show_on_detail: false, show_on_create: false, show_on_edit: true },
    { id: 5, table_name: 'syn_flags', content: 'ties with a property sort_order', sort_order: 20, column_width: 1, show_on_detail: true, show_on_create: true, show_on_edit: true },
    { id: 6, table_name: 'no_such_table', content: 'orphan text', sort_order: 1, column_width: 1, show_on_detail: true, show_on_create: true, show_on_edit: true },
  ];

  return { entities, props, m2m, staticText };
}

/** Guided-form steps for GuidedFormService (pure computations). */
export function syntheticGuidedFormSteps() {
  const cond = (id: number, condition_type: 'skip_if' | 'require_if', field: string, operator: any, value: string | null) =>
    ({ id, condition_type, field, operator, value });
  const step = (id: number, step_key: string, conditions: any[], o: Record<string, any> = {}) => ({
    id, guided_form_key: 'syn_form', step_key, display_name: step_key, description: null, step_table: `syn_${step_key}`,
    parent_fk_column: 'parent_id', step_order: id, can_skip: false, track_key: null, conditions, ...o,
  });
  return [
    step(1, 'no_conditions', []),
    step(2, 'skip_eq', [cond(1, 'skip_if', 'kind', 'eq', '1')]),
    step(3, 'skip_neq', [cond(2, 'skip_if', 'kind', 'neq', '1')]),
    step(4, 'skip_null', [cond(3, 'skip_if', 'note', 'is_null', null)]),
    step(5, 'skip_not_null', [cond(4, 'skip_if', 'note', 'is_not_null', null)]),
    step(6, 'require_eq_on_skippable', [cond(5, 'require_if', 'kind', 'eq', '2')], { can_skip: true }),
    step(7, 'require_eq_on_required', [cond(6, 'require_if', 'kind', 'eq', '2')]),
    step(8, 'multi_skip_second_matches', [cond(7, 'skip_if', 'kind', 'eq', '1'), cond(8, 'skip_if', 'note', 'is_null', null), cond(9, 'skip_if', 'kind', 'eq', '9')]),
    step(9, 'multi_require_second_matches', [cond(10, 'require_if', 'kind', 'eq', '1'), cond(11, 'require_if', 'note', 'is_not_null', null)], { can_skip: true }),
    step(10, 'skip_and_require', [cond(12, 'skip_if', 'kind', 'eq', '1'), cond(13, 'require_if', 'note', 'is_not_null', null)], { can_skip: true }),
    step(11, 'skip_embedded_fk', [cond(14, 'skip_if', 'owner_id', 'eq', '7')]),
    step(12, 'unknown_operator_never_matches', [cond(15, 'skip_if', 'kind', 'gt' as any, '1'), cond(16, 'require_if', 'kind', 'lt' as any, '1')], { can_skip: true }),
  ];
}

export function syntheticVariant(): Variant {
  const { entities, props, m2m, staticText } = build();
  return {
    example: '_synthetic', variant: 'all', role: 'testadmin', locale: 'en', dir: '',
    inline: {
      schema_entities: entities, schema_properties: props, schema_m2m_properties: m2m, static_text: staticText,
      constraint_messages: [], schema_entity_actions: [],
    },
  };
}

/** Raw-fixture variants plus the hand-built `_synthetic/all` variant. */
export function listGoldenVariants(): Variant[] {
  return [...listAllVariants(), syntheticVariant()];
}
