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
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { NotificationService } from './notification.service';
import { AuthService } from './auth.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let httpMock: HttpTestingController;
  let currentUserId: string | null;

  beforeEach(() => {
    currentUserId = '11111111-1111-1111-1111-111111111111';

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { getCurrentUserId: () => of(currentUserId) } },
        NotificationService
      ]
    });

    service = TestBed.inject(NotificationService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('updatePreference', () => {
    it('should filter the PATCH by the current user as well as the channel', () => {
      let result: any;
      service.updatePreference('email', false).subscribe(r => (result = r));

      const req = httpMock.expectOne(r => r.url.includes('notification_preferences'));
      expect(req.request.method).toBe('PATCH');
      expect(req.request.url).toContain('channel=eq.email');
      expect(req.request.url).toContain('user_id=eq.11111111-1111-1111-1111-111111111111');
      expect(req.request.body).toEqual({ enabled: false });
      req.flush([{ channel: 'email', enabled: false }]);

      expect(result.success).toBe(true);
    });

    it('should not send a request when there is no authenticated user', () => {
      currentUserId = null;
      let result: any;
      service.updatePreference('sms', true).subscribe(r => (result = r));

      httpMock.expectNone(r => r.url.includes('notification_preferences'));
      expect(result.success).toBe(false);
    });
  });
});
