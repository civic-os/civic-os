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

import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { maintenanceInterceptor } from './maintenance.interceptor';
import { MaintenanceService } from '../services/maintenance.service';
import { getPostgrestUrl } from '../config/runtime';

describe('maintenanceInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let mockMaintenanceService: any;

  beforeEach(() => {
    mockMaintenanceService = {
      updateFromHeader: vi.fn().mockName('MaintenanceService.updateFromHeader'),
      updateFromError: vi.fn().mockName('MaintenanceService.updateFromError'),
      clearFromInterceptor: vi.fn().mockName('MaintenanceService.clearFromInterceptor'),
      isActive: vi.fn().mockReturnValue(false).mockName('MaintenanceService.isActive')
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr(), withInterceptors([maintenanceInterceptor])),
        provideHttpClientTesting(),
        { provide: MaintenanceService, useValue: mockMaintenanceService }
      ]
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should call updateFromHeader when PostgREST response has X-Maintenance-Mode header', () => {
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe();

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush([], {
      headers: { 'X-Maintenance-Mode': 'readonly' }
    });

    expect(mockMaintenanceService.updateFromHeader).toHaveBeenCalledWith('readonly');
  });

  it('should call updateFromHeader with admin bypass header', () => {
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe();

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush([], {
      headers: { 'X-Maintenance-Mode': 'readonly-admin' }
    });

    expect(mockMaintenanceService.updateFromHeader).toHaveBeenCalledWith('readonly-admin');
  });

  it('should call updateFromError on 503 from PostgREST', () => {
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe({
      error: () => { }
    });

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush({ message: 'Service Unavailable' }, { status: 503, statusText: 'Service Unavailable' });

    expect(mockMaintenanceService.updateFromError).toHaveBeenCalled();
  });

  it('should not call updateFromHeader when response has no maintenance header', () => {
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe();

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush([{ id: 1 }]);

    expect(mockMaintenanceService.updateFromHeader).not.toHaveBeenCalled();
  });

  it('should call clearFromInterceptor when response has no header and service is active', () => {
    mockMaintenanceService.isActive.mockReturnValue(true);

    http.get(`${getPostgrestUrl()}schema_entities`).subscribe();

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush([{ id: 1 }]);

    expect(mockMaintenanceService.clearFromInterceptor).toHaveBeenCalled();
  });

  it('should not call clearFromInterceptor when response has no header and service is not active', () => {
    mockMaintenanceService.isActive.mockReturnValue(false);

    http.get(`${getPostgrestUrl()}schema_entities`).subscribe();

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush([{ id: 1 }]);

    expect(mockMaintenanceService.clearFromInterceptor).not.toHaveBeenCalled();
  });

  it('should not call updateFromError on non-503 errors', () => {
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe({
      error: () => { }
    });

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });

    expect(mockMaintenanceService.updateFromError).not.toHaveBeenCalled();
  });

  it('should not inspect non-PostgREST requests', () => {
    http.get('https://api.example.com/data').subscribe();

    const req = httpMock.expectOne('https://api.example.com/data');
    req.flush([], {
      headers: { 'X-Maintenance-Mode': 'full' }
    });

    expect(mockMaintenanceService.updateFromHeader).not.toHaveBeenCalled();
  });

  it('should pass through successful responses without modification', () => {
    let responseData: unknown;
    http.get(`${getPostgrestUrl()}schema_entities`).subscribe({
      next: (data) => { responseData = data; }
    });

    const req = httpMock.expectOne(`${getPostgrestUrl()}schema_entities`);
    req.flush([{ id: 1, name: 'test' }]);

    expect(responseData).toEqual([{ id: 1, name: 'test' }]);
  });
});
