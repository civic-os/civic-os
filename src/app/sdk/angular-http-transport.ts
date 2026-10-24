/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { HttpClient, HttpErrorResponse, HttpEvent, HttpEventType, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { TransportError } from '@civic-os/core';
import type { Transport, TransportRequest, TransportResponse } from '@civic-os/core';

/**
 * Original `HttpErrorResponse` behind a resolved error `TransportResponse`,
 * keyed by that response's `headers` object (core's `DataClientError` keeps the
 * same object as its own `headers`). Lets the app hand legacy callers the very
 * error HttpClient produced; see `legacy-error.ts`.
 */
const originalErrors = new WeakMap<object, HttpErrorResponse>();

/** The `HttpErrorResponse` a resolved error response came from, if it came from this transport. */
export function originalHttpError(headers: object): HttpErrorResponse | undefined {
  return originalErrors.get(headers);
}

function lowercaseHeaders(headers: HttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of headers.keys()) {
    const values = headers.getAll(name);
    if (values) out[name.toLowerCase()] = values.join(', ');
  }
  return out;
}

/** Raw text of an `HttpErrorResponse` body, as the core expects it (JSON text when HttpClient parsed it). */
function errorText(err: HttpErrorResponse): string {
  const body: unknown = err.error;
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  // A 2xx response whose body failed HttpClient's JSON parse carries the raw text.
  if (err.status >= 200 && err.status < 300 && typeof (body as { text?: unknown }).text === 'string') {
    return (body as { text: string }).text;
  }
  try {
    return JSON.stringify(body) ?? '';
  } catch {
    return '';
  }
}

function toTransportResponse(res: HttpResponse<unknown>): TransportResponse {
  const body = res.body;
  return {
    status: res.status,
    statusText: res.statusText,
    headers: lowercaseHeaders(res.headers),
    text: body === null || body === undefined ? '' : (JSON.stringify(body) ?? ''),
  };
}

/**
 * The core `Transport` over Angular's `HttpClient`, so the existing interceptor
 * chain (bearer token, impersonation, locale, maintenance, auth-error, error
 * tracking) applies to every core request exactly as it does to a direct
 * `HttpClient` call.
 *
 * - `request()` subscribes to HttpClient synchronously, so an
 *   `HttpTestingController` (or the network) sees the request in the same tick.
 * - Core hands the body over as JSON text; it is parsed back to a value before
 *   it reaches HttpClient, which then serializes it and sets
 *   `Content-Type: application/json` itself (a string body would be sent as
 *   `text/plain`, which PostgREST rejects with 415). HttpClient's default
 *   `Accept` is kept.
 * - The response is read with `responseType: 'json'`, not `'text'`: the
 *   interceptors that run after the response (maintenance detection reads
 *   `error.error.hint`, error tracking reads `error.error.code`) expect a
 *   parsed error body, as they get today. The parsed value is serialized back
 *   to the text core parses again, which yields an equal value.
 * - A non-2xx response resolves (`status`, lowercased `headers`, `text`);
 *   status 0 and any non-HTTP failure reject with `TransportError` `network`
 *   (the original error is the `cause`). Aborting the `signal` unsubscribes,
 *   which cancels the request, and rejects with `TransportError` `aborted`.
 * - Upload progress events go to `onUploadProgress`.
 */
export function angularHttpTransport(http: HttpClient): Transport {
  return {
    request(req: TransportRequest): Promise<TransportResponse> {
      return new Promise<TransportResponse>((resolve, reject) => {
        const signal = req.signal;
        if (signal?.aborted) {
          reject(new TransportError('aborted'));
          return;
        }

        const body: unknown = req.body === undefined ? undefined : JSON.parse(req.body);
        const headers = req.headers;
        let settled = false;
        let onAbort: (() => void) | undefined;

        const settle = () => {
          settled = true;
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        };

        const events$: Observable<HttpEvent<unknown>> = req.onUploadProgress
          ? http.request<unknown>(req.method, req.url, { body, headers, observe: 'events', reportProgress: true, responseType: 'json' })
          : http.request<unknown>(req.method, req.url, { body, headers, observe: 'response', responseType: 'json' });

        const subscription = events$.subscribe({
          next: event => {
            if (event.type === HttpEventType.UploadProgress) {
              req.onUploadProgress?.(event.loaded, event.total);
            } else if (event.type === HttpEventType.Response) {
              settle();
              resolve(toTransportResponse(event));
            }
          },
          error: (err: unknown) => {
            settle();
            if (err instanceof HttpErrorResponse && err.status !== 0) {
              const response: TransportResponse = {
                status: err.status,
                statusText: err.statusText,
                headers: lowercaseHeaders(err.headers),
                text: errorText(err),
              };
              originalErrors.set(response.headers, err);
              resolve(response);
            } else {
              reject(new TransportError('network', err instanceof Error ? err.message : undefined, { cause: err }));
            }
          },
        });

        if (signal && !settled) {
          onAbort = () => {
            if (settled) return;
            settled = true;
            subscription.unsubscribe();
            reject(new TransportError('aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },
  };
}
