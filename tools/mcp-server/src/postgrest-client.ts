/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Typed HTTP client for PostgREST.
 * Wraps native fetch with JWT auth, Content-Range parsing, ETag capture,
 * and structured error responses.
 */

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

  constructor(config: PostgRESTClientConfig) {
    // Remove trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
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
   * Supports If-Match header for ETag-based optimistic concurrency.
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

    // Capture ETag header
    const etag = response.headers.get('ETag') ?? undefined;

    if (!response.ok) {
      let errorBody: PostgRESTError | undefined;
      try {
        errorBody = (await response.json()) as PostgRESTError;
      } catch {
        // Response body wasn't JSON
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

    return { data, status: response.status, contentRange, etag };
  }

  private parseContentRange(header: string | null): ContentRange | undefined {
    if (!header) return undefined;
    // Format: "0-24/237" or "0-24/*"
    const match = header.match(/^(\d+)-(\d+)\/(\d+|\*)/);
    if (!match) return undefined;
    return {
      from: parseInt(match[1], 10),
      to: parseInt(match[2], 10),
      total: match[3] === '*' ? null : parseInt(match[3], 10),
    };
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
      return this.code === '23P01'
        ? 'This conflicts with an existing record. Please check your input and try again.'
        : `Validation failed: ${constraintMatch?.[1] ?? 'check constraint'}`;
    }

    if (this.httpCode === 0) return 'Network error. Please check your connection.';
    if (this.code === '42501') return 'Permission denied. You do not have access to perform this action.';
    if (this.code === '23505') return 'A record with these values already exists (duplicate).';
    if (this.httpCode === 404) return 'Record not found.';
    if (this.httpCode === 401) return 'Authentication required. Your session may have expired.';
    if (this.httpCode === 412) return 'This record has been modified since you last read it. Please fetch the latest version and try again.';
    if (this.code === 'P0001') return this.message; // Custom PL/pgSQL error — message is user-facing
    return `Error: ${this.message}`;
  }
}
