/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Reference models of the frontend and MCP behavior the divergence ledger
 * compares (scripts/golden/ledger.mjs).
 *
 * The ledger attributes a difference to a rule only when BOTH golden values
 * equal what these models predict and the rule's specific transformation
 * explains the gap. A golden value a model does not reproduce is reported as
 * unattributed (exit 2), so any change in either code base that the ledger
 * does not already describe fails the run. Each model is a transcription of
 * the cited code; keep them in step with it (the mutation check,
 * scripts/golden/ledger-mutation-check.sh, proves they are tight).
 */

export const INT = ['int4', 'int8'];

// ---------------------------------------------------------------------------
// Select strings
// ---------------------------------------------------------------------------

const FE_FILE = '(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,thumbnail_error,created_at)';
const FE_PAYMENT = '(id,amount,currency,status,effective_status,total_refunded,refund_count,pending_refund_count,display_name,error_message,created_at)';
const FE_GALLERY = '(id,created_at,photo_gallery_files(file_id,sort_order,caption,alt_text,file:files!file_id(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status)))';
const LIST_GALLERY = '(id,photo_gallery_files(file_id))';

/** SchemaService.propertyToSelectString (schema.service.ts:693-755), non-M:M properties. */
export function feSelect(type, p) {
  const c = p.column_name;
  if (['File', 'FileImage', 'FilePDF'].includes(type)) return `${c}:files!${c}${FE_FILE}`;
  if (type === 'Payment') return `${c}:payment_transactions!${c}${FE_PAYMENT}`;
  if (type === 'Status') return `${c}:statuses!${c}(id,display_name,color,status_key)`;
  if (type === 'Category') return `${c}:categories!${c}(id,display_name,color)`;
  if (type === 'PhotoGallery') return `${c}:photo_galleries!${c}${FE_GALLERY}`;
  if (type === 'User') return `${c}:civic_os_users!${c}(id,display_name,full_name,phone,email)`;
  if (p.join_schema == 'public' && p.join_column) return `${c}:${p.join_table}!${c}(${p.join_column},display_name)`;
  if (type === 'GeoPoint' || type === 'GeoPolygon') return `${c}:${c}_text`;
  return c;
}
/** SchemaService.propertyToSelectStringForList (schema.service.ts:827-832). */
export function feSelectForList(type, p) {
  return type === 'PhotoGallery' ? `${p.column_name}:photo_galleries!${p.column_name}${LIST_GALLERY}` : feSelect(type, p);
}

/** MCP select-builder.ts propertyToSelectString. */
export function mcpSelect(type, p) {
  const c = p.column_name;
  switch (type) {
    case 'ForeignKeyName': return `${c}:${p.join_table}!${c}(id,display_name)`;
    case 'User': return `${c}:civic_os_users!${c}(id,display_name,full_name)`;
    case 'Status': return `${c}:statuses!${c}(id,display_name,color,status_key)`;
    case 'Category': return `${c}:categories!${c}(id,display_name,color)`;
    case 'File': case 'FileImage': case 'FilePDF': return `${c}:files!${c}(id,file_name,file_type,file_size)`;
    case 'Payment': return `${c}:payment_transactions!${c}(id,amount,currency,status,effective_status,display_name)`;
    case 'PhotoGallery': return `${c}:photo_galleries!${c}${LIST_GALLERY}`;
    case 'GeoPoint': case 'GeoPolygon': return `${c}:${c}_text`;
    default: return c;
  }
}

/** MCP buildSelectString (select-builder.ts:66-91). `props` carry `.type` (MCP type name). */
export function mcpBuildSelect(props, includeTimestamps = false) {
  const fields = new Set();
  if (props.some(p => p.column_name === 'id' || p.is_identity === true)) fields.add('id');
  for (const p of props) {
    if (p.column_name === 'id') continue;
    fields.add(mcpSelect(p.type, p));
  }
  if (includeTimestamps) { fields.add('created_at'); fields.add('updated_at'); }
  return [...fields].join(',');
}

/** MCP filterProperties (select-builder.ts:104-123). */
export function mcpFilter(props, context) {
  return props.filter(p => {
    if ((context === 'create' || context === 'edit') && (p.is_identity || p.is_generated)) return false;
    return p[`show_on_${context}`] !== false;
  });
}

/** Frontend getPropsFor* base predicate before ensureStructuralProps / map property (schema.service.ts:848-921). */
export function feBase(view, p) {
  if (view === 'list' || view === 'detail') return p[`show_on_${view}`] !== false;
  if (p.column_name === 'created_at' || p.column_name === 'updated_at') return false;
  return !(p.is_generated || p.is_identity) && !!p.is_updatable && p[`show_on_${view}`] !== false;
}
export const STRUCTURAL = ['display_name', 'status_id', 'submitted_at'];

// ---------------------------------------------------------------------------
// Type detection (both sides, transcribed)
// ---------------------------------------------------------------------------

const FE_SYSTEM = ['files', 'civic_os_users', 'payment_transactions', 'transactions', 'statuses', 'photo_galleries'];
/** constants/system-types.ts isSystemType. */
function feIsSystemType(t) {
  if (t.includes('.')) {
    const [schema, table] = t.split('.');
    return schema === 'metadata' && FE_SYSTEM.includes(table);
  }
  return FE_SYSTEM.includes(t);
}

/** SchemaService.getPropertyType (schema.service.ts:633-692), as a type name. */
export function feType(v) {
  const udt = v.udt_name;
  if (v.status_entity_type && INT.includes(udt) && v.join_column != null) return 'Status';
  if (v.category_entity_type && INT.includes(udt) && v.join_column != null) return 'Category';
  if (udt === 'uuid' && v.join_table && feIsSystemType(v.join_table)) {
    if (v.join_table === 'files') {
      const fv = (v.validation_rules ?? []).find(r => r.type === 'fileType');
      if (fv?.value) {
        if (fv.value.startsWith('image/')) return 'FileImage';
        if (fv.value === 'application/pdf') return 'FilePDF';
      }
      return 'File';
    } else if (v.join_table === 'civic_os_users') {
      return 'User';
    } else if (v.join_table === 'payment_transactions' || (v.join_table === 'transactions' && v.join_schema === 'payments')) {
      return 'Payment';
    } else if (v.join_table === 'photo_galleries') {
      return 'PhotoGallery';
    }
  }
  /* eslint-disable eqeqeq */
  return (INT.includes(udt) && v.join_column != null) ? 'ForeignKeyName'
    : (udt === 'geography' && v.geography_type == 'Polygon') ? 'GeoPolygon'
    : (udt === 'geography' && v.geography_type == 'Point') ? 'GeoPoint'
    : udt === 'timestamp' ? 'DateTime'
    : udt === 'timestamptz' ? 'DateTimeLocal'
    : udt === 'date' ? 'Date'
    : udt === 'bool' ? 'Boolean'
    : INT.includes(udt) ? 'IntegerNumber'
    : udt === 'money' ? 'Money'
    : ['numeric', 'float4', 'float8'].includes(udt) ? 'DecimalNumber'
    : udt === 'hex_color' ? 'Color'
    : udt === 'email_address' ? 'Email'
    : udt === 'phone_number' ? 'Telephone'
    : (udt === 'time_slot' && v.is_recurring) ? 'RecurringTimeSlot'
    : udt === 'time_slot' ? 'TimeSlot'
    : udt === 'markdown' ? 'Markdown'
    : udt === 'varchar' ? 'TextShort'
    : udt === 'text' ? 'TextLong'
    : 'Unknown';
  /* eslint-enable eqeqeq */
}

/** MCP schema-cache.ts detectPropertyType (437-515), as a type name. */
export function mcpType(p) {
  const { udt_name: udt, join_table: jt, join_column: jc, data_type: dt, geography_type: gt } = p;
  const hasFK = !!jt && !!jc;
  if (p.status_entity_type && hasFK) return 'Status';
  if (p.category_entity_type && hasFK) return 'Category';
  if (hasFK) {
    if (jt === 'files') {
      const r = (p.validation_rules ?? []).find(x => x.type === 'fileType');
      if (r?.value?.startsWith('image')) return 'FileImage';
      if (r?.value === 'application/pdf') return 'FilePDF';
      return 'File';
    }
    if (jt === 'civic_os_users' || jt === 'civic_os_users_private') return 'User';
    if (jt === 'payment_transactions' || jt === 'transactions') return 'Payment';
    if (jt === 'photo_galleries') return 'PhotoGallery';
  }
  if (dt === 'USER-DEFINED' && udt === 'geography') return gt === 'Polygon' || gt === 'MultiPolygon' ? 'GeoPolygon' : 'GeoPoint';
  switch (udt) {
    case 'timestamp': return 'DateTime';
    case 'timestamptz': return 'DateTimeLocal';
    case 'date': return 'Date';
    case 'bool': return 'Boolean';
    case 'money': return 'Money';
    case 'numeric': case 'float4': case 'float8': return 'DecimalNumber';
    case 'hex_color': return 'Color';
    case 'email_address': return 'Email';
    case 'phone_number': return 'Telephone';
    case 'markdown': return 'Markdown';
    case 'time_slot': return p.is_recurring ? 'RecurringTimeSlot' : 'TimeSlot';
    case 'int4': case 'int8': case 'int2': return hasFK ? 'ForeignKeyName' : 'IntegerNumber';
    case 'uuid': return hasFK ? 'ForeignKeyName' : 'TextShort';
    case 'varchar': case 'bpchar': return 'TextShort';
    case 'text': return 'TextLong';
    default: return hasFK ? 'ForeignKeyName' : 'Unknown';
  }
}

/**
 * SchemaService.getPropsForList/Detail/Create/Edit/Filter (schema.service.ts:848-948)
 * as column sets, over the entity's properties including M:M virtual ones (each with `.type`).
 */
export function feViews(props, ent) {
  const cols = arr => arr.map(p => p.column_name);
  const add = (base, view) => {
    const out = [...base];
    for (const c of STRUCTURAL) {
      const p = props.find(x => x.column_name === c);
      if (p && !out.includes(p)) out.push(p);
    }
    void view;
    return out;
  };
  const list = props.filter(p => p.show_on_list !== false);
  if (ent?.show_map && ent.map_property_name) {
    const mp = props.find(p => p.column_name === ent.map_property_name);
    if (mp && !list.includes(mp)) list.push(mp);
  }
  const filterTypes = ['ForeignKeyName', 'DateTime', 'DateTimeLocal', 'Date', 'Boolean', 'IntegerNumber', 'Money', 'User', 'Status', 'Category'];
  return {
    list: cols(add(list, 'list')),
    detail: cols(add(props.filter(p => p.show_on_detail !== false), 'detail')),
    create: cols(props.filter(p => feBase('create', p))),
    edit: cols(add(props.filter(p => feBase('edit', p)), 'edit')),
    filter: cols(props.filter(p => p.filterable === true && filterTypes.includes(p.type))),
  };
}

// ---------------------------------------------------------------------------
// Type-detection rules (exact frontend / MCP pairs)
// ---------------------------------------------------------------------------

const MCP_SYSTEM = ['files', 'civic_os_users', 'civic_os_users_private', 'payment_transactions', 'transactions', 'photo_galleries'];
const KNOWN_UDT = ['timestamp', 'timestamptz', 'date', 'bool', 'money', 'numeric', 'float4', 'float8', 'hex_color', 'email_address',
  'phone_number', 'markdown', 'time_slot', 'int4', 'int8', 'int2', 'uuid', 'varchar', 'bpchar', 'text', 'geography'];

/** The frontend type of a udt that has no FK branch on the frontend side (only the udts the rules need). */
function fePlain(udt) {
  return udt === 'text' ? 'TextLong' : udt === 'varchar' ? 'TextShort' : 'Unknown';
}
function mcpSystemType(p) {
  const jt = p.join_table;
  if (jt === 'files') {
    const v = (p.validation_rules ?? []).find(r => r.type === 'fileType')?.value;
    if (v?.startsWith('image')) return 'FileImage';
    if (v === 'application/pdf') return 'FilePDF';
    return 'File';
  }
  if (jt === 'civic_os_users' || jt === 'civic_os_users_private') return 'User';
  if (jt === 'payment_transactions' || jt === 'transactions') return 'Payment';
  if (jt === 'photo_galleries') return 'PhotoGallery';
  return null;
}

/**
 * The type rule that explains frontend type `fe` vs MCP type `mc` for raw
 * property `p`, or null. Each rule names its precondition on the property and
 * the exact type on each side.
 */
export function typeRule(p, fe, mc) {
  const { udt_name: udt, join_table: jt, join_column: jc, join_schema: js, data_type: dt, geography_type: gt } = p;
  const hasFK = !!jt && !!jc;
  const status = !!p.status_entity_type;
  const cat = !!p.category_entity_type;
  if (INT.includes(udt) && jc != null && !jt) {
    return fe === (status ? 'Status' : cat ? 'Category' : 'ForeignKeyName') && mc === 'IntegerNumber' ? 'T-01' : null;
  }
  if ((status || cat) && hasFK && !INT.includes(udt)) {
    return mc === (status ? 'Status' : 'Category') && fe === fePlain(udt) ? 'T-02' : null;
  }
  if (status || cat) return null;
  if (hasFK && MCP_SYSTEM.includes(jt)) {
    if (udt !== 'uuid') return mc === mcpSystemType(p) && fe === (INT.includes(udt) ? 'ForeignKeyName' : fePlain(udt)) ? 'T-03' : null;
    if (jt === 'civic_os_users_private') return fe === 'Unknown' && mc === 'User' ? 'T-04' : null;
    if (jt === 'transactions' && js !== 'payments') return fe === 'Unknown' && mc === 'Payment' ? 'T-05' : null;
    if (jt === 'files') {
      const v = (p.validation_rules ?? []).find(r => r.type === 'fileType')?.value ?? '';
      return v.startsWith('image') && !v.startsWith('image/') && fe === 'File' && mc === 'FileImage' ? 'T-06' : null;
    }
    return null;
  }
  if (udt === 'geography' && !hasFK) {
    if (dt === 'USER-DEFINED') {
      if (gt === 'MultiPolygon') return fe === 'Unknown' && mc === 'GeoPolygon' ? 'T-07' : null;
      if (gt !== 'Point' && gt !== 'Polygon') return fe === 'Unknown' && mc === 'GeoPoint' ? 'T-07' : null;
      return null;
    }
    if (gt === 'Point') return fe === 'GeoPoint' && mc === 'Unknown' ? 'T-07' : null;
    if (gt === 'Polygon') return fe === 'GeoPolygon' && mc === 'Unknown' ? 'T-07' : null;
    return null;
  }
  if (udt === 'int2') return fe === 'Unknown' && mc === (hasFK ? 'ForeignKeyName' : 'IntegerNumber') ? 'T-08' : null;
  if (udt === 'uuid') return fe === 'Unknown' && mc === (hasFK ? 'ForeignKeyName' : 'TextShort') ? 'T-09' : null;
  if (udt === 'bpchar') return fe === 'Unknown' && mc === 'TextShort' ? 'T-10' : null;
  if (!KNOWN_UDT.includes(udt) && hasFK) return fe === 'Unknown' && mc === 'ForeignKeyName' ? 'T-11' : null;
  return null;
}

/**
 * The select rule for a property whose type agrees on both sides but whose
 * select differs, given that each side's select equals its model. Null if the
 * pair is not a documented shape.
 */
export function selectRule(type, p, feSel, mcSel) {
  if (feSel !== feSelect(type, p) || mcSel !== mcpSelect(type, p)) return null;
  switch (type) {
    case 'User': return 'S-03';
    case 'File': case 'FileImage': case 'FilePDF': return 'S-04';
    case 'Payment': return 'S-05';
    case 'PhotoGallery': return mcSel === feSelectForList(type, p) ? 'S-06' : null;
    case 'ForeignKeyName':
      if (p.join_schema !== 'public') return 'S-02';
      if (p.join_column !== 'id') return 'S-01';
      return null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Condition evaluators
// ---------------------------------------------------------------------------

export const THROWS = '__throws:TypeError__';
const KNOWN_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'in', 'is_null', 'is_not_null'];

/**
 * Parametrized evaluator. With all flags off it is the frontend
 * utils/condition-evaluator.ts; each flag switches one MCP rule on:
 *   noIdExtract (C-01), loose (C-02), noNumericGuard (C-03),
 *   unknownTrue (C-04), noDataGuard (C-05), noConditionGuard (C-06).
 * All flags on is execute-action.ts evaluateCondition.
 */
export function evaluate(cond, data, f = {}) {
  const run = () => {
    if (f.noConditionGuard) {
      // `'or' in condition` throws on null/undefined; a non-array `or`/`and` throws at .some/.every
      if ('or' in cond) return cond.or.some(c => evaluate(c, data, f));
      if ('and' in cond) return cond.and.every(c => evaluate(c, data, f));
    } else {
      if (!cond) return true;
      if (!f.noDataGuard && !data) return false;
      if ('or' in cond && Array.isArray(cond.or)) return cond.or.some(c => evaluate(c, data, f));
      if ('and' in cond && Array.isArray(cond.and)) return cond.and.every(c => evaluate(c, data, f));
    }
    if (f.noConditionGuard && !f.noDataGuard && !data) return false;
    const { field, operator, value } = cond;
    let v;
    const path = String(field);
    if (path.includes('.') || f.noIdExtract) {
      v = data;
      for (const part of path.split('.')) {
        if (v === null || v === undefined || typeof v !== 'object') { v = undefined; break; }
        v = v[part];
      }
    } else {
      v = data?.[path];
      if (v !== null && typeof v === 'object' && 'id' in v) v = v.id;
    }
    const num = (a, b) => typeof a === 'number' && typeof b === 'number';
    switch (operator) {
      // eslint-disable-next-line eqeqeq
      case 'eq': return f.loose ? v == value : v === value;
      // eslint-disable-next-line eqeqeq
      case 'ne': return f.loose ? v != value : v !== value;
      case 'gt': return f.noNumericGuard ? v > value : num(v, value) && v > value;
      case 'lt': return f.noNumericGuard ? v < value : num(v, value) && v < value;
      case 'gte': return f.noNumericGuard ? v >= value : num(v, value) && v >= value;
      case 'lte': return f.noNumericGuard ? v <= value : num(v, value) && v <= value;
      case 'in': return Array.isArray(value) && value.includes(v);
      case 'is_null': return v === null || v === undefined;
      case 'is_not_null': return v !== null && v !== undefined;
      default: return !!f.unknownTrue;
    }
  };
  try {
    return run();
  } catch {
    return THROWS;
  }
}
export const MCP_FLAGS = { noIdExtract: true, loose: true, noNumericGuard: true, unknownTrue: true, noDataGuard: true, noConditionGuard: true };
export const CONDITION_RULE_FLAGS = {
  'C-01': { noIdExtract: true }, 'C-02': { loose: true }, 'C-03': { noNumericGuard: true },
  'C-04': { unknownTrue: true }, 'C-05': { noDataGuard: true }, 'C-06': { noConditionGuard: true },
};
export const isKnownOp = op => KNOWN_OPS.includes(op);

/**
 * Smallest set of condition rules (1 or 2) whose combined flags turn the
 * frontend result into the MCP result for this input, or null.
 */
export function conditionRules(cond, data) {
  const target = evaluate(cond, data, MCP_FLAGS);
  const ids = Object.keys(CONDITION_RULE_FLAGS);
  for (const id of ids) if (evaluate(cond, data, CONDITION_RULE_FLAGS[id]) === target) return [id];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (evaluate(cond, data, { ...CONDITION_RULE_FLAGS[ids[i]], ...CONDITION_RULE_FLAGS[ids[j]] }) === target) return [ids[i], ids[j]];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

/** ErrorService.parseToHuman (error.service.ts:106-126) -> [kind, text]. */
export function feParse(e) {
  if (e.httpCode === 0) return ['network', 'Network error. Please check your connection.'];
  if (e.code == '42501') return ['permission', 'Permissions error'];
  if (e.code == '23505') return ['unique', 'Record must be unique'];
  if (e.code == '23514') return ['check', 'Validation failed'];
  if (e.code == '23P01') return ['exclusion', 'This conflicts with an existing record.'];
  if (e.httpCode == 404) return ['notfound', 'Resource not found'];
  if (e.httpCode == 401) return ['auth', 'Your session has expired. Please refresh the page to log in again.'];
  if (e.code == 'P0001') return ['raise', e.message];
  return ['fallback', 'System Error'];
}
/** ErrorService.parseToHumanWithLookup (error.service.ts:61-95); `messages` undefined = not loaded. */
export function feParseLookup(e, messages) {
  if (e.code === '23514' || e.code === '23P01') {
    const m = e.details?.match(/constraint "([^"]+)"/) || e.message?.match(/constraint "([^"]+)"/);
    if (m && m[1]) {
      const hit = messages?.find(cm => cm.constraint_name === m[1]);
      if (hit) return ['constraint-lookup', hit.error_message];
      return e.code === '23P01'
        ? ['exclusion-named', 'This conflicts with an existing record. Please check your input and try again.']
        : ['check-named', `Validation failed: ${m[1]}`];
    }
    return e.code === '23P01' ? ['exclusion', 'This conflicts with an existing record.'] : ['check', 'Validation failed'];
  }
  return feParse(e);
}
/** PostgRESTRequestError.toHumanMessage (postgrest-client.ts:204-255) -> [kind, text]. */
export function mcpParse(e, messages) {
  // new Error(undefined).message is '' (PostgRESTRequestError passes the message to super()).
  const msg = e.message === undefined ? '' : String(e.message);
  if (e.code === '23514' || e.code === '23P01') {
    const m = e.details?.match(/constraint "([^"]+)"/) ?? msg.match(/constraint "([^"]+)"/);
    if (m?.[1] && messages) {
      const hit = messages.find(cm => cm.constraint_name === m[1]);
      if (hit) return ['constraint-lookup', hit.error_message];
    }
    if (e.code === '23P01') return ['exclusion-named', 'This conflicts with an existing record. Please check your input and try again.'];
    const name = m?.[1] ?? 'check constraint';
    return [m?.[1] ? 'check-named' : 'check', `Invalid ${name.replace(/_check$/, '').replace(/_/g, ' ')}. Check the value and try again.`];
  }
  if (e.httpCode === 0) return ['network', 'Network error. Please check your connection.'];
  if (e.code === '42501') return ['permission', 'Permission denied. You do not have access to perform this action.'];
  if (e.code === '23505') return ['unique', 'A record with these values already exists (duplicate).'];
  if (e.code === '23502') {
    const c = msg.match(/column "([^"]+)"/);
    return ['notnull', c ? `Required field "${c[1]}" is missing.` : 'A required field is missing.'];
  }
  if (e.code === '22P02') {
    const t = msg.match(/invalid input syntax for type (\w+)/);
    if (t) {
      const friendly = { integer: 'a whole number', numeric: 'a number', boolean: 'true or false', date: 'a date (YYYY-MM-DD)', timestamp: 'a date/time', uuid: 'a valid UUID' };
      return ['invalid-input', `Invalid value — expected ${friendly[t[1]] ?? `type "${t[1]}"`}. Check the value and try again.`];
    }
    return ['invalid-input', `Invalid value format. ${msg}`];
  }
  if (e.code === '22007' || e.code === '22008') return ['datetime', 'Invalid date format. Use YYYY-MM-DD for dates or YYYY-MM-DDTHH:MM:SS for timestamps.'];
  if (e.httpCode === 404) return ['notfound', 'Record not found.'];
  if (e.httpCode === 401) return ['auth', 'Authentication required. Your session may have expired.'];
  if (e.httpCode === 412) return ['precondition', 'This record has been modified since you last read it. Please fetch the latest version and try again.'];
  if (e.code === 'P0001') return ['raise', msg];
  return ['fallback', `Error: ${msg}`];
}
/** MCP client error path (postgrest-client.ts:110-147) for a stubbed response. */
export function mcpClientError(response) {
  if (response.networkError) {
    return { thrown: 'PostgRESTRequestError', message: 'Network error: unable to reach PostgREST. Check your connection and PostgREST URL.', httpCode: 0 };
  }
  const body = response.text !== undefined ? undefined : response.body; // a non-JSON body fails response.json()
  if (response.status === 503 && body?.code === 'PT503') {
    const mode = (body.message ?? '').includes('read-only') ? 'readonly' : 'full';
    return {
      thrown: 'MaintenanceError', mode,
      message: mode === 'full'
        ? 'System is in full maintenance mode. All operations are temporarily unavailable.'
        : 'System is in read-only maintenance mode. Read operations work but writes are blocked.',
    };
  }
  return { thrown: 'PostgRESTRequestError', message: body?.message ?? `PostgREST returned ${response.status}`, httpCode: response.status, code: body?.code, details: body?.details, hint: body?.hint };
}

// ---------------------------------------------------------------------------
// Content-Range
// ---------------------------------------------------------------------------

export function feTotalPaginated(header, rows) {
  if (!header) return rows;
  const m = header.match(/\/(\d+|\*)$/);
  return m && m[1] !== '*' ? parseInt(m[1], 10) : rows;
}
export function feTotalPreview(header, rows) {
  if (!header) return 0;
  const m = header.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : rows;
}
export function mcpContentRange(header) {
  if (!header) return undefined;
  const m = header.match(/^(\d+)-(\d+)\/(\d+|\*)/);
  if (!m) return undefined;
  return { from: parseInt(m[1], 10), to: parseInt(m[2], 10), total: m[3] === '*' ? null : parseInt(m[3], 10) };
}

// ---------------------------------------------------------------------------
// Name resolution (name-resolver.ts)
// ---------------------------------------------------------------------------

export class NameError extends Error {}

export function resolveEntity(entities, name) {
  const n = name.trim().toLowerCase();
  const byTable = entities.find(e => e.table_name === n);
  if (byTable) return byTable;
  const byDisplay = entities.find(e => e.display_name.toLowerCase() === n);
  if (byDisplay) return byDisplay;
  const sub = entities.filter(e => e.display_name.toLowerCase().includes(n) || e.table_name.includes(n));
  const readable = sub.filter(e => e.select);
  const eff = readable.length > 0 ? readable : sub;
  if (eff.length === 1) return eff[0];
  if (eff.length > 1) throw new NameError(`Ambiguous entity name "${name}". Did you mean one of: ${eff.map(e => `"${e.display_name}" (${e.table_name})`).join(', ')}?`);
  const r = entities.filter(e => e.select);
  throw new NameError(`Entity "${name}" not found. Available entities include: ${r.slice(0, 10).map(e => `"${e.display_name}"`).join(', ')}${r.length > 10 ? '...' : ''}`);
}
export function resolveColumn(props, table, name) {
  const n = name.trim().toLowerCase();
  const byCol = props.find(p => p.column_name === n);
  if (byCol) return byCol;
  const byDisplay = props.find(p => p.display_name.toLowerCase() === n);
  if (byDisplay) return byDisplay;
  const sub = props.filter(p => p.display_name.toLowerCase().includes(n) || p.column_name.includes(n));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) throw new NameError(`Ambiguous column "${name}" in ${table}. Did you mean one of: ${sub.map(p => `"${p.display_name}" (${p.column_name})`).join(', ')}?`);
  throw new NameError(`Column "${name}" not found in ${table}. Available columns: ${props.slice(0, 10).map(p => `"${p.display_name}"`).join(', ')}`);
}
export function resolveAction(actions, table, name) {
  const n = name.trim().toLowerCase();
  const byName = actions.find(a => a.action_name.toLowerCase() === n);
  if (byName) return byName;
  const byDisplay = actions.find(a => a.display_name.toLowerCase() === n);
  if (byDisplay) return byDisplay;
  const sub = actions.filter(a => a.display_name.toLowerCase().includes(n) || a.action_name.toLowerCase().includes(n));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) throw new NameError(`Ambiguous action "${name}". Did you mean one of: ${sub.map(a => `"${a.display_name}" (${a.action_name})`).join(', ')}?`);
  const available = actions.map(a => `"${a.display_name}"`).join(', ');
  throw new NameError(`Action "${name}" not found for ${table}. Available actions: ${available || 'none'}`);
}
export function resolveStatus(statuses, entityType, name) {
  const list = statuses.filter(s => s.entity_type === entityType);
  const n = name.trim().toLowerCase();
  const byKey = list.find(s => s.status_key?.toLowerCase() === n);
  if (byKey) return byKey.id;
  const byName = list.find(s => s.display_name.toLowerCase() === n);
  if (byName) return byName.id;
  throw new NameError(`Status "${name}" not found for entity type "${entityType}". Available: ${list.map(s => `"${s.display_name}"`).join(', ')}`);
}
export function resolveCategory(categories, entityType, name) {
  const list = categories.filter(c => c.entity_type === entityType);
  const n = name.trim().toLowerCase();
  const hit = list.find(c => c.display_name.toLowerCase() === n);
  if (hit) return hit.id;
  throw new NameError(`Category "${name}" not found for entity type "${entityType}". Available: ${list.map(c => `"${c.display_name}"`).join(', ')}`);
}
export const attempt = fn => { try { return fn(); } catch (e) { if (e instanceof NameError) return `ERR ${e.message}`; throw e; } };

/**
 * resolveForeignKeyValue against a responder (decoded params -> rows):
 * eq lookup, then ilike when eq finds nothing. Returns { result, requests }.
 */
export function resolveFk(table, name, responder) {
  const requests = [];
  const get = params => { const d = params.map(([k, v]) => `${k}=${v}`); requests.push({ path: table, decoded: d }); return responder(d); };
  const eq = get([['select', 'id,display_name'], ['display_name', `eq.${name}`], ['limit', '5']]);
  if (eq.length === 1) return { result: eq[0].id, requests };
  if (eq.length === 0) {
    const il = get([['select', 'id,display_name'], ['display_name', `ilike.${name}`], ['limit', '5']]);
    if (il.length === 1) return { result: il[0].id, requests };
    if (il.length > 1) return { error: `Multiple matches for "${name}" in ${table}: ${il.map(r => `"${r.display_name}" (ID: ${r.id})`).join(', ')}. Please be more specific or use the exact ID.`, requests };
    return { error: `"${name}" not found in ${table}. Check the name and try again.`, requests };
  }
  return { error: `Multiple records match "${name}" in ${table}: ${eq.map(r => `"${r.display_name}" (ID: ${r.id})`).join(', ')}. Use the exact ID to disambiguate.`, requests };
}

// ---------------------------------------------------------------------------
// Requests: frontend DataService and MCP list_records / get_record
// ---------------------------------------------------------------------------

/**
 * DataService.getData / getDataPaginated (data.service.ts:40-143) for one
 * DataQuery. Returns the URL exactly as emitted (unencoded, `<PGRST>/...`),
 * the headers, and `intended`: the parameters as the caller meant them
 * (before string concatenation), so encoding damage can be measured.
 */
export function feRequest(query, paginated) {
  const args = [];
  const intended = [];
  if (query.fields) {
    const fields = [...query.fields];
    if (!query.isSummaryView && !fields.includes('id')) fields.push('id');
    args.push('select=' + fields.join(','));
    intended.push(['select', fields.join(',')]);
  }
  if (query.searchQuery && query.searchQuery.trim()) {
    args.push('civic_os_text_search=wfts.' + encodeURIComponent(query.searchQuery.trim()));
    intended.push(['civic_os_text_search', 'wfts.' + query.searchQuery.trim()]);
  } else if (query.orderField) {
    const o = `${query.orderField}.${query.orderDirection ?? 'asc'}`;
    args.push('order=' + o);
    intended.push(['order', o]);
  }
  if (query.entityId) { args.push('id=eq.' + query.entityId); intended.push(['id', `eq.${query.entityId}`]); }
  for (const f of query.filters ?? []) {
    if (f.value === null || f.value === undefined || f.value === '') continue;
    const v = f.operator === 'in' && Array.isArray(f.value) ? `in.(${f.value.join(',')})` : `${f.operator}.${f.value}`;
    args.push(`${f.column}=${v}`);
    intended.push([f.column, v]);
  }
  if (query.limit) { args.push(`limit=${query.limit}`); intended.push(['limit', String(query.limit)]); }
  for (const raw of query.rawQueryParams ?? []) {
    args.push(raw);
    for (const [k, v] of new URLSearchParams(raw)) intended.push([k, v]);
  }
  const headers = {};
  if (paginated) {
    const pg = query.pagination || { page: 1, pageSize: 25 };
    const offset = (pg.page - 1) * pg.pageSize;
    headers['Prefer'] = 'count=exact';
    headers['Range'] = `${offset}-${offset + pg.pageSize - 1}`;
    headers['Range-Unit'] = 'items';
  }
  return { url: `<PGRST>/${query.key}?${args.join('&')}`, headers, intended };
}

/** Decoded parameters of a frontend URL as PostgREST parses it. */
export function decodeFeUrl(url) {
  const rest = url.replace(/^<PGRST>\//, '');
  const q = rest.indexOf('?');
  return [...new URLSearchParams(q < 0 ? '' : rest.slice(q + 1))];
}

/** list_records input validation (zod schema in list-records.ts:33-58), issue codes as the SDK reports them. */
function zodList(input) {
  const issues = [];
  (input.filters ?? []).forEach((f, i) => {
    const ok = v => v === null || ['string', 'number', 'boolean'].includes(typeof v)
      || (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number'));
    if (!ok(f.value)) issues.push(`filters.${i}.value: invalid_union`);
  });
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit)) issues.push('limit: invalid_type');
    else if (input.limit < 1) issues.push('limit: too_small');
    else if (input.limit > 100) issues.push('limit: too_big');
  }
  if (input.offset !== undefined) {
    if (!Number.isInteger(input.offset)) issues.push('offset: invalid_type');
    else if (input.offset < 0) issues.push('offset: too_small');
  }
  return issues;
}

function mapOperator(op) {
  switch (op.toLowerCase()) {
    case 'eq': case '=': case 'equals': return 'eq';
    case 'neq': case 'ne': case '!=': case 'not_equal': return 'neq';
    case 'gt': case '>': case 'greater_than': return 'gt';
    case 'gte': case '>=': return 'gte';
    case 'lt': case '<': case 'less_than': return 'lt';
    case 'lte': case '<=': return 'lte';
    case 'like': return 'like';
    case 'ilike': return 'ilike';
    case 'in': return 'in';
    case 'is': return 'is';
    default: return op;
  }
}

/**
 * The MCP list_records tool (tools/list-records.ts) over schema context S for
 * one input, with the golden stub (every data request answers [] and
 * an unknown-total Content-Range). Returns { invalidInput } | { thrown } | { toolError }
 * plus `requests` (path, decoded params, headers) in order, and `trace`: the
 * per-filter steps the ledger attributes.
 */
export function mcpListRecords(input, S) {
  const issues = zodList(input);
  if (issues.length) return { invalidInput: issues, requests: [] };
  const requests = [];
  const trace = { filters: [] };
  try {
    const limit = input.limit ?? 25;
    const offset = input.offset ?? 0;
    const ent = resolveEntity(S.entities, input.entity);
    const all = S.props(ent.table_name);
    const display = input.columns ? input.columns.map(c => resolveColumn(all, ent.table_name, c)) : mcpFilter(all, 'list');
    const hasId = all.some(p => p.column_name === 'id' || p.is_identity);
    let select = mcpBuildSelect(display);
    if (hasId && !display.some(p => p.column_name === 'id' || p.is_identity)) select = 'id,' + select;
    const params = new Map([['select', select]]);
    if (input.filters) {
      const conds = [];
      for (const f of input.filters) {
        const prop = resolveColumn(all, ent.table_name, f.field);
        const op = mapOperator(f.operator);
        let value = f.value;
        const isRef = (prop.type === 'Status' && prop.status_entity_type) || (prop.type === 'Category' && prop.category_entity_type) || prop.join_table;
        if (isRef && (op === 'like' || op === 'ilike')) {
          return { toolError: `Cannot use ${op} on "${prop.display_name}" — it is a foreign key column that stores IDs, not text. Use eq with the exact display name or use the search parameter for full-text search.`, requests, trace };
        }
        const step = { column: prop.column_name, input: f.value };
        try {
          if (prop.type === 'Status' && prop.status_entity_type) {
            if (op === 'in' && Array.isArray(value)) value = value.map(v => typeof v === 'string' ? resolveStatus(S.statuses, prop.status_entity_type, v) : v);
            else if (typeof value === 'string') value = resolveStatus(S.statuses, prop.status_entity_type, value);
          } else if (prop.type === 'Category' && prop.category_entity_type) {
            if (op === 'in' && Array.isArray(value)) value = value.map(v => typeof v === 'string' ? resolveCategory(S.categories, prop.category_entity_type, v) : v);
            else if (typeof value === 'string') value = resolveCategory(S.categories, prop.category_entity_type, value);
          } else if (prop.join_table) {
            if (op === 'in' && Array.isArray(value) && value.some(v => typeof v === 'string')) {
              return { unsupported: 'FK in-list with string values (concurrent lookups) is not modeled', requests, trace };
            }
            if (typeof value === 'string') {
              const r = resolveFk(prop.join_table, value, () => []);
              for (const q of r.requests) requests.push({ method: 'GET', path: q.path, decoded: q.decoded, headers: {} });
              step.lookup = prop.join_table;
              if (r.error) throw new NameError(r.error);
              value = r.result;
            }
          }
        } catch (e) {
          if (e instanceof NameError) { step.error = e.message; trace.filters.push(step); return { toolError: e.message, requests, trace }; }
          throw e;
        }
        const expr = op === 'in' && Array.isArray(value) ? `in.(${value.join(',')})` : op === 'is' ? `is.${value}` : `${op}.${value}`;
        step.expression = expr;
        trace.filters.push(step);
        conds.push([prop.column_name, expr]);
      }
      const byCol = new Map();
      for (const [c, e] of conds) byCol.set(c, [...(byCol.get(c) ?? []), e]);
      const and = [];
      for (const [c, es] of byCol) {
        if (es.length === 1) params.set(c, es[0]);
        else for (const e of es) and.push(`${c}.${e}`);
      }
      if (and.length) params.set('and', `(${and.join(',')})`);
      trace.grouped = [...byCol].filter(([, es]) => es.length > 1).map(([c]) => c);
    }
    if (input.search && ent.fulltext_search_column) params.set(ent.fulltext_search_column, `wfts(simple).${input.search}`);
    else if (input.search && ent.substring_search_column) params.set(ent.substring_search_column, `ilike.*${input.search}*`);
    else if (input.search) params.set('display_name', `ilike.*${input.search}*`);
    if (input.sort) {
      const desc = input.sort.startsWith('-');
      const sp = resolveColumn(all, ent.table_name, desc ? input.sort.slice(1) : input.sort);
      params.set('order', `${sp.column_name}.${desc ? 'desc' : 'asc'}`);
    } else if (all.some(p => p.column_name === 'display_name')) params.set('order', 'display_name.asc');
    else if (all.some(p => p.column_name === 'id' || p.is_identity === true)) params.set('order', 'id.asc');
    else if (all[0]) params.set('order', `${all[0].column_name}.asc`);
    trace.defaultOrder = !input.sort;
    requests.push({
      method: 'GET', path: ent.table_name, decoded: [...params].map(([k, v]) => `${k}=${v}`),
      headers: { 'Prefer': 'count=exact', 'Range': `${offset}-${offset + limit - 1}`, 'Range-Unit': 'items' },
    });
    return { requests, trace };
  } catch (e) {
    if (e instanceof NameError) return { thrown: `NameResolutionError: ${e.message}`, requests, trace };
    throw e;
  }
}

/** The MCP get_record tool (tools/get-record.ts) with the golden stub (no rows). */
export function mcpGetRecord(input, S) {
  try {
    const ent = resolveEntity(S.entities, input.entity);
    const all = S.props(ent.table_name);
    if (input.columns) input.columns.forEach(c => resolveColumn(all, ent.table_name, c));
    const req = { method: 'GET', path: ent.table_name, decoded: [`select=${mcpBuildSelect(all, true)}`, `id=eq.${input.id}`], headers: {} };
    return { toolError: `Record #${input.id} not found in ${ent.display_name}.`, requests: [req] };
  } catch (e) {
    if (e instanceof NameError) return { thrown: `NameResolutionError: ${e.message}`, requests: [] };
    throw e;
  }
}

/** Split a PostgREST select value into top-level items (parentheses-aware). */
export function splitSelect(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s ?? '') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur !== '' || out.length) out.push(cur);
  return out;
}
export const selectAlias = item => item.split(':')[0].split('!')[0].split('(')[0];

/** buildHybridSearchParams (search.utils.ts:20-45): the raw (encoded) query-param strings. */
export function feHybridSearchParams(term, fulltextColumn, substringColumns = []) {
  const safe = term.replace(/[(),]/g, '').trim();
  if (!safe) return [];
  const encoded = encodeURIComponent(safe);
  const clauses = [];
  if (fulltextColumn) clauses.push(`${fulltextColumn}.wfts.${encoded}`);
  for (const col of substringColumns) clauses.push(`${col}.ilike.*${encoded}*`);
  if (clauses.length === 0) return [];
  if (clauses.length === 1) {
    const dot = clauses[0].indexOf('.');
    return [`${clauses[0].slice(0, dot)}=${clauses[0].slice(dot + 1)}`];
  }
  return [`or=(${clauses.join(',')})`];
}
/** ListPage.buildSearchParams (list.page.ts:881-889). */
export function feListSearchParams(term, ent) {
  return feHybridSearchParams(term, ent.fulltext_search_column, ent.substring_search_column ? [ent.substring_search_column] : []);
}
/** Raw param strings -> decoded [key, value] pairs, as PostgREST reads them. */
export const decodeParams = raws => raws.flatMap(r => [...new URLSearchParams(r)]);

// ---------------------------------------------------------------------------
// execute_action / get_record (tools/execute-action.ts, tools/get-record.ts)
// ---------------------------------------------------------------------------

function mcpFieldValue(record, field) {
  let cur = record;
  for (const part of String(field).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** describeConditionFailure (execute-action.ts:285-320); a thrown error becomes THROWS. */
export function mcpDescribe(cond, record) {
  const run = c => {
    if ('or' in c) {
      const parts = c.or.map(x => run(x));
      return `None of these conditions are met:\n${parts.map(p => `  - ${p}`).join('\n')}`;
    }
    if ('and' in c) {
      const failing = c.and.filter(x => !evaluate(x, record, MCP_FLAGS));
      return failing.map(x => run(x)).join('; ');
    }
    const { field, operator, value } = c;
    const actual = mcpFieldValue(record, field);
    const fmt = v => (v === null || v === undefined ? 'null' : JSON.stringify(v));
    switch (operator) {
      case 'eq': return `${field} is ${fmt(actual)}, expected ${fmt(value)}`;
      case 'ne': return `${field} is ${fmt(actual)}, must not be ${fmt(value)}`;
      case 'gt': return `${field} is ${fmt(actual)}, must be > ${fmt(value)}`;
      case 'lt': return `${field} is ${fmt(actual)}, must be < ${fmt(value)}`;
      case 'gte': return `${field} is ${fmt(actual)}, must be >= ${fmt(value)}`;
      case 'lte': return `${field} is ${fmt(actual)}, must be <= ${fmt(value)}`;
      case 'in': return `${field} is ${fmt(actual)}, must be one of ${fmt(value)}`;
      case 'is_null': return `${field} is ${fmt(actual)}, must be null`;
      case 'is_not_null': return `${field} is null, must have a value`;
      default: return `${field} failed condition "${operator}"`;
    }
  };
  try {
    return run(cond);
  } catch {
    return THROWS;
  }
}

const NEXT = '\n\nUse `get_record` to see the current state and available actions.';

/**
 * Field order of an embed select, as the golden harness builds embedded
 * objects (conditions.golden.test.ts embedFields). The golden file stores
 * records with sorted keys, but the MCP saw (and JSON-stringifies in its
 * messages) the objects in select order, so the model restores that order.
 */
function embedFieldOrder(select) {
  const open = select.indexOf('(');
  if (open < 0 || !select.endsWith(')')) return null;
  return splitSelect(select.slice(open + 1, -1)).map(f => f.replace(/\(.*$/, '').replace(/^[^:]*:/, '').replace(/!.*$/, ''));
}
function inSelectOrder(record, props) {
  if (!record || typeof record !== 'object') return record;
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    const p = props.find(x => x.column_name === k);
    const order = p && v && typeof v === 'object' && !Array.isArray(v) ? embedFieldOrder(mcpSelect(p.type, p)) : null;
    if (!order) { out[k] = v; continue; }
    const o = {};
    for (const f of order) if (f in v) o[f] = v[f];
    for (const [fk, fv] of Object.entries(v)) if (!(fk in o)) o[fk] = fv;
    out[k] = o;
  }
  return out;
}

/**
 * execute_action over one record (the stub serves the row, the RPC and the
 * notes exactly; anything else is a 404). Returns the outcome class, the
 * tool-error text, and the requests in order.
 */
export function mcpExecuteAction(action, sortedRecord, S) {
  const record = inSelectOrder(sortedRecord, S.props(action.table_name));
  let ent;
  try { ent = resolveEntity(S.entities, action.table_name); } catch (e) {
    if (e instanceof NameError) return { outcome: `other: NameResolutionError: ${e.message}`, requests: [] };
    throw e;
  }
  const resolved = resolveAction(S.actions.filter(a => a.table_name === ent.table_name), ent.table_name, action.action_name);
  if (!resolved.can_execute) return { outcome: 'no-permission', text: `You do not have permission to execute "${resolved.display_name}" on ${ent.display_name}.`, requests: [] };
  const requests = [];
  if (resolved.visibility_condition || resolved.enabled_condition) {
    requests.push({ method: 'GET', path: ent.table_name, decoded: [`select=${mcpBuildSelect(S.props(ent.table_name))}`, 'id=eq.1'], headers: {} });
    if (resolved.visibility_condition && !evaluate(resolved.visibility_condition, record, MCP_FLAGS)) {
      return { outcome: 'not-available', text: `Action "${resolved.display_name}" is not available for this record.\n\n${mcpDescribe(resolved.visibility_condition, record)}${NEXT}`, requests };
    }
    if (resolved.enabled_condition && !evaluate(resolved.enabled_condition, record, MCP_FLAGS)) {
      const reason = resolved.disabled_tooltip ?? mcpDescribe(resolved.enabled_condition, record);
      return { outcome: 'disabled', text: `Action "${resolved.display_name}" is disabled: ${reason}${NEXT}`, requests };
    }
  }
  const missing = (resolved.parameters ?? []).find(p => p.required);
  if (missing) return { outcome: 'passed-conditions (missing required parameter)', requests };
  requests.push({ method: 'POST', path: `rpc/${resolved.rpc_function}`, decoded: [], headers: {}, body: { p_entity_id: 1 } });
  return { outcome: 'executed', requests };
}

/** get_record requests for id 1 with the row served (tools/get-record.ts:52-150). */
export function mcpGetRecordRequests(table, S) {
  let ent;
  try { ent = resolveEntity(S.entities, table); } catch (e) {
    if (e instanceof NameError) return [];
    throw e;
  }
  const out = [{ method: 'GET', path: ent.table_name, decoded: [`select=${mcpBuildSelect(S.props(ent.table_name), true)}`, 'id=eq.1'], headers: {} }];
  if (ent.enable_notes) {
    out.push({
      method: 'GET', path: 'entity_notes',
      decoded: ['select=id,content,note_type,created_at,author_id:civic_os_users!author_id(id,display_name,full_name)', `entity_type=eq.${ent.table_name}`, 'entity_id=eq.1', 'order=created_at.desc', 'limit=1'],
      headers: { 'Prefer': 'count=exact', 'Range': '0-0', 'Range-Unit': 'items' },
    });
  }
  return out;
}
