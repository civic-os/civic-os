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
import { HttpClient, provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { KEYCLOAK_EVENT_SIGNAL, KeycloakEvent, KeycloakEventType } from 'keycloak-angular';
import { ConfigService } from './config.service';

const STORAGE_KEY = 'civic-os-config';
const API = 'http://test-api.example.com/';
const CONFIG_URL = `${API}instance_config?select=config_key,config_value`;

describe('ConfigService', () => {
  let httpMock: HttpTestingController | undefined;
  let keycloakEvent: WritableSignal<KeycloakEvent>;

  /** ENV layer: window.civicOsConfig, the same source runtime.ts reads in production. */
  function setEnv(overrides: Record<string, unknown> = {}): void {
    (window as any).civicOsConfig = {
      postgrestUrl: API,
      swaggerUrl: '',
      map: { tileUrl: 't', attribution: 'a', defaultCenter: [10, 20], defaultZoom: 7 },
      keycloak: { url: '', realm: '', clientId: '' },
      s3: { endpoint: '', bucket: '' },
      stripe: { publishableKey: 'pk_env' },
      appTitle: 'Env Title',
      theme: { defaultTheme: 'nord' },
      locale: { defaultLocale: 'fr', supportedLocales: ['fr', 'en'] },
      sms: { configured: true },
      matomo: { url: 'https://m.example.com', siteId: '3', enabled: false },
      ...overrides
    };
  }

  function seed(values: Record<string, string>): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ values }));
  }

  function create(opts: { http?: boolean; keycloak?: boolean } = {}): ConfigService {
    const providers: any[] = [provideZonelessChangeDetection()];
    if (opts.http !== false) {
      providers.push(provideHttpClient(withXhr()), provideHttpClientTesting());
    }
    if (opts.keycloak) {
      keycloakEvent = signal<KeycloakEvent>({ type: KeycloakEventType.KeycloakAngularNotInitialized, args: undefined });
      providers.push({ provide: KEYCLOAK_EVENT_SIGNAL, useValue: keycloakEvent });
    }
    TestBed.configureTestingModule({ providers });
    if (opts.http !== false) {
      httpMock = TestBed.inject(HttpTestingController);
    }
    return TestBed.inject(ConfigService);
  }

  beforeEach(() => {
    localStorage.clear();
    setEnv();
  });

  afterEach(() => {
    httpMock?.verify();
    httpMock = undefined;
    delete (window as any).civicOsConfig;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('hydration from localStorage', () => {
    it('reads a valid blob synchronously in the constructor', () => {
      seed({ app_title: 'From Cache', default_theme: 'dark' });
      const service = create();
      expect(service.appTitle()).toBe('From Cache');
      expect(service.defaultTheme()).toBe('dark');
    });

    it('starts empty (ENV values) when there is no blob', () => {
      const service = create();
      expect(service.appTitle()).toBe('Env Title');
      expect(service.dbValue('app_title')).toBeNull();
    });

    it('throws away a corrupt blob', () => {
      localStorage.setItem(STORAGE_KEY, '{not json');
      const service = create();
      expect(service.appTitle()).toBe('Env Title');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it.each([
      ['null', 'null'],
      ['a bare string', '"hello"'],
      ['values is an array', '{"values":["a"]}'],
      ['values is a string', '{"values":"x"}'],
      ['a non-string value', '{"values":{"app_title":5}}'],
      ['no values key', '{"other":{}}']
    ])('throws away a wrongly shaped blob (%s)', (_name, raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      const service = create();
      expect(service.appTitle()).toBe('Env Title');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('never throws when localStorage throws', () => {
      const throwing = {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('denied'); },
        removeItem: () => { throw new Error('denied'); }
      };
      const storageSpy = vi.spyOn(window, 'localStorage', 'get').mockReturnValue(throwing as any);
      try {
        const service = create();
        expect(service.appTitle()).toBe('Env Title');

        service.load();
        httpMock!.expectOne(CONFIG_URL).flush([{ config_key: 'app_title', config_value: 'Loaded' }]);
        expect(service.appTitle()).toBe('Loaded');
      } finally {
        storageSpy.mockRestore();
      }
    });
  });

  describe('accessors: DB, then ENV, then default', () => {
    it('appTitle: DB (trimmed) wins, blank falls back to ENV, then to Civic OS', () => {
      seed({ app_title: '  Tidy  ' });
      expect(create().appTitle()).toBe('Tidy');
    });

    it('appTitle: a blank DB title falls back to ENV', () => {
      seed({ app_title: '   ' });
      expect(create().appTitle()).toBe('Env Title');
    });

    it('appTitle: falls back to the built-in default when neither is set', () => {
      delete (window as any).civicOsConfig.appTitle;
      expect(create().appTitle()).toBe('Civic OS');
    });

    it('defaultTheme: a vetted DB theme wins', () => {
      seed({ default_theme: 'dark' });
      expect(create().defaultTheme()).toBe('dark');
    });

    it('defaultTheme: an unvetted DB theme falls back to ENV', () => {
      seed({ default_theme: 'not-a-daisy-theme' });
      expect(create().defaultTheme()).toBe('nord');
    });

    it('defaultTheme: falls back to corporate when ENV is also unset', () => {
      delete (window as any).civicOsConfig.theme;
      expect(create().defaultTheme()).toBe('corporate');
    });

    it('defaultLocale: accepts xx and xx-YY, rejects anything else', () => {
      seed({ default_locale: 'es-MX' });
      expect(create().defaultLocale()).toBe('es-MX');
    });

    it.each(['EN', 'english', 'e', 'en_US', 'en-us'])('defaultLocale: rejects "%s" and uses ENV', (bad) => {
      seed({ default_locale: bad });
      expect(create().defaultLocale()).toBe('fr');
    });

    it('supportedLocales: splits, trims and drops empty entries', () => {
      seed({ supported_locales: 'en, es ,,ar' });
      expect(create().supportedLocales()).toEqual(['en', 'es', 'ar']);
    });

    it('supportedLocales: a list with no usable entry falls back to ENV', () => {
      seed({ supported_locales: ' , ,' });
      expect(create().supportedLocales()).toEqual(['fr', 'en']);
    });

    it('smsConfigured: DB true/false wins over ENV', () => {
      seed({ sms_configured: 'false' });
      expect(create().smsConfigured()).toBe(false);
    });

    it('smsConfigured: "yes" is invalid and falls back to the ENV boolean', () => {
      seed({ sms_configured: 'yes' });
      expect(create().smsConfigured()).toBe(true);
    });

    it('smsConfigured: follows an ENV false when the DB has no value', () => {
      setEnv({ sms: { configured: false } });
      expect(create().smsConfigured()).toBe(false);
    });

    it('matomoEnabled: DB true overrides an ENV false', () => {
      seed({ matomo_enabled: 'true' });
      expect(create().matomoEnabled()).toBe(true);
    });

    it('matomoEnabled: "1" is invalid and falls back to ENV', () => {
      seed({ matomo_enabled: '1' });
      expect(create().matomoEnabled()).toBe(false);
    });

    it('matomoEnabled: defaults to true when ENV does not say', () => {
      setEnv({ matomo: { url: 'https://m.example.com', siteId: '3' } });
      expect(create().matomoEnabled()).toBe(true);
    });

    it('mapDefaults: ENV values with an empty DB', () => {
      expect(create().mapDefaults()).toEqual({ center: [10, 20], zoom: 7 });
    });

    it('mapDefaults: lat, lng and zoom resolve independently', () => {
      seed({ map_default_lat: '42.5', map_default_zoom: '12' });
      expect(create().mapDefaults()).toEqual({ center: [42.5, 20], zoom: 12 });
    });

    it('mapDefaults: a non-numeric lat and a fractional zoom fall back to ENV', () => {
      seed({ map_default_lat: 'abc', map_default_lng: '-83.1', map_default_zoom: '1.5' });
      expect(create().mapDefaults()).toEqual({ center: [10, -83.1], zoom: 7 });
    });

    it('mapDefaults: accepts zero and negative numbers', () => {
      seed({ map_default_lat: '0', map_default_lng: '-0.5' });
      expect(create().mapDefaults().center).toEqual([0, -0.5]);
    });

    it('mapDefaults: Infinity and NaN strings are rejected', () => {
      seed({ map_default_lat: 'Infinity', map_default_lng: 'NaN' });
      expect(create().mapDefaults().center).toEqual([10, 20]);
    });

    it('mapDefaults: keeps what the ENV helper returns when it is itself not finite', () => {
      setEnv({ map: { tileUrl: 't', attribution: 'a', defaultCenter: [NaN, 20], defaultZoom: 7 } });
      const center = create().mapDefaults().center;
      expect(Number.isNaN(center[0])).toBe(true);
      expect(center[1]).toBe(20);
    });

    it('stripePublishableKey: DB wins, blank falls back to ENV', () => {
      seed({ stripe_publishable_key: ' pk_db ' });
      expect(create().stripePublishableKey()).toBe('pk_db');
    });

    it('stripePublishableKey: a blank DB value falls back to ENV', () => {
      seed({ stripe_publishable_key: '  ' });
      expect(create().stripePublishableKey()).toBe('pk_env');
    });

    it('pwaAppName: the ENV PWA_APP_NAME wins over the app title', () => {
      setEnv({ pwa: { enabled: true, appName: 'Env PWA' } });
      seed({ app_title: 'DB Title' });
      expect(create().pwaAppName()).toBe('Env PWA');
    });

    it('pwaAppName: otherwise follows the DB-resolved app title', () => {
      seed({ app_title: 'DB Title' });
      expect(create().pwaAppName()).toBe('DB Title');
    });
  });

  describe('load()', () => {
    it('requests the view with the narrow select', () => {
      const service = create();
      service.load();
      const req = httpMock!.expectOne(CONFIG_URL);
      expect(req.request.method).toBe('GET');
      req.flush([]);
    });

    describe('settled', () => {
      it('is false before any response, even with a cached blob', () => {
        seed({ matomo_enabled: 'true' });
        const service = create();
        expect(service.settled()).toBe(false);
        service.load();
        expect(service.settled()).toBe(false);
        httpMock!.expectOne(CONFIG_URL).flush([]);
      });

      it('is true after a successful response', () => {
        const service = create();
        service.load();
        httpMock!.expectOne(CONFIG_URL).flush([]);
        expect(service.settled()).toBe(true);
      });

      it('is true after an HTTP error', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const service = create();
        service.load();
        httpMock!.expectOne(CONFIG_URL).error(new ProgressEvent('error'));
        expect(service.settled()).toBe(true);
      });

      it('stays true during and after a later load', () => {
        const service = create();
        service.load();
        httpMock!.expectOne(CONFIG_URL).flush([]);
        service.load();
        expect(service.settled()).toBe(true);
        httpMock!.expectOne(CONFIG_URL).flush([]);
        expect(service.settled()).toBe(true);
      });

      it('is not settled by a cancelled request, only by its replacement', () => {
        const service = create();
        service.load();
        const first = httpMock!.expectOne(CONFIG_URL);
        service.load();
        expect(first.cancelled).toBe(true);
        expect(service.settled()).toBe(false);
        httpMock!.expectOne(CONFIG_URL).flush([]);
        expect(service.settled()).toBe(true);
      });
    });

    it('replaces values with the non-null entries and writes the blob', () => {
      seed({ app_title: 'Old', default_theme: 'dark' });
      const service = create();

      service.load();
      httpMock!.expectOne(CONFIG_URL).flush([
        { config_key: 'app_title', config_value: 'New' },
        { config_key: 'default_locale', config_value: null },
        { config_key: 'supported_locales', config_value: '' },
        { config_key: 'sms_configured', config_value: 'true' }
      ]);

      expect(service.appTitle()).toBe('New');
      // default_theme was absent from the response, so the stale value is dropped (replace, not merge)
      expect(service.dbValue('default_theme')).toBeNull();
      expect(service.dbValue('default_locale')).toBeNull();
      expect(service.dbValue('supported_locales')).toBeNull();
      expect(service.dbValue('sms_configured')).toBe('true');
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
        values: { app_title: 'New', sms_configured: 'true' }
      });
    });

    it('invalidateCache() reloads', () => {
      const service = create();
      service.invalidateCache();
      httpMock!.expectOne(CONFIG_URL).flush([{ config_key: 'app_title', config_value: 'Bumped' }]);
      expect(service.appTitle()).toBe('Bumped');
    });

    it('keeps the current values and warns once when the request fails', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      seed({ app_title: 'Cached' });
      const service = create();

      service.load();
      httpMock!.expectOne(CONFIG_URL).flush('relation does not exist', { status: 404, statusText: 'Not Found' });

      expect(service.appTitle()).toBe('Cached');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).values).toEqual({ app_title: 'Cached' });
    });

    it('keeps working after a failure (the stream is not terminated)', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const service = create();

      service.load();
      httpMock!.expectOne(CONFIG_URL).error(new ProgressEvent('error'));
      service.load();
      httpMock!.expectOne(CONFIG_URL).flush([{ config_key: 'app_title', config_value: 'Recovered' }]);

      expect(service.appTitle()).toBe('Recovered');
    });

    it('ignores a response that is not an array', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      seed({ app_title: 'Cached' });
      const service = create();
      service.load();
      httpMock!.expectOne(CONFIG_URL).flush({ message: 'nope' });
      expect(service.appTitle()).toBe('Cached');
    });

    it('latest wins: a second load() cancels the request still in flight', () => {
      const service = create();

      service.load();
      service.load();

      const reqs = httpMock!.match(CONFIG_URL);
      expect(reqs.length).toBe(2);
      expect(reqs[0].cancelled).toBe(true);
      expect(reqs[1].cancelled).toBe(false);

      reqs[1].flush([{ config_key: 'app_title', config_value: 'Authenticated' }]);
      expect(service.appTitle()).toBe('Authenticated');
    });

    it('resolves HttpClient lazily: constructing never touches it, and a failing client fails soft', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const get = vi.fn(() => { throw new Error('no http'); });
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), { provide: HttpClient, useFactory: () => ({ get }) }]
      });
      const service = TestBed.inject(ConfigService);
      expect(get).not.toHaveBeenCalled();
      expect(service.appTitle()).toBe('Env Title');

      expect(() => service.load()).not.toThrow();
      expect(get).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('dbValue() and envValue()', () => {
    it('dbValue returns the raw DB value or null', () => {
      seed({ app_title: 'X' });
      const service = create();
      expect(service.dbValue('app_title')).toBe('X');
      expect(service.dbValue('default_theme')).toBeNull();
    });

    it('envValue formats the ENV value the way the DB stores it', () => {
      const service = create();
      expect(service.envValue('app_title')).toBe('Env Title');
      expect(service.envValue('default_theme')).toBe('nord');
      expect(service.envValue('default_locale')).toBe('fr');
      expect(service.envValue('supported_locales')).toBe('fr,en');
      expect(service.envValue('sms_configured')).toBe('true');
      expect(service.envValue('matomo_enabled')).toBe('false');
      expect(service.envValue('map_default_lat')).toBe('10');
      expect(service.envValue('map_default_lng')).toBe('20');
      expect(service.envValue('map_default_zoom')).toBe('7');
      expect(service.envValue('stripe_publishable_key')).toBe('pk_env');
    });

    it('envValue ignores the DB layer and returns null for an unknown key', () => {
      seed({ app_title: 'DB' });
      const service = create();
      expect(service.envValue('app_title')).toBe('Env Title');
      expect(service.envValue('no_such_key')).toBeNull();
    });
  });

  describe('Keycloak triggers', () => {
    it('loads on Ready when authenticated', () => {
      create({ keycloak: true });
      TestBed.tick();
      httpMock!.expectNone(CONFIG_URL);

      keycloakEvent.set({ type: KeycloakEventType.Ready, args: true });
      TestBed.tick();
      httpMock!.expectOne(CONFIG_URL).flush([]);
    });

    it('does not load on Ready when anonymous', () => {
      create({ keycloak: true });
      keycloakEvent.set({ type: KeycloakEventType.Ready, args: false });
      TestBed.tick();
      httpMock!.expectNone(CONFIG_URL);
    });

    it('reloads on AuthLogout so auth-only keys are dropped', () => {
      seed({ sms_configured: 'true' });
      const service = create({ keycloak: true });

      keycloakEvent.set({ type: KeycloakEventType.AuthLogout, args: undefined });
      TestBed.tick();
      httpMock!.expectOne(CONFIG_URL).flush([{ config_key: 'app_title', config_value: 'Public' }]);

      expect(service.dbValue('sms_configured')).toBeNull();
      expect(service.appTitle()).toBe('Public');
    });

    it('ignores other Keycloak events', () => {
      create({ keycloak: true });
      keycloakEvent.set({ type: KeycloakEventType.AuthRefreshError, args: undefined });
      TestBed.tick();
      httpMock!.expectNone(CONFIG_URL);
    });

    it('is created without a Keycloak signal provided', () => {
      expect(() => create()).not.toThrow();
    });
  });
});
