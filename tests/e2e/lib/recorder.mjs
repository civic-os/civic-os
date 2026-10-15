/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Passive network recorder. Listens to context-level request events (no
 * routing of recorded origins), attributes every request to the step that was
 * active when it started, and tracks in-flight requests so a step can wait for
 * the app to go quiet before it ends.
 */

import { classify } from './normalize.mjs';
import { ALLOWED_ORIGINS, QUIET_IDLE_MS, QUIET_TIMEOUT_MS } from './config.mjs';

/** Requests that never settle the page and must not hold a step open. */
const QUIET_IGNORE = [
  (u) => u.pathname === '/maintenance.json',
  (u) => u.pathname.startsWith('/@vite') || u.pathname.startsWith('/@fs') || u.pathname.includes('__vite'),
  (u) => u.protocol === 'ws:' || u.protocol === 'wss:',
];

function isAllowed(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
    return ALLOWED_ORIGINS.includes(u.origin);
  } catch {
    return false;
  }
}

export class Recorder {
  constructor({ example, file, test, clockT0 }) {
    this.example = example;
    this.file = file;
    this.test = test;
    this.clockT0 = clockT0;
    this.realStart = Date.now();
    this.realEnd = null;
    this.steps = [];
    this.requests = [];
    this.registered = [];
    this.currentStep = '(before first step)';
    this.currentKind = 'pre';
    /** Name of the last step that ended; requests in the gap after it carry it as afterStep. */
    this.lastStep = null;
    this.seq = 0;
    this.inflight = new Map();
    this.lastActivity = Date.now();
    this.pending = new Set();
    this.byRequest = new Map();
  }

  /** Blocks every origin outside the local stack (Matomo, tiles, fonts, Stripe, YouTube). */
  static async blockThirdParties(context) {
    await context.route((url) => !isAllowed(url.toString()), (route) => route.abort('blockedbyclient'));
  }

  attach(context) {
    context.on('request', (req) => this.onRequest(req));
    context.on('requestfinished', (req) => this.track(this.onFinished(req, null)));
    context.on('requestfailed', (req) => this.track(this.onFinished(req, req.failure()?.errorText || 'failed')));
  }

  track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
  }

  beginStep(name, kind = 'step') {
    if (this.steps.some((s) => s.name === name)) throw new Error(`Duplicate step name in flow "${this.test}": ${name}`);
    this.steps.push({ name, kind });
    this.currentStep = name;
    this.currentKind = kind;
  }

  endStep() {
    this.lastStep = this.currentStep;
    this.currentStep = '(between steps)';
    this.currentKind = 'gap';
  }

  /** Explicitly registers ids of `table` created on the flow's behalf (API setup, worker expansion). */
  registerIds(table, ids) {
    this.registered.push({ step: this.currentStep, table, ids: ids.map(String) });
  }

  onRequest(req) {
    const url = req.url();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const kind = classify(url);
    const quietRelevant = isAllowed(url) && !QUIET_IGNORE.some((f) => f(parsed)) && parsed.protocol.startsWith('http');
    if (quietRelevant) {
      this.inflight.set(req, url);
      this.lastActivity = Date.now();
    }
    if (kind === 'other') return;
    // MinIO: only API traffic (presigned PUT/GET via XHR/fetch), not <img> loads whose timing is rendering-dependent.
    if (kind === 'minio' && !['xhr', 'fetch'].includes(req.resourceType())) return;
    const rec = {
      seq: ++this.seq,
      step: this.currentStep,
      stepKind: this.currentKind,
      afterStep: this.currentKind === 'gap' ? this.lastStep : null,
      kind,
      method: req.method(),
      url,
      resourceType: req.resourceType(),
      headers: lowerKeys(req.headers()),
      frameUrl: frameUrlOf(req),
      postData: kind === 'postgrest' ? safePostData(req) : null,
      status: null,
      failure: null,
      createdIds: [],
    };
    this.requests.push(rec);
    this.byRequest.set(req, rec);
  }

  async onFinished(req, failure) {
    try {
      const rec = this.byRequest.get(req);
      if (rec) {
        if (failure) {
          rec.failure = failure;
        } else {
          const resp = await req.response();
          rec.status = resp ? resp.status() : null;
          if (rec.kind === 'postgrest' && rec.method === 'POST' && resp) {
            rec.createdIds = await extractCreatedIds(new URL(rec.url).pathname, resp);
          }
          // Headers as finally sent (includes headers added after the request event).
          try {
            rec.headers = lowerKeys(await req.allHeaders());
          } catch {
            /* keep request-time headers */
          }
        }
      }
    } finally {
      this.inflight.delete(req);
      this.lastActivity = Date.now();
    }
  }

  /** Resolves once nothing relevant is in flight and nothing new started for QUIET_IDLE_MS. */
  async waitForQuiet({ idleMs = QUIET_IDLE_MS, timeoutMs = QUIET_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await Promise.allSettled([...this.pending]);
      const idleFor = Date.now() - this.lastActivity;
      if (this.inflight.size === 0 && idleFor >= idleMs) return;
      if (Date.now() > deadline) {
        const stuck = [...this.inflight.values()].slice(0, 10).join('\n  ');
        throw new Error(`Step "${this.currentStep}" did not go quiet within ${timeoutMs} ms. In flight:\n  ${stuck}`);
      }
      await new Promise((r) => setTimeout(r, Math.max(50, Math.min(200, idleMs - idleFor))));
    }
  }

  toJSON() {
    return {
      version: 1,
      example: this.example,
      file: this.file,
      test: this.test,
      clockT0: this.clockT0,
      realStart: this.realStart,
      realEnd: this.realEnd ?? Date.now(),
      steps: this.steps,
      registered: this.registered,
      requests: this.requests.map(({ seq, step, stepKind, afterStep, kind, method, url, resourceType, headers, frameUrl, postData, status, failure, createdIds }) => ({
        seq, step, stepKind, afterStep, kind, method, url, resourceType, headers, frameUrl, postData, status, failure, createdIds,
      })),
    };
  }
}

function lowerKeys(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
  return out;
}

function safePostData(req) {
  try {
    return req.postData();
  } catch {
    return '<binary>';
  }
}

function frameUrlOf(req) {
  try {
    return req.frame().url();
  } catch {
    return null;
  }
}

/**
 * RPCs that create rows, with the table of each id field in their result.
 * Only these (plus plain table inserts) register ids for masking: registering
 * ids from read RPCs would tokenize seed ids and could hide a changed value.
 */
export const CREATING_RPCS = {
  create_recurring_series: { group_id: 'time_slot_series_groups', series_id: 'time_slot_series' },
  split_series_from_date: { new_series_id: 'time_slot_series', group_id: 'time_slot_series_groups' },
};

function isIntLike(v) {
  return Number.isInteger(v) || (typeof v === 'string' && /^\d+$/.test(v));
}

/**
 * Ids of rows a POST created, as { table, id }: the `id` of rows returned by a
 * table insert (Prefer: return=representation), and the mapped result fields
 * of an allowlisted creating RPC.
 */
async function extractCreatedIds(pathname, resp) {
  const ct = resp.headers()['content-type'] || '';
  if (!/json/.test(ct) || resp.status() >= 300) return [];
  const rpc = pathname.startsWith('/rpc/') ? pathname.slice('/rpc/'.length) : null;
  if (rpc && !CREATING_RPCS[rpc]) return [];
  let body;
  try {
    body = JSON.parse(await resp.text());
  } catch {
    return [];
  }
  const rows = Array.isArray(body) ? body : [body];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (rpc) {
      for (const [field, table] of Object.entries(CREATING_RPCS[rpc])) {
        if (isIntLike(row[field])) out.push({ table, id: String(row[field]) });
      }
    } else if (isIntLike(row.id)) {
      out.push({ table: decodeURIComponent(pathname.slice(1)), id: String(row.id) });
    }
  }
  return out;
}
