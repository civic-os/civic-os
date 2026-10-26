/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * PostgREST access for the MCP server: core's fetch transport and DataClient
 * over a base URL and a bearer token. The only MCP-specific behavior kept here
 * is the PT503/503 to MaintenanceError mapping and the PostgRESTRequestError
 * the tools catch; requests, query strings and Content-Range parsing are core's.
 */

import {
  DataClient,
  DataClientError,
  TransportError,
  fetchTransport,
  DEFAULT_ERROR_MESSAGES,
  humanizeError,
  type ConstraintMessage,
  type CountedResponse,
  type DataQuery,
  type EditDataResult,
  type EntityData,
  type ErrorMessageOverrides,
  type Transport,
} from '@civic-os/core';

export interface PostgRESTClientConfig {
  /** PostgREST base URL (e.g., http://localhost:3000) */
  baseUrl: string;
  /** JWT token for Authorization header */
  token?: string;
  /** Replaces the fetch transport (tests only; the default sends over the network). */
  transport?: Transport;
}

/** Largest `limit` the MCP accepts on a read (consumer policy, Q-10; the app allows 1000 for calendars). */
export const MCP_MAX_LIMIT = 100;

/** Headers the MCP sends on every request, as before the move to core (core's fetch transport sends none of them by default). */
export const MCP_DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/** A transport that adds `defaults` to every request; headers a request sets itself win. */
function withDefaultHeaders(inner: Transport, defaults: Readonly<Record<string, string>>): Transport {
  return { request: req => inner.request({ ...req, headers: { ...defaults, ...req.headers } }) };
}

/** Text of the error thrown for a network failure. */
const NETWORK_ERROR_MESSAGE = 'Network error: unable to reach PostgREST. Check your connection and PostgREST URL.';

/**
 * Core's DataClient with every failure mapped to the MCP's error types
 * ({@link toRequestError}). Only the methods the tools use are wrapped; each
 * still issues its request synchronously.
 */
class McpDataClient extends DataClient {
  override getData(query: DataQuery): Promise<EntityData[]> {
    return mapped(super.getData(query));
  }

  override getDataWindow(query: DataQuery): Promise<CountedResponse<EntityData>> {
    return mapped(super.getDataWindow(query));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST payloads are untyped JSON.
  override createData(entity: string, data: unknown): Promise<any> {
    return mapped(super.createData(entity, data));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST payloads are untyped JSON.
  override editData(entity: string, id: string | number, data: any): Promise<EditDataResult> {
    return mapped(super.editData(entity, id, data));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST payloads are untyped JSON.
  override callRpc(functionName: string, params: Record<string, any>): Promise<any> {
    return mapped(super.callRpc(functionName, params));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST payloads are untyped JSON.
  override refreshCurrentUser(): Promise<any> {
    return mapped(super.refreshCurrentUser());
  }
}

function mapped<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    throw toRequestError(err);
  });
}

export class PostgRESTClient {
  private baseUrl: string;
  private token?: string;

  /**
   * Core transport over this client's base URL and current token. The core
   * clients (SchemaClient, DataClient) are built on it; the bearer token is sent
   * only to URLs under the base URL.
   */
  readonly transport: Transport;

  /** Core DataClient over {@link transport}; it rejects with {@link PostgRESTRequestError} or {@link MaintenanceError}. */
  readonly data: DataClient;

  constructor(config: PostgRESTClientConfig) {
    // Remove trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.transport = config.transport ?? withDefaultHeaders(
      fetchTransport({ apiUrl: this.baseUrl, getToken: () => this.token }),
      MCP_DEFAULT_HEADERS,
    );
    this.data = new McpDataClient({ transport: this.transport, apiUrl: this.baseUrl, maxLimit: MCP_MAX_LIMIT });
  }

  /** Update the JWT token (e.g., after refresh) */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * Every row of a table or view with the given `order` parameter and no
   * `select` (all columns), for the bootstrap reads of the schema cache.
   */
  getAll<T = unknown>(key: string, order: string): Promise<T[]> {
    // No `fields`: core then sends no select, so every column comes back (the DataQuery type requires the property).
    const query = { key, rawQueryParams: [`order=${order}`] } as unknown as DataQuery;
    return this.data.getData(query) as Promise<T[]>;
  }
}

/** Build the maintenance error from a PT503 body (the mode description is in `message`). */
function maintenanceError(message: string | undefined, hint: string | null | undefined): MaintenanceError {
  const mode = (message ?? '').includes('read-only') ? 'readonly' : 'full';
  return new MaintenanceError(mode, hint);
}

/**
 * Map a failure from a core client (SchemaClient, DataClient) to the MCP's error
 * types: PT503 on a 503 becomes {@link MaintenanceError} (the only MCP-specific
 * mapping), any other HTTP failure a {@link PostgRESTRequestError}, and a network
 * failure a {@link PostgRESTRequestError} with HTTP code 0. Anything else is
 * returned unchanged.
 */
export function toRequestError(err: unknown): unknown {
  if (err instanceof DataClientError) {
    if (err.status === 503 && err.shape.code === 'PT503') {
      return maintenanceError(err.shape.message, err.shape.hint);
    }
    // Only a JSON object body carries PostgREST fields; an empty, null, string or non-JSON (proxy HTML) body
    // gets the status message, and a JSON null in hint or details stays null, as the base client did.
    const body = err.body !== null && typeof err.body === 'object' && !Array.isArray(err.body)
      ? (err.body as { message?: string; code?: string; details?: string | null; hint?: string | null })
      : undefined;
    return new PostgRESTRequestError(
      body?.message ?? `PostgREST returned ${err.status}`,
      err.status,
      body?.code,
      body?.details,
      body?.hint,
    );
  }
  if (err instanceof TransportError) {
    return new PostgRESTRequestError(NETWORK_ERROR_MESSAGE, 0);
  }
  return err;
}

/** Maintenance mode error — thrown when PostgREST returns 503 with PT503 SQLSTATE */
export class MaintenanceError extends Error {
  constructor(
    public readonly mode: 'readonly' | 'full',
    public readonly hint?: string | null,
  ) {
    super(mode === 'full'
      ? 'System is in full maintenance mode. All operations are temporarily unavailable.'
      : 'System is in read-only maintenance mode. Read operations work but writes are blocked.');
    this.name = 'MaintenanceError';
  }
}

const PG_TYPE_NAMES: Record<string, string> = {
  integer: 'a whole number',
  numeric: 'a number',
  boolean: 'true or false',
  date: 'a date (YYYY-MM-DD)',
  timestamp: 'a date/time',
  uuid: 'a valid UUID',
};

/**
 * The MCP's own sentences for the error kinds where it keeps its wording (E-01,
 * E-06: cosmetic, per consumer). Everything else is core's default: the
 * constraint fallbacks end with the raw constraint name (E-03), and 23503 and
 * PGRST116 are friendly (F-17). An unrecognized error keeps the raw message
 * (E-04), since an LLM can act on it.
 */
export const MCP_ERROR_MESSAGES: ErrorMessageOverrides = {
  permission: 'Permission denied. You do not have access to perform this action.',
  unique: 'A record with these values already exists (duplicate).',
  invalidInput: ({ params, error }) =>
    params.expectedType === undefined
      ? `Invalid value format. ${error.message ?? ''}`.trimEnd()
      : `Invalid value — expected ${PG_TYPE_NAMES[params.expectedType] ?? `type "${params.expectedType}"`}. Check the value and try again.`,
  // E-01: the MCP keeps its base wording for a violation that names no constraint; a named one uses core's text (E-03).
  check: ctx => ctx.params.constraintName === undefined
    ? 'Invalid check constraint. Check the value and try again.'
    : (DEFAULT_ERROR_MESSAGES.check as (c: typeof ctx) => string)(ctx),
  notFound: 'Record not found.',
  sessionExpired: 'Authentication required. Your session may have expired.',
  system: ({ error }) => `Error: ${error.message ?? ''}`,
};

/** Structured error from PostgREST */
export class PostgRESTRequestError extends Error {
  constructor(
    message: string,
    public readonly httpCode: number,
    public readonly code?: string,
    public readonly details?: string | null,
    public readonly hint?: string | null,
  ) {
    super(message);
    this.name = 'PostgRESTRequestError';
  }

  /**
   * Convert a PostgreSQL/PostgREST error to a user-friendly message: classified
   * and worded by core, with the MCP's wording for the kinds in
   * {@link MCP_ERROR_MESSAGES}, and a configured constraint message winning for
   * a violated constraint.
   */
  toHumanMessage(constraintMessages?: ReadonlyArray<Pick<ConstraintMessage, 'constraint_name' | 'error_message'>>): string {
    return humanizeError(
      {
        httpCode: this.httpCode,
        code: this.code,
        details: this.details ?? undefined,
        message: this.message,
      },
      { constraintMessages, messages: MCP_ERROR_MESSAGES },
    );
  }
}
