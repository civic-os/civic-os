/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Turns raw recordings (one JSON per flow, written by recorder.mjs) into the
 * normalized, committed baseline format.
 *
 * Masking rules (each one is justified in README.md "What is masked"):
 *   - UUIDs                          -> <uuid:N>
 *   - ids of rows the run created    -> <Table:N>, only where the position's
 *                                       table is known (see resolveTable)
 *   - JWTs                           -> <jwt>
 *   - ISO timestamps inside the run's clock windows -> <runtime-ts>
 * Nothing else is masked. User-typed values are chosen outside the clock
 * windows, so they stay exact.
 */

import { HARNESS_VERSION, POSTGREST_ORIGIN, KEYCLOAK_ORIGIN, MINIO_ORIGIN, RECORDED_HEADERS } from './config.mjs';

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
// Same shape as TS_RE but tolerant of percent-encoding / form-encoding in raw URLs.
const RAW_TS_RE = /\d{4}-\d{2}-\d{2}(?:T| |%20|\+)\d{2}(?::|%3[Aa])\d{2}(?:(?::|%3[Aa])\d{2}(?:\.\d{1,9})?)?(?:Z|(?:\+|-|%2[Bb])\d{2}(?:(?::|%3[Aa])?\d{2})?)?/g;
/** A PostgREST condition inside or=(...)/and=(...): column.[not.]operator.value */
const COND_RE = /([A-Za-z0-9_]+)\.(?:not\.)?(?:eq|neq|gt|gte|lt|lte|in|is|like|ilike|cs|cd|ov)\.(\([^)]*\)|[^,()]+)/g;

/** Margin around each clock window. */
const WINDOW_MARGIN_MS = 5 * 60 * 1000;
/** America/New_York offsets a zone-less wall-clock value may have been rendered in, plus UTC. */
const WALL_CLOCK_OFFSETS_H = [0, 4, 5];

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
    name: 'file thumbnail_status polling',
    test: (e) => e.method === 'GET' && e.path === '/files'
      && Object.keys(e.query).every((k) => k === 'id' || k === 'select')
      && (e.query.select === undefined || e.query.select === 'thumbnail_status'),
  },
];

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

/** Parses an ISO-ish timestamp into candidate epoch-ms instants (several for zone-less wall-clock values). */
export function timestampInstants(text) {
  let s = text.replace(' ', 'T');
  const zoned = /(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(s);
  if (zoned) {
    let off = zoned[1];
    if (off !== 'Z') {
      if (/^[+-]\d{2}$/.test(off)) off += ':00';
      else if (/^[+-]\d{4}$/.test(off)) off = off.slice(0, 3) + ':' + off.slice(3);
      s = s.slice(0, zoned.index) + off;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? [t] : [];
  }
  const asUtc = Date.parse(s + 'Z');
  if (!Number.isFinite(asUtc)) return [];
  return WALL_CLOCK_OFFSETS_H.map((h) => asUtc + h * 3600 * 1000);
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
   */
  constructor({ registered, windows, foreignKeys = [] }) {
    this.registered = new Map();
    for (const { table, id } of registered) {
      if (!this.registered.has(table)) this.registered.set(table, new Set());
      this.registered.get(table).add(String(id));
    }
    this.fk = new Map();
    for (const { table_name, column_name, join_table } of foreignKeys) {
      if (!this.fk.has(table_name)) this.fk.set(table_name, new Map());
      this.fk.get(table_name).set(column_name, join_table);
    }
    this.windows = windows;
    this.uuidTokens = new Map();
    this.idTokens = new Map();
    /** When false, unseen values get a placeholder instead of a new numbered token (used for ordering keys). */
    this.assign = true;
  }

  uuidToken(raw) {
    const key = raw.toLowerCase();
    if (!this.assign) return this.uuidTokens.get(key) ?? '<uuid>';
    if (!this.uuidTokens.has(key)) this.uuidTokens.set(key, `<uuid:${this.uuidTokens.size + 1}>`);
    return this.uuidTokens.get(key);
  }

  isRegistered(table, id) {
    return !!table && !!this.registered.get(table)?.has(String(id));
  }

  /** Token for a created id of `table`; numbered per table by first appearance. */
  idToken(table, id) {
    if (!this.idTokens.has(table)) this.idTokens.set(table, new Map());
    const m = this.idTokens.get(table);
    const key = String(id);
    if (!this.assign) return m.get(key) ?? `<${table}>`;
    if (!m.has(key)) m.set(key, `<${table}:${m.size + 1}>`);
    return m.get(key);
  }

  /** Table a column's value refers to: the table itself for `id`, the FK target otherwise. */
  columnTable(table, column) {
    if (!table) return null;
    if (column === 'id') return table;
    return this.fk.get(table)?.get(column) ?? null;
  }

  /** Table of an RPC id parameter, from a sibling table parameter, the page's record, or a fixed map. */
  rpcParamTable(key, value, args, page) {
    for (const p of RPC_TABLE_PARAMS) {
      if (typeof args?.[p] === 'string' && /(_id|_ids)$/.test(key)) return args[p];
    }
    if (RPC_PARAM_TABLES[key]) return RPC_PARAM_TABLES[key];
    if (RPC_PAGE_ID_PARAMS.has(key) && page && String(value) === page.id) return page.table;
    return null;
  }

  inWindow(instants) {
    return instants.some((t) => this.windows.some(([a, b]) => t >= a - WINDOW_MARGIN_MS && t <= b + WINDOW_MARGIN_MS));
  }

  /** Masks JWTs, UUIDs and runtime timestamps inside a decoded string. */
  maskString(s) {
    return s
      .replace(JWT_RE, '<jwt>')
      .replace(UUID_RE, (m) => this.uuidToken(m))
      .replace(TS_RE, (m) => (this.inWindow(timestampInstants(m)) ? '<runtime-ts>' : m));
  }

  /** Same as maskString for a raw (possibly percent-encoded) URL fragment. */
  maskRawString(s) {
    return s
      .replace(JWT_RE, '<jwt>')
      .replace(UUID_RE, (m) => this.uuidToken(m))
      .replace(RAW_TS_RE, (m) => {
        const decoded = safeDecode(m.replace(/^(\d{4}-\d{2}-\d{2})\+/, '$1 '));
        return this.inWindow(timestampInstants(decoded)) ? '<runtime-ts>' : m;
      });
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
    let v = this.maskString(value);
    if (/(^|\.)(or|and)$/.test(name)) {
      v = this.maskConditions(name.includes('.') ? null : ctx.table, v);
    } else if (!name.includes('.')) {
      const t = ctx.rpc ? this.rpcParamTable(name, v.replace(/^[a-z]+\./, ''), {}, ctx.page) : this.columnTable(ctx.table, name);
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
        let table = null;
        if (ctx.rpc) {
          if (depth === 1) table = this.rpcParamTable(key, v, parent, ctx.page);
        } else if (depth <= 1) {
          table = this.columnTable(ctx.table, key);
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
      let v = this.maskRawString(seg.slice(eq + 1));
      if (/(^|\.)(or|and)$/.test(name)) {
        if (!name.includes('.') && ctx.table) {
          // Conditions may have encoded parens/commas; mask digits of any registered id of the referenced tables.
          for (const t of this.fk.get(ctx.table)?.values() ?? []) v = this.maskIdDigits(t, v, true);
          v = this.maskIdDigits(ctx.table, v, true);
        }
      } else if (!name.includes('.')) {
        const decoded = safeDecode(v.replace(/\+/g, ' '));
        const t = ctx.rpc ? this.rpcParamTable(name, decoded.replace(/^[a-z]+\./, ''), {}, ctx.page) : this.columnTable(ctx.table, name);
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
  const pathname = new URL(req.url).pathname;
  const page = pageRecord(req.frameUrl);
  if (pathname.startsWith('/rpc/')) return { rpc: pathname.slice('/rpc/'.length), page };
  return { table: safeDecode(pathname.replace(/^\//, '')), page };
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

  const status = req.failure ? `failed:${req.failure}` : req.status ?? null;
  const entry = { method: req.method, path, query, headers, body, status };
  const rawUrl = path + mctx.maskRawQuery(rawSearch(req.url), ctx);
  return { entry, raw: { url: rawUrl, body: rawBody } };
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

/**
 * Normalizes a whole run (array of raw flow recordings in run order) into
 * baseline documents, one per flow. Token numbering is global across the run
 * so an id created in one flow and used in a later flow keeps its token.
 *
 * @param rawFlows   raw recordings in run order
 * @param foreignKeys schema_properties rows with join_table (FK map), captured during the run
 */
export function normalizeRun(rawFlows, foreignKeys = []) {
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
  const mctx = new MaskContext({ registered, windows, foreignKeys });

  return rawFlows.map((f) => {
    const steps = [];
    for (const step of f.steps) {
      if (step.kind !== 'step') continue;
      const reqs = f.requests.filter((r) => r.step === step.name);
      steps.push(normalizeStep(step.name, reqs, mctx));
    }
    return { harness: HARNESS_VERSION, flow: f.test, steps };
  });
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
