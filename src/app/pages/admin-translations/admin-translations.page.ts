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

import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit, OnDestroy } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, Subject, Subscription, debounceTime } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { utils, writeFileXLSX, WorkBook, WorkSheet } from 'xlsx';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ImportModalComponent } from '../../components/import-modal/import-modal.component';
import { CustomImportConfig, CustomImportResult } from '../../interfaces/import';
import { TranslationAdminService, Translation, MissingTranslation, UpsertTranslation, sourceTypesFor } from '../../services/translation-admin.service';
import { TranslationService } from '../../services/translation.service';
import { SchemaService } from '../../services/schema.service';
import { DashboardService } from '../../services/dashboard.service';
import { LocaleService, LocaleInfo } from '../../services/locale.service';
import { ContrastTextDirective } from '../../directives/contrast-text.directive';

/** Source types shown in the filter dropdown. A grouped filter (SOURCE_TYPE_GROUPS) covers
 * several stored types: 'dashboard' adds 'widget_config', 'instance_config' adds
 * 'instance_config_group'. */
const SOURCE_TYPES = [
  'ui', 'entity', 'property', 'status', 'category',
  'action', 'action_param', 'guided_form_step', 'static_text',
  'dashboard', 'menu_node', 'instance_config'
];

/** Every stored source type the page labels, each with an `admin_translations.source_type.<type>` key. */
export const LABELED_SOURCE_TYPES = [
  ...SOURCE_TYPES, 'widget_config', 'instance_config_group'
];

/** Excel column headers, shared by export, template and import. They stay English in every locale: the
 * importer matches headers by exact text, so a file exported in one language imports in any other. */
export const EXCEL_HEADERS = {
  sourceType: 'Source Type',
  sourceKey: 'Source Key',
  englishDefault: 'English Default',
  translatedText: 'Translated Text'
} as const;

@Component({
  selector: 'app-admin-translations',
  standalone: true,
  imports: [FormsModule, CosModalComponent, ImportModalComponent, TranslatePipe, ContrastTextDirective],
  templateUrl: './admin-translations.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminTranslationsPage implements OnInit, OnDestroy {
  private translationAdmin = inject(TranslationAdminService);
  private translationService = inject(TranslationService);
  private schema = inject(SchemaService);
  private dashboard = inject(DashboardService);
  private localeService = inject(LocaleService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private subscriptions = new Subscription();
  private searchDebounce$ = new Subject<string>();

  // Available source types for filter dropdown
  readonly sourceTypes = SOURCE_TYPES;

  // Available target locales (excludes English since that's the source language)
  readonly targetLocales = computed<LocaleInfo[]>(() =>
    this.localeService.supportedLocales().filter(l => l.code !== 'en'));

  // URL-driven filter state (synced from route.queryParams in ngOnInit)
  selectedLocale = signal<string>(this.targetLocales()[0]?.code ?? 'es');
  selectedSourceType = signal<string>('');
  searchQuery = signal<string>('');
  activeTab = signal<'translations' | 'missing'>('translations');

  // Data
  translations = signal<Translation[]>([]);
  missingTranslations = signal<MissingTranslation[]>([]);
  defaults = signal<Map<string, string>>(new Map());
  loading = signal(true);

  // Alerts
  error = signal<string | undefined>(undefined);
  successMessage = signal<string | undefined>(undefined);

  // Edit modal
  showEditModal = signal(false);
  editingTranslation = signal<Translation | null>(null);
  editForm = signal({ sourceType: '', sourceKey: '', translatedText: '', defaultText: '' });
  editError = signal<string | undefined>(undefined);
  editSaving = signal(false);

  // Delete confirmation
  showDeleteModal = signal(false);
  deletingTranslation = signal<Translation | null>(null);
  deleteLoading = signal(false);

  // Computed: filtered translations by search query (searches key, English default, translated text, and type)
  filteredTranslations = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const list = this.translations();
    if (!query) return list;
    const defaultsMap = this.defaults();
    return list.filter(t =>
      t.source_key.toLowerCase().includes(query) ||
      t.translated_text.toLowerCase().includes(query) ||
      t.source_type.toLowerCase().includes(query) ||
      (defaultsMap.get(`${t.source_type}:${t.source_key}`) ?? '').toLowerCase().includes(query)
    );
  });

  // Computed: filtered missing translations by search query and source type
  filteredMissing = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const sourceType = this.selectedSourceType();
    let list = this.missingTranslations();
    if (sourceType) {
      // A grouped filter (SOURCE_TYPE_GROUPS) matches each of its stored types
      const types = sourceTypesFor(sourceType);
      list = list.filter(m => types.includes(m.source_type));
    }
    if (!query) return list;
    return list.filter(m =>
      m.source_key.toLowerCase().includes(query) ||
      m.default_text.toLowerCase().includes(query) ||
      m.source_type.toLowerCase().includes(query)
    );
  });

  missingCount = computed(() => this.missingTranslations().length);

  coverageStats = computed(() => {
    const translated = this.translations().length;
    const missing = this.missingTranslations().length;
    const total = translated + missing;
    const percentage = total > 0 ? Math.round((translated / total) * 100) : 0;
    return { translated, missing, total, percentage };
  });

  // Import modal
  showImportModal = signal(false);

  // Rebuilt on a language change (version()), so the modal's title and item label follow the UI language.
  // Column names are the English Excel headers (EXCEL_HEADERS).
  translationImportConfig = computed<CustomImportConfig>(() => {
    this.translationService.version();
    return {
      title: this.t('import_title'),
      itemLabel: this.t('import_item_label'),
      columns: [
        { name: EXCEL_HEADERS.sourceType, key: 'source_type', required: true, type: 'text' },
        { name: EXCEL_HEADERS.sourceKey, key: 'source_key', required: true, type: 'text' },
        { name: EXCEL_HEADERS.translatedText, key: 'translated_text', required: false, type: 'text' }
      ],
      preFilter: (rows: Record<string, any>[]) => rows.filter(r => r['translated_text']),
      submit: (validRows: Record<string, any>[]): Observable<CustomImportResult> => {
        return this.submitTranslationImport(validRows);
      },
      generateTemplate: () => {
        this.generateImportTemplate();
      }
    };
  });

  // ── Lifecycle ────────────────────────────────

  ngOnInit() {
    this.subscribeToQueryParams();

    // Debounce search input — 400ms pause before updating URL
    this.subscriptions.add(
      this.searchDebounce$.pipe(debounceTime(400)).subscribe(query => {
        this.router.navigate([], {
          queryParams: { q: query || null },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      })
    );
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
  }

  // ── URL ↔ Signal Sync ──────────────────────────

  private subscribeToQueryParams() {
    let prevServerKey = '';
    this.subscriptions.add(
      this.route.queryParams.pipe(
        map(p => ({
          locale: p['locale'] || this.targetLocales()[0]?.code || 'es',
          type: p['type'] || '',
          q: p['q'] || '',
          tab: (p['tab'] === 'missing' ? 'missing' : 'translations') as 'translations' | 'missing'
        })),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))
      ).subscribe(state => {
        // Always sync all signals
        this.selectedLocale.set(state.locale);
        this.selectedSourceType.set(state.type);
        this.searchQuery.set(state.q);
        this.activeTab.set(state.tab);

        // Only reload from server when locale/type/tab change (not search — that's client-side)
        const serverKey = `${state.locale}|${state.type}|${state.tab}`;
        if (serverKey !== prevServerKey) {
          prevServerKey = serverKey;
          this.loadData();
        }
      })
    );
  }

  private updateUrl(params: Record<string, string | null>) {
    this.router.navigate([], {
      queryParams: params,
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  // ── Data Loading ──────────────────────────────

  loadData() {
    this.loading.set(true);
    this.error.set(undefined);
    this.loadTranslations();
    this.loadMissing();
    this.loadDefaults();
  }

  loadTranslations() {
    const locale = this.selectedLocale();
    const sourceType = (this.activeTab() === 'translations' && this.selectedSourceType()) ? this.selectedSourceType() : undefined;
    this.translationAdmin.getTranslations(locale, sourceType).subscribe(translations => {
      this.translations.set(translations);
      this.loading.set(false);
    });
  }

  loadMissing() {
    const locale = this.selectedLocale();
    this.translationAdmin.getMissingTranslations(locale).subscribe(missing => {
      this.missingTranslations.set(missing);
    });
  }

  loadDefaults() {
    this.translationAdmin.getDefaults().subscribe(defaults => {
      this.defaults.set(defaults);
    });
  }

  onLocaleChange(value: string) {
    this.updateUrl({ locale: value === this.targetLocales()[0]?.code ? null : value });
  }

  onSourceTypeChange(value: string) {
    this.updateUrl({ type: value || null });
  }

  onSearchInput(value: string) {
    this.searchQuery.set(value); // Immediate client-side filtering
    this.searchDebounce$.next(value); // Debounced URL update
  }

  switchTab(tab: 'translations' | 'missing') {
    this.updateUrl({ tab: tab === 'translations' ? null : tab });
  }

  // ── Edit Translation ──────────────────────────

  openEditModal(translation: Translation) {
    this.editingTranslation.set(translation);
    this.editForm.set({
      sourceType: translation.source_type,
      sourceKey: translation.source_key,
      translatedText: translation.translated_text,
      defaultText: this.getDefault(translation.source_type, translation.source_key)
    });
    this.editError.set(undefined);
    this.showEditModal.set(true);
  }

  openCreateFromMissing(missing: MissingTranslation) {
    this.editingTranslation.set(null);
    this.editForm.set({
      sourceType: missing.source_type,
      sourceKey: missing.source_key,
      translatedText: '',
      defaultText: missing.default_text
    });
    this.editError.set(undefined);
    this.showEditModal.set(true);
  }

  closeEditModal() {
    this.showEditModal.set(false);
  }

  updateTranslatedText(value: string) {
    this.editForm.update(f => ({ ...f, translatedText: value }));
  }

  submitEdit() {
    const form = this.editForm();
    if (!form.translatedText.trim()) {
      this.editError.set(this.t('text_required'));
      return;
    }

    this.editSaving.set(true);
    this.editError.set(undefined);

    const payload: UpsertTranslation[] = [{
      source_type: form.sourceType,
      source_key: form.sourceKey,
      locale: this.selectedLocale(),
      translated_text: form.translatedText.trim()
    }];

    this.translationAdmin.upsertTranslations(payload).subscribe({
      next: (response) => {
        this.editSaving.set(false);
        if (response.success) {
          this.showEditModal.set(false);
          this.successMessage.set(this.t(this.editingTranslation() ? 'updated' : 'created'));
          this.refreshAfterSave();
        } else {
          this.editError.set(response.error?.humanMessage || this.t('save_failed'));
        }
      },
      error: () => {
        this.editSaving.set(false);
        this.editError.set(this.t('save_failed'));
      }
    });
  }

  // ── Delete Translation ────────────────────────

  openDeleteModal(translation: Translation) {
    this.deletingTranslation.set(translation);
    this.showDeleteModal.set(true);
  }

  closeDeleteModal() {
    this.showDeleteModal.set(false);
    this.deletingTranslation.set(null);
  }

  submitDelete() {
    const translation = this.deletingTranslation();
    if (!translation) return;

    this.deleteLoading.set(true);
    this.translationAdmin.deleteTranslation(translation.id).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          this.showDeleteModal.set(false);
          this.deletingTranslation.set(null);
          this.successMessage.set(this.t('deleted'));
          this.refreshAfterSave();
        } else {
          this.showDeleteModal.set(false);
          this.error.set(response.error?.humanMessage || this.t('delete_failed'));
        }
      },
      error: () => {
        this.deleteLoading.set(false);
        this.showDeleteModal.set(false);
        this.error.set(this.t('delete_failed'));
      }
    });
  }

  // ── Cache Invalidation ────────────────────────

  /**
   * After saving/deleting translations, refresh the translation cache so
   * the live UI reflects the changes without page reload.
   */
  private refreshAfterSave() {
    this.loadTranslations();
    this.loadMissing();
    // Invalidate TranslationService cache so pipes re-render
    this.translationService.clearCache();
    // Refresh schema cache (metadata VIEWs use t()), and guided form steps, which
    // refreshCache() keeps (same set as schemaVersionGuard on a translations change)
    this.schema.refreshCache();
    this.schema.invalidateGuidedFormCache();
    // Refresh dashboard cache (RPCs use t())
    this.dashboard.refreshCache();
  }

  // ── Export / Import ─────────────────────────

  exportTranslations(): void {
    const translations = this.filteredTranslations();
    if (translations.length === 0) return;

    const defaultsMap = this.defaults();
    const rows = translations.map(t => ({
      [EXCEL_HEADERS.sourceType]: t.source_type,
      [EXCEL_HEADERS.sourceKey]: t.source_key,
      [EXCEL_HEADERS.englishDefault]: defaultsMap.get(`${t.source_type}:${t.source_key}`) ?? '',
      [EXCEL_HEADERS.translatedText]: t.translated_text
    }));

    const worksheet = this.excelSheet('hint_edit', rows);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, this.sheetName('sheet_translations', 'Translations'));

    const date = new Date().toISOString().slice(0, 10);
    const filename = `translations_${this.selectedLocale()}_${date}.xlsx`;
    this.saveExcelFile(workbook, filename);
  }

  /** Wrapper for testability (mirrors ImportExportService.saveWorkbook pattern) */
  protected saveExcelFile(workbook: WorkBook, filename: string): void {
    writeFileXLSX(workbook, filename);
  }

  openImportModal(): void {
    this.showImportModal.set(true);
  }

  onImportSuccess(count: number): void {
    this.showImportModal.set(false);
    this.successMessage.set(this.t(count === 1 ? 'imported_one' : 'imported_other', { count }));
    this.refreshAfterSave();
  }

  private submitTranslationImport(validRows: Record<string, any>[]): Observable<CustomImportResult> {
    const locale = this.selectedLocale();
    const payload: UpsertTranslation[] = validRows.map(row => ({
      source_type: row['source_type'],
      source_key: row['source_key'],
      locale,
      translated_text: row['translated_text']
    }));

    return this.translationAdmin.upsertTranslations(payload).pipe(
      map(response => ({
        success: response.success,
        importedCount: response.success ? payload.length : 0,
        errorCount: response.success ? 0 : payload.length,
        errors: response.success ? [] : [{
          index: 1,
          error: response.error?.humanMessage || this.t('import_failed')
        }]
      }))
    );
  }

  private generateImportTemplate(): void {
    const missing = this.missingTranslations();


    // Include English Default inline for translator context — the import
    // parser only reads columns defined in translationImportConfig.columns,
    // so "English Default" is naturally ignored on upload.
    const dataRows = missing.map(m => ({
      [EXCEL_HEADERS.sourceType]: m.source_type,
      [EXCEL_HEADERS.sourceKey]: m.source_key,
      [EXCEL_HEADERS.englishDefault]: m.default_text,
      [EXCEL_HEADERS.translatedText]: ''
    }));

    const dataSheet = this.excelSheet('hint_enter', dataRows);

    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, dataSheet, this.sheetName('sheet_import_data', 'Import Data'));

    const date = new Date().toISOString().slice(0, 10);
    this.saveExcelFile(workbook, `translation_template_${this.selectedLocale()}_${date}.xlsx`);
  }

  // ── Helpers ───────────────────────────────────

  dismissSuccess() {
    this.successMessage.set(undefined);
  }

  dismissError() {
    this.error.set(undefined);
  }

  /** Look up the English default text for a given source type and key */
  getDefault(sourceType: string, sourceKey: string): string {
    return this.defaults().get(`${sourceType}:${sourceKey}`) ?? '';
  }

  /** Source type label in the UI language. Reads version() so a template call re-renders on a language
   * change; an unknown type shows as itself. */
  sourceTypeLabel(type: string): string {
    this.translationService.version();
    return LABELED_SOURCE_TYPES.includes(type) ? this.t('source_type.' + type) : type;
  }

  /** An `admin_translations.` string in the UI language */
  private t(key: string, params?: Record<string, string | number>): string {
    return this.translationService.get('admin_translations.' + key, params);
  }

  /** A translated sheet name Excel accepts: no []:*?/\ and at most 31 characters, else the English name.
   * An admin can edit the translation, so it is not trusted to fit. */
  private sheetName(key: string, english: string): string {
    // Excel's sheet name rules: at most 31 characters, none of []:*?/\, no leading or trailing apostrophe,
    // and not the reserved name History. Admins can edit these translations, so fall back to English.
    const name = this.t(key).replace(/[[\]:*?/\\]/g, '').trim().slice(0, 31).replace(/^[\s']+|[\s']+$/g, '');
    return name && name.toLowerCase() !== 'history' ? name : english;
  }

  /**
   * An Excel sheet the importer reads back: row 1 holds a hint per column in the UI language, row 2 the
   * English headers, row 3 on the data (parseExcelFile skips row 1 and keys rows by row 2).
   */
  private excelSheet(translatedTextHint: 'hint_edit' | 'hint_enter', rows: Record<string, string>[]): WorkSheet {
    const headers: string[] = Object.values(EXCEL_HEADERS);
    const hints = {
      [EXCEL_HEADERS.sourceType]: this.t('hint_do_not_edit'),
      [EXCEL_HEADERS.sourceKey]: this.t('hint_do_not_edit'),
      [EXCEL_HEADERS.englishDefault]: this.t('hint_reference'),
      [EXCEL_HEADERS.translatedText]: this.t(translatedTextHint)
    };
    const headerRow = Object.fromEntries(headers.map(h => [h, h]));
    return utils.json_to_sheet([hints, headerRow, ...rows], { header: headers, skipHeader: true });
  }
}
