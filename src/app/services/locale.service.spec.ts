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
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { LocaleService } from './locale.service';
import { AuthService } from './auth.service';

describe('LocaleService', () => {
  let service: LocaleService;

  beforeEach(() => {
    // Clear localStorage to avoid leaking state between tests
    localStorage.removeItem('civic-os-locale');

    const mockAuthService = {
      authenticated: signal(false),
      getCurrentUserId: () => ({ subscribe: () => {} })
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
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
      expect(service.isRtl()).toBeTrue();
    });

    it('should return true for Hebrew', () => {
      service.setLocale('he');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeTrue();
    });

    it('should return true for Persian', () => {
      service.setLocale('fa');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeTrue();
    });

    it('should return true for Urdu', () => {
      service.setLocale('ur');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeTrue();
    });

    it('should return true for Pashto', () => {
      service.setLocale('ps');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeTrue();
    });

    it('should return true for Dari', () => {
      service.setLocale('prs');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeTrue();
    });

    it('should return false for English', () => {
      service.setLocale('en');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeFalse();
    });

    it('should return false for Spanish', () => {
      service.setLocale('es');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeFalse();
    });

    it('should return false for French', () => {
      service.setLocale('fr');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeFalse();
    });

    it('should return false for German', () => {
      service.setLocale('de');
      TestBed.flushEffects();
      expect(service.isRtl()).toBeFalse();
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
});
