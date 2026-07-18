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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of, BehaviorSubject } from 'rxjs';
import { AdminTranslationsPage } from './admin-translations.page';
import { TranslationAdminService, Translation, MissingTranslation } from '../../services/translation-admin.service';
import { TranslationService } from '../../services/translation.service';
import { SchemaService } from '../../services/schema.service';
import { DashboardService } from '../../services/dashboard.service';
import { LocaleService } from '../../services/locale.service';

describe('AdminTranslationsPage', () => {
  let component: AdminTranslationsPage;
  let fixture: ComponentFixture<AdminTranslationsPage>;
  let mockTranslationAdmin: jasmine.SpyObj<TranslationAdminService>;
  let mockTranslation: jasmine.SpyObj<TranslationService>;
  let mockSchema: jasmine.SpyObj<SchemaService>;
  let mockDashboard: jasmine.SpyObj<DashboardService>;
  let mockRouter: jasmine.SpyObj<Router>;
  let queryParams$: BehaviorSubject<Record<string, string>>;

  const mockTranslations: Translation[] = [
    { id: 1, source_type: 'ui', source_key: 'nav.home', locale: 'es', translated_text: 'Inicio', created_at: '', updated_at: '' },
    { id: 2, source_type: 'entity', source_key: 'Pot_Hole.display_name', locale: 'es', translated_text: 'Baches', created_at: '', updated_at: '' },
    { id: 3, source_type: 'dashboard', source_key: 'dashboard.1.display_name', locale: 'es', translated_text: 'Bienvenida', created_at: '', updated_at: '' }
  ];

  const mockMissing: MissingTranslation[] = [
    { source_type: 'ui', source_key: 'nav.settings', default_text: 'Settings' },
    { source_type: 'status', source_key: 'pot_hole.open.display_name', default_text: 'Open' }
  ];

  const mockLocaleService = {
    locale: jasmine.createSpy('locale').and.returnValue('en'),
    supportedLocales: [
      { code: 'en', name: 'English', englishName: 'English' },
      { code: 'es', name: 'Español', englishName: 'Spanish' }
    ],
    setLocale: jasmine.createSpy('setLocale'),
    isSupported: (code: string) => code === 'en' || code === 'es',
    getLocaleInfo: () => ({ code: 'en', name: 'English', englishName: 'English' }),
    initFromJwt: () => {}
  };

  beforeEach(async () => {
    queryParams$ = new BehaviorSubject<Record<string, string>>({});

    mockTranslationAdmin = jasmine.createSpyObj('TranslationAdminService', [
      'getTranslations', 'getMissingTranslations', 'getDefaults', 'upsertTranslations', 'deleteTranslation'
    ]);
    mockTranslation = jasmine.createSpyObj('TranslationService', ['clearCache', 'get'], {
      version: signal(1),
      loading: signal(false)
    });
    mockTranslation.get.and.callFake((key: string) => key);
    mockSchema = jasmine.createSpyObj('SchemaService', ['refreshCache']);
    mockDashboard = jasmine.createSpyObj('DashboardService', ['refreshCache']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);

    mockTranslationAdmin.getTranslations.and.returnValue(of(mockTranslations));
    mockTranslationAdmin.getMissingTranslations.and.returnValue(of(mockMissing));
    mockTranslationAdmin.getDefaults.and.returnValue(of(new Map<string, string>([
      ['ui:nav.home', 'Home'],
      ['entity:Pot_Hole.display_name', 'Pot Hole'],
      ['dashboard:dashboard.1.display_name', 'Welcome']
    ])));

    await TestBed.configureTestingModule({
      imports: [AdminTranslationsPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: TranslationAdminService, useValue: mockTranslationAdmin },
        { provide: TranslationService, useValue: mockTranslation },
        { provide: SchemaService, useValue: mockSchema },
        { provide: DashboardService, useValue: mockDashboard },
        { provide: LocaleService, useValue: mockLocaleService },
        { provide: ActivatedRoute, useValue: { queryParams: queryParams$.asObservable() } },
        { provide: Router, useValue: mockRouter }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AdminTranslationsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load translations on init', () => {
    expect(mockTranslationAdmin.getTranslations).toHaveBeenCalledWith('es', undefined);
    expect(component.translations()).toEqual(mockTranslations);
  });

  it('should load missing translations on init', () => {
    expect(mockTranslationAdmin.getMissingTranslations).toHaveBeenCalledWith('es');
    expect(component.missingTranslations()).toEqual(mockMissing);
  });

  it('should load English defaults on init', () => {
    expect(mockTranslationAdmin.getDefaults).toHaveBeenCalled();
    expect(component.defaults().size).toBe(3);
  });

  it('should return English default text via getDefault()', () => {
    expect(component.getDefault('ui', 'nav.home')).toBe('Home');
    expect(component.getDefault('entity', 'Pot_Hole.display_name')).toBe('Pot Hole');
    expect(component.getDefault('ui', 'nonexistent.key')).toBe('');
  });

  it('should exclude English from target locales', () => {
    expect(component.targetLocales.find(l => l.code === 'en')).toBeUndefined();
    expect(component.targetLocales.length).toBe(1);
    expect(component.targetLocales[0].code).toBe('es');
  });

  it('should filter translations by search query', () => {
    component.searchQuery.set('nav');
    expect(component.filteredTranslations().length).toBe(1);
    expect(component.filteredTranslations()[0].source_key).toBe('nav.home');
  });

  it('should filter translations by English default text', () => {
    component.searchQuery.set('Pot Hole');
    expect(component.filteredTranslations().length).toBe(1);
    expect(component.filteredTranslations()[0].source_key).toBe('Pot_Hole.display_name');
  });

  it('should update URL on source type change', () => {
    component.onSourceTypeChange('dashboard');
    expect(mockRouter.navigate).toHaveBeenCalledWith([], {
      queryParams: { type: 'dashboard' },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  });

  it('should reload translations when source type query param changes', () => {
    mockTranslationAdmin.getTranslations.calls.reset();
    queryParams$.next({ type: 'dashboard' });
    expect(mockTranslationAdmin.getTranslations).toHaveBeenCalledWith('es', 'dashboard');
  });

  it('should update URL on locale change', () => {
    component.onLocaleChange('es');
    // 'es' is the default locale, so it should be null (clean URL)
    expect(mockRouter.navigate).toHaveBeenCalledWith([], {
      queryParams: { locale: null },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  });

  it('should reload data when locale query param changes', () => {
    // Initial load used default locale 'es'. Simulate switching to a different locale.
    mockTranslationAdmin.getTranslations.calls.reset();
    mockTranslationAdmin.getMissingTranslations.calls.reset();
    queryParams$.next({ locale: 'fr' });
    expect(mockTranslationAdmin.getTranslations).toHaveBeenCalled();
    expect(mockTranslationAdmin.getMissingTranslations).toHaveBeenCalled();
  });

  it('should update URL on tab switch', () => {
    component.switchTab('missing');
    expect(mockRouter.navigate).toHaveBeenCalledWith([], {
      queryParams: { tab: 'missing' },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  });

  it('should compute missing count', () => {
    expect(component.missingCount()).toBe(2);
  });

  describe('Edit modal', () => {
    it('should open edit modal with translation data and English default', () => {
      component.openEditModal(mockTranslations[0]);
      expect(component.showEditModal()).toBeTrue();
      expect(component.editingTranslation()).toEqual(mockTranslations[0]);
      expect(component.editForm().translatedText).toBe('Inicio');
      expect(component.editForm().defaultText).toBe('Home');
    });

    it('should open create modal from missing translation', () => {
      component.openCreateFromMissing(mockMissing[0]);
      expect(component.showEditModal()).toBeTrue();
      expect(component.editingTranslation()).toBeNull();
      expect(component.editForm().sourceKey).toBe('nav.settings');
      expect(component.editForm().defaultText).toBe('Settings');
      expect(component.editForm().translatedText).toBe('');
    });

    it('should validate translated text is required', () => {
      component.openCreateFromMissing(mockMissing[0]);
      component.submitEdit();
      expect(component.editError()).toContain('required');
    });

    it('should submit edit and refresh caches', () => {
      mockTranslationAdmin.upsertTranslations.and.returnValue(of({ success: true }));
      component.openEditModal(mockTranslations[0]);
      component.updateTranslatedText('Casa');
      component.submitEdit();

      expect(mockTranslationAdmin.upsertTranslations).toHaveBeenCalledWith([{
        source_type: 'ui',
        source_key: 'nav.home',
        locale: 'es',
        translated_text: 'Casa'
      }]);
      expect(component.showEditModal()).toBeFalse();
      expect(mockTranslation.clearCache).toHaveBeenCalled();
      expect(mockSchema.refreshCache).toHaveBeenCalled();
      expect(mockDashboard.refreshCache).toHaveBeenCalled();
    });
  });

  describe('Delete', () => {
    it('should open and close delete modal', () => {
      component.openDeleteModal(mockTranslations[0]);
      expect(component.showDeleteModal()).toBeTrue();
      expect(component.deletingTranslation()).toEqual(mockTranslations[0]);
      component.closeDeleteModal();
      expect(component.showDeleteModal()).toBeFalse();
    });

    it('should delete and refresh caches', () => {
      mockTranslationAdmin.deleteTranslation.and.returnValue(of({ success: true }));
      component.openDeleteModal(mockTranslations[0]);
      component.submitDelete();
      expect(mockTranslationAdmin.deleteTranslation).toHaveBeenCalledWith(1);
      expect(component.showDeleteModal()).toBeFalse();
      expect(mockTranslation.clearCache).toHaveBeenCalled();
    });

    it('should show error on delete failure', () => {
      mockTranslationAdmin.deleteTranslation.and.returnValue(of({
        success: false,
        error: { message: 'Forbidden', humanMessage: 'Cannot delete this translation' }
      }));
      component.openDeleteModal(mockTranslations[0]);
      component.submitDelete();
      expect(component.error()).toContain('Cannot delete');
    });
  });

  describe('Coverage stats', () => {
    it('should compute coverage stats from translations and missing', () => {
      // 3 translations + 2 missing = 5 total, 60% coverage
      const stats = component.coverageStats();
      expect(stats.translated).toBe(3);
      expect(stats.missing).toBe(2);
      expect(stats.total).toBe(5);
      expect(stats.percentage).toBe(60);
    });

    it('should return 0% when no data', () => {
      component.translations.set([]);
      component.missingTranslations.set([]);
      const stats = component.coverageStats();
      expect(stats.total).toBe(0);
      expect(stats.percentage).toBe(0);
    });

    it('should return 100% when all translated', () => {
      component.missingTranslations.set([]);
      const stats = component.coverageStats();
      expect(stats.translated).toBe(3);
      expect(stats.missing).toBe(0);
      expect(stats.percentage).toBe(100);
    });
  });

  describe('Export', () => {
    it('should export filtered translations to Excel', () => {
      const spy = spyOn(component as any, 'saveExcelFile');
      component.exportTranslations();
      expect(spy).toHaveBeenCalled();
      const [, filename] = spy.calls.mostRecent().args;
      expect(filename).toMatch(/^translations_es_\d{4}-\d{2}-\d{2}\.xlsx$/);
    });

    it('should not export when no translations', () => {
      const spy = spyOn(component as any, 'saveExcelFile');
      component.translations.set([]);
      component.exportTranslations();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Import', () => {
    it('should have import config with 3 columns and optional Translated Text', () => {
      expect(component.translationImportConfig.columns.length).toBe(3);
      expect(component.translationImportConfig.title).toBe('Import Translations');
      const translatedTextCol = component.translationImportConfig.columns.find(c => c.key === 'translated_text');
      expect(translatedTextCol?.required).toBeFalse();
    });

    it('should preFilter out rows with empty Translated Text', () => {
      const rows = [
        { source_type: 'ui', source_key: 'nav.home', translated_text: 'Inicio' },
        { source_type: 'ui', source_key: 'nav.settings', translated_text: null },
        { source_type: 'ui', source_key: 'nav.about', translated_text: '' }
      ];
      const filtered = component.translationImportConfig.preFilter!(rows);
      expect(filtered.length).toBe(1);
      expect(filtered[0]['source_key']).toBe('nav.home');
    });

    it('should submit all rows passed to submit()', () => {
      mockTranslationAdmin.upsertTranslations.and.returnValue(of({ success: true, upserted: 1 }));
      const rows = [
        { source_type: 'ui', source_key: 'nav.home', translated_text: 'Inicio' }
      ];
      component.translationImportConfig.submit(rows).subscribe();
      expect(mockTranslationAdmin.upsertTranslations).toHaveBeenCalledWith([{
        source_type: 'ui',
        source_key: 'nav.home',
        locale: 'es',
        translated_text: 'Inicio'
      }]);
    });

    it('should open import modal', () => {
      component.openImportModal();
      expect(component.showImportModal()).toBeTrue();
    });

    it('should close modal and refresh on import success', () => {
      component.showImportModal.set(true);
      mockTranslationAdmin.getTranslations.calls.reset();
      mockTranslationAdmin.getMissingTranslations.calls.reset();

      component.onImportSuccess(5);

      expect(component.showImportModal()).toBeFalse();
      expect(component.successMessage()).toContain('5 translations imported');
      expect(mockTranslation.clearCache).toHaveBeenCalled();
      expect(mockSchema.refreshCache).toHaveBeenCalled();
      expect(mockDashboard.refreshCache).toHaveBeenCalled();
    });
  });

  describe('Source type labels', () => {
    it('should return human-readable labels', () => {
      expect(component.sourceTypeLabel('ui')).toBe('UI');
      expect(component.sourceTypeLabel('entity')).toBe('Entity');
      expect(component.sourceTypeLabel('widget_config')).toBe('Dashboard');
    });

    it('should fall back to raw type for unknown types', () => {
      expect(component.sourceTypeLabel('unknown')).toBe('unknown');
    });
  });
});
