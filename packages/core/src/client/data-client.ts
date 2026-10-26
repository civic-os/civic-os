/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST payloads are untyped JSON, as in DataService. */

/**
 * DataClient: the core's PostgREST data access, over a {@link Transport}.
 *
 * It reproduces every request `src/app/services/data.service.ts`
 * made before the P1.3 ledger rows: method, URL (API base + path), explicit
 * headers and JSON body. Filter values and every `id=eq.<id>` / `col=eq.<value>`
 * value are URL-encoded through `encodeQueryValue` (ledger row F-01). It sets no `Content-Type` except for
 * the two bulk inserts (as DataService does); a transport adds
 * `application/json` for a body that has none (`fetchTransport` does).
 *
 * Every method calls `transport.request` synchronously, in the same tick as
 * the call: the Angular `fromCore()` helper depends on that to issue HTTP
 * inside `subscribe`. Methods resolve parsed JSON (an empty body is `null`)
 * and reject with {@link DataClientError} for a non-2xx status or an
 * unparsable 2xx body, and with `TransportError` for a network failure or
 * abort. They never build `ApiResponse` or human messages: that mapping, the
 * `HttpErrorResponse` handling and `console.error` fallbacks stay in the app.
 *
 * ## DataService to DataClient
 *
 * | DataService method | DataClient method | Stays in DataService |
 * |---|---|---|
 * | `getData(query)` | `getData(query)` | `ensureIdField` (in-place `fields.push('id')`) |
 * | `getDataPaginated(query)` | `getDataPaginated(query)` -> `{ data, totalCount: number \| null }` | `ensureIdField`; row-count fallback for a null total; `catchError` -> `{ data: [], totalCount: 0 }` |
 * | (none: the MCP's windowed read) | `getDataWindow(query)` -> `{ data, totalCount: number \| null }` | nothing (errors propagate) |
 * | `createData(entity, data)` | `createData(entity, data)` -> body | `ApiResponse` wrapping, `parseApiError` |
 * | `editData(entity, id, data)` | `editData(entity, id, data)` -> `{ body, check }` | on success use `check` (the `checkEditResult` result) as the `ApiResponse`; errors via `parseApiError` |
 * | `deleteData(entity, id)` | `deleteData(entity, id)` -> body | wrapping, analytics `trackEvent` |
 * | `refreshCurrentUser()` | `refreshCurrentUser()` -> body | wrapping |
 * | `getInverseRelationshipPreview(...)` | `getInverseRelationshipPreview(...)` -> `{ records, totalCount: number \| null }` | row-count fallback for a null total; `catchError` -> `{ records: [], totalCount: 0 }` |
 * | `getInverseRelationshipData(meta, id)` | (compose in the app from the preview) | whole method |
 * | `addManyToManyRelation(id, meta, target, extra)` | `addManyToManyRelation(...)` -> `null` | wrapping |
 * | `updateManyToManyRelation(...)` | `updateManyToManyRelation(...)` -> `null` | wrapping |
 * | `removeManyToManyRelation(...)` | `removeManyToManyRelation(...)` -> `null` | wrapping |
 * | `bulkInsert(entity, data)` | `bulkInsert(entity, data, { onUploadProgress })` -> body | percent = `round(loaded / (total \|\| loaded) * 100)`, interim `{ success: false, progress }` emissions |
 * | `bulkInsertJunctions(table, records)` | `bulkInsertJunctions(table, records)` -> `null` (no request when empty) | wrapping |
 * | `callRpc(fn, params)` | `callRpc(fn, params)` -> body | nothing (errors propagate) |
 * | `executeRpc(fn, params)` | `executeRpc(fn, params)` -> body | the `success: false` body normalization and wrapping |
 * | `transformManyToManyData` | `transformManyToManyData` (core export, unchanged) | static delegate |
 *
 * Error mapping: `DataClientError.shape` is `{ httpCode, code, details, hint,
 * message }` as `parseApiError` reads them from `evt.error` (`message` may be
 * undefined: the app falls back to `error.statusText`, then `'Unknown error'`).
 * A `TransportError` of kind `network` corresponds to `httpCode: 0`.
 */

import type { EntityData, ManyToManyMeta } from '../model/entity.js';
import type { CountedResponse, DataQuery } from '../model/query.js';
import { compileDataQuery, QueryValidationError } from '../query/compile.js';
import type { CompiledDataQuery } from '../query/compile.js';
import { checkEditResult } from '../query/compare.js';
import { encodeQueryValue } from '../query/encode.js';
import { parseContentRangeTotal } from '../query/response.js';
import type { AbortSignalLike, Transport, TransportRequest } from '../transport/types.js';
import { normalizeApiUrl, send } from './http.js';

/**
 * Options for {@link DataClient}.
 *
 * @consumer typed DataClient
 */
export interface DataClientOptions {
  transport: Transport;
  /** PostgREST base URL; a trailing `/` is added when missing. */
  apiUrl: string;
  /** Largest accepted `limit` / `pageSize` (consumer policy, Q-10); unset means no maximum. */
  maxLimit?: number;
}

/**
 * Per-call options.
 *
 * @consumer typed DataClient
 */
export interface DataRequestOptions {
  /** Aborting rejects the call with `TransportError` `kind: 'aborted'`. */
  signal?: AbortSignalLike;
}

/**
 * Options for {@link DataClient.bulkInsert}.
 *
 * @consumer typed DataClient
 */
export interface BulkInsertOptions extends DataRequestOptions {
  /** Forwarded to the transport unchanged; raw bytes, not a percentage. */
  onUploadProgress?: (loaded: number, total: number | undefined) => void;
}

/**
 * Result of {@link DataClient.editData}: the returned representation and the
 * `checkEditResult` verdict on it.
 *
 * @consumer mcp
 */
export interface EditDataResult {
  /** Parsed `Prefer: return=representation` body (an array of the updated rows). */
  body: any;
  /** `checkEditResult(data, { success: true, body })`: the `ApiResponse` DataService returns on success. */
  check: any;
}

/**
 * Result of {@link DataClient.getInverseRelationshipPreview}.
 *
 * @consumer typed DataClient
 */
export interface InversePreviewResult {
  records: EntityData[];
  /** Null when `Content-Range` carries no numeric total (Q-16); the consumer picks the fallback. */
  totalCount: number | null;
}

/**
 * What the M:M methods need from {@link ManyToManyMeta}.
 *
 * @consumer typed DataClient
 */
export type JunctionRef = Pick<ManyToManyMeta, 'junctionTable' | 'sourceColumn' | 'targetColumn'>;

/**
 * PostgREST data access over a {@link Transport}. See the module comment for
 * the request-parity contract and the DataService mapping table.
 *
 * @consumer app
 */
export class DataClient {
  private readonly transport: Transport;
  private readonly apiUrl: string;
  private readonly maxLimit?: number;

  constructor(options: DataClientOptions) {
    this.transport = options.transport;
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.maxLimit = options.maxLimit;
  }

  private request(
    method: TransportRequest['method'],
    path: string,
    extra: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignalLike; onUploadProgress?: TransportRequest['onUploadProgress'] } = {},
  ) {
    const req: TransportRequest = { method, url: this.apiUrl + path };
    if (extra.headers) req.headers = extra.headers;
    if (extra.body !== undefined) req.body = JSON.stringify(extra.body);
    if (extra.signal) req.signal = extra.signal;
    if (extra.onUploadProgress) req.onUploadProgress = extra.onUploadProgress;
    return send(this.transport, req);
  }

  /** Compiles a query; an invalid limit, offset or pagination rejects (never throws synchronously). */
  private compile(query: DataQuery, paginated: boolean, useRange = false): CompiledDataQuery | QueryValidationError {
    try {
      return compileDataQuery(query, { paginated, useRange, maxLimit: this.maxLimit });
    } catch (err) {
      if (err instanceof QueryValidationError) return err;
      throw err;
    }
  }

  /** `GET <key>?<compiled query>`; `Prefer: count=exact` only when `query.count` is set. Rejects with `QueryValidationError` for an invalid limit or offset. */
  getData(query: DataQuery, options: DataRequestOptions = {}): Promise<EntityData[]> {
    const compiled = this.compile(query, false);
    if (compiled instanceof QueryValidationError) return Promise.reject(compiled);
    const headers = Object.keys(compiled.headers).length > 0 ? { headers: compiled.headers } : {};
    return this.request('GET', compiled.path, { ...headers, ...options }).then(r => r.body as EntityData[]);
  }

  /**
   * Paginated read: `Range-Unit`, `Range` and `Prefer: count=exact` headers,
   * total from `Content-Range` via `parseContentRangeTotal` (null when the
   * response carries no numeric total; the consumer picks the fallback). A
   * null body gives `[]`. Rejects with `QueryValidationError` for a page or
   * page size that is not an integer >= 1.
   */
  getDataPaginated(query: DataQuery, options: DataRequestOptions = {}): Promise<CountedResponse<EntityData>> {
    const compiled = this.compile(query, true);
    if (compiled instanceof QueryValidationError) return Promise.reject(compiled);
    return this.request('GET', compiled.path, { headers: compiled.headers, ...options }).then(({ body, response }) => {
      const data = (body as EntityData[] | null) || [];
      return { data, totalCount: parseContentRangeTotal(response.headers['content-range']) };
    });
  }

  /**
   * Windowed read with a total (Q-02): `query.limit` / `query.offset` (default
   * 25 / 0) are sent as `Range-Unit` and `Range` headers, never as `limit=` /
   * `offset=`, and `Prefer: count=exact` is always sent. The total comes from
   * `Content-Range` via `parseContentRangeTotal` (null when the response
   * carries no numeric total, Q-16). A null body gives `[]`. A window past the
   * last row rejects with `DataClientError` status 416. Rejects with
   * `QueryValidationError` for a limit or offset that is not valid (Q-10).
   * This is the MCP transport policy; the app pages with {@link getDataPaginated}.
   */
  getDataWindow(query: DataQuery, options: DataRequestOptions = {}): Promise<CountedResponse<EntityData>> {
    const compiled = this.compile({ ...query, count: true }, false, true);
    if (compiled instanceof QueryValidationError) return Promise.reject(compiled);
    return this.request('GET', compiled.path, { headers: compiled.headers, ...options }).then(({ body, response }) => {
      const data = (body as EntityData[] | null) || [];
      return { data, totalCount: parseContentRangeTotal(response.headers['content-range']) };
    });
  }

  /** `POST <entity>` with `Prefer: return=representation`. */
  createData(entity: string, data: unknown, options: DataRequestOptions = {}): Promise<any> {
    return this.request('POST', entity, { headers: { Prefer: 'return=representation' }, body: data, ...options }).then(r => r.body);
  }

  /** `PATCH <entity>?id=eq.<id>` with `Prefer: return=representation` (id URL-encoded, F-01). */
  editData(entity: string, id: string | number, data: any, options: DataRequestOptions = {}): Promise<EditDataResult> {
    return this.request('PATCH', entity + '?id=eq.' + encodeQueryValue(id), { headers: { Prefer: 'return=representation' }, body: data, ...options }).then(
      ({ body }) => ({ body, check: checkEditResult(data, { success: true, body }) }),
    );
  }

  /** `DELETE <entity>?id=eq.<id>` (id URL-encoded, F-01). */
  deleteData(entity: string, id: string | number, options: DataRequestOptions = {}): Promise<any> {
    return this.request('DELETE', entity + '?id=eq.' + encodeQueryValue(id), options).then(r => r.body);
  }

  /** `POST rpc/refresh_current_user` with body `{}`. */
  refreshCurrentUser(options: DataRequestOptions = {}): Promise<any> {
    return this.request('POST', 'rpc/refresh_current_user', { body: {}, ...options }).then(r => r.body);
  }

  /**
   * Count-and-preview read for an inverse relationship (`Prefer: count=exact`).
   * `previewMode` picks the select list: `display_name` -> `id,display_name`,
   * `id` -> `id`, `count` -> the filter column with `limit=0`. The total comes
   * from `Content-Range` via `parseContentRangeTotal` (null when absent or not numeric).
   */
  getInverseRelationshipPreview(
    sourceTable: string,
    filterColumn: string,
    filterValue: unknown,
    limit = 5,
    previewMode: 'display_name' | 'id' | 'count' = 'display_name',
    options: DataRequestOptions = {},
  ): Promise<InversePreviewResult> {
    const select = previewMode === 'display_name' ? 'id,display_name' : previewMode === 'id' ? 'id' : filterColumn;
    const effectiveLimit = previewMode === 'count' ? 0 : limit;
    const path = `${sourceTable}?${filterColumn}=eq.${encodeQueryValue(filterValue)}&select=${select}&limit=${effectiveLimit}`;
    return this.request('GET', path, { headers: { Prefer: 'count=exact' }, ...options }).then(({ body, response }) => {
      const records = (body as EntityData[] | null) || [];
      return { records, totalCount: parseContentRangeTotal(response.headers['content-range']) };
    });
  }

  /** `POST <junctionTable>` with `{ [sourceColumn]: entityId, [targetColumn]: targetId, ...extraData }` and `Prefer: return=minimal`. */
  addManyToManyRelation(
    entityId: number | string,
    meta: JunctionRef,
    targetId: number | string,
    extraData?: Record<string, unknown>,
    options: DataRequestOptions = {},
  ): Promise<null> {
    const body = { [meta.sourceColumn]: entityId, [meta.targetColumn]: targetId, ...extraData };
    return this.request('POST', meta.junctionTable, { headers: { Prefer: 'return=minimal' }, body, ...options }).then(() => null);
  }

  /** `PATCH <junctionTable>?<source>=eq.<id>&<target>=eq.<id>` with `Prefer: return=minimal`. */
  updateManyToManyRelation(
    entityId: number | string,
    meta: JunctionRef,
    targetId: number | string,
    patchData: Record<string, unknown>,
    options: DataRequestOptions = {},
  ): Promise<null> {
    const filter = `${meta.sourceColumn}=eq.${encodeQueryValue(entityId)}&${meta.targetColumn}=eq.${encodeQueryValue(targetId)}`;
    return this.request('PATCH', meta.junctionTable + '?' + filter, { headers: { Prefer: 'return=minimal' }, body: patchData, ...options }).then(
      () => null,
    );
  }

  /** `DELETE <junctionTable>?<source>=eq.<id>&<target>=eq.<id>`. */
  removeManyToManyRelation(entityId: number | string, meta: JunctionRef, targetId: number | string, options: DataRequestOptions = {}): Promise<null> {
    const filter = `${meta.sourceColumn}=eq.${encodeQueryValue(entityId)}&${meta.targetColumn}=eq.${encodeQueryValue(targetId)}`;
    return this.request('DELETE', meta.junctionTable + '?' + filter, options).then(() => null);
  }

  /**
   * `POST <entity>` with an array body, `Content-Type: application/json` and
   * `Prefer: return=representation`. All-or-nothing on the server. Upload
   * progress is forwarded to the transport (raw loaded/total).
   */
  bulkInsert(entity: string, data: unknown[], options: BulkInsertOptions = {}): Promise<any> {
    return this.request('POST', entity, {
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: data,
      ...options,
    }).then(r => r.body);
  }

  /** `POST <junctionTable>` with an array body and `Prefer: return=minimal`; an empty array sends nothing and resolves `null`. */
  bulkInsertJunctions(junctionTable: string, records: Record<string, any>[], options: DataRequestOptions = {}): Promise<null> {
    if (records.length === 0) {
      return Promise.resolve(null);
    }
    return this.request('POST', junctionTable, {
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: records,
      ...options,
    }).then(() => null);
  }

  /** `POST rpc/<functionName>` with `params` as the JSON body and no extra headers. */
  callRpc(functionName: string, params: Record<string, any>, options: DataRequestOptions = {}): Promise<any> {
    return this.request('POST', 'rpc/' + functionName, { body: params, ...options }).then(r => r.body);
  }

  /**
   * Same request as {@link callRpc}. DataService's `executeRpc` differs only in
   * how it wraps the result (`success: false` bodies become errors), which
   * stays in the app.
   */
  executeRpc(functionName: string, params: Record<string, any>, options: DataRequestOptions = {}): Promise<any> {
    return this.callRpc(functionName, params, options);
  }
}
