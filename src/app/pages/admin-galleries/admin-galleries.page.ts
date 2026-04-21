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

import { Component, inject, signal, computed, effect, ChangeDetectionStrategy, OnInit, OnDestroy } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, Subject, catchError, combineLatest, debounceTime, distinctUntilChanged, map, of } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { GalleryService } from '../../services/gallery.service';
import { EntityPropertyType, SchemaEntityTable, SchemaEntityProperty } from '../../interfaces/entity';
import { getPostgrestUrl } from '../../config/runtime';
import { PaginationComponent } from '../../components/pagination/pagination.component';

interface GalleryAdminRow {
  id: string;
  entity_type: string;
  entity_id: string | null;
  property_name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  is_linked: boolean;
  image_count: number;
  total_size: number;
}

/**
 * AdminGalleriesPage — Centralized gallery administration for administrators.
 *
 * Reads from the `gallery_admin` VIEW (aggregated: image count + total size per gallery).
 * Permission-gated: requires admin role.
 *
 * Reactive architecture using Angular signals + effects:
 *   URL params → signals → effects → HTTP → result signals → template
 *
 * Features:
 * - Gallery list with filters (entity_type, linked/draft status, date range, search)
 * - Stats: total galleries, total images, storage usage
 * - Entity navigation: link from gallery → parent entity detail page
 * - Orphan management: view draft galleries
 *
 * @since v0.47.0
 */
@Component({
  selector: 'app-admin-galleries',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, RouterLink, PaginationComponent],
  templateUrl: './admin-galleries.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminGalleriesPage implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private schema = inject(SchemaService);
  private galleryService = inject(GalleryService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private readonly apiUrl = getPostgrestUrl();
  private subscriptions = new Subscription();

  // Permission
  canView = computed(() => this.auth.isAdmin());

  // Schema-driven entity type dropdown
  allEntities = signal<SchemaEntityTable[]>([]);
  allProperties = signal<SchemaEntityProperty[]>([]);

  /** Entities that have at least one PhotoGallery property */
  entityOptions = computed(() => {
    const entities = this.allEntities();
    const props = this.allProperties();
    const entityTablesWithGalleries = new Set(
      props.filter(p => p.type === EntityPropertyType.PhotoGallery).map(p => p.table_name)
    );
    return entities
      .filter(e => entityTablesWithGalleries.has(e.table_name))
      .map(e => ({ value: e.table_name, label: e.display_name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  // Data + loading
  loading = signal(true);
  error = signal<string | undefined>(undefined);
  galleries = signal<GalleryAdminRow[]>([]);
  totalCount = signal(0);

  // Stats
  totalGalleries = signal(0);
  totalImages = signal(0);
  totalStorageBytes = signal(0);

  // URL-driven state (synced from route.queryParams in ngOnInit)
  filterEntityType = signal('');
  filterStatus = signal<'all' | 'linked' | 'draft'>('all');
  filterDateFrom = signal('');
  filterDateTo = signal('');
  filterSearch = signal('');
  currentPage = signal(1);
  pageSize = signal(25);
  sortColumn = signal<string>('created_at');
  sortDirection = signal<'asc' | 'desc'>('desc');

  // Non-URL state
  refreshTrigger = signal(0);

  private searchDebounce$ = new Subject<string>();

  // Data load effect
  private dataLoadEffect = effect((onCleanup) => {
    // Read all filter/sort/page signals to establish dependencies
    const entityType = this.filterEntityType();
    const status = this.filterStatus();
    const dateFrom = this.filterDateFrom();
    const dateTo = this.filterDateTo();
    const search = this.filterSearch();
    const page = this.currentPage();
    const size = this.pageSize();
    const sort = this.sortColumn();
    const dir = this.sortDirection();
    const _refresh = this.refreshTrigger();

    if (!this.canView()) return;

    this.loading.set(true);
    this.error.set(undefined);

    // Build query
    let params = `select=*&order=${sort}.${dir}`;
    const offset = (page - 1) * size;
    params += `&limit=${size}&offset=${offset}`;

    if (entityType) {
      params += `&entity_type=eq.${entityType}`;
    }
    if (status === 'linked') {
      params += `&is_linked=eq.true`;
    } else if (status === 'draft') {
      params += `&is_linked=eq.false`;
    }
    if (dateFrom) {
      params += `&created_at=gte.${dateFrom}T00:00:00Z`;
    }
    if (dateTo) {
      params += `&created_at=lte.${dateTo}T23:59:59Z`;
    }
    if (search) {
      params += `&entity_id=ilike.*${search}*`;
    }

    const sub = this.http.get<GalleryAdminRow[]>(
      `${this.apiUrl}gallery_admin?${params}`,
      { headers: { 'Prefer': 'count=exact' }, observe: 'response' }
    ).subscribe({
      next: (response) => {
        const range = response.headers.get('Content-Range');
        if (range) {
          const match = range.match(/\/(\d+|\*)/);
          if (match && match[1] !== '*') {
            this.totalCount.set(parseInt(match[1], 10));
          }
        }
        this.galleries.set(response.body || []);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set('Failed to load galleries');
        this.loading.set(false);
        console.error('Gallery admin load error:', err);
      }
    });
    onCleanup(() => sub.unsubscribe());
  });

  ngOnInit() {
    this.loadStats();
    this.loadSchemaData();
    this.subscribeToQueryParams();

    // Debounce search input — 400ms pause before triggering navigation
    this.subscriptions.add(
      this.searchDebounce$.pipe(debounceTime(400)).subscribe(query => {
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
   * Subscribe to URL query params → sync to signals.
   * Only does signal sync — data loading is handled reactively by effects.
   */
  private subscribeToQueryParams() {
    this.subscriptions.add(
      this.route.queryParams.pipe(
        map(p => ({
          entity: p['entity'] || '',
          status: (p['status'] || 'all') as 'all' | 'linked' | 'draft',
          from: p['from'] || '',
          to: p['to'] || '',
          q: p['q'] || '',
          sort: p['sort'] || 'created_at',
          dir: (p['dir'] || 'desc') as 'asc' | 'desc',
          page: +(p['page'] || 1),
          pageSize: +(p['pageSize'] || 25),
        })),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))
      ).subscribe(state => {
        this.filterEntityType.set(state.entity);
        this.filterStatus.set(state.status);
        this.filterDateFrom.set(state.from);
        this.filterDateTo.set(state.to);
        this.filterSearch.set(state.q);
        this.sortColumn.set(state.sort);
        this.sortDirection.set(state.dir);
        this.currentPage.set(state.page);
        this.pageSize.set(state.pageSize);
      })
    );
  }

  private loadStats() {
    this.subscriptions.add(
      this.galleryService.getStorageStats().pipe(
        catchError(() => of({ total_galleries: 0, total_images: 0, total_storage_bytes: 0 }))
      ).subscribe((stats: any) => {
        this.totalGalleries.set(stats.total_galleries || 0);
        this.totalImages.set(stats.total_images || 0);
        this.totalStorageBytes.set(stats.total_storage_bytes || 0);
      })
    );
  }

  /** Load entity/property metadata for the entity type dropdown */
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

  // --- URL Navigation / State Changes ---

  onEntityTypeFilterChange(value: string) {
    this.router.navigate([], {
      queryParams: { entity: value || null, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onStatusFilterChange(value: string) {
    this.router.navigate([], {
      queryParams: { status: value === 'all' ? null : value, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onDateFromChange(value: string) {
    this.router.navigate([], {
      queryParams: { from: value || null, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onDateToChange(value: string) {
    this.router.navigate([], {
      queryParams: { to: value || null, page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onSearchChange(value: string) {
    this.searchDebounce$.next(value);
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

  refresh() {
    this.refreshTrigger.update(n => n + 1);
    this.loadStats();
  }

  getSortIcon(column: string): string {
    if (this.sortColumn() !== column) return 'unfold_more';
    return this.sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  // --- Helpers ---

  formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  getEntityRoute(gallery: GalleryAdminRow): string[] | null {
    if (!gallery.entity_id) return null;
    return ['/view', gallery.entity_type, gallery.entity_id];
  }
}
