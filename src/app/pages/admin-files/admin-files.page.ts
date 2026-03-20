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

import { Component, inject, signal, computed, effect, untracked, ChangeDetectionStrategy, OnInit, OnDestroy } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { of, catchError, Subscription, combineLatest, map, switchMap, distinctUntilChanged, Subject, debounceTime } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { getPostgrestUrl, getS3Config } from '../../config/runtime';
import { FileReference, EntityPropertyType, SchemaEntityProperty, SchemaEntityTable } from '../../interfaces/entity';
import { FilterCriteria } from '../../interfaces/query';
import { PaginationComponent } from '../../components/pagination/pagination.component';
import { FilterBarComponent } from '../../components/filter-bar/filter-bar.component';

interface EntityOption {
  value: string;
  label: string;
}

/**
 * AdminFilesPage - Centralized file administration for administrators
 *
 * Two viewing modes:
 * - All Files (default): Browse/filter all files directly with inline filters
 * - Entity Files: Select entity type, apply entity-level filters, then view associated files
 *
 * Reactive architecture using Angular signals + effects:
 *   URL params → signals → effects → HTTP → result signals → template
 *
 * Three effects drive data loading:
 *   1. entityPropsEffect: loads entity schema when currentEntityType changes
 *   2. phase1Effect: entity-level query (extracts linked file IDs from entity FK columns)
 *   3. dataLoadEffect: file-level query (All Files direct, or Phase 2 by file IDs)
 *
 * Phase 1 updates cachedFileIds → triggers dataLoadEffect for Phase 2.
 * Page/sort/file-filter changes only trigger dataLoadEffect (skip Phase 1).
 *
 * v0.39.0
 */
@Component({
  selector: 'app-admin-files',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, RouterLink, PaginationComponent, FilterBarComponent],
  templateUrl: './admin-files.page.html',
  styleUrl: './admin-files.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminFilesPage implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private schema = inject(SchemaService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private readonly apiUrl = getPostgrestUrl();

  // Permission
  canViewFiles = computed(() => this.auth.hasPermission('files', 'read'));

  // Data + loading
  loading = signal(true);
  loadingPhase = signal<'idle' | 'searching-entities' | 'loading-files'>('idle');
  error = signal<string | undefined>(undefined);
  files = signal<FileReference[]>([]);
  totalCount = signal(0);

  // Stats
  totalFileCount = signal(0);
  totalFileSize = signal(0);

  // Entity Files mode cached state (Phase 1 output → Phase 2 input)
  cachedFileIds = signal<string[]>([]);
  cachedEntityNames = signal<Map<string, string>>(new Map());
  entityProperties = signal<SchemaEntityProperty[]>([]);

  // All entities and their file properties (for dropdown)
  allEntities = signal<SchemaEntityTable[]>([]);
  allProperties = signal<SchemaEntityProperty[]>([]);

  // Selection
  selectedFileIds = signal<Set<string>>(new Set());

  // URL-driven state (synced from route.queryParams in ngOnInit)
  currentEntityType = signal<string>('all');
  currentFileTypeFilter = signal<string>('');
  currentDateFrom = signal<string>('');
  currentDateTo = signal<string>('');
  currentSearch = signal<string>('');
  currentPage = signal(1);
  currentPageSize = signal(25);
  sortColumn = signal<string>('created_at');
  sortDirection = signal<'asc' | 'desc'>('desc');
  entityFilters = signal<FilterCriteria[]>([]);

  // Computed: entities with file-type properties
  entityOptions = computed<EntityOption[]>(() => {
    const entities = this.allEntities();
    const props = this.allProperties();

    const fileTypes = [EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF];
    const entityTablesWithFiles = new Set(
      props.filter(p => fileTypes.includes(p.type)).map(p => p.table_name)
    );

    return entities
      .filter(e => entityTablesWithFiles.has(e.table_name))
      .map(e => ({ value: e.table_name, label: e.display_name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  // Computed: file property column names for current entity (used in Phase 1)
  filePropertyColumns = computed<string[]>(() => {
    const props = this.entityProperties();
    const fileTypes = [EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF];
    return props.filter(p => fileTypes.includes(p.type)).map(p => p.column_name);
  });

  // Computed: filterable properties for FilterBar
  filterableProperties = computed<SchemaEntityProperty[]>(() => {
    return this.entityProperties().filter(p => p.filterable);
  });

  private subscriptions = new Subscription();
  private searchDebounce$ = new Subject<string>();

  // ──────────────────────────────────────────────
  // Reactive Effects (signal-driven data loading)
  // ──────────────────────────────────────────────

  /**
   * Effect 1: Load entity properties when currentEntityType changes.
   * Sets entityProperties signal → filePropertyColumns computed auto-updates.
   */
  private entityPropsEffect = effect((onCleanup) => {
    const entityType = this.currentEntityType();
    if (entityType === 'all') {
      this.entityProperties.set([]);
      return;
    }
    const sub = untracked(() =>
      this.schema.getEntity(entityType).pipe(
        switchMap(entity => entity ? this.schema.getPropertiesForEntity(entity) : of([] as SchemaEntityProperty[]))
      ).subscribe(props => this.entityProperties.set(props))
    );
    onCleanup(() => sub.unsubscribe());
  });

  /**
   * Effect 2: Phase 1 — entity-level query.
   * Reads: currentEntityType, entityFilters, filePropertyColumns
   * Writes: cachedFileIds, cachedEntityNames (triggers dataLoadEffect)
   *
   * Only runs in entity mode. Skips if filePropertyColumns is empty (properties still loading).
   * Selects entity id + display column + file FK columns, extracts linked file UUIDs.
   */
  private phase1Effect = effect((onCleanup) => {
    const entityType = this.currentEntityType();
    if (entityType === 'all') {
      // Clear entity-mode cache when switching to All Files
      this.cachedFileIds.set([]);
      this.cachedEntityNames.set(new Map());
      return;
    }
    const entityFilters = this.entityFilters();
    const fileCols = this.filePropertyColumns();

    // Set loading state early so the spinner message is visible while properties load
    this.loading.set(true);
    this.loadingPhase.set('searching-entities');
    this.error.set(undefined);

    if (fileCols.length === 0) {
      // Properties not loaded yet — clear stale cache while waiting
      this.cachedFileIds.set([]);
      return;
    }

    // Properties are loaded, proceed with Phase 1
    this.selectedFileIds.set(new Set());

    // Build Phase 1 query: id, display column, + file FK columns
    const displayCol = untracked(() => this.getDisplayColumn(entityType));
    const selectParts = ['id'];
    if (displayCol !== 'id') selectParts.push(displayCol);
    selectParts.push(...fileCols);
    let queryParams = `select=${[...new Set(selectParts)].join(',')}`;

    // Apply entity filters
    entityFilters.forEach(f => {
      if (f.operator === 'in' && Array.isArray(f.value)) {
        queryParams += `&${f.column}=in.(${f.value.join(',')})`;
      } else {
        queryParams += `&${f.column}=${f.operator}.${f.value}`;
      }
    });

    // Null filter: only entities with at least one file FK set
    if (fileCols.length === 1) {
      queryParams += `&${fileCols[0]}=not.is.null`;
    } else {
      queryParams += `&or=(${fileCols.map(c => `${c}.not.is.null`).join(',')})`;
    }

    const sub = this.http.get<any[]>(`${this.apiUrl}${entityType}?${queryParams}`).pipe(
      catchError(err => {
        console.error('Phase 1 error:', err);
        this.error.set('Failed to search entities');
        this.loading.set(false);
        this.loadingPhase.set('idle');
        return of([]);
      })
    ).subscribe(entities => {
      if (entities.length === 0) {
        this.cachedFileIds.set([]);
        this.cachedEntityNames.set(new Map());
        this.files.set([]);
        this.totalCount.set(0);
        this.loading.set(false);
        this.loadingPhase.set('idle');
        return;
      }

      if (entities.length > 5000) {
        this.error.set(`Found ${entities.length} matching entities. Please refine your filters to narrow results.`);
        this.loading.set(false);
        this.loadingPhase.set('idle');
        return;
      }

      // Extract file UUIDs from entity file columns and cache entity display names
      const fileIdSet = new Set<string>();
      const nameMap = new Map<string, string>();
      entities.forEach(e => {
        const entityId = String(e.id);
        const name = displayCol !== 'id' ? (e[displayCol] || entityId) : entityId;
        nameMap.set(entityId, name);
        for (const col of fileCols) {
          if (e[col]) fileIdSet.add(String(e[col]));
        }
      });

      this.cachedFileIds.set([...fileIdSet]);
      this.cachedEntityNames.set(nameMap);
      // Phase 2 triggers automatically via dataLoadEffect (cachedFileIds changed)
    });
    onCleanup(() => sub.unsubscribe());
  });

  /**
   * Effect 3: Data load — All Files mode or Phase 2.
   * Reads: currentEntityType, page/sort/file-filter signals,
   *        cachedFileIds (only in entity mode — conditional read)
   *
   * In All Files mode: direct query to /files with filters.
   * In Entity mode: queries /files?id=in.(cachedFileIds) — only linked files, no orphans.
   */
  private dataLoadEffect = effect((onCleanup) => {
    const entityType = this.currentEntityType();
    // Read file-level + pagination signals to establish dependencies
    const page = this.currentPage();
    const size = this.currentPageSize();
    const sort = this.sortColumn();
    const dir = this.sortDirection();
    const ftype = this.currentFileTypeFilter();
    const from = this.currentDateFrom();
    const to = this.currentDateTo();
    const q = this.currentSearch();

    if (entityType === 'all') {
      // All Files mode: direct query
      this.loading.set(true);
      this.loadingPhase.set('idle');
      this.error.set(undefined);
      this.selectedFileIds.set(new Set());

      const params = untracked(() => this.buildAllFilesQueryParams());
      const sub = this.http.get<FileReference[]>(
        `${this.apiUrl}files?${params}`,
        { headers: { 'Prefer': 'count=exact' }, observe: 'response' }
      ).subscribe({
        next: (response) => {
          this.extractTotalCount(response.headers.get('Content-Range'));
          this.files.set(response.body || []);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set('Failed to load files');
          this.loading.set(false);
          console.error('Error loading files:', err);
        }
      });
      onCleanup(() => sub.unsubscribe());
    } else {
      // Entity mode: Phase 2 — query by cached file IDs
      const fileIds = this.cachedFileIds(); // Only tracked in entity branch
      if (fileIds.length === 0) return; // Phase 1 not done yet or no files

      this.loading.set(true);
      this.loadingPhase.set('loading-files');

      const offset = (page - 1) * size;
      let params = `select=*&id=in.(${fileIds.join(',')})`;
      params += untracked(() => this.buildFileFilterParams());
      params += `&order=${sort}.${dir}`;
      params += `&limit=${size}&offset=${offset}`;

      const sub = this.http.get<FileReference[]>(
        `${this.apiUrl}files?${params}`,
        { headers: { 'Prefer': 'count=exact' }, observe: 'response' }
      ).subscribe({
        next: (response) => {
          this.extractTotalCount(response.headers.get('Content-Range'));
          this.files.set(response.body || []);
          this.loading.set(false);
          this.loadingPhase.set('idle');
        },
        error: (err) => {
          this.error.set('Failed to load files');
          this.loading.set(false);
          this.loadingPhase.set('idle');
          console.error('Phase 2 error:', err);
        }
      });
      onCleanup(() => sub.unsubscribe());
    }
  });

  ngOnInit() {
    this.loadStorageStats();
    this.loadSchemaData();
    this.subscribeToQueryParams();

    // Debounce search input — 500ms pause before triggering navigation
    this.subscriptions.add(
      this.searchDebounce$.pipe(debounceTime(500)).subscribe(query => {
        this.router.navigate([], {
          queryParams: { q: query || null, page: 1 },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      })
    );
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
  }

  /**
   * Load entity/property metadata for the entity dropdown
   */
  private loadSchemaData() {
    this.subscriptions.add(
      combineLatest([
        this.schema.getEntities(),
        this.schema.getProperties()
      ]).subscribe(([entities, props]) => {
        this.allEntities.set(entities);
        this.allProperties.set(props);
      })
    );
  }

  /**
   * Subscribe to URL query params → sync to signals.
   * Only does signal sync — data loading is handled reactively by effects.
   */
  private subscribeToQueryParams() {
    this.subscriptions.add(
      this.route.queryParams.pipe(
        map(p => ({
          entity: p['entity'] || 'all',
          ftype: p['ftype'] || '',
          from: p['from'] || '',
          to: p['to'] || '',
          q: p['q'] || '',
          sort: p['sort'] || 'created_at',
          dir: (p['dir'] || 'desc') as 'asc' | 'desc',
          page: +(p['page'] || 1),
          pageSize: +(p['pageSize'] || 25),
          filters: this.parseFilterParams(p)
        })),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))
      ).subscribe(state => {
        this.currentEntityType.set(state.entity);
        this.currentFileTypeFilter.set(state.ftype);
        this.currentDateFrom.set(state.from);
        this.currentDateTo.set(state.to);
        this.currentSearch.set(state.q);
        this.sortColumn.set(state.sort);
        this.sortDirection.set(state.dir);
        this.currentPage.set(state.page);
        this.currentPageSize.set(state.pageSize);
        this.entityFilters.set(state.filters);
      })
    );
  }

  /**
   * Parse f0_col, f0_op, f0_val filter params from URL
   */
  private parseFilterParams(params: { [key: string]: string }): FilterCriteria[] {
    const filters: FilterCriteria[] = [];
    for (let i = 0; ; i++) {
      const col = params[`f${i}_col`];
      const op = params[`f${i}_op`];
      const val = params[`f${i}_val`];
      if (!col || !op) break;

      let parsedVal: any = val;
      if (op === 'in' && val) {
        const cleaned = val.replace(/^\(/, '').replace(/\)$/, '');
        parsedVal = cleaned.split(',').map(v => v.trim());
      }

      filters.push({ column: col, operator: op, value: parsedVal });
    }
    return filters;
  }

  // ──────────────────────────────────────────────
  // Query Builders
  // ──────────────────────────────────────────────

  private buildAllFilesQueryParams(): string {
    const params: string[] = ['select=*'];

    const fileFilters = this.buildFileFilterParams();
    if (fileFilters) params.push(fileFilters.substring(1)); // strip leading &

    params.push(`order=${this.sortColumn()}.${this.sortDirection()}`);

    const page = this.currentPage();
    const size = this.currentPageSize();
    const offset = (page - 1) * size;
    params.push(`limit=${size}`);
    params.push(`offset=${offset}`);

    return params.join('&');
  }

  /**
   * Build file-level filter params (file type, date range, filename search).
   * Returns a string prefixed with & for easy concatenation, or empty string if no filters.
   */
  private buildFileFilterParams(): string {
    const parts: string[] = [];

    const ftype = this.currentFileTypeFilter();
    if (ftype) {
      if (ftype === 'documents') {
        parts.push(`or=(file_type.eq.application/pdf,file_type.like.application/vnd.openxmlformats%,file_type.like.application/vnd.ms-%,file_type.like.application/vnd.oasis.opendocument%,file_type.like.application/msword%)`);
      } else if (ftype.includes('*')) {
        parts.push(`file_type=like.${ftype.replace('*', '%')}`);
      } else {
        parts.push(`file_type=eq.${ftype}`);
      }
    }

    const from = this.currentDateFrom();
    if (from) parts.push(`created_at=gte.${from}T00:00:00Z`);

    const to = this.currentDateTo();
    if (to) parts.push(`created_at=lte.${to}T23:59:59Z`);

    const q = this.currentSearch();
    if (q) parts.push(`file_name=ilike.*${q}*`);

    return parts.length > 0 ? '&' + parts.join('&') : '';
  }

  // ──────────────────────────────────────────────
  // Shared Helpers
  // ──────────────────────────────────────────────

  private extractTotalCount(contentRange: string | null) {
    if (contentRange) {
      const match = contentRange.match(/\/(\d+|\*)/);
      if (match && match[1] !== '*') {
        this.totalCount.set(parseInt(match[1], 10));
      }
    }
  }

  /**
   * Determine which column to use as display name for an entity type.
   * Convention: use display_name if it exists, else first text list property, else id.
   */
  getDisplayColumn(entityType: string): string {
    const props = this.entityProperties();
    if (props.some(p => p.column_name === 'display_name')) return 'display_name';
    const firstTextProp = props.find(p =>
      p.show_on_list && [EntityPropertyType.TextShort, EntityPropertyType.TextLong].includes(p.type)
    );
    return firstTextProp?.column_name || 'id';
  }

  /**
   * Load storage stats via RPC
   */
  private loadStorageStats() {
    this.subscriptions.add(
      this.http.post<{ total_count: number; total_size_bytes: number }[]>(
        `${this.apiUrl}rpc/get_file_storage_stats`, {}
      ).pipe(catchError(() => of([{ total_count: 0, total_size_bytes: 0 }])))
        .subscribe(result => {
          const stats = result[0] || { total_count: 0, total_size_bytes: 0 };
          this.totalFileCount.set(stats.total_count);
          this.totalFileSize.set(stats.total_size_bytes);
        })
    );
  }

  // ──────────────────────────────────────────────
  // URL Navigation / State Changes
  // ──────────────────────────────────────────────

  onEntitySelectedByValue(value: string) {
    this.router.navigate([], {
      queryParams: {
        entity: value,
        page: 1,
        // Clear entity filters (entity-specific, don't carry over)
        f0_col: null, f0_op: null, f0_val: null,
        f1_col: null, f1_op: null, f1_val: null,
        f2_col: null, f2_op: null, f2_val: null,
        f3_col: null, f3_op: null, f3_val: null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onPageChange(page: number) {
    this.router.navigate([], {
      queryParams: { page },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onPageSizeChange(size: number) {
    this.router.navigate([], {
      queryParams: { pageSize: size, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onSort(column: string) {
    let dir: 'asc' | 'desc' = 'desc';
    if (this.sortColumn() === column) {
      dir = this.sortDirection() === 'asc' ? 'desc' : 'asc';
    }
    this.router.navigate([], {
      queryParams: { sort: column, dir },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  getSortIcon(column: string): string {
    if (this.sortColumn() !== column) return 'unfold_more';
    return this.sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  onFileTypeFilterChange(ftype: string) {
    this.router.navigate([], {
      queryParams: { ftype: ftype || null, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onDateFromChange(date: string) {
    this.router.navigate([], {
      queryParams: { from: date || null, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onDateToChange(date: string) {
    this.router.navigate([], {
      queryParams: { to: date || null, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onSearchChange(query: string) {
    this.searchDebounce$.next(query);
  }

  onEntityFiltersChange(filters: FilterCriteria[]) {
    const params: { [key: string]: string | null } = { page: '1' };

    // Clear old filter params
    for (let i = 0; i < 10; i++) {
      params[`f${i}_col`] = null;
      params[`f${i}_op`] = null;
      params[`f${i}_val`] = null;
    }

    // Set new filter params
    filters.forEach((f, i) => {
      params[`f${i}_col`] = f.column;
      params[`f${i}_op`] = f.operator;
      if (Array.isArray(f.value)) {
        params[`f${i}_val`] = `(${f.value.join(',')})`;
      } else {
        params[`f${i}_val`] = String(f.value);
      }
    });

    this.router.navigate([], {
      queryParams: params,
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  refresh() {
    // Bump a signal to re-trigger effects without URL change
    // Simplest: re-set the same entity type to trigger the effect chain
    const current = this.currentEntityType();
    this.currentEntityType.set('');
    // Microtask ensures the effect sees the change
    queueMicrotask(() => this.currentEntityType.set(current));
  }

  // ──────────────────────────────────────────────
  // File Display Helpers
  // ──────────────────────────────────────────────

  getS3Url(key: string): string {
    const s3 = getS3Config();
    return `${s3.endpoint}/${s3.bucket}/${key}`;
  }

  getThumbnailUrl(file: FileReference): string | null {
    if (file.thumbnail_status === 'completed' && file.s3_thumbnail_small_key) {
      return this.getS3Url(file.s3_thumbnail_small_key);
    }
    return null;
  }

  getFileIcon(fileType: string): string {
    if (fileType.startsWith('image/')) return 'image';
    if (fileType === 'application/pdf') return 'picture_as_pdf';
    if (fileType.startsWith('video/')) return 'videocam';
    if (fileType.startsWith('audio/')) return 'audio_file';
    if (fileType.includes('spreadsheet') || fileType.includes('excel')) return 'table_chart';
    if (fileType.includes('document') || fileType.includes('word')) return 'description';
    return 'insert_drive_file';
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  getEntityDisplayName(file: FileReference): string {
    if (this.currentEntityType() !== 'all') {
      return this.cachedEntityNames().get(file.entity_id) || file.entity_id;
    }
    const entity = this.allEntities().find(e => e.table_name === file.entity_type);
    return entity?.display_name || file.entity_type;
  }

  getEntityRoute(file: FileReference): string[] {
    return ['/view', file.entity_type, file.entity_id];
  }

  getPropertyDisplayName(file: FileReference): string {
    if (!file.property_name) return '—';
    const entityProps = this.entityProperties();
    const match = entityProps.find(p => p.column_name === file.property_name && p.table_name === file.entity_type);
    if (match) return match.display_name;
    const allMatch = this.allProperties().find(p => p.column_name === file.property_name && p.table_name === file.entity_type);
    if (allMatch) return allMatch.display_name;
    return file.property_name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // ──────────────────────────────────────────────
  // Selection
  // ──────────────────────────────────────────────

  toggleFileSelection(id: string) {
    const current = new Set(this.selectedFileIds());
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    this.selectedFileIds.set(current);
  }

  toggleSelectAll() {
    const current = this.selectedFileIds();
    const allIds = this.files().map(f => f.id);
    if (current.size === allIds.length && allIds.every(id => current.has(id))) {
      this.selectedFileIds.set(new Set());
    } else {
      this.selectedFileIds.set(new Set(allIds));
    }
  }

  isAllSelected(): boolean {
    const files = this.files();
    const selected = this.selectedFileIds();
    return files.length > 0 && files.every(f => selected.has(f.id));
  }

  downloadSelected() {
    const selected = this.selectedFileIds();
    const filesToDownload = this.files().filter(f => selected.has(f.id));
    for (const file of filesToDownload) {
      window.open(this.getS3Url(file.s3_original_key), '_blank');
    }
  }

  // File type filter options
  fileTypeOptions = [
    { value: '', label: 'All Types' },
    { value: 'image/*', label: 'Images' },
    { value: 'documents', label: 'Documents' },
    { value: 'video/*', label: 'Videos' },
    { value: 'audio/*', label: 'Audio' },
  ];
}
