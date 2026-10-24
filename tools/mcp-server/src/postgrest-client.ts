/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Typed HTTP client for PostgREST.
 * Wraps native fetch with JWT auth, Content-Range parsing,
 * and structured error responses.
 */

import { DataClientError, TransportError, fetchTransport, type Transport } from '@civic-os/core';
import type { ContentRange, PostgRESTError, PostgRESTResponse } from './interfaces.js';

export interface PostgRESTClientConfig {
  /** PostgREST base URL (e.g., http://localhost:3000) */
  baseUrl: string;
  /** JWT token for Authorization header */
  token?: string;
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

  constructor(config: PostgRESTClientConfig) {
    // Remove trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.transport = fetchTransport({ apiUrl: this.baseUrl, getToken: () => this.token });
  }

  /** Update the JWT token (e.g., after refresh) */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * GET request — fetch data from a table or view.
   * Supports select, filters, ordering, pagination via query params.
   */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<PostgRESTResponse<T>> {
    const url = this.buildUrl(path, params);
    return this.request<T>('GET', url, undefined, headers);
  }

  /**
   * POST request — insert a record or call an RPC.
   */
  async post<T = unknown>(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<PostgRESTResponse<T>> {
    const url = this.buildUrl(path);
    return this.request<T>('POST', url, body, headers);
  }

  /**
   * PATCH request — update a record.
   */
  async patch<T = unknown>(
    path: string,
    body: unknown,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<PostgRESTResponse<T>> {
    const url = this.buildUrl(path, params);
    return this.request<T>('PATCH', url, body, headers);
  }

  /**
   * DELETE request — delete a record.
   */
  async delete<T = unknown>(
    path: string,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<PostgRESTResponse<T>> {
    const url = this.buildUrl(path, params);
    return this.request<T>('DELETE', url, undefined, headers);
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<PostgRESTResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new PostgRESTRequestError(
        'Network error: unable to reach PostgREST. Check your connection and PostgREST URL.',
        0,
      );
    }

    // Parse Content-Range header if present
    const contentRange = this.parseContentRange(response.headers.get('Content-Range'));

    if (!response.ok) {
      let errorBody: PostgRESTError | undefined;
      try {
        errorBody = (await response.json()) as PostgRESTError;
      } catch {
        // Response body wasn't JSON
      }

      // Maintenance mode detection: PT503 is the specific SQLSTATE set by check_jwt()
      // check_jwt() puts the mode description in `message` (hint is null)
      if (response.status === 503 && errorBody?.code === 'PT503') {
        throw maintenanceError(errorBody.message, errorBody.hint);
      }

      throw new PostgRESTRequestError(
        errorBody?.message ?? `PostgREST returned ${response.status}`,
        response.status,
        errorBody?.code,
        errorBody?.details,
        errorBody?.hint,
      );
    }

    // Parse response body
    let data: T;
    const contentType = response.headers.get('Content-Type') ?? '';
    if (response.status === 204 || !contentType.includes('json')) {
      data = (undefined as unknown) as T;
    } else {
      data = (await response.json()) as T;
    }

    return { data, status: response.status, contentRange };
  }

  private parseContentRange(header: string | null): ContentRange | undefined {
    if (!header) return undefined;
    // Formats: "0-24/237", "0-24/*", and "*/0" (PostgREST's empty range).
    // The total is read from the end of the header, as the frontend's DataService
    // does, so "*/0" yields 0 and trailing garbage ("0-9/12abc") yields nothing.
    const totalMatch = header.match(/\/(\d+|\*)$/);
    if (!totalMatch) return undefined;
    const rangeMatch = header.match(/^(\d+)-(\d+)\//);
    return {
      from: rangeMatch ? parseInt(rangeMatch[1], 10) : null,
      to: rangeMatch ? parseInt(rangeMatch[2], 10) : null,
      total: totalMatch[1] === '*' ? null : parseInt(totalMatch[1], 10),
    };
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
    return new PostgRESTRequestError(
      err.shape.message ?? `PostgREST returned ${err.status}`,
      err.status,
      err.shape.code,
      err.shape.details,
      err.shape.hint,
    );
  }
  if (err instanceof TransportError) {
    return new PostgRESTRequestError(
      'Network error: unable to reach PostgREST. Check your connection and PostgREST URL.',
      0,
    );
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

  /** Convert PostgreSQL/PostgREST error to user-friendly message */
  toHumanMessage(constraintMessages?: Array<{ constraint_name: string; error_message: string }>): string {
    // Constraint violations with lookup
    if (this.code === '23514' || this.code === '23P01') {
      const constraintMatch = this.details?.match(/constraint "([^"]+)"/) ?? this.message.match(/constraint "([^"]+)"/);
      if (constraintMatch?.[1] && constraintMessages) {
        const entry = constraintMessages.find(cm => cm.constraint_name === constraintMatch[1]);
        if (entry) return entry.error_message;
      }
      if (this.code === '23P01') {
        return 'This conflicts with an existing record. Please check your input and try again.';
      }
      // Humanize constraint name: "email_address_check" → "Invalid email address"
      const constraintName = constraintMatch?.[1] ?? 'check constraint';
      const humanized = constraintName
        .replace(/_check$/, '')
        .replace(/_/g, ' ');
      return `Invalid ${humanized}. Check the value and try again.`;
    }

    if (this.httpCode === 0) return 'Network error. Please check your connection.';
    if (this.code === '42501') return 'Permission denied. You do not have access to perform this action.';
    if (this.code === '23505') return 'A record with these values already exists (duplicate).';
    if (this.code === '23502') {
      // Not-null violation — extract column name from message
      const colMatch = this.message.match(/column "([^"]+)"/);
      return colMatch
        ? `Required field "${colMatch[1]}" is missing.`
        : 'A required field is missing.';
    }
    if (this.code === '22P02') {
      // Invalid input syntax — make the type error more readable
      const typeMatch = this.message.match(/invalid input syntax for type (\w+)/);
      if (typeMatch) {
        const pgType = typeMatch[1];
        const friendlyType: Record<string, string> = {
          integer: 'a whole number', numeric: 'a number', boolean: 'true or false',
          date: 'a date (YYYY-MM-DD)', timestamp: 'a date/time', uuid: 'a valid UUID',
        };
        return `Invalid value — expected ${friendlyType[pgType] ?? `type "${pgType}"`}. Check the value and try again.`;
      }
      return `Invalid value format. ${this.message}`;
    }
    // Date/time format errors (22007 = invalid format, 22008 = field overflow like month 13)
    if (this.code === '22007' || this.code === '22008') {
      return 'Invalid date format. Use YYYY-MM-DD for dates or YYYY-MM-DDTHH:MM:SS for timestamps.';
    }
    if (this.httpCode === 404) return 'Record not found.';
    if (this.httpCode === 401) return 'Authentication required. Your session may have expired.';
    if (this.httpCode === 412) return 'This record has been modified since you last read it. Please fetch the latest version and try again.';
    if (this.code === 'P0001') return this.message; // Custom PL/pgSQL error — message is user-facing
    return `Error: ${this.message}`;
  }
}
