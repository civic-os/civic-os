/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Turns raw recordings (one JSON per flow, written by recorder.mjs) into the
 * normalized, committed baseline format.
 *
 * Masking rules (each one is justified in README.md "What is masked"):
 *   - the Keycloak user ids of the test roles -> <user:role>
 *   - other UUIDs                    -> <uuid:N>
 *   - ids of rows the run created    -> <Table:N>, numbered per table in
 *                                       creation order, only where the
 *                                       position's table is known
 *   - JWTs                           -> <jwt>
 *   - a run-time timestamp, only in a field declared in RUNTIME_TS_FIELDS
 *                                    -> <runtime-ts:shape>
 * Nothing else is masked. Requests that start outside a named step are kept
 * as UNATTRIBUTED entries, which always fail a comparison.
 */

import { HARNESS_VERSION, POSTGREST_ORIGIN, KEYCLOAK_ORIGIN, MINIO_ORIGIN, RECORDED_HEADERS, TIMEZONE } from './config.mjs';

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
/** A whole value that is an ISO-8601 date-time; group 1 = the zone designator, if any. */
const WHOLE_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
/** <Table>/<id>/ immediately followed by a UUID, as in S3 object keys built by the file upload service. */
const OBJECT_KEY_RE = /(^|\/)([A-Za-z_][A-Za-z0-9_]*)\/(\d+)\/(?=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-)/g;
/** A PostgREST condition inside or=(...)/and=(...): column.[not.]operator.value */
const COND_RE = /([A-Za-z0-9_]+)\.(?:not\.)?(?:eq|neq|gt|gte|lt|lte|in|is|like|ilike|cs|cd|ov)\.(\([^)]*\)|[^,()]+)/g;

/** Margin around each clock window. */
const WINDOW_MARGIN_MS = 5 * 60 * 1000;

/**
 * The only positions where a timestamp generated during the run (the client's
 * new Date() on the fake clock, or the database's now()) may be masked: a JSON
 * body key or query parameter name, and the format the value must have there.
 *   format 'zoned': the value carries Z or an offset; its instant must lie in a run window.
 *   format 'wall':  the value has no zone; it is read as wall-clock time in the pinned
 *                   TIMEZONE (never as UTC), and that instant must lie in a run window.
 * A masked value keeps its shape (<runtime-ts:dddd-dd-ddTdd:dd:dd.dddZ>), so a format
 * change (Z vs offset, dropped milliseconds) still shows. Any other timestamp stays
 * exact wherever it appears.
 *
 * Empty on purpose: no recorded flow sends a run-time timestamp today. Adding an entry
 * needs a written justification in README.md "What is masked".
 */
export const RUNTIME_TS_FIELDS = [];

/** RPC parameters that name the table of their sibling id parameters. */
const RPC_TABLE_PARAMS = ['p_entity_type', 'p_entity_table', 'p_table_name', 'p_table'];
/** RPC parameters whose table is fixed by the framework's recurring-series API. */
const RPC_PARAM_TABLES = {
  p_series_id: 'time_slot_series',
  p_group_id: 'time_slot_series_groups',
};
/** RPC id parameters that refer to the record shown on the current page (/view|/edit/:entity/:id). */
const RPC_PAGE_ID_PARAMS = new Set(['p_entity_id', 'p_parent_id', 'p_id', 'p_record_id']);

/**
 * Polling / retry requests whose repetition count depends on worker timing.
 * Each matching request collapses to a single entry with n: ">=1".
 */
export const COLLAPSE_RULES = [
  { name: 'schema_cache_versions on navigation', test: (e) => e.method === 'GET' && e.path === '/schema_cache_versions' },
  { name: 'presigned upload URL retries', test: (e) => e.method === 'GET' && e.path === '/rpc/get_upload_url' },
  {
    // FileUploadService.waitForThumbnails(): GET files?id=eq.<id>&select=thumbnail_status every second.
    name: 'file thumbnail_status polling',
    test: (e) => e.method === 'GET' && e.path === '/files'
      && Object.keys(e.query).length === 2
      && e.query.select === 'thumbnail_status'
      && isFileIdFilter(e.query.id),
  },
  {
    // FileThumbnailComponent.startPolling(): FileUploadService.getFile(), i.e. GET files?id=eq.<id>
    // with no other parameter, every second while a shown file's thumbnail is pending. Gallery
    // uploads do not wait for thumbnails, so the count follows the worker (seen as 1 or 2).
    // Only that exact shape: any select, order or second filter is counted exactly.
    name: 'file thumbnail component polling (getFile)',
    test: (e) => e.method === 'GET' && e.path === '/files'
      && Object.keys(e.query).length === 1
      && isFileIdFilter(e.query.id),
  },
];

/** eq.<uuid token>: a single file by its (masked) id. */
function isFileIdFilter(v) {
  return typeof v === 'string' && /^eq\.<uuid:\d+>$/.test(v);
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Offset (ms, local minus UTC) of `timeZone` at instant `t`. */
function zoneOffsetMs(t, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * The instant a whole ISO-8601 value denotes, or null. A zoned value is read as
 * written. A zone-less value is read as wall-clock time in `timeZone` (the
 * pinned browser zone), never as UTC: a value rendered with UTC digits by
 * mistake therefore lands hours away from the run windows and stays exact.
 */
export function timestampInstant(text, timeZone = TIMEZONE) {
  const m = WHOLE_TS_RE.exec(text);
  if (!m) return null;
  let s = text.replace(' ', 'T');
  if (m[1]) {
    let off = m[1];
    if (off !== 'Z') {
      if (/^[+-]\d{2}$/.test(off)) off += ':00';
      else if (/^[+-]\d{4}$/.test(off)) off = off.slice(0, 3) + ':' + off.slice(3);
      s = s.slice(0, s.length - m[1].length) + off;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const wall = Date.parse(s + 'Z');
  if (!Number.isFinite(wall)) return null;
  // Two passes settle the offset next to a transition.
  let t = wall - zoneOffsetMs(wall, timeZone);
  t = wall - zoneOffsetMs(t, timeZone);
  return t;
}

/** The format signature kept in a masked timestamp: digits become 'd', everything else stays. */
function timestampShape(text) {
  const m = WHOLE_TS_RE.exec(text);
  const zone = m?.[1] ?? '';
  return text.slice(0, text.length - zone.length).replace(/\d/g, 'd') + zone;
}

/** The entity shown by an app route (/view|/edit/:entity/:id), used to resolve page-scoped RPC ids. */
export function pageRecord(frameUrl) {
  if (!frameUrl) return null;
  try {
    const m = /^\/(?:view|edit)\/([^/?#]+)\/([^/?#]+)/.exec(new URL(frameUrl).pathname);
    return m ? { table: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) } : null;
  } catch {
    return null;
  }
}

export class MaskContext {
  /**
   * @param {object} opts
   * @param {Array<{table: string, id: string}>} opts.registered  ids created by the run, with their table
   * @param {Array<[number, number]>} opts.windows                runtime clock windows (epoch ms)
   * @param {Array<{table_name: string, column_name: string, join_table: string}>} [opts.foreignKeys]
   * @param {Array<{guided_form_key: string, parent_table: string}>} [opts.guidedForms]
   * @param {Array<{role: string, id: string}>} [opts.users]   Keycloak user ids of the test roles
   * @param {Array<{field: string, format: 'zoned'|'wall'}>} [opts.runtimeTsFields]
   */
  constructor({ registered, windows, foreignKeys = [], guidedForms = [], users = [], runtimeTsFields = RUNTIME_TS_FIELDS }) {
    this.registered = new Map();
    for (const { table, id } of registered) {
      if (!this.registered.has(table)) this.registered.set(table, new Set());
      this.registered.get(table).add(String(id));
    }
    // Created ids are numbered per table in creation order before anything is masked, so
    // a token names one specific row: <Issue:5> is the fifth Issue the run created, and
    // a request for the sixth instead shows as a diff. Integer ids come from the table's
    // sequence, so ascending value is creation order, whatever order the responses were
    // recorded in; other ids keep their registration order.
    this.idTokens = new Map();
    for (const [table, ids] of this.registered) {
      const list = [...ids];
      if (list.every((x) => /^\d+$/.test(x))) list.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
      this.idTokens.set(table, new Map(list.map((id, i) => [id, `<${table}:${i + 1}>`])));
    }
    // Role users are named by role, so a request for another user's id is a diff.
    this.userTokens = new Map(users.filter((u) => u.id).map((u) => [String(u.id).toLowerCase(), `<user:${u.role}>`]));
    this.runtimeTsFields = new Map(runtimeTsFields.map((f) => [f.field, f.format]));
    this.fk = new Map();
    for (const { table_name, column_name, join_table } of foreignKeys) {
      if (!this.fk.has(table_name)) this.fk.set(table_name, new Map());
      this.fk.get(table_name).set(column_name, join_table);
    }
    this.guidedFormTables = new Map(guidedForms.map((g) => [g.guided_form_key, g.parent_table]));
    this.windows = windows;
    this.uuidTokens = new Map();
    /** When false, unseen values get a placeholder instead of a new numbered token (used for ordering keys). */
    this.assign = true;
  }

  uuidToken(raw) {
    const key = raw.toLowerCase();
    if (this.userTokens.has(key)) return this.userTokens.get(key);
    if (!this.assign) return this.uuidTokens.get(key) ?? '<uuid>';
    if (!this.uuidTokens.has(key)) this.uuidTokens.set(key, `<uuid:${this.uuidTokens.size + 1}>`);
    return this.uuidTokens.get(key);
  }

  isRegistered(table, id) {
    return !!table && !!this.registered.get(table)?.has(String(id));
  }

  /** Token of a created id of `table` (pre-numbered in creation order; callers check isRegistered first). */
  idToken(table, id) {
    return this.idTokens.get(table)?.get(String(id)) ?? `<${table}:?${id}>`;
  }

  /** Table a column's value refers to: the table itself for `id`, the FK target otherwise. */
  columnTable(table, column) {
    if (!table) return null;
    if (column === 'id') return table;
    return this.fk.get(table)?.get(column) ?? null;
  }

  /**
   * Polymorphic references: `<prefix>_id` next to `<prefix>_type` (e.g. entity_id + entity_type
   * on entity_notes) refers to the table named by the type value ('eq.' prefix allowed).
   */
  polymorphicTable(key, siblings) {
    const m = /^(.*)_id$/.exec(key);
    if (!m || !siblings) return null;
    const t = siblings[`${m[1]}_type`];
    if (typeof t !== 'string') return null;
    return t.replace(/^eq\./, '');
  }

  /** Table of an RPC id parameter, from a sibling table parameter, the page's record, or a fixed map. */
  rpcParamTable(key, value, args, page) {
    for (const p of RPC_TABLE_PARAMS) {
      if (typeof args?.[p] === 'string' && /(_id|_ids)$/.test(key)) return args[p];
    }
    if (RPC_PARAM_TABLES[key]) return RPC_PARAM_TABLES[key];
    if (key === 'p_parent_id' && typeof args?.p_guided_form_key === 'string') return this.guidedFormTables.get(args.p_guided_form_key) ?? null;
    if (RPC_PAGE_ID_PARAMS.has(key) && page && String(value) === page.id) return page.table;
    return null;
  }

  inWindow(t) {
    return t != null && this.windows.some(([a, b]) => t >= a - WINDOW_MARGIN_MS && t <= b + WINDOW_MARGIN_MS);
  }

  /**
   * <runtime-ts:shape> when `field` is declared in RUNTIME_TS_FIELDS, the whole value has
   * that field's format, and its instant lies in a run window; otherwise null.
   */
  runtimeTimestamp(field, value) {
    if (typeof value !== 'string' || !this.runtimeTsFields.has(field)) return null;
    const m = WHOLE_TS_RE.exec(value);
    if (!m) return null;
    const format = this.runtimeTsFields.get(field);
    if ((format === 'zoned') !== !!m[1]) return null;
    return this.inWindow(timestampInstant(value)) ? `<runtime-ts:${timestampShape(value)}>` : null;
  }

  /** Masks JWTs, object-key ids and UUIDs inside a decoded string. */
  maskString(s) {
    return s
      .replace(JWT_RE, '<jwt>')
      // Storage object keys embed the owning record: <Table>/<id>/<uuid>/<name>.
      .replace(OBJECT_KEY_RE, (m, pre, table, id) => (this.isRegistered(table, id) ? `${pre}${table}/${this.idToken(table, id)}/` : m))
      .replace(UUID_RE, (m) => this.uuidToken(m));
  }

  /** Same as maskString for a raw (possibly percent-encoded) URL fragment. */
  maskRawString(s) {
    return s.replace(JWT_RE, '<jwt>').replace(UUID_RE, (m) => this.uuidToken(m));
  }

  /** Replaces created ids of `table` in a filter value (eq.5, in.(5,6), not.eq.5). */
  maskIdDigits(table, value, rawDelims = false) {
    if (!table || !this.registered.has(table)) return value;
    const re = rawDelims
      ? /(^|[.(,]|%28|%2[Cc])(\d+)(?=$|[,)&]|%29|%2[Cc])/g
      : /(^|[.(,])(\d+)(?=$|[,)])/g;
    return value.replace(re, (m, pre, digits) => (this.isRegistered(table, digits) ? pre + this.idToken(table, digits) : m));
  }

  /** Masks ids inside or=(...)/and=(...) conditions of `table`. */
  maskConditions(table, value, rawDelims = false) {
    const text = rawDelims ? value : value;
    return text.replace(COND_RE, (m, col, operand) => {
      const t = this.columnTable(table, col);
      return t ? m.slice(0, m.length - operand.length) + this.maskIdDigits(t, operand, rawDelims) : m;
    });
  }

  /** Masks one decoded query param value. `ctx` = { table } for table requests, { rpc, page } for RPCs. */
  maskQueryValue(ctx, name, value) {
    const ts = this.runtimeTimestamp(name, value.replace(/^[a-z]+\./, ''));
    if (ts !== null) return value.slice(0, value.length - value.replace(/^[a-z]+\./, '').length) + ts;
    let v = this.maskString(value);
    if (/(^|\.)(or|and)$/.test(name)) {
      v = this.maskConditions(name.includes('.') ? null : ctx.table, v);
    } else if (!name.includes('.')) {
      const t = ctx.rpc
        ? this.rpcParamTable(name, v.replace(/^[a-z]+\./, ''), ctx.params, ctx.page)
        : this.columnTable(ctx.table, name) ?? this.polymorphicTable(name, ctx.params);
      v = this.maskIdDigits(t, v);
    }
    return v;
  }

  maskScalarId(table, value) {
    if (typeof value === 'number' && Number.isInteger(value) && this.isRegistered(table, value)) return this.idToken(table, value);
    if (typeof value === 'string' && /^\d+$/.test(value) && this.isRegistered(table, value)) return this.idToken(table, value);
    return null;
  }

  /**
   * Masks a JSON body. ctx = { table } for table writes (keys are columns),
   * { rpc, page } for RPC arguments. sort=true gives the canonical form,
   * sort=false keeps the key order as sent (raw comparison).
   */
  maskBody(value, ctx, sort = true) {
    const walk = (v, key, parent, depth) => {
      if (Array.isArray(v)) return v.map((x) => walk(x, key, parent, depth));
      if (v && typeof v === 'object') {
        const out = {};
        const keys = sort ? Object.keys(v).sort() : Object.keys(v);
        for (const k of keys) out[k] = walk(v[k], k, v, depth + 1);
        return out;
      }
      if (key !== null && (typeof v === 'number' || typeof v === 'string')) {
        const ts = this.runtimeTimestamp(key, v);
        if (ts !== null) return ts;
        let table = null;
        if (ctx.rpc) {
          if (depth === 1) table = this.rpcParamTable(key, v, parent, ctx.page);
        } else if (depth <= 1) {
          table = this.columnTable(ctx.table, key) ?? this.polymorphicTable(key, parent);
        }
        const masked = this.maskScalarId(table, v);
        if (masked !== null) return masked;
      }
      return typeof v === 'string' ? this.maskString(v) : v;
    };
    return walk(value, null, null, 0);
  }

  /** Masks a raw query string (with leading '?') segment by segment, keeping order and encoding. */
  maskRawQuery(search, ctx) {
    if (!search || search === '?') return '';
    const segs = search.slice(1).split('&').map((seg) => {
      const eq = seg.indexOf('=');
      if (eq < 0) return this.maskRawString(seg);
      const rawName = seg.slice(0, eq);
      const name = safeDecode(rawName.replace(/\+/g, ' '));
      const decodedValue = safeDecode(seg.slice(eq + 1).replace(/\+/g, ' '));
      const ts = this.runtimeTimestamp(name, decodedValue.replace(/^[a-z]+\./, ''));
      if (ts !== null) return rawName + '=' + decodedValue.slice(0, decodedValue.length - decodedValue.replace(/^[a-z]+\./, '').length) + ts;
      let v = this.maskRawString(seg.slice(eq + 1));
      if (/(^|\.)(or|and)$/.test(name)) {
        if (!name.includes('.') && ctx.table) {
          // Conditions may have encoded parens/commas; mask digits of any registered id of the referenced tables.
          for (const t of this.fk.get(ctx.table)?.values() ?? []) v = this.maskIdDigits(t, v, true);
          v = this.maskIdDigits(ctx.table, v, true);
        }
      } else if (!name.includes('.')) {
        const decoded = safeDecode(v.replace(/\+/g, ' '));
        const t = ctx.rpc
          ? this.rpcParamTable(name, decoded.replace(/^[a-z]+\./, ''), ctx.params, ctx.page)
          : this.columnTable(ctx.table, name) ?? this.polymorphicTable(name, ctx.params);
        v = this.maskIdDigits(t, v, true);
      }
      return rawName + '=' + v;
    });
    return '?' + segs.join('&');
  }

  /** Masks a PostgREST path (table or rpc name only). */
  maskPath(pathname) {
    return pathname.split('/').map((seg) => this.maskString(safeDecode(seg))).join('/');
  }

  /** MinIO object path: /<bucket>/<Table>/<id>/<uuid>/<name>. */
  maskObjectPath(pathname) {
    const segs = pathname.split('/').map((s) => safeDecode(s));
    return segs
      .map((s, i) => {
        const t = i >= 1 ? segs[i - 1] : null;
        if (/^\d+$/.test(s) && this.isRegistered(t, s)) return this.idToken(t, s);
        return this.maskString(s);
      })
      .join('/');
  }
}

function parseBody(postData, contentType) {
  if (postData == null || postData === '') return { kind: 'none', value: null };
  if (/json/i.test(contentType || '') || /^[[{]/.test(postData.trim())) {
    try {
      return { kind: 'json', value: JSON.parse(postData) };
    } catch {
      /* fall through */
    }
  }
  return { kind: 'text', value: postData };
}

/** Request context used to resolve which table an id position refers to. */
function requestContext(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const page = pageRecord(req.frameUrl);
  const params = Object.fromEntries(url.searchParams);
  if (pathname.startsWith('/rpc/')) return { rpc: pathname.slice('/rpc/'.length), page, params };
  return { table: safeDecode(pathname.replace(/^\//, '')), page, params };
}

/**
 * Builds the semantic + raw form of one PostgREST request.
 * Returns { entry, raw } where entry has no raw fields.
 */
export function normalizePostgrestRequest(req, mctx) {
  const url = new URL(req.url);
  const ctx = requestContext(req);
  const path = mctx.maskPath(url.pathname);

  const pairs = [];
  for (const [k, v] of url.searchParams) pairs.push([k, mctx.maskQueryValue(ctx, k, v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const query = {};
  for (const [k, v] of pairs) {
    if (k in query) query[k] = [].concat(query[k], v);
    else query[k] = v;
  }

  const headers = {};
  const h = req.headers || {};
  for (const name of RECORDED_HEADERS) {
    if (h[name] !== undefined) headers[name] = mctx.maskString(String(h[name]));
  }
  if (h.authorization !== undefined) headers.authorization = /^Bearer\s+\S+/i.test(h.authorization) ? 'Bearer <present>' : '<present>';

  const parsed = parseBody(req.postData, h['content-type']);
  let body = null;
  let rawBody = null;
  if (parsed.kind === 'json') {
    body = mctx.maskBody(parsed.value, ctx, true);
    rawBody = JSON.stringify(mctx.maskBody(parsed.value, ctx, false));
  } else if (parsed.kind === 'text') {
    body = mctx.maskString(parsed.value);
    rawBody = body;
  }

  const status = statusClass(req);
  const entry = { method: req.method, path, query, headers, body, status };
  const rawUrl = path + mctx.maskRawQuery(rawSearch(req.url), ctx);
  return { entry, raw: { url: rawUrl, body: rawBody } };
}

/** Methods whose cancellation has no effect on the server: an aborted read only discards its response. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * RPCs the app calls with POST that only read. A POST to one of these classes
 * as a read, because aborting it discards a response and nothing else.
 *
 * Criterion for membership: the function's LATEST definition (last
 * CREATE OR REPLACE FUNCTION in sqitch.plan order under
 * postgres/migrations/deploy, or, for an example-only RPC, that example's
 * init-scripts) is declared STABLE or IMMUTABLE. PostgreSQL rejects writes
 * inside such a function. A name prefix proves nothing (integrator RPCs exist),
 * so this is an explicit list, not a `get_*` pattern. Functions left out on
 * purpose: refresh_current_user, log_impersonation, request_upload_url,
 * get_upload_url, get_user_default_dashboard, get_preview_results,
 * get_validation_results, admin_get_user_notification_preferences,
 * preview_template_parts and validate_template_parts are declared VOLATILE.
 * Add a name only after checking its latest definition.
 */
export const READ_ONLY_RPCS = new Set([
  'admin_get_user_bulk_subscriptions',
  'get_borrowers_for_reservation', // examples/neighborhood-hub only
  'get_categories_for_entity',
  'get_category_entity_types',
  'get_current_user_permissions',
  'get_dashboard',
  'get_dashboards',
  'get_entity_action_roles',
  'get_entity_source_code',
  'get_file_storage_stats',
  'get_gallery_storage_stats',
  'get_guided_form_context',
  'get_manageable_roles',
  'get_missing_translations',
  'get_own_profile',
  'get_role_can_manage',
  'get_role_permissions',
  'get_roles',
  'get_series_membership',
  'get_status_entity_types',
  'get_status_transitions_for_entity',
  'get_statuses_for_entity',
  'get_translation_defaults',
  'get_translations_for_locale',
  'get_user_bulk_subscriptions',
  'is_admin',
  'preview_recurring_conflicts',
]);

/** True for a POST to exactly `/rpc/<name>` where `name` is in READ_ONLY_RPCS. Matches the URL's pathname only. */
function isReadOnlyRpcPost(req) {
  if (String(req.method).toUpperCase() !== 'POST') return false;
  let pathname;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return false;
  }
  const m = /^\/rpc\/([A-Za-z0-9_]+)$/.exec(pathname);
  return m !== null && READ_ONLY_RPCS.has(m[1]);
}

/**
 * Response status as compared.
 *
 * Reads (GET, HEAD, OPTIONS, and a POST to an RPC in READ_ONLY_RPCS): a 2xx
 * response and a request the app cancelled (net::ERR_ABORTED, from switchMap
 * or a navigation) share one class, '2xx|cancelled'. Whether a superseded
 * read's response arrived before the cancel is timing, and a read changes
 * nothing either way.
 *
 * Writes (POST, PATCH, PUT, DELETE, including every RPC POST not in
 * READ_ONLY_RPCS): '2xx' and 'cancelled' stay distinct. A cancelled write may
 * or may not have reached the database, so a write the app now aborts is a
 * behavior change, not timing.
 *
 * Every other status stays exact.
 */
export function statusClass(req) {
  const read = READ_METHODS.has(String(req.method).toUpperCase()) || isReadOnlyRpcPost(req);
  if (req.failure) {
    if (!/ERR_ABORTED/.test(req.failure)) return `failed:${req.failure}`;
    return read ? '2xx|cancelled' : 'cancelled';
  }
  if (req.status == null) return null;
  if (req.status >= 200 && req.status < 300) return read ? '2xx|cancelled' : '2xx';
  return req.status;
}

/** The query string exactly as sent. */
function rawSearch(urlString) {
  const q = urlString.indexOf('?');
  if (q < 0) return '';
  const hash = urlString.indexOf('#', q);
  return urlString.slice(q, hash < 0 ? undefined : hash);
}

function originOf(urlString) {
  try {
    return new URL(urlString).origin;
  } catch {
    return '';
  }
}

export function classify(urlString) {
  const o = originOf(urlString);
  if (o === POSTGREST_ORIGIN) return 'postgrest';
  if (o === KEYCLOAK_ORIGIN) return 'keycloak';
  if (o === MINIO_ORIGIN) return 'minio';
  return 'other';
}

function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Request kinds that must belong to a step: app API traffic. Keycloak calls are timer-driven token refreshes. */
const STEP_BOUND_KINDS = new Set(['postgrest', 'minio']);

/**
 * Normalizes a whole run (array of raw flow recordings in run order) into
 * baseline documents, one per flow. Token numbering is global across the run
 * so an id created in one flow and used in a later flow keeps its token.
 *
 * PostgREST and MinIO requests that started outside any step (before the
 * first step, or between two steps) are not dropped: they are normalized into
 * the flow's `unattributed` list, addressed by the step they followed, and
 * every comparison fails on them. A `harness.setup()` step is kept as a step
 * named "setup: ...": its Node-side API calls are never recorded, but any
 * browser request made while it runs is, and compares like any other step.
 *
 * @param rawFlows   raw recordings in run order
 * @param foreignKeys schema_properties rows with join_table (FK map), captured during the run
 * @param guidedForms schema_guided_forms rows (guided_form_key -> parent_table), captured during the run
 * @param users      [{ role, id }] Keycloak user ids of the test roles, captured at auth setup
 */
export function normalizeRun(rawFlows, foreignKeys = [], guidedForms = [], users = []) {
  const windows = [];
  const registered = [];
  for (const f of rawFlows) {
    if (f.clockT0 != null && f.realStart != null && f.realEnd != null) {
      windows.push([f.clockT0, f.clockT0 + (f.realEnd - f.realStart)]);
      windows.push([f.realStart, f.realEnd]);
    }
    for (const r of f.requests) for (const c of r.createdIds || []) registered.push(c);
    for (const reg of f.registered || []) for (const id of reg.ids) registered.push({ table: reg.table, id: String(id) });
  }
  const mctx = new MaskContext({ registered, windows, foreignKeys, guidedForms, users });

  return rawFlows.map((f) => {
    const steps = [];
    for (const step of f.steps) {
      // Recorded steps and setup steps both: browser requests during harness.setup() are app
      // traffic too (the Node-side API seeding inside it is never recorded).
      if (step.kind !== 'step' && step.kind !== 'setup') continue;
      const reqs = f.requests.filter((r) => r.step === step.name);
      steps.push(normalizeStep(step.name, reqs, mctx));
    }
    const doc = { harness: HARNESS_VERSION, flow: f.test, steps };
    const outside = new Map();
    for (const r of f.requests) {
      if ((r.stepKind !== 'gap' && r.stepKind !== 'pre') || !STEP_BOUND_KINDS.has(r.kind)) continue;
      const where = r.stepKind === 'pre' || !r.afterStep ? '(before the first step)' : `(after step "${r.afterStep}")`;
      if (!outside.has(where)) outside.set(where, []);
      outside.get(where).push(r);
    }
    if (outside.size) {
      doc.unattributed = [...outside.entries()].map(([where, reqs]) => {
        const { postgrest, minio } = normalizeStep(where, reqs, mctx);
        return { where, postgrest, minio };
      });
    }
    return doc;
  });
}

/** Human-readable list of a normalized run's unattributed requests, one line per request; empty when there are none. */
export function describeUnattributed(doc) {
  const out = [];
  for (const u of doc.unattributed || []) {
    for (const e of u.postgrest) {
      const q = Object.entries(e.query).map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}=${x}`).join('&') : `${k}=${v}`)).join('&');
      out.push(`${u.where} n=${e.n}: ${e.method} ${e.path}${q ? '?' + q : ''} -> ${e.status}`);
    }
    for (const m of u.minio) out.push(`${u.where} MINIO ${m}`);
  }
  return out;
}

function normalizeStep(name, reqs, mctx) {
  // 1. PostgREST: order requests canonically using placeholder tokens, so token
  //    numbering does not depend on network timing.
  const pg = reqs.filter((r) => r.kind === 'postgrest');
  mctx.assign = false;
  const keyed = pg.map((r) => {
    const placeholder = stableStringify(normalizePostgrestRequest(r, mctx).entry);
    return { r, placeholder, actual: stableStringify({ url: r.url, body: r.postData ?? null }) };
  });
  mctx.assign = true;
  keyed.sort((a, b) => compareStr(a.placeholder, b.placeholder) || compareStr(a.actual, b.actual));

  const groups = new Map();
  for (const { r } of keyed) {
    const { entry, raw } = normalizePostgrestRequest(r, mctx);
    const rule = COLLAPSE_RULES.find((c) => c.test(entry));
    const key = stableStringify(entry);
    if (!groups.has(key)) groups.set(key, { entry, n: 0, collapse: !!rule, raw: new Set() });
    const g = groups.get(key);
    g.n += 1;
    g.raw.add(stableStringify(raw));
  }
  const postgrest = [...groups.entries()]
    .sort((a, b) => compareStr(a[0], b[0]))
    .map(([, g]) => ({
      ...g.entry,
      n: g.collapse ? '>=1' : g.n,
      raw: [...g.raw].sort().map((s) => JSON.parse(s)),
    }));

  // 2. Keycloak: counts per OIDC endpoint only (bodies never diffed).
  const keycloak = {};
  for (const r of reqs.filter((x) => x.kind === 'keycloak')) {
    const p = new URL(r.url).pathname;
    if (!p.includes('/protocol/openid-connect/')) continue;
    const k = `${r.method} ${p}`;
    keycloak[k] = (keycloak[k] || 0) + 1;
  }

  // 3. MinIO: method + masked object path + status (presigned query dropped).
  const minioCounts = new Map();
  for (const r of reqs.filter((x) => x.kind === 'minio').sort((a, b) => compareStr(a.url, b.url))) {
    const k = `${r.method} ${mctx.maskObjectPath(new URL(r.url).pathname)} -> ${r.failure ? 'failed' : r.status}`;
    minioCounts.set(k, (minioCounts.get(k) || 0) + 1);
  }
  const minio = [...minioCounts.entries()].sort((a, b) => compareStr(a[0], b[0])).map(([k, n]) => (n === 1 ? k : `${k} x${n}`));

  return { name, postgrest, keycloak: sortKeys(keycloak), minio };
}
