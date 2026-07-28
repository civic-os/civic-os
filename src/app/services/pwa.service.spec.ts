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
import { SwUpdate } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { PwaService } from './pwa.service';

describe('PwaService', () => {
  let service: PwaService;
  let mockSwUpdate: { isEnabled: boolean; versionUpdates: Subject<any> };

  beforeEach(() => {
    mockSwUpdate = {
      isEnabled: false,
      versionUpdates: new Subject()
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SwUpdate, useValue: mockSwUpdate }
      ]
    });
    service = TestBed.inject(PwaService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should track online status', () => {
    expect(service.isOnline()).toBeTrue();
  });

  it('should not show install banner by default', () => {
    expect(service.showInstallBanner()).toBeFalse();
  });

  it('should not show install in settings by default', () => {
    expect(service.showInstallInSettings()).toBeFalse();
  });

  it('should not have update available by default', () => {
    expect(service.updateAvailable()).toBeFalse();
  });

  it('should update online status on offline event', () => {
    window.dispatchEvent(new Event('offline'));
    expect(service.isOnline()).toBeFalse();

    window.dispatchEvent(new Event('online'));
    expect(service.isOnline()).toBeTrue();
  });

  it('should dismiss install banner and persist to localStorage', () => {
    service.dismissInstallBanner();
    expect(service.installDismissed()).toBeTrue();
    expect(localStorage.getItem('civic-os-pwa-install-dismissed')).toBe('true');
  });

  afterEach(() => {
    localStorage.removeItem('civic-os-pwa-install-dismissed');
  });
});
