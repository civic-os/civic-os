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

import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { DataClientError, TransportError } from '@civic-os/core';
import { originalHttpError } from './angular-http-transport';

/**
 * Maps an error from a core call back to the error `HttpClient` itself would
 * have produced, so the app's existing handling (`parseApiError`, the
 * `console.error` fallbacks, callers that read `err.status` or `err.error`)
 * sees the same value as before the core took over the I/O.
 *
 * - `DataClientError`: the original `HttpErrorResponse` when the request went
 *   through `angularHttpTransport`; otherwise an equivalent one is rebuilt from
 *   the status, status text, headers and parsed body.
 * - `TransportError` `network`: its `cause`, which is the original
 *   `HttpErrorResponse` (status 0) or whatever an interceptor threw.
 * - anything else (an abort, a programming error) is returned unchanged.
 */
export function toLegacyError(err: unknown): unknown {
  if (err instanceof DataClientError) {
    const original = originalHttpError(err.headers);
    if (original) return original;
    return new HttpErrorResponse({
      error: err.kind === 'parse' ? { error: undefined, text: err.text } : (err.body !== undefined ? err.body : err.text || null),
      status: err.status,
      statusText: err.statusText ?? '',
      headers: new HttpHeaders(err.headers),
    });
  }
  if (err instanceof TransportError && err.kind === 'network') {
    return err.cause ?? err;
  }
  return err;
}
