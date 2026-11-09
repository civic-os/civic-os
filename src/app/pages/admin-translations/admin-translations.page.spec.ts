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
import { utils, WorkBook } from 'xlsx';
import { AdminTranslationsPage, EXCEL_HEADERS, LABELED_SOURCE_TYPES } from './admin-translations.page';
import { EN_TRANSLATIONS } from '../../i18n/en.translations';
import { TranslationAdminService, Translation, MissingTranslation } from '../../services/translation-admin.service';
import { TranslationService } from '../../services/translation.service';
import { SchemaService } from '../../services/schema.service';
import { DashboardService } from '../../services/dashboard.service';
import { LocaleService } from '../../services/locale.service';

/** English lookup with {{param}} interpolation, as TranslationService resolves an en key */
function enGet(key: string, params?: Record<string, string | number>): string {
    const text = EN_TRANSLATIONS[key] ?? key;
    return params ? text.replace(/\{\{(\w+)\}\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m)) : text;
}

describe('AdminTranslationsPage', () => {
    let component: AdminTranslationsPage;
    let fixture: ComponentFixture<AdminTranslationsPage>;
    let mockTranslationAdmin: any;
    let mockTranslation: any;
    let mockSchema: any;
    let mockDashboard: any;
    let mockRouter: any;
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
        locale: vi.fn().mockName('locale').mockReturnValue('en'),
        supportedLocales: signal([
            { code: 'en', name: 'English', englishName: 'English' },
            { code: 'es', name: 'Español', englishName: 'Spanish' }
        ]),
        setLocale: vi.fn().mockName('setLocale'),
        isSupported: (code: string) => code === 'en' || code === 'es',
        getLocaleInfo: () => ({ code: 'en', name: 'English', englishName: 'English' }),
        initFromJwt: () => { }
    };

    beforeEach(async () => {
        queryParams$ = new BehaviorSubject<Record<string, string>>({});

        mockTranslationAdmin = {
            getTranslations: vi.fn().mockName("TranslationAdminService.getTranslations"),
            getMissingTranslations: vi.fn().mockName("TranslationAdminService.getMissingTranslations"),
            getDefaults: vi.fn().mockName("TranslationAdminService.getDefaults"),
            upsertTranslations: vi.fn().mockName("TranslationAdminService.upsertTranslations"),
            deleteTranslation: vi.fn().mockName("TranslationAdminService.deleteTranslation")
        };
        mockTranslation = {
            clearCache: vi.fn().mockName("TranslationService.clearCache"),
            get: vi.fn().mockName("TranslationService.get"),
            version: signal(1),
            loading: signal(false)
        };
        mockTranslation.get.mockImplementation(enGet);
        mockSchema = {
            refreshCache: vi.fn().mockName("SchemaService.refreshCache"),
            invalidateGuidedFormCache: vi.fn().mockName("SchemaService.invalidateGuidedFormCache")
        };
        mockDashboard = {
            refreshCache: vi.fn().mockName("DashboardService.refreshCache")
        };
        mockRouter = {
            navigate: vi.fn().mockName("Router.navigate")
        };

        mockTranslationAdmin.getTranslations.mockReturnValue(of(mockTranslations));
        mockTranslationAdmin.getMissingTranslations.mockReturnValue(of(mockMissing));
        mockTranslationAdmin.getDefaults.mockReturnValue(of(new Map<string, string>([
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
        expect(component.targetLocales().find(l => l.code === 'en')).toBeUndefined();
        expect(component.targetLocales().length).toBe(1);
        expect(component.targetLocales()[0].code).toBe('es');
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
        mockTranslationAdmin.getTranslations.mockClear();
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
        mockTranslationAdmin.getTranslations.mockClear();
        mockTranslationAdmin.getMissingTranslations.mockClear();
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
            expect(component.showEditModal()).toBe(true);
            expect(component.editingTranslation()).toEqual(mockTranslations[0]);
            expect(component.editForm().translatedText).toBe('Inicio');
            expect(component.editForm().defaultText).toBe('Home');
        });

        it('should open create modal from missing translation', () => {
            component.openCreateFromMissing(mockMissing[0]);
            expect(component.showEditModal()).toBe(true);
            expect(component.editingTranslation()).toBeNull();
            expect(component.editForm().sourceKey).toBe('nav.settings');
            expect(component.editForm().defaultText).toBe('Settings');
            expect(component.editForm().translatedText).toBe('');
        });

        it('should validate translated text is required', () => {
            component.openCreateFromMissing(mockMissing[0]);
            component.submitEdit();
            expect(component.editError()).toBe('Translation text is required');
        });

        it('should submit edit and refresh caches', () => {
            mockTranslationAdmin.upsertTranslations.mockReturnValue(of({ success: true }));
            component.openEditModal(mockTranslations[0]);
            component.updateTranslatedText('Casa');
            component.submitEdit();

            expect(mockTranslationAdmin.upsertTranslations).toHaveBeenCalledWith([{
                    source_type: 'ui',
                    source_key: 'nav.home',
                    locale: 'es',
                    translated_text: 'Casa'
                }]);
            expect(component.showEditModal()).toBe(false);
            expect(mockTranslation.clearCache).toHaveBeenCalled();
            expect(mockSchema.refreshCache).toHaveBeenCalled();
            expect(mockSchema.invalidateGuidedFormCache).toHaveBeenCalled();
            expect(mockDashboard.refreshCache).toHaveBeenCalled();
        });
    });

    describe('Delete', () => {
        it('should open and close delete modal', () => {
            component.openDeleteModal(mockTranslations[0]);
            expect(component.showDeleteModal()).toBe(true);
            expect(component.deletingTranslation()).toEqual(mockTranslations[0]);
            component.closeDeleteModal();
            expect(component.showDeleteModal()).toBe(false);
        });

        it('should delete and refresh caches', () => {
            mockTranslationAdmin.deleteTranslation.mockReturnValue(of({ success: true }));
            component.openDeleteModal(mockTranslations[0]);
            component.submitDelete();
            expect(mockTranslationAdmin.deleteTranslation).toHaveBeenCalledWith(1);
            expect(component.showDeleteModal()).toBe(false);
            expect(mockTranslation.clearCache).toHaveBeenCalled();
        });

        it('should show error on delete failure', () => {
            mockTranslationAdmin.deleteTranslation.mockReturnValue(of({
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
            const spy = vi.spyOn(component as any, 'saveExcelFile').mockReturnValue(undefined);
            component.exportTranslations();
            expect(spy).toHaveBeenCalled();
            const [, filename] = vi.mocked(spy).mock.lastCall!;
            expect(filename).toMatch(/^translations_es_\d{4}-\d{2}-\d{2}\.xlsx$/);
        });

        it('should write English headers matching the import column names, and translated hints and sheet name', () => {
            const spy = vi.spyOn(component as any, 'saveExcelFile').mockReturnValue(undefined);
            mockTranslation.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
                key === 'admin_translations.sheet_translations' ? 'Traducciones'
                    : key.startsWith('admin_translations.') ? `es:${key}` : enGet(key, params));
            component.exportTranslations();
            const [workbook] = vi.mocked(spy).mock.lastCall! as [WorkBook, string];
            const sheetName = workbook.SheetNames[0];
            expect(sheetName).toBe('Traducciones');
            const [hints, headers, firstRow] = utils.sheet_to_json<string[]>(workbook.Sheets[sheetName], { header: 1 });
            expect(headers).toEqual(Object.values(EXCEL_HEADERS));
            expect(firstRow).toEqual(['ui', 'nav.home', 'Home', 'Inicio']);
            expect(headers).toEqual(expect.arrayContaining(component.translationImportConfig().columns.map(c => c.name)));
            expect(hints).toEqual([
                'es:admin_translations.hint_do_not_edit',
                'es:admin_translations.hint_do_not_edit',
                'es:admin_translations.hint_reference',
                'es:admin_translations.hint_edit'
            ]);
        });

        it('should write the template with the same English headers and translated hints', () => {
            const spy = vi.spyOn(component as any, 'saveExcelFile').mockReturnValue(undefined);
            component.translationImportConfig().generateTemplate!();
            const [workbook, filename] = vi.mocked(spy).mock.lastCall! as [WorkBook, string];
            expect(filename).toMatch(/^translation_template_es_\d{4}-\d{2}-\d{2}\.xlsx$/);
            expect(workbook.SheetNames).toEqual(['Import Data']);
            const [hints, headers] = utils.sheet_to_json<string[]>(workbook.Sheets['Import Data'], { header: 1 });
            expect(headers).toEqual(Object.values(EXCEL_HEADERS));
            expect(hints[3]).toBe('Enter translation here');
        });

        it('should strip characters Excel rejects from a translated sheet name, and cap it at 31', () => {
            const spy = vi.spyOn(component as any, 'saveExcelFile').mockReturnValue(undefined);
            mockTranslation.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
                key === 'admin_translations.sheet_translations' ? 'Trad: [es] / a very long sheet name indeed' : enGet(key, params));
            component.exportTranslations();
            const name = (vi.mocked(spy).mock.lastCall![0] as WorkBook).SheetNames[0];
            expect(name).toBe('Trad es  a very long sheet name');
            expect(name.length).toBeLessThanOrEqual(31);

            mockTranslation.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
                key === 'admin_translations.sheet_translations' ? ':/?' : enGet(key, params));
            component.exportTranslations();
            expect((vi.mocked(spy).mock.lastCall![0] as WorkBook).SheetNames[0]).toBe('Translations');

            mockTranslation.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
                key === 'admin_translations.sheet_translations' ? " 'Trad' " : enGet(key, params));
            component.exportTranslations();
            expect((vi.mocked(spy).mock.lastCall![0] as WorkBook).SheetNames[0]).toBe('Trad');

            mockTranslation.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
                key === 'admin_translations.sheet_translations' ? 'HISTORY' : enGet(key, params));
            component.exportTranslations();
            expect((vi.mocked(spy).mock.lastCall![0] as WorkBook).SheetNames[0]).toBe('Translations');
        });

        it('should export a file the importer reads back by its English column names', () => {
            const spy = vi.spyOn(component as any, 'saveExcelFile').mockReturnValue(undefined);
            component.exportTranslations();
            const [workbook] = vi.mocked(spy).mock.lastCall! as [WorkBook, string];
            // As ImportExportService.parseExcelFile reads it: skip row 1, key rows by row 2
            const parsed = utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]], { range: 1 });
            const names = component.translationImportConfig().columns.map(c => c.name);
            expect(parsed).toHaveLength(mockTranslations.length);
            expect(parsed[0]).toEqual(expect.objectContaining({
                [EXCEL_HEADERS.sourceType]: 'ui', [EXCEL_HEADERS.sourceKey]: 'nav.home', [EXCEL_HEADERS.translatedText]: 'Inicio'
            }));
            for (const name of names) {
                expect(Object.keys(parsed[0])).toContain(name);
            }
        });

        it('should not export when no translations', () => {
            const spy = vi.spyOn(component as any, 'saveExcelFile').mockReturnValue(undefined);
            component.translations.set([]);
            component.exportTranslations();
            expect(spy).not.toHaveBeenCalled();
        });
    });

    describe('Import', () => {
        it('should have import config with 3 columns and optional Translated Text', () => {
            expect(component.translationImportConfig().columns.length).toBe(3);
            expect(component.translationImportConfig().title).toBe('Import Translations');
            expect(component.translationImportConfig().itemLabel).toBe('translations');
            const translatedTextCol = component.translationImportConfig().columns.find(c => c.key === 'translated_text');
            expect(translatedTextCol?.required).toBe(false);
        });

        it('should preFilter out rows with empty Translated Text', () => {
            const rows = [
                { source_type: 'ui', source_key: 'nav.home', translated_text: 'Inicio' },
                { source_type: 'ui', source_key: 'nav.settings', translated_text: null },
                { source_type: 'ui', source_key: 'nav.about', translated_text: '' }
            ];
            const filtered = component.translationImportConfig().preFilter!(rows);
            expect(filtered.length).toBe(1);
            expect(filtered[0]['source_key']).toBe('nav.home');
        });

        it('should submit all rows passed to submit()', () => {
            mockTranslationAdmin.upsertTranslations.mockReturnValue(of({ success: true, upserted: 1 }));
            const rows = [
                { source_type: 'ui', source_key: 'nav.home', translated_text: 'Inicio' }
            ];
            component.translationImportConfig().submit(rows).subscribe();
            expect(mockTranslationAdmin.upsertTranslations).toHaveBeenCalledWith([{
                    source_type: 'ui',
                    source_key: 'nav.home',
                    locale: 'es',
                    translated_text: 'Inicio'
                }]);
        });

        it('should open import modal', () => {
            component.openImportModal();
            expect(component.showImportModal()).toBe(true);
        });

        it('should close modal and refresh on import success', () => {
            component.showImportModal.set(true);
            mockTranslationAdmin.getTranslations.mockClear();
            mockTranslationAdmin.getMissingTranslations.mockClear();

            component.onImportSuccess(5);

            expect(component.showImportModal()).toBe(false);
            expect(component.successMessage()).toBe('5 translations imported successfully.');
            expect(mockTranslation.clearCache).toHaveBeenCalled();
            expect(mockSchema.refreshCache).toHaveBeenCalled();
            expect(mockSchema.invalidateGuidedFormCache).toHaveBeenCalled();
            expect(mockDashboard.refreshCache).toHaveBeenCalled();
        });
    });

    describe('Source type labels', () => {
        it('should return human-readable labels', () => {
            expect(component.sourceTypeLabel('ui')).toBe('UI');
            expect(component.sourceTypeLabel('entity')).toBe('Entity');
            expect(component.sourceTypeLabel('widget_config')).toBe('Dashboard');
            expect(component.sourceTypeLabel('menu_node')).toBe('Menu');
            expect(component.sourceTypeLabel('instance_config')).toBe('Configuration');
            expect(component.sourceTypeLabel('instance_config_group')).toBe('Configuration');
        });

        it('should have an English label for every labeled source type, and every filter type is labeled', () => {
            for (const type of LABELED_SOURCE_TYPES) {
                expect(EN_TRANSLATIONS[`admin_translations.source_type.${type}`], type).toBeTruthy();
            }
            expect(LABELED_SOURCE_TYPES).toEqual(expect.arrayContaining(component.sourceTypes));
        });

        it('should label a source type in the UI language', () => {
            mockTranslation.get.mockImplementation((key: string) =>
                key === 'admin_translations.source_type.dashboard' ? 'Panel' : key);
            expect(component.sourceTypeLabel('dashboard')).toBe('Panel');
        });

        it('should rebuild the import title and item label when the language changes', () => {
            expect(component.translationImportConfig().title).toBe('Import Translations');
            mockTranslation.get.mockImplementation((key: string) =>
                ({ 'admin_translations.import_title': 'Importar traducciones', 'admin_translations.import_item_label': 'traducciones' })[key] ?? key);
            mockTranslation.version.set(2);
            expect(component.translationImportConfig().title).toBe('Importar traducciones');
            expect(component.translationImportConfig().itemLabel).toBe('traducciones');
            expect(component.translationImportConfig().columns.map(c => c.name))
                .toEqual([EXCEL_HEADERS.sourceType, EXCEL_HEADERS.sourceKey, EXCEL_HEADERS.translatedText]);
        });

        it('should offer Configuration in the filter, once', () => {
            expect(component.sourceTypes.filter(t => t === 'instance_config')).toHaveLength(1);
            expect(component.sourceTypes).not.toContain('instance_config_group');
        });
    });

    describe('Rendered chrome', () => {
        const el = () => fixture.nativeElement as HTMLElement;

        it('should render its chrome through the translation service', async () => {
            mockTranslation.get.mockImplementation((key: string, params?: Record<string, string | number>) =>
                key.startsWith('admin_translations.') ? `es:${key}${params ? JSON.stringify(params) : ''}` : enGet(key, params));
            mockTranslation.version.set(2);
            fixture.detectChanges();
            await fixture.whenStable();

            expect(el().querySelector('h1')?.textContent?.trim()).toBe('es:admin_translations.title');
            expect(el().querySelector('#translation-search')?.getAttribute('placeholder'))
                .toBe('es:admin_translations.search_placeholder');
            const headers = Array.from(el().querySelectorAll('th')).map(th => th.textContent?.trim());
            expect(headers).toContain('es:admin_translations.source_key');
            expect(el().textContent).toContain('es:admin_translations.count_other{"count":3}');
            expect(el().textContent).not.toContain('Translation Management');
        });

        it('should use the singular count key for one row', async () => {
            component.searchQuery.set('nav');
            fixture.detectChanges();
            await fixture.whenStable();
            expect(el().textContent).toContain('1 translation');
            expect(el().textContent).not.toContain('1 translations');
        });
    });

    describe('Missing tab source filter', () => {
        const missing = (source_type: string, source_key: string) =>
            ({ source_type, source_key, default_text: source_key });

        beforeEach(() => {
            component.missingTranslations.set([
                missing('instance_config', 'app_title.display_name'),
                missing('instance_config_group', 'appearance.display_name'),
                missing('dashboard', 'dashboard.1.display_name'),
                missing('widget_config', 'dashboard.1.widget.2.content'),
                missing('entity', 'issues.display_name')
            ] as any);
        });

        it('should keep config keys and groups under the instance_config filter', () => {
            component.selectedSourceType.set('instance_config');
            expect(component.filteredMissing().map(m => m.source_type))
                .toEqual(['instance_config', 'instance_config_group']);
        });

        it('should keep dashboards and widget config under the dashboard filter', () => {
            component.selectedSourceType.set('dashboard');
            expect(component.filteredMissing().map(m => m.source_type)).toEqual(['dashboard', 'widget_config']);
        });

        it('should match only its own type for an ungrouped filter', () => {
            component.selectedSourceType.set('entity');
            expect(component.filteredMissing().map(m => m.source_type)).toEqual(['entity']);
        });

        it('should fall back to raw type for unknown types', () => {
            expect(component.sourceTypeLabel('unknown')).toBe('unknown');
        });
    });
});
