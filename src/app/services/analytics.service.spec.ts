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

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AnalyticsService } from './analytics.service';
import { MatomoTracker } from 'ngx-matomo-client';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let mockTracker: jasmine.SpyObj<MatomoTracker>;
  let originalDoNotTrack: string | null;

  beforeEach(() => {
    // Save original DNT value
    originalDoNotTrack = navigator.doNotTrack;

    // Mock MatomoTracker
    mockTracker = jasmine.createSpyObj('MatomoTracker', [
      'trackPageView',
      'trackEvent',
      'setUserId',
      'resetUserId',
      'optUserOut',
      'forgetUserOptOut'
    ]);

    // Clear localStorage
    localStorage.clear();

    // Mock runtime configuration with Matomo enabled
    (window as any).civicOsConfig = {
      matomo: {
        url: 'https://stats.civic-os.org',
        siteId: '7',
        enabled: true
      }
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        AnalyticsService,
        { provide: MatomoTracker, useValue: mockTracker }
      ]
    });

    service = TestBed.inject(AnalyticsService);
  });

  afterEach(() => {
    // Restore original DNT value
    Object.defineProperty(navigator, 'doNotTrack', {
      value: originalDoNotTrack,
      configurable: true
    });

    // Clean up mock
    delete (window as any).civicOsConfig;
    localStorage.clear();
  });

  describe('Service Setup', () => {
    it('should be created', () => {
      expect(service).toBeTruthy();
    });
  });

  describe('isEnabled()', () => {
    it('should return true when all conditions are met', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when user has opted out', () => {
      localStorage.setItem('analytics_enabled', 'false');
      expect(service.isEnabled()).toBe(false);
    });

    it('should return false when browser DNT is set to "1"', () => {
      Object.defineProperty(navigator, 'doNotTrack', {
        value: '1',
        configurable: true
      });
      expect(service.isEnabled()).toBe(false);
    });

    it('should return true when localStorage is not set (defaults to enabled)', () => {
      localStorage.removeItem('analytics_enabled');
      expect(service.isEnabled()).toBe(true);
    });

    it('should return true when localStorage is explicitly set to "true"', () => {
      localStorage.setItem('analytics_enabled', 'true');
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('setEnabled()', () => {
    it('should set localStorage to "true" when enabling', () => {
      service.setEnabled(true);
      expect(localStorage.getItem('analytics_enabled')).toBe('true');
    });

    it('should set localStorage to "false" when disabling', () => {
      service.setEnabled(false);
      expect(localStorage.getItem('analytics_enabled')).toBe('false');
    });

    it('should call forgetUserOptOut() when enabling', () => {
      service.setEnabled(true);
      expect(mockTracker.forgetUserOptOut).toHaveBeenCalled();
    });

    it('should call optUserOut() when disabling', () => {
      service.setEnabled(false);
      expect(mockTracker.optUserOut).toHaveBeenCalled();
    });

  });

  describe('getUserPreference()', () => {
    it('should return true when localStorage is not set (defaults to enabled)', () => {
      localStorage.removeItem('analytics_enabled');
      expect(service.getUserPreference()).toBe(true);
    });

    it('should return true when localStorage is "true"', () => {
      localStorage.setItem('analytics_enabled', 'true');
      expect(service.getUserPreference()).toBe(true);
    });

    it('should return false when localStorage is "false"', () => {
      localStorage.setItem('analytics_enabled', 'false');
      expect(service.getUserPreference()).toBe(false);
    });
  });

  describe('trackPageView()', () => {
    it('should call tracker.trackPageView() when enabled', () => {
      service.trackPageView();
      expect(mockTracker.trackPageView).toHaveBeenCalled();
    });

    it('should call tracker.trackPageView() with custom title', () => {
      service.trackPageView('/issues');
      expect(mockTracker.trackPageView).toHaveBeenCalledWith('/issues');
    });

    it('should not call tracker when disabled (user opt-out)', () => {
      localStorage.setItem('analytics_enabled', 'false');
      service.trackPageView();
      expect(mockTracker.trackPageView).not.toHaveBeenCalled();
    });

    it('should not call tracker when DNT is set', () => {
      Object.defineProperty(navigator, 'doNotTrack', {
        value: '1',
        configurable: true
      });
      service.trackPageView();
      expect(mockTracker.trackPageView).not.toHaveBeenCalled();
    });

  });

  describe('trackEvent()', () => {
    it('should call tracker.trackEvent() with all parameters', () => {
      service.trackEvent('Entity', 'Create', 'issues', 1);
      expect(mockTracker.trackEvent).toHaveBeenCalledWith('Entity', 'Create', 'issues', 1);
    });

    it('should call tracker.trackEvent() without optional parameters', () => {
      service.trackEvent('Entity', 'Create');
      expect(mockTracker.trackEvent).toHaveBeenCalledWith('Entity', 'Create', undefined, undefined);
    });

    it('should call tracker.trackEvent() with name only', () => {
      service.trackEvent('Search', 'Query', 'issues');
      expect(mockTracker.trackEvent).toHaveBeenCalledWith('Search', 'Query', 'issues', undefined);
    });

    it('should not call tracker when disabled', () => {
      localStorage.setItem('analytics_enabled', 'false');
      service.trackEvent('Entity', 'Create', 'issues');
      expect(mockTracker.trackEvent).not.toHaveBeenCalled();
    });

  });

  describe('trackError()', () => {
    it('should call trackEvent() with Error category and Application action', () => {
      spyOn(service, 'trackEvent');
      service.trackError('Failed to load issues', 500);
      expect(service.trackEvent).toHaveBeenCalledWith('Error', 'Application', 'Failed to load issues', 500);
    });

    it('should call trackEvent() without status code', () => {
      spyOn(service, 'trackEvent');
      service.trackError('Validation failed');
      expect(service.trackEvent).toHaveBeenCalledWith('Error', 'Application', 'Validation failed', undefined);
    });
  });

  describe('setUserId()', () => {
    it('should call tracker.setUserId() when enabled', () => {
      service.setUserId('user-123');
      expect(mockTracker.setUserId).toHaveBeenCalledWith('user-123');
    });

    it('should not call tracker when disabled', () => {
      localStorage.setItem('analytics_enabled', 'false');
      service.setUserId('user-123');
      expect(mockTracker.setUserId).not.toHaveBeenCalled();
    });

  });

  describe('resetUserId()', () => {
    it('should call tracker.resetUserId() when enabled', () => {
      service.resetUserId();
      expect(mockTracker.resetUserId).toHaveBeenCalled();
    });

    it('should not call tracker when disabled', () => {
      localStorage.setItem('analytics_enabled', 'false');
      service.resetUserId();
      expect(mockTracker.resetUserId).not.toHaveBeenCalled();
    });

  });
});
