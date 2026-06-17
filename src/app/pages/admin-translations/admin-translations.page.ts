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
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, Subject, Subscription, debounceTime } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { utils, writeFileXLSX, WorkBook } from 'xlsx';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { ImportModalComponent } from '../../components/import-modal/import-modal.component';
import { CustomImportConfig, CustomImportResult } from '../../interfaces/import';
import { TranslationAdminService, Translation, MissingTranslation, UpsertTranslation } from '../../services/translation-admin.service';
import { TranslationService } from '../../services/translation.service';
import { SchemaService } from '../../services/schema.service';
import { DashboardService } from '../../services/dashboard.service';
import { LocaleService, LocaleInfo } from '../../services/locale.service';

/** Source types shown in the filter dropdown.
 * 'widget_config' is grouped under 'dashboard' in the UI. */
const SOURCE_TYPES = [
  'ui', 'entity', 'property', 'status', 'category',
  'action', 'action_param', 'guided_form_step', 'static_text',
  'dashboard'
];

@Component({
  selector: 'app-admin-translations',
  standalone: true,
  imports: [CommonModule, FormsModule, CosModalComponent, ImportModalComponent],
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
  readonly targetLocales: LocaleInfo[] = this.localeService.supportedLocales.filter(l => l.code !== 'en');

  // URL-driven filter state (synced from route.queryParams in ngOnInit)
  selectedLocale = signal<string>(this.targetLocales[0]?.code ?? 'es');
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
      // 'dashboard' filter includes 'widget_config' (grouped in UI)
      list = sourceType === 'dashboard'
        ? list.filter(m => m.source_type === 'dashboard' || m.source_type === 'widget_config')
        : list.filter(m => m.source_type === sourceType);
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

  translationImportConfig: CustomImportConfig = {
    title: 'Import Translations',
    itemLabel: 'translations',
    columns: [
      { name: 'Source Type', key: 'source_type', required: true, type: 'text' },
      { name: 'Source Key', key: 'source_key', required: true, type: 'text' },
      { name: 'Translated Text', key: 'translated_text', required: false, type: 'text' }
    ],
    preFilter: (rows: Record<string, any>[]) => rows.filter(r => r['translated_text']),
    submit: (validRows: Record<string, any>[]): Observable<CustomImportResult> => {
      return this.submitTranslationImport(validRows);
    },
    generateTemplate: () => {
      this.generateImportTemplate();
    }
  };

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
          locale: p['locale'] || this.targetLocales[0]?.code || 'es',
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
    this.updateUrl({ locale: value === this.targetLocales[0]?.code ? null : value });
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
      this.editError.set('Translation text is required');
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
          this.successMessage.set(this.editingTranslation() ? 'Translation updated' : 'Translation created');
          this.refreshAfterSave();
        } else {
          this.editError.set(response.error?.humanMessage || 'Failed to save translation');
        }
      },
      error: () => {
        this.editSaving.set(false);
        this.editError.set('Failed to save translation');
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
          this.successMessage.set('Translation deleted');
          this.refreshAfterSave();
        } else {
          this.showDeleteModal.set(false);
          this.error.set(response.error?.humanMessage || 'Failed to delete translation');
        }
      },
      error: () => {
        this.deleteLoading.set(false);
        this.showDeleteModal.set(false);
        this.error.set('Failed to delete translation');
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
    // Refresh schema cache (metadata VIEWs use t())
    this.schema.refreshCache();
    // Refresh dashboard cache (RPCs use t())
    this.dashboard.refreshCache();
  }

  // ── Export / Import ─────────────────────────

  exportTranslations(): void {
    const translations = this.filteredTranslations();
    if (translations.length === 0) return;

    const defaultsMap = this.defaults();
    const headers = ['Source Type', 'Source Key', 'English Default', 'Translated Text'];
    const hints = {
      'Source Type': 'Do not edit',
      'Source Key': 'Do not edit',
      'English Default': 'Reference only (ignored on import)',
      'Translated Text': 'Edit translations here'
    };
    const rows = translations.map(t => ({
      'Source Type': t.source_type,
      'Source Key': t.source_key,
      'English Default': defaultsMap.get(`${t.source_type}:${t.source_key}`) ?? '',
      'Translated Text': t.translated_text
    }));

    // Row 1 = hints, Row 2 = headers, Row 3+ = data (matches parseExcelFile range:1 convention)
    const worksheet = utils.json_to_sheet([hints, ...rows], { header: headers, skipHeader: false });
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, 'Translations');

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
    this.successMessage.set(`${count} translation${count === 1 ? '' : 's'} imported successfully.`);
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
          error: response.error?.humanMessage || 'Failed to import translations'
        }]
      }))
    );
  }

  private generateImportTemplate(): void {
    const missing = this.missingTranslations();

    // Row 1 = hints, Row 2 = headers, Row 3+ = data
    // (matches the entity import convention — parseExcelFile uses range:1 to skip hints)
    const headers = ['Source Type', 'Source Key', 'English Default', 'Translated Text'];
    const hints = {
      'Source Type': 'Do not edit',
      'Source Key': 'Do not edit',
      'English Default': 'Reference only (ignored on import)',
      'Translated Text': 'Enter translation here'
    };

    // Include English Default inline for translator context — the import
    // parser only reads columns defined in translationImportConfig.columns,
    // so "English Default" is naturally ignored on upload.
    const dataRows = missing.map(m => ({
      'Source Type': m.source_type,
      'Source Key': m.source_key,
      'English Default': m.default_text,
      'Translated Text': ''
    }));

    const dataSheet = utils.json_to_sheet([hints, ...dataRows], { header: headers, skipHeader: false });

    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, dataSheet, 'Import Data');

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

  /** Human-readable source type label */
  sourceTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      'ui': 'UI',
      'entity': 'Entity',
      'property': 'Property',
      'status': 'Status',
      'category': 'Category',
      'action': 'Action',
      'action_param': 'Param',
      'guided_form_step': 'Form Step',
      'static_text': 'Static Text',
      'dashboard': 'Dashboard',
      'widget_config': 'Dashboard'
    };
    return labels[type] || type;
  }
}
