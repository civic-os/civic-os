/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

import { HttpTestingController } from '@angular/common/http/testing';

/**
 * Helper to expect a PostgREST request and flush a response.
 *
 * @param httpMock - The HttpTestingController from Angular's testing module
 * @param path - The path segment to match in the request URL (e.g., 'schema_entities' or 'Issue')
 * @param responseData - The data to return in the response
 * @returns The matched HttpRequest for further assertions
 */
export function expectPostgrestRequest(
  httpMock: HttpTestingController,
  path: string,
  responseData: any
) {
  const req = httpMock.expectOne(req => req.url.includes(path));
  req.flush(responseData);
  return req;
}

/**
 * Helper to expect a PostgREST request with specific query parameters.
 *
 * @param httpMock - The HttpTestingController
 * @param path - The base path (e.g., 'Issue')
 * @param params - Object of query parameters to match (e.g., { select: 'id,name', order: 'id.asc' })
 * @param responseData - The data to return
 */
export function expectPostgrestRequestWithParams(
  httpMock: HttpTestingController,
  path: string,
  params: Record<string, string>,
  responseData: any
) {
  const req = httpMock.expectOne(req => {
    if (!req.url.includes(path)) return false;

    // Check all expected params are present
    return Object.entries(params).every(([key, value]) => {
      return req.url.includes(`${key}=${value}`);
    });
  });

  req.flush(responseData);
  return req;
}

/**
 * Helper to flush the schema_m2m_properties request with empty data.
 * Required because getProperties() uses combineLatest with this VIEW,
 * so it won't emit until the M:M metadata request completes.
 * Most tests don't need M:M metadata — call this after flushing schema_properties.
 *
 * @since v0.46.0
 */
export function flushM2mMetadata(httpMock: HttpTestingController, data: any[] = []) {
  const reqs = httpMock.match(req => req.url.includes('schema_m2m_properties'));
  reqs.forEach(req => req.flush(data));
}

/**
 * Verifies no outstanding HTTP requests remain.
 * Call this in afterEach() to ensure clean test state.
 */
export function verifyNoOutstandingRequests(httpMock: HttpTestingController) {
  httpMock.verify();
}
