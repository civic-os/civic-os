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
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TranslationAdminService, Translation, MissingTranslation } from './translation-admin.service';

describe('TranslationAdminService', () => {
  let service: TranslationAdminService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        TranslationAdminService
      ]
    });
    service = TestBed.inject(TranslationAdminService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('getTranslations', () => {
    it('should build correct URL with locale filter', () => {
      service.getTranslations('es').subscribe();
      const req = httpMock.expectOne(r => r.url.includes('translations') && r.url.includes('locale=eq.es'));
      expect(req.request.method).toBe('GET');
      expect(req.request.url).toContain('order=source_type,source_key');
      req.flush([]);
    });

    it('should add source_type filter when provided', () => {
      service.getTranslations('es', 'ui').subscribe();
      const req = httpMock.expectOne(r =>
        r.url.includes('locale=eq.es') && r.url.includes('source_type=eq.ui')
      );
      expect(req.request.method).toBe('GET');
      req.flush([]);
    });

    it('should return empty array on error', () => {
      let result: Translation[] = [];
      service.getTranslations('es').subscribe(t => result = t);
      httpMock.expectOne(r => r.url.includes('translations')).error(new ProgressEvent('error'));
      expect(result).toEqual([]);
    });
  });

  describe('getMissingTranslations', () => {
    it('should call get_missing_translations RPC', () => {
      service.getMissingTranslations('es').subscribe();
      const req = httpMock.expectOne(r => r.url.includes('rpc/get_missing_translations'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_target_locale: 'es' });
      req.flush([]);
    });

    it('should return empty array on error', () => {
      let result: MissingTranslation[] = [];
      service.getMissingTranslations('es').subscribe(m => result = m);
      httpMock.expectOne(r => r.url.includes('rpc/get_missing_translations')).error(new ProgressEvent('error'));
      expect(result).toEqual([]);
    });
  });

  describe('upsertTranslations', () => {
    it('should call upsert_translations RPC with correct payload', () => {
      const translations = [
        { source_type: 'ui', source_key: 'nav.home', locale: 'es', translated_text: 'Inicio' }
      ];
      service.upsertTranslations(translations).subscribe();
      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_translations'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_translations: translations });
      req.flush(null);
    });

    it('should return success response', () => {
      let response: any;
      service.upsertTranslations([]).subscribe(r => response = r);
      httpMock.expectOne(r => r.url.includes('rpc/upsert_translations')).flush(null);
      expect(response.success).toBeTrue();
    });

    it('should return error response on failure', () => {
      let response: any;
      service.upsertTranslations([]).subscribe(r => response = r);
      httpMock.expectOne(r => r.url.includes('rpc/upsert_translations')).error(new ProgressEvent('error'));
      expect(response.success).toBeFalse();
    });
  });

  describe('getDefaults', () => {
    it('should call get_translation_defaults RPC and return a Map', () => {
      let result: Map<string, string> | undefined;
      service.getDefaults().subscribe(m => result = m);
      const req = httpMock.expectOne(r => r.url.includes('rpc/get_translation_defaults'));
      expect(req.request.method).toBe('POST');
      req.flush([
        { source_type: 'ui', source_key: 'nav.home', default_text: 'Home' },
        { source_type: 'entity', source_key: 'Pot_Hole.display_name', default_text: 'Pot Hole' },
        { source_type: 'dashboard', source_key: 'dashboard.1.display_name', default_text: 'Welcome' }
      ]);
      expect(result!.get('ui:nav.home')).toBe('Home');
      expect(result!.get('entity:Pot_Hole.display_name')).toBe('Pot Hole');
      expect(result!.get('dashboard:dashboard.1.display_name')).toBe('Welcome');
      expect(result!.size).toBe(3);
    });

    it('should filter out null default_text values', () => {
      let result: Map<string, string> | undefined;
      service.getDefaults().subscribe(m => result = m);
      const req = httpMock.expectOne(r => r.url.includes('rpc/get_translation_defaults'));
      req.flush([
        { source_type: 'ui', source_key: 'nav.home', default_text: 'Home' },
        { source_type: 'entity', source_key: 'Issue.description', default_text: null }
      ]);
      expect(result!.size).toBe(1);
      expect(result!.has('entity:Issue.description')).toBeFalse();
    });

    it('should return empty Map on error', () => {
      let result: Map<string, string> | undefined;
      service.getDefaults().subscribe(m => result = m);
      httpMock.expectOne(r => r.url.includes('rpc/get_translation_defaults')).error(new ProgressEvent('error'));
      expect(result!.size).toBe(0);
    });
  });

  describe('deleteTranslation', () => {
    it('should call DELETE with correct filter', () => {
      service.deleteTranslation(42).subscribe();
      const req = httpMock.expectOne(r => r.url.includes('translations?id=eq.42'));
      expect(req.request.method).toBe('DELETE');
      expect(req.request.headers.get('Prefer')).toBe('return=minimal');
      req.flush(null);
    });

    it('should return success on delete', () => {
      let response: any;
      service.deleteTranslation(1).subscribe(r => response = r);
      httpMock.expectOne(r => r.url.includes('translations?id=eq.1')).flush(null);
      expect(response.success).toBeTrue();
    });

    it('should return error response on failure', () => {
      let response: any;
      service.deleteTranslation(1).subscribe(r => response = r);
      httpMock.expectOne(r => r.url.includes('translations?id=eq.1')).error(new ProgressEvent('error'));
      expect(response.success).toBeFalse();
    });
  });
});
