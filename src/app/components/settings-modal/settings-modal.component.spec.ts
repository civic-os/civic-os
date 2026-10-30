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
import { provideZonelessChangeDetection, signal, WritableSignal } from '@angular/core';
import { of } from 'rxjs';
import { SettingsModalComponent } from './settings-modal.component';
import { AnalyticsService } from '../../services/analytics.service';
import { NotificationService } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { ImpersonationService } from '../../services/impersonation.service';
import { PermissionsService } from '../../services/permissions.service';
import { ConfigService } from '../../services/config.service';
import { LocaleService } from '../../services/locale.service';
import { PwaService } from '../../services/pwa.service';
import { provideTranslationTesting } from '../../testing/translation-testing';

describe('SettingsModalComponent analyticsConfigured', () => {
  let matomoEnabled: WritableSignal<boolean>;

  function create(): SettingsModalComponent {
    matomoEnabled = signal(true);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslationTesting(),
        { provide: AnalyticsService, useValue: { getUserPreference: () => true, setEnabled: vi.fn() } },
        { provide: NotificationService, useValue: { getUserPreferences: () => of([]) } },
        { provide: AuthService, useValue: { isRealAdmin: () => false, authenticated: signal(false) } },
        { provide: ImpersonationService, useValue: {} },
        { provide: PermissionsService, useValue: {} },
        { provide: LocaleService, useValue: {} },
        { provide: PwaService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            appTitle: signal('Civic OS'),
            pwaAppName: signal('Civic OS'),
            smsConfigured: signal(false),
            matomoEnabled
          }
        }
      ]
    });
    return TestBed.createComponent(SettingsModalComponent).componentInstance;
  }

  beforeEach(() => {
    (window as any).civicOsConfig = { matomo: { url: 'https://stats.example.org', siteId: '7', enabled: true } };
  });

  afterEach(() => {
    delete (window as any).civicOsConfig;
  });

  it('is true when Matomo is configured and enabled', () => {
    expect(create().analyticsConfigured()).toBe(true);
  });

  it('is false when the instance has turned analytics off', () => {
    const component = create();
    matomoEnabled.set(false);
    expect(component.analyticsConfigured()).toBe(false);
  });

  it('is false when Matomo is not configured at all', () => {
    (window as any).civicOsConfig = { matomo: { url: '', siteId: '', enabled: true } };
    const component = create();
    expect(component.analyticsConfigured()).toBe(false);
  });
});
