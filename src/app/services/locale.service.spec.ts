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
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, WritableSignal } from '@angular/core';
import { ConfigService } from './config.service';
import { LocaleService } from './locale.service';
import { AuthService } from './auth.service';

describe('LocaleService', () => {
    let service: LocaleService;

    beforeEach(() => {
        // Clear localStorage to avoid leaking state between tests
        localStorage.removeItem('civic-os-locale');

        const mockAuthService = {
            authenticated: signal(false),
            getCurrentUserId: () => ({ subscribe: () => { } })
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                { provide: AuthService, useValue: mockAuthService },
                LocaleService
            ]
        });

        service = TestBed.inject(LocaleService);
    });

    afterEach(() => {
        // Reset document direction after each test
        document.documentElement.dir = 'ltr';
        document.documentElement.lang = 'en';
        localStorage.removeItem('civic-os-locale');
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    describe('isRtl()', () => {
        it('should return true for Arabic', () => {
            service.setLocale('ar');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(true);
        });

        it('should return true for Hebrew', () => {
            service.setLocale('he');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(true);
        });

        it('should return true for Persian', () => {
            service.setLocale('fa');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(true);
        });

        it('should return true for Urdu', () => {
            service.setLocale('ur');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(true);
        });

        it('should return true for Pashto', () => {
            service.setLocale('ps');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(true);
        });

        it('should return true for Dari', () => {
            service.setLocale('prs');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(true);
        });

        it('should return false for English', () => {
            service.setLocale('en');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(false);
        });

        it('should return false for Spanish', () => {
            service.setLocale('es');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(false);
        });

        it('should return false for French', () => {
            service.setLocale('fr');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(false);
        });

        it('should return false for German', () => {
            service.setLocale('de');
            TestBed.flushEffects();
            expect(service.isRtl()).toBe(false);
        });
    });

    describe('document.dir attribute', () => {
        it('should set dir to rtl for Arabic', () => {
            service.setLocale('ar');
            TestBed.flushEffects();
            expect(document.documentElement.dir).toBe('rtl');
        });

        it('should set dir to ltr for English', () => {
            service.setLocale('en');
            TestBed.flushEffects();
            expect(document.documentElement.dir).toBe('ltr');
        });

        it('should set dir to rtl for Hebrew', () => {
            service.setLocale('he');
            TestBed.flushEffects();
            expect(document.documentElement.dir).toBe('rtl');
        });
    });

    describe('document.lang attribute', () => {
        it('should set lang to ar for Arabic', () => {
            service.setLocale('ar');
            TestBed.flushEffects();
            expect(document.documentElement.lang).toBe('ar');
        });

        it('should set lang to en for English', () => {
            service.setLocale('en');
            TestBed.flushEffects();
            expect(document.documentElement.lang).toBe('en');
        });
    });

    describe('round-trip locale switching', () => {
        it('should toggle dir correctly through en → ar → es → en', () => {
            service.setLocale('en');
            TestBed.flushEffects();
            expect(document.documentElement.dir).toBe('ltr');

            service.setLocale('ar');
            TestBed.flushEffects();
            expect(document.documentElement.dir).toBe('rtl');

            service.setLocale('es');
            TestBed.flushEffects();
            expect(document.documentElement.dir).toBe('ltr');

            service.setLocale('en');
            TestBed.flushEffects();
            expect(document.documentElement.dir).toBe('ltr');
        });
    });

    describe('getLocaleInfo()', () => {
        it('should return Pashto info', () => {
            const info = service.getLocaleInfo('ps');
            expect(info).toEqual({ code: 'ps', name: 'پښتو', englishName: 'Pashto' });
        });

        it('should return Dari info', () => {
            const info = service.getLocaleInfo('prs');
            expect(info).toEqual({ code: 'prs', name: 'دری', englishName: 'Dari' });
        });

        it('should return Hebrew info', () => {
            const info = service.getLocaleInfo('he');
            expect(info).toEqual({ code: 'he', name: 'עברית', englishName: 'Hebrew' });
        });

        it('should return Persian info', () => {
            const info = service.getLocaleInfo('fa');
            expect(info).toEqual({ code: 'fa', name: 'فارسی', englishName: 'Persian' });
        });

        it('should return Urdu info', () => {
            const info = service.getLocaleInfo('ur');
            expect(info).toEqual({ code: 'ur', name: 'اردو', englishName: 'Urdu' });
        });

        it('should fallback for unknown locale', () => {
            const info = service.getLocaleInfo('xx');
            expect(info).toEqual({ code: 'xx', name: 'xx', englishName: 'xx' });
        });
    });

    describe('instance config changes (ConfigService)', () => {
        let defaultLocale: WritableSignal<string>;
        let supported: WritableSignal<string[]>;
        let browserLanguage: ReturnType<typeof vi.spyOn>;

        function createService(initial: { default: string; supported: string[] }, language = 'xx-XX'): LocaleService {
            TestBed.resetTestingModule();
            defaultLocale = signal(initial.default);
            supported = signal(initial.supported);
            browserLanguage = vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
            TestBed.configureTestingModule({
                providers: [
                    provideZonelessChangeDetection(),
                    provideHttpClient(withXhr()),
                    provideHttpClientTesting(),
                    { provide: AuthService, useValue: { authenticated: signal(false) } },
                    { provide: ConfigService, useValue: { defaultLocale, supportedLocales: supported } }
                ]
            });
            return TestBed.inject(LocaleService);
        }

        afterEach(() => browserLanguage?.mockRestore());

        it('should expose supportedLocales as a signal driven by the config', () => {
            const svc = createService({ default: 'en', supported: ['en', 'es'] });
            expect(svc.supportedLocales().map(l => l.code)).toEqual(['en', 'es']);

            supported.set(['en', 'es', 'ar']);
            expect(svc.supportedLocales().map(l => l.code)).toEqual(['en', 'es', 'ar']);
            expect(svc.isSupported('ar')).toBe(true);
        });

        it('should move a user on the instance default to the new default', () => {
            const svc = createService({ default: 'en', supported: ['en', 'es'] });
            TestBed.tick();
            expect(svc.locale()).toBe('en');

            defaultLocale.set('es');
            TestBed.tick();
            expect(svc.locale()).toBe('es');
        });

        it('should not switch to a default that is not in the supported list', () => {
            const svc = createService({ default: 'en', supported: ['en', 'es'] });
            TestBed.tick();
            expect(svc.locale()).toBe('en');

            defaultLocale.set('fr');
            TestBed.tick();
            // fr is not supported, so resolveLocale() falls back to the first supported locale
            expect(svc.locale()).toBe('en');
            expect(svc.isSupported(svc.locale())).toBe(true);
        });

        it('should start on a supported locale when the configured default is unsupported', () => {
            const svc = createService({ default: 'fr', supported: ['en', 'es'] });
            expect(svc.locale()).toBe('en');
        });

        it('should not persist an instance-default switch as a user choice', () => {
            const svc = createService({ default: 'en', supported: ['en', 'es'] });
            TestBed.tick();
            defaultLocale.set('es');
            TestBed.tick();
            expect(svc.locale()).toBe('es');
            expect(localStorage.getItem('civic-os-locale')).toBeNull();
        });

        it('should keep a saved choice when the default changes', () => {
            localStorage.setItem('civic-os-locale', 'es');
            const svc = createService({ default: 'en', supported: ['en', 'es', 'fr'] });
            TestBed.tick();
            expect(svc.locale()).toBe('es');

            defaultLocale.set('fr');
            TestBed.tick();
            expect(svc.locale()).toBe('es');
        });

        it('should keep a browser-language choice when the default changes', () => {
            const svc = createService({ default: 'en', supported: ['en', 'es', 'fr'] }, 'es-MX');
            TestBed.tick();
            expect(svc.locale()).toBe('es');

            defaultLocale.set('fr');
            TestBed.tick();
            expect(svc.locale()).toBe('es');
        });

        it('should treat setLocale() as a user choice that a new default does not override', () => {
            const svc = createService({ default: 'en', supported: ['en', 'es', 'fr'] });
            TestBed.tick();
            svc.setLocale('es');

            defaultLocale.set('fr');
            TestBed.tick();
            expect(svc.locale()).toBe('es');
        });

        it('should re-resolve a current locale that is no longer supported', () => {
            const svc = createService({ default: 'en', supported: ['en', 'es'] });
            TestBed.tick();
            svc.setLocale('es');
            localStorage.removeItem('civic-os-locale');

            supported.set(['en', 'fr']);
            TestBed.tick();
            expect(svc.locale()).toBe('en');
        });

        it('should fall back to a still-supported saved choice when the current one is dropped', () => {
            localStorage.setItem('civic-os-locale', 'fr');
            const svc = createService({ default: 'en', supported: ['en', 'es', 'fr'] }, 'es-MX');
            TestBed.tick();
            expect(svc.locale()).toBe('fr');

            supported.set(['en', 'es']);
            TestBed.tick();
            // saved 'fr' is gone, browser 'es' is next in the priority chain
            expect(svc.locale()).toBe('es');
        });
    });
});
