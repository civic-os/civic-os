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

import { HttpClient } from '@angular/common/http';
import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable, combineLatest, filter, map, of, tap, shareReplay, finalize, catchError, take } from 'rxjs';
import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable, InverseRelationshipMeta, ManyToManyMeta, ParentHop, StatusValue, CategoryValue, StaticText, RenderableItem, isProperty, EntityAction } from '../interfaces/entity';
import { GuidedFormDefinition, GuidedFormStep } from '../interfaces/guided-form';
import { ValidatorFn, Validators } from '@angular/forms';
import { getPostgrestUrl } from '../config/runtime';
import { ConstraintMessage } from '../interfaces/api';
import { LocaleService } from './locale.service';
import type { M2mPropertyMetadata, StatusOption, CategoryOption } from '@civic-os/core';
import { ensureStructuralProps as coreEnsureStructuralProps, propsForList, propsForDetail, propsForCreate, propsForEdit, propsForFilter, getDefaultValueForProperty as coreGetDefaultValueForProperty, getColumnSpan as coreGetColumnSpan, getRenderableColumnSpan as coreGetRenderableColumnSpan, detailRenderables, createRenderables, editRenderables, getPropertyType as coreGetPropertyType, propertyToSelectString as corePropertyToSelectString, propertyToSelectStringForEdit as corePropertyToSelectStringForEdit, propertyToSelectStringForList as corePropertyToSelectStringForList } from '@civic-os/core';

export type { M2mPropertyMetadata, StatusOption, CategoryOption } from '@civic-os/core';

@Injectable({
  providedIn: 'root'
})
export class SchemaService {
  private http = inject(HttpClient);
  private readonly localeService = inject(LocaleService);

  public properties?: SchemaEntityProperty[];
  public constraintMessages?: ConstraintMessage[];
  private tables = signal<SchemaEntityTable[] | undefined>(undefined);

  // Cached observables for HTTP requests (with shareReplay)
  private schemaCache$?: Observable<SchemaEntityTable[]>;
  private propertiesCache$?: Observable<SchemaEntityProperty[]>;
  private m2mMetadataCache$?: Observable<M2mPropertyMetadata[]>;
  private constraintMessagesCache$?: Observable<ConstraintMessage[]>;

  // Status cache: keyed by entity_type (e.g., 'reservation_request', 'issue')
  // Signal-based cache for synchronous access without subscriptions (v0.24.0)
  // This prevents infinite loops when effects read status options
  private statusOptionsCache = signal<Map<string, StatusOption[]>>(new Map());
  private loadingStatuses = new Set<string>();

  // Legacy observable cache - kept for backward compatibility
  private statusesCache = new Map<string, Observable<StatusOption[]>>();

  // Category cache: keyed by entity_type (e.g., 'time_entry', 'building_type')
  // Signal-based cache for synchronous access (mirrors status pattern, v0.34.0)
  private categoryOptionsCache = signal<Map<string, CategoryOption[]>>(new Map());
  private loadingCategories = new Set<string>();
  private categoriesCache = new Map<string, Observable<CategoryOption[]>>();

  // Static text cache (v0.17.0)
  private staticTextCache$?: Observable<StaticText[]>;
  private loadingStaticText = false;

  // In-flight request tracking to prevent duplicate concurrent requests
  private loadingEntities = false;
  private loadingProperties = false;
  private loadingConstraintMessages = false;

  // Observable from signal - created once in injection context
  private tables$ = toObservable(this.tables).pipe(
    filter(tables => tables !== undefined),
    map(tables => tables!)
  );

  // Re-fetch schema data when locale changes (VIEWs return locale-aware text via t())
  // IMPORTANT: refreshCache() clears and re-reads caches — must use untracked()
  // to prevent those signal reads from becoming tracked dependencies (infinite loop).
  private localeEffect = (() => {
    let initial = true;
    return effect(() => {
      this.localeService.locale(); // Track the signal
      if (initial) {
        initial = false;
        return;
      }
      untracked(() => this.refreshCache());
    });
  })();

  private getSchema() {
    if (!this.schemaCache$) {
      this.schemaCache$ = this.http.get<SchemaEntityTable[]>(getPostgrestUrl() + 'schema_entities')
        .pipe(
          tap(tables => {
            this.tables.set(tables);
          }),
          finalize(() => {
            // Reset loading flag when HTTP completes (success or error)
            this.loadingEntities = false;
          }),
          shareReplay({ bufferSize: 1, refCount: false })
        );
    }
    return this.schemaCache$;
  }

  public init() {
    // Load schema on init
    this.getSchema().subscribe();
    // Preload constraint messages for error handling
    this.getConstraintMessages().subscribe();
  }

  public refreshCache() {
    // Clear cached observables to force fresh HTTP requests
    this.schemaCache$ = undefined;
    this.propertiesCache$ = undefined;
    this.m2mMetadataCache$ = undefined;
    this.constraintMessagesCache$ = undefined;
    this.staticTextCache$ = undefined;
    // Clear processed cache (properties must be cleared so next fetch uses new locale)
    this.properties = undefined;
    this.constraintMessages = undefined;
    // Clear status cache (keyed by entity_type)
    this.statusesCache.clear();
    this.statusOptionsCache.set(new Map());
    this.loadingStatuses.clear();
    // Clear category cache (keyed by entity_type)
    this.categoriesCache.clear();
    this.categoryOptionsCache.set(new Map());
    this.loadingCategories.clear();
    // Reset loading flags to allow new fetches
    this.loadingEntities = false;
    this.loadingProperties = false;
    this.loadingConstraintMessages = false;
    this.loadingStaticText = false;
    // Refresh schema eagerly (entities drive sidebar rendering).
    // Properties and constraint messages are NOT eagerly re-fetched here;
    // clearing their processed caches (above) ensures the next consumer
    // triggers a fresh fetch with the correct Accept-Language header,
    // while avoiding unnecessary form rebuilds across the app.
    this.getSchema().subscribe();
  }

  /**
   * Refresh only the statuses cache.
   * Use when metadata.statuses or metadata.status_types change.
   */
  public refreshStatusesCache(): void {
    this.statusesCache.clear();
    this.statusOptionsCache.set(new Map());
    this.loadingStatuses.clear();
  }

  /**
   * Refresh only the entities cache.
   * Use when metadata.entities, metadata.permissions, or metadata.roles change.
   */
  public refreshEntitiesCache(): void {
    // Clear cached observable to force fresh HTTP request
    this.schemaCache$ = undefined;
    // Reset loading flag to allow new fetch
    this.loadingEntities = false;
    this.getSchema().subscribe();
  }

  /**
   * Refresh only the properties cache.
   * Use when metadata.properties or metadata.validations change.
   */
  public refreshPropertiesCache(): void {
    // Clear both the processed cache and the HTTP cache
    this.properties = undefined;
    this.propertiesCache$ = undefined;
    this.m2mMetadataCache$ = undefined;
    // Reset loading flag to allow new fetch
    this.loadingProperties = false;
    // Trigger fetch - will re-enrich with M:M data
    this.getProperties().subscribe();
  }

  public getEntities(): Observable<SchemaEntityTable[]> {
    // Only trigger fetch if not already loaded AND not currently loading
    if (!this.tables() && !this.loadingEntities) {
      this.loadingEntities = true;
      this.getSchema().subscribe();
    }

    // Return pre-created observable that updates when signal changes
    return this.tables$;
  }
  public getEntity(key: string): Observable<SchemaEntityTable | undefined> {
    return this.getEntities().pipe(map(e => {
      return e.find(x => x.table_name == key);
    }));
  }
  public getProperties(): Observable<SchemaEntityProperty[]> {
    // Return cached properties if available
    if (this.properties) {
      return of(this.properties);
    }

    // Create cached HTTP observable if it doesn't exist
    if (!this.propertiesCache$ && !this.loadingProperties) {
      this.loadingProperties = true;
      this.propertiesCache$ = this.http.get<SchemaEntityProperty[]>(getPostgrestUrl() + 'schema_properties')
        .pipe(
          finalize(() => {
            // Reset loading flag when HTTP completes (success or error)
            this.loadingProperties = false;
          }),
          shareReplay({ bufferSize: 1, refCount: false })
        );
    }

    // Fetch both properties and tables to enable M:M enrichment
    // If cache wasn't created (shouldn't happen but guard against it), return empty
    if (!this.propertiesCache$) {
      return of([]);
    }

    // Fetch M:M metadata VIEW (cached separately, cleared alongside properties)
    if (!this.m2mMetadataCache$) {
      this.m2mMetadataCache$ = this.http.get<M2mPropertyMetadata[]>(
        getPostgrestUrl() + 'schema_m2m_properties'
      ).pipe(
        catchError(() => of([] as M2mPropertyMetadata[])),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }

    // Note: getEntities() returns a signal-derived observable that never completes.
    // We use take(1) to complete after first emission, enabling use with forkJoin/combineLatest.
    return combineLatest([
      this.propertiesCache$,
      this.getEntities().pipe(take(1)),
      this.m2mMetadataCache$
    ]).pipe(
      map(([props, tables, m2mMetadata]) => {
        // First, set property types
        const typedProps = props.map(p => {
          p.type = this.getPropertyType(p);
          return p;
        });

        // Then enrich with M:M virtual properties (including metadata flags) and sort
        const enriched = this.enrichPropertiesWithManyToMany(typedProps, tables, m2mMetadata);
        return enriched.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      }),
      tap(enrichedProps => {
        this.properties = enrichedProps;
      })
    );
  }

  // v0.44.0 getM2mOptionsSourceRpc() removed in v0.46.0.
  // M:M metadata (options_source_rpc, fk_search_modal, show_inline) is now
  // batch-loaded from schema_m2m_properties VIEW during getProperties()
  // and applied to synthetic properties in enrichPropertiesWithManyToMany().

  /**
   * Fetches constraint error messages from the database.
   * Used by ErrorService to display user-friendly error messages
   * instead of PostgreSQL constraint violation codes.
   * Results are cached and preloaded on app initialization.
   */
  public getConstraintMessages(): Observable<ConstraintMessage[]> {
    // Return cached messages if available
    if (this.constraintMessages) {
      return of(this.constraintMessages);
    }

    // Create cached HTTP observable if it doesn't exist
    if (!this.constraintMessagesCache$ && !this.loadingConstraintMessages) {
      this.loadingConstraintMessages = true;
      this.constraintMessagesCache$ = this.http.get<ConstraintMessage[]>(
        getPostgrestUrl() + 'constraint_messages'
      ).pipe(
        tap(messages => {
          this.constraintMessages = messages;
        }),
        catchError(err => {
          console.error('Failed to load constraint messages:', err);
          // Return empty array on error - graceful degradation
          return of([]);
        }),
        finalize(() => {
          // Reset loading flag when HTTP completes (success or error)
          this.loadingConstraintMessages = false;
        }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }

    // Return cached observable or empty array if cache wasn't created
    return this.constraintMessagesCache$ || of([]);
  }

  /**
   * Get statuses for a specific entity type from metadata.statuses.
   * Results are cached per entity_type to avoid redundant RPC calls.
   *
   * @param entityType The status_entity_type value (e.g., 'reservation_request', 'issue')
   * @returns Observable of StatusOption array sorted by sort_order
   */
  public getStatusesForEntity(entityType: string): Observable<StatusOption[]> {
    // Return cached observable if available
    const cached = this.statusesCache.get(entityType);
    if (cached) {
      return cached;
    }

    // Skip if already loading to prevent duplicate concurrent requests
    if (this.loadingStatuses.has(entityType)) {
      // Return empty observable that will be replaced when cache is populated
      // Callers should subscribe after a short delay or use the cached observable
      return of([]);
    }

    // Mark as loading
    this.loadingStatuses.add(entityType);

    // Call RPC to get statuses filtered by entity_type
    const status$ = this.http.post<StatusOption[]>(
      getPostgrestUrl() + 'rpc/get_statuses_for_entity',
      { p_entity_type: entityType }
    ).pipe(
      map(statuses => statuses.map(s => ({
        id: s.id,
        display_name: s.display_name,
        color: s.color,
        status_key: s.status_key
      }))),
      tap(statuses => {
        // Also update signal cache for synchronous access (v0.24.0)
        this.statusOptionsCache.update(cache => {
          const newCache = new Map(cache);
          newCache.set(entityType, statuses);
          return newCache;
        });
      }),
      catchError(err => {
        console.error(`Failed to load statuses for entity type '${entityType}':`, err);
        return of([]);
      }),
      finalize(() => {
        this.loadingStatuses.delete(entityType);
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );

    // Cache the observable
    this.statusesCache.set(entityType, status$);

    return status$;
  }

  /**
   * Get cached status options synchronously. Returns empty array if not loaded.
   * Use ensureStatusOptionsLoaded() to trigger loading if needed.
   *
   * @param entityType The status_entity_type value
   * @returns Cached StatusOption array or empty array
   */
  public getStatusOptionsSync(entityType: string): StatusOption[] {
    return this.statusOptionsCache().get(entityType) || [];
  }

  /**
   * Ensure status options are loaded for an entity type.
   * This triggers loading if not already cached or loading.
   * Use with getStatusOptionsSync() for subscription-free access in effects.
   *
   * @param entityType The status_entity_type value
   */
  public ensureStatusOptionsLoaded(entityType: string): void {
    // Check signal cache first
    if (this.statusOptionsCache().has(entityType)) {
      return;
    }
    // Check if already loading
    if (this.loadingStatuses.has(entityType)) {
      return;
    }
    // Trigger load (will update signal cache via tap in getStatusesForEntity)
    this.getStatusesForEntity(entityType).subscribe();
  }

  /**
   * Invalidate status options cache.
   * Call when statuses are modified to force reload on next access.
   *
   * @param entityType Optional - invalidate specific entity type, or all if not provided
   */
  public invalidateStatusCache(entityType?: string): void {
    if (entityType) {
      // Invalidate specific entity type
      this.statusesCache.delete(entityType);
      this.statusOptionsCache.update(cache => {
        const newCache = new Map(cache);
        newCache.delete(entityType);
        return newCache;
      });
    } else {
      // Invalidate all
      this.statusesCache.clear();
      this.statusOptionsCache.set(new Map());
    }
  }

  // ===========================================================================
  // CATEGORY CACHE (v0.34.0) - mirrors Status cache pattern
  // ===========================================================================

  /**
   * Get categories for a specific entity type from metadata.categories.
   * Results are cached per entity_type to avoid redundant RPC calls.
   */
  public getCategoriesForEntity(entityType: string): Observable<CategoryOption[]> {
    const cached = this.categoriesCache.get(entityType);
    if (cached) {
      return cached;
    }

    if (this.loadingCategories.has(entityType)) {
      return of([]);
    }

    this.loadingCategories.add(entityType);

    const category$ = this.http.post<CategoryOption[]>(
      getPostgrestUrl() + 'rpc/get_categories_for_entity',
      { p_entity_type: entityType }
    ).pipe(
      map(categories => categories.map(c => ({
        id: c.id,
        display_name: c.display_name,
        color: c.color
      }))),
      tap(categories => {
        this.categoryOptionsCache.update(cache => {
          const newCache = new Map(cache);
          newCache.set(entityType, categories);
          return newCache;
        });
      }),
      catchError(err => {
        console.error(`Failed to load categories for entity type '${entityType}':`, err);
        return of([]);
      }),
      finalize(() => {
        this.loadingCategories.delete(entityType);
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );

    this.categoriesCache.set(entityType, category$);
    return category$;
  }

  /**
   * Get cached category options synchronously. Returns empty array if not loaded.
   * Use ensureCategoryOptionsLoaded() to trigger loading if needed.
   */
  public getCategoryOptionsSync(entityType: string): CategoryOption[] {
    return this.categoryOptionsCache().get(entityType) || [];
  }

  /**
   * Ensure category options are loaded for an entity type.
   * Triggers loading if not already cached or loading.
   */
  public ensureCategoryOptionsLoaded(entityType: string): void {
    if (this.categoryOptionsCache().has(entityType)) {
      return;
    }
    if (this.loadingCategories.has(entityType)) {
      return;
    }
    this.getCategoriesForEntity(entityType).subscribe();
  }

  /**
   * Invalidate category options cache.
   */
  public invalidateCategoryCache(entityType?: string): void {
    if (entityType) {
      this.categoriesCache.delete(entityType);
      this.categoryOptionsCache.update(cache => {
        const newCache = new Map(cache);
        newCache.delete(entityType);
        return newCache;
      });
    } else {
      this.categoriesCache.clear();
      this.categoryOptionsCache.set(new Map());
    }
  }

  // ===========================================================================
  // GUIDED FORM SUPPORT (v0.48.0)
  // ===========================================================================

  private guidedFormDefinitionsCache$?: Observable<GuidedFormDefinition[]>;
  private guidedFormStepsCache$?: Observable<GuidedFormStep[]>;

  public getGuidedFormDefinitions(): Observable<GuidedFormDefinition[]> {
    if (!this.guidedFormDefinitionsCache$) {
      this.guidedFormDefinitionsCache$ = this.http.get<GuidedFormDefinition[]>(
        getPostgrestUrl() + 'schema_guided_forms'
      ).pipe(
        catchError(err => {
          console.error('Failed to load guided form definitions:', err);
          return of([]);
        }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }
    return this.guidedFormDefinitionsCache$;
  }

  public getGuidedFormSteps(): Observable<GuidedFormStep[]> {
    if (!this.guidedFormStepsCache$) {
      this.guidedFormStepsCache$ = this.http.get<GuidedFormStep[]>(
        getPostgrestUrl() + 'schema_guided_form_steps'
      ).pipe(
        catchError(err => {
          console.error('Failed to load guided form steps:', err);
          return of([]);
        }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }
    return this.guidedFormStepsCache$;
  }

  public getEntityGuidedFormKey(tableName: string): string | undefined {
    const entities = this.tables();
    if (!entities) return undefined;
    const entity = entities.find(e => e.table_name === tableName);
    return entity?.guided_form_key || undefined;
  }

  public getGuidedFormForEntity(table: SchemaEntityTable): Observable<{ definition: GuidedFormDefinition | null, steps: GuidedFormStep[] }> {
    if (!table.guided_form_key) {
      return of({ definition: null, steps: [] });
    }
    return combineLatest([
      this.getGuidedFormDefinitions(),
      this.getGuidedFormSteps()
    ]).pipe(
      map(([definitions, steps]) => ({
        definition: definitions.find(d => d.guided_form_key === table.guided_form_key) || null,
        steps: steps.filter(s => s.guided_form_key === table.guided_form_key)
      }))
    );
  }

  public invalidateGuidedFormCache(): void {
    this.guidedFormDefinitionsCache$ = undefined;
    this.guidedFormStepsCache$ = undefined;
  }

  public getPropertiesForEntity(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getProperties().pipe(map(props => {
      return props.filter(p =>
        p.table_name == table.table_name
      );
    }));
  }
  public getPropertiesForEntityFresh(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    // Fetch fresh from database, bypass cache
    return this.http.get<SchemaEntityProperty[]>(getPostgrestUrl() + 'schema_properties')
      .pipe(
        map(props => {
          return props
            .filter(p => p.table_name == table.table_name)
            .map(p => {
              p.type = this.getPropertyType(p);
              return p;
            });
        })
      );
  }
  private getPropertyType(val: SchemaEntityProperty): EntityPropertyType {
    return coreGetPropertyType(val);
  }
  public static propertyToSelectString(prop: SchemaEntityProperty): string {
    return corePropertyToSelectString(prop);
  }

  /**
   * Returns the PostgREST select string for a property in edit forms.
   * For FK fields, returns only the column name (raw ID) instead of embedded objects.
   * Edit forms need primitive IDs for form controls, not display objects.
   */
  public static propertyToSelectStringForEdit(prop: SchemaEntityProperty): string {
    return corePropertyToSelectStringForEdit(prop);
  }

  /**
   * Returns a lightweight PostgREST select string optimized for list pages.
   * PhotoGallery fetches only file IDs (for client-side count) instead of full file metadata.
   * All other types delegate to propertyToSelectString().
   */
  public static propertyToSelectStringForList(prop: SchemaEntityProperty): string {
    return corePropertyToSelectStringForList(prop);
  }

  /**
   * Ensure display_name is always fetched — used structurally for page headers,
   * map markers, calendar titles, and delete confirmation modals.
   */
  private static ensureStructuralProps(allProps: SchemaEntityProperty[], visibleProps: SchemaEntityProperty[]): void {
    visibleProps.splice(0, visibleProps.length, ...coreEnsureStructuralProps(allProps, visibleProps));
  }

  public getPropsForList(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => propsForList(table, props)));
  }
  public getPropsForDetail(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => propsForDetail(props)));
  }
  public getPropsForCreate(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => propsForCreate(props)));
  }
  public getPropsForEdit(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => propsForEdit(props)));
  }
  public getPropsForFilter(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => propsForFilter(props)));
  }
  public static getFormValidatorsForProperty(prop: SchemaEntityProperty): ValidatorFn[] {
    let validators:ValidatorFn[] = [];

    // First, check is_nullable for backwards compatibility
    if(!prop.is_nullable) {
      validators.push(Validators.required);
    }

    // Then, add validators from validation_rules metadata
    if(prop.validation_rules && prop.validation_rules.length > 0) {
      prop.validation_rules.forEach(rule => {
        switch(rule.type) {
          case 'required':
            validators.push(Validators.required);
            break;
          case 'min':
            if(rule.value) {
              const minValue = Number(rule.value);
              validators.push(Validators.min(minValue));
            }
            break;
          case 'max':
            if(rule.value) {
              const maxValue = Number(rule.value);
              validators.push(Validators.max(maxValue));
            }
            break;
          case 'minLength':
            if(rule.value) {
              const minLen = Number(rule.value);
              validators.push(Validators.minLength(minLen));
            }
            break;
          case 'maxLength':
            if(rule.value) {
              const maxLen = Number(rule.value);
              validators.push(Validators.maxLength(maxLen));
            }
            break;
          case 'pattern':
            if(rule.value) {
              validators.push(Validators.pattern(rule.value));
            }
            break;
        }
      });
    }

    return validators;
  }
  public static getDefaultValueForProperty(prop: SchemaEntityProperty): any {
    return coreGetDefaultValueForProperty(prop);
  }

  /**
   * Get the column span for a property based on custom width or type-based defaults
   */
  public static getColumnSpan(property: SchemaEntityProperty): number {
    return coreGetColumnSpan(property);
  }

  /**
   * Get all inverse relationships for a given entity.
   * Returns tables that have foreign keys pointing to this entity.
   *
   * Example: For entity 'issue_statuses', finds all tables with FK to issue_statuses
   * (e.g., issues.status -> issue_statuses.id)
   */
  public getInverseRelationships(targetTable: string, excludeTables?: Set<string>): Observable<InverseRelationshipMeta[]> {
    return this.getProperties().pipe(
      map(props => {
        // Derive junction tables on-demand from properties (no caching needed)
        const junctionTables = this.getJunctionTableNamesFromProperties(props);

        // Find all properties where join_table matches target
        // But exclude junction tables (handled by M:M) and caller-specified tables
        // (e.g., guided form child step tables shown in review section)
        const inverseProps = props.filter(p =>
          p.join_table === targetTable &&
          p.join_schema === 'public' &&
          !junctionTables.has(p.table_name) &&
          (!excludeTables || !excludeTables.has(p.table_name))
        );

        // Group by source table to avoid duplicates
        const grouped = this.groupBySourceTable(inverseProps);

        // Convert to InverseRelationshipMeta[]
        return grouped.map(g => ({
          sourceTable: g.table_name,
          sourceColumn: g.column_name,
          sourceTableDisplayName: this.getDisplayNameForTable(g.table_name),
          sourceColumnDisplayName: g.display_name,
          showOnDetail: this.shouldShowOnDetail(g),
          sortOrder: g.sort_order || 0,
          previewLimit: this.getPreviewLimit(g),
          previewMode: this.getPreviewMode(g.table_name, props)
        }));
      })
    );
  }

  /**
   * Derive junction table names from enriched properties.
   * Looks for virtual M:M properties and extracts their junction table names.
   * This is cheaper than re-detecting from scratch since M:M properties are already identified.
   */
  private getJunctionTableNamesFromProperties(props: SchemaEntityProperty[]): Set<string> {
    const junctionNames = new Set<string>();

    // M:M properties have type ManyToMany and contain junction table metadata
    props.forEach(p => {
      if (p.type === EntityPropertyType.ManyToMany && p.many_to_many_meta) {
        junctionNames.add(p.many_to_many_meta.junctionTable);
      }
    });

    return junctionNames;
  }

  /**
   * Determine how a source table's preview records can be fetched, based on
   * which columns it actually has. Not every FK-bearing table has
   * id/display_name: composite-PK junctions (e.g. 3-way junctions) and guided
   * form step tables lack display_name and sometimes id, and selecting a
   * missing column makes PostgREST return 400 for the whole preview query.
   */
  private getPreviewMode(tableName: string, props: SchemaEntityProperty[]): 'display_name' | 'id' | 'count' {
    const columns = new Set(
      props.filter(p => p.table_name === tableName).map(p => p.column_name)
    );
    if (columns.has('display_name')) {
      return 'display_name';
    }
    return columns.has('id') ? 'id' : 'count';
  }

  /**
   * Group properties by source table (table_name).
   * Takes first property found for each unique table.
   */
  private groupBySourceTable(props: SchemaEntityProperty[]): SchemaEntityProperty[] {
    const tableMap = new Map<string, SchemaEntityProperty>();

    for (const prop of props) {
      if (!tableMap.has(prop.table_name)) {
        tableMap.set(prop.table_name, prop);
      }
    }

    return Array.from(tableMap.values());
  }

  /**
   * Get cached display name for an entity
   */
  private getDisplayNameForTable(tableName: string): string {
    const tables = this.tables();
    const entity = tables?.find(t => t.table_name === tableName);
    return entity?.display_name || tableName;
  }

  /**
   * Determine if inverse relationship should be shown on detail page.
   * Can be customized via metadata in future (Phase 3).
   */
  private shouldShowOnDetail(property: SchemaEntityProperty): boolean {
    // Default: show all inverse relationships
    // Future: check metadata.inverse_relationships table
    return true;
  }

  /**
   * Get preview limit for an inverse relationship.
   * Can be customized via metadata in future (Phase 3).
   */
  private getPreviewLimit(property: SchemaEntityProperty): number {
    // Default: 5 records
    // Future: check metadata.inverse_relationships table
    return 5;
  }

  /**
   * Detect junction tables using structural heuristics.
   * A junction table must have exactly 2 FKs to 'public' schema and only metadata columns.
   *
   * @param tables All entity tables in the schema
   * @param properties All properties across all tables
   * @returns Map of junction table name to array of M:M metadata (bidirectional)
   */
  private detectJunctionTables(
    tables: SchemaEntityTable[],
    properties: SchemaEntityProperty[]
  ): Map<string, ManyToManyMeta[]> {
    const junctions = new Map<string, ManyToManyMeta[]>();

    tables.forEach(table => {
      const tableProps = properties.filter(p => p.table_name === table.table_name);

      // Find all foreign key columns
      const fkProps = tableProps.filter(p =>
        p.join_table &&
        p.join_schema === 'public' &&
        (p.type === EntityPropertyType.ForeignKeyName || p.type === EntityPropertyType.User)
      );

      // Must have exactly 2 FKs
      if (fkProps.length !== 2) {
        return;
      }

      // Check for non-metadata columns
      // Ignore ALL FK columns (including non-public FKs) to handle edge case where
      // phantom metadata schema FKs exist (e.g., from pre-v0.8.2 bug)
      const metadataColumns = ['id', 'created_at', 'updated_at'];
      const extraColumnProps = tableProps.filter(p =>
        !metadataColumns.includes(p.column_name) &&
        !fkProps.includes(p) &&
        p.type !== EntityPropertyType.ForeignKeyName &&
        p.type !== EntityPropertyType.User
      );

      const hasExtraColumns = extraColumnProps.length > 0;

      // v0.51.0: Rich junctions bypass the extra-column guard
      const isRichJunction = hasExtraColumns && table.is_rich_junction === true;

      if (hasExtraColumns && !isRichJunction) {
        return;
      }

      // This is a junction table! Create M:M metadata for both directions
      const [fk1, fk2] = fkProps;

      // Collect extra columns for rich junctions (typed SchemaEntityProperty[])
      // Only include columns visible on create or edit forms — auto-generated
      // columns hidden from both (e.g. tracking tokens) shouldn't appear in the
      // M:M editor dialog.
      const extraColumns = isRichJunction
        ? extraColumnProps.filter(p => p.show_on_create !== false || p.show_on_edit !== false)
        : [];

      // Check if related tables have 'color' and 'display_name' columns.
      // Tables without display_name (e.g. guided form step tables) can't be rendered
      // as M:M chips — the PostgREST select requires display_name on the related table.
      const fk2TableHasColor = properties.some(p =>
        p.table_name === fk2.join_table && p.column_name === 'color'
      );
      const fk1TableHasColor = properties.some(p =>
        p.table_name === fk1.join_table && p.column_name === 'color'
      );
      const fk2TableHasDisplayName = properties.some(p =>
        p.table_name === fk2.join_table && p.column_name === 'display_name'
      );
      const fk1TableHasDisplayName = properties.some(p =>
        p.table_name === fk1.join_table && p.column_name === 'display_name'
      );

      // Direction 1: fk1.join_table -> fk2.join_table via this junction
      // Create if the related table (fk2) has display_name, or if we can hop through to a parent that does
      if (fk2TableHasDisplayName) {
        const meta1: ManyToManyMeta = {
          junctionTable: table.table_name,
          sourceTable: fk1.join_table,
          targetTable: fk2.join_table,
          sourceColumn: fk1.column_name,
          targetColumn: fk2.column_name,
          relatedTable: fk2.join_table,
          relatedTableDisplayName: this.getDisplayNameForTable(fk2.join_table),
          showOnSource: true,
          showOnTarget: true,
          displayOrder: 100, // Default high sort order (appears after regular props)
          relatedTableHasColor: fk2TableHasColor,
          extraColumns
        };

        if (!junctions.has(fk1.join_table)) {
          junctions.set(fk1.join_table, []);
        }
        junctions.get(fk1.join_table)!.push(meta1);
      } else {
        // fk2 target lacks display_name — try parent hop detection
        const hopResult = this.detectParentHops(fk2.join_table, table.table_name, properties);
        if (hopResult) {
          const grandparentHasColor = properties.some(p =>
            p.table_name === hopResult.finalTable && p.column_name === 'color'
          );
          const meta1: ManyToManyMeta = {
            junctionTable: table.table_name,
            sourceTable: fk1.join_table,
            targetTable: fk2.join_table, // intermediate (no display_name)
            sourceColumn: fk1.column_name,
            targetColumn: fk2.column_name,
            relatedTable: hopResult.finalTable, // displayable grandparent
            relatedTableDisplayName: this.getDisplayNameForTable(hopResult.finalTable),
            showOnSource: true,
            showOnTarget: true,
            displayOrder: 100,
            relatedTableHasColor: grandparentHasColor,
            extraColumns: [], // Reverse direction doesn't carry rich junction data
            parentHops: hopResult.hops
          };

          if (!junctions.has(fk1.join_table)) {
            junctions.set(fk1.join_table, []);
          }
          junctions.get(fk1.join_table)!.push(meta1);
        }
      }

      // Direction 2: fk2.join_table -> fk1.join_table via this junction
      // Create if the related table (fk1) has display_name, or if we can hop through to a parent that does
      if (fk1TableHasDisplayName) {
        const meta2: ManyToManyMeta = {
          junctionTable: table.table_name,
          sourceTable: fk2.join_table,
          targetTable: fk1.join_table,
          sourceColumn: fk2.column_name,
          targetColumn: fk1.column_name,
          relatedTable: fk1.join_table,
          relatedTableDisplayName: this.getDisplayNameForTable(fk1.join_table),
          showOnSource: true,
          showOnTarget: true,
          displayOrder: 100,
          relatedTableHasColor: fk1TableHasColor,
          extraColumns
        };

        if (!junctions.has(fk2.join_table)) {
          junctions.set(fk2.join_table, []);
        }
        junctions.get(fk2.join_table)!.push(meta2);
      } else {
        // fk1 target lacks display_name — try parent hop detection
        const hopResult = this.detectParentHops(fk1.join_table, table.table_name, properties);
        if (hopResult) {
          const grandparentHasColor = properties.some(p =>
            p.table_name === hopResult.finalTable && p.column_name === 'color'
          );
          const meta2: ManyToManyMeta = {
            junctionTable: table.table_name,
            sourceTable: fk2.join_table,
            targetTable: fk1.join_table, // intermediate (no display_name)
            sourceColumn: fk2.column_name,
            targetColumn: fk1.column_name,
            relatedTable: hopResult.finalTable, // displayable grandparent
            relatedTableDisplayName: this.getDisplayNameForTable(hopResult.finalTable),
            showOnSource: true,
            showOnTarget: true,
            displayOrder: 100,
            relatedTableHasColor: grandparentHasColor,
            extraColumns: [], // Reverse direction doesn't carry rich junction data
            parentHops: hopResult.hops
          };

          if (!junctions.has(fk2.join_table)) {
            junctions.set(fk2.join_table, []);
          }
          junctions.get(fk2.join_table)!.push(meta2);
        }
      }
    });

    return junctions;
  }

  /**
   * Detect parent hops from an intermediate table (lacks display_name) to a displayable parent.
   * Looks at FK columns FROM the intermediate table to find a parent with display_name.
   * Only succeeds when exactly one unambiguous candidate is found.
   *
   * @param intermediateTable The table that lacks display_name (junction's direct FK target)
   * @param junctionTable The junction table to exclude from candidates
   * @param properties All properties for FK inspection
   * @returns ParentHop chain + final table, or null if ambiguous/impossible
   */
  private detectParentHops(
    intermediateTable: string,
    junctionTable: string,
    properties: SchemaEntityProperty[]
  ): { hops: ParentHop[]; finalTable: string } | null {
    // Find FK columns FROM the intermediate table (public schema only, exclude system tables)
    const systemTables = ['statuses', 'categories', 'civic_os_users', 'civic_os_users_private'];
    const intermediateFks = properties.filter(p =>
      p.table_name === intermediateTable &&
      p.join_table &&
      p.join_schema === 'public' &&
      p.join_table !== junctionTable &&
      !systemTables.includes(p.join_table) &&
      (p.type === EntityPropertyType.ForeignKeyName || p.type === EntityPropertyType.User)
    );

    // Find candidates whose target table has display_name
    const candidates = intermediateFks.filter(fk =>
      properties.some(p => p.table_name === fk.join_table && p.column_name === 'display_name')
    );

    // Exactly one candidate → unambiguous hop
    if (candidates.length === 1) {
      const candidate = candidates[0];
      return {
        hops: [{ table: candidate.join_table, fkColumn: candidate.column_name }],
        finalTable: candidate.join_table
      };
    }

    // Zero or multiple → ambiguous, skip
    return null;
  }

  /**
   * Enrich properties with virtual M:M properties based on detected junctions.
   * Creates synthetic properties for each M:M relationship.
   *
   * @param properties Original properties from database
   * @param tables All entity tables
   * @returns Properties array with added virtual M:M properties
   */
  private enrichPropertiesWithManyToMany(
    properties: SchemaEntityProperty[],
    tables: SchemaEntityTable[],
    m2mMetadata: M2mPropertyMetadata[] = []
  ): SchemaEntityProperty[] {
    const junctions = this.detectJunctionTables(tables, properties);
    const enriched: SchemaEntityProperty[] = [...properties];

    // Build lookup map for M:M metadata: "tableName:columnName" → metadata
    const metadataMap = new Map<string, M2mPropertyMetadata>();
    m2mMetadata.forEach(m => metadataMap.set(`${m.table_name}:${m.column_name}`, m));

    // For each junction table, create virtual M:M properties on source/target
    junctions.forEach((metas, tableName) => {
      metas.forEach(meta => {
        const columnName = `${meta.junctionTable}_m2m`;
        const metaKey = `${meta.sourceTable}:${columnName}`;
        const m2mMeta = metadataMap.get(metaKey);

        // Create a virtual property for the M:M relationship
        // Use empty string for fields we don't have from database
        const virtualProp: SchemaEntityProperty = {
          table_catalog: '',
          table_schema: 'public',
          table_name: meta.sourceTable,
          column_name: columnName,
          display_name: m2mMeta?.display_name || meta.relatedTableDisplayName,
          description: `Many-to-many relationship via ${meta.junctionTable}`,
          sort_order: m2mMeta?.sort_order ?? meta.displayOrder,
          column_width: m2mMeta?.column_width ?? 2,
          sortable: false,  // M:M not sortable in list view
          filterable: false, // M:M not filterable (yet)
          column_default: '',
          is_nullable: true,  // M:M is always optional
          data_type: 'many_to_many',
          character_maximum_length: 0,
          udt_schema: 'public',
          udt_name: 'many_to_many',
          is_self_referencing: false,
          is_identity: false,
          is_generated: false,
          is_updatable: true,
          join_schema: '',
          join_table: '',
          join_column: '',
          geography_type: '',
          // show_on_* defaults are M:M-specific; metadata.properties can override
          // (e.g., show_on_detail: false to hide M:M from detail page entirely)
          // v0.51.0: Parent hop M:M is detail-only (can't edit through grandparent chain)
          show_on_list: false,  // M:M can't render in list table rows
          show_on_create: meta.parentHops?.length ? false : (m2mMeta?.show_on_create ?? true),
          show_on_edit: meta.parentHops?.length ? false : (m2mMeta?.show_on_edit ?? true),
          show_on_detail: m2mMeta?.show_on_detail ?? true,
          type: EntityPropertyType.ManyToMany,
          many_to_many_meta: meta,
          // v0.44.0+: M:M metadata flags from schema_m2m_properties VIEW
          options_source_rpc: m2mMeta?.options_source_rpc || undefined,
          depends_on_columns: m2mMeta?.depends_on_columns || undefined,
          // v0.45.0+: FK search modal flag
          // v0.51.0: Rich junctions force search modal (no inline checkbox editor)
          // Parent hop M:M is never editable so no search modal needed
          fk_search_modal: meta.parentHops?.length ? false : (meta.extraColumns.length > 0 ? true : (m2mMeta?.fk_search_modal ?? false)),
          // v0.46.0: Inline positioning
          // v0.51.0: Parent hop M:M renders inline (read-only chips in property grid)
          show_inline: meta.parentHops?.length ? true : (m2mMeta?.show_inline ?? false),
          // v0.53.0: Computed column filter for FK search modal
          options_filter_column: m2mMeta?.options_filter_column || undefined,
        };

        enriched.push(virtualProp);
      });
    });

    return enriched;
  }

  /**
   * Get M:M relationships for a given table.
   * Public method for components to check if table has M:M relationships.
   *
   * @param tableName The table to get M:M relationships for
   * @returns Observable of M:M metadata array (may be empty)
   */
  public getManyToManyRelationships(tableName: string): Observable<ManyToManyMeta[]> {
    return this.getProperties().pipe(
      map(props => {
        // Properties are already enriched, just filter for M:M on this table
        return props
          .filter(p => p.table_name === tableName && p.type === EntityPropertyType.ManyToMany)
          .map(p => p.many_to_many_meta!)
          .filter(meta => meta !== undefined);
      })
    );
  }

  /**
   * Get all detected junction tables.
   * Used by ERD service to hide junction tables from diagram.
   *
   * @returns Observable of Set of junction table names
   */
  public getDetectedJunctionTables(): Observable<Set<string>> {
    return this.getProperties().pipe(
      map(props => this.getJunctionTableNamesFromProperties(props))
    );
  }

  /**
   * Get entities for menu display (excluding junction tables).
   * Junction tables are hidden from the menu but still accessible via direct URL.
   *
   * @returns Observable of entities excluding detected junction tables
   */
  public getEntitiesForMenu(): Observable<SchemaEntityTable[]> {
    return combineLatest([
      this.getEntities(),
      this.getDetectedJunctionTables()
    ]).pipe(
      map(([allTables, junctions]) =>
        allTables.filter(t =>
          !junctions.has(t.table_name) && t.show_in_sidebar !== false
        )
      )
    );
  }

  /**
   * Get entities for the Entity Management admin page.
   * Excludes junction tables but includes sidebar-hidden entities
   * so admins can toggle visibility.
   */
  public getEntitiesForManagement(): Observable<SchemaEntityTable[]> {
    return combineLatest([
      this.getEntities(),
      this.getDetectedJunctionTables()
    ]).pipe(
      map(([allTables, junctions]) =>
        allTables.filter(t => !junctions.has(t.table_name))
      )
    );
  }

  // ===========================================================================
  // STATIC TEXT SYSTEM (v0.17.0)
  // ===========================================================================

  /**
   * Fetch all static text entries from the database.
   * Results are cached with shareReplay to avoid redundant HTTP requests.
   *
   * @returns Observable of all StaticText entries with itemType discriminator
   */
  public getStaticText(): Observable<StaticText[]> {
    if (!this.staticTextCache$ && !this.loadingStaticText) {
      this.loadingStaticText = true;
      this.staticTextCache$ = this.http.get<Omit<StaticText, 'itemType'>[]>(
        getPostgrestUrl() + 'static_text'
      ).pipe(
        map(items => items.map(item => ({
          ...item,
          itemType: 'static_text' as const  // Add discriminator for union type
        }))),
        catchError(err => {
          console.error('Failed to load static text:', err);
          return of([]);  // Graceful degradation
        }),
        finalize(() => {
          this.loadingStaticText = false;
        }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }
    return this.staticTextCache$ || of([]);
  }

  /**
   * Get static text entries for a specific entity.
   *
   * @param tableName The entity table name (e.g., 'reservation_requests')
   * @returns Observable of StaticText entries for that table
   */
  public getStaticTextForEntity(tableName: string): Observable<StaticText[]> {
    return this.getStaticText().pipe(
      map(items => items.filter(item => item.table_name === tableName))
    );
  }

  /**
   * Refresh only the static text cache.
   * Use when metadata.static_text changes.
   */
  public refreshStaticTextCache(): void {
    this.staticTextCache$ = undefined;
    this.loadingStaticText = false;
  }

  /**
   * Get all renderable items (properties + static text) for Detail page.
   * Merges properties and static text, then sorts by sort_order.
   *
   * @param table The entity to get renderables for
   * @returns Observable of RenderableItem[] sorted by sort_order
   */
  public getDetailRenderables(table: SchemaEntityTable): Observable<RenderableItem[]> {
    return combineLatest([
      this.getPropsForDetail(table),
      this.getStaticTextForEntity(table.table_name)
    ]).pipe(
      map(([props, staticTexts]) => detailRenderables(props, staticTexts))
    );
  }

  /**
   * Get all renderable items (properties + static text) for Create page.
   * Merges properties and static text, then sorts by sort_order.
   *
   * @param table The entity to get renderables for
   * @returns Observable of RenderableItem[] sorted by sort_order
   */
  public getCreateRenderables(table: SchemaEntityTable): Observable<RenderableItem[]> {
    return combineLatest([
      this.getPropsForCreate(table),
      this.getStaticTextForEntity(table.table_name)
    ]).pipe(
      map(([props, staticTexts]) => createRenderables(props, staticTexts))
    );
  }

  /**
   * Get all renderable items (properties + static text) for Edit page.
   * Merges properties and static text, then sorts by sort_order.
   *
   * @param table The entity to get renderables for
   * @returns Observable of RenderableItem[] sorted by sort_order
   */
  public getEditRenderables(table: SchemaEntityTable): Observable<RenderableItem[]> {
    return combineLatest([
      this.getPropsForEdit(table),
      this.getStaticTextForEntity(table.table_name)
    ]).pipe(
      map(([props, staticTexts]) => editRenderables(props, staticTexts))
    );
  }

  /**
   * Get the column span for any renderable item (property or static text).
   * Static text uses column_width directly; properties use type-based defaults.
   *
   * @param item The renderable item
   * @returns Column span (1 = half width, 2 = full width)
   */
  public static getRenderableColumnSpan(item: RenderableItem): number {
    return coreGetRenderableColumnSpan(item);
  }

  // ===========================================================================
  // ENTITY ACTIONS SYSTEM (v0.18.0)
  // ===========================================================================

  /**
   * Get entity actions for a specific table.
   * Returns actions that the current user has permission to see (can_execute = true).
   * Actions are sorted by sort_order.
   *
   * NOTE: This method does NOT cache results because:
   * 1. Actions include can_execute which depends on current user's JWT
   * 2. JWT roles can change between requests (login/logout)
   * 3. Actions are only fetched on Detail page load (low frequency)
   *
   * @param tableName The entity table name (e.g., 'reservation_requests')
   * @returns Observable of EntityAction[] sorted by sort_order
   */
  public getEntityActions(tableName: string): Observable<EntityAction[]> {
    return this.http.get<EntityAction[]>(
      getPostgrestUrl() + 'schema_entity_actions',
      {
        params: {
          table_name: `eq.${tableName}`,
          order: 'sort_order.asc'
        }
      }
    ).pipe(
      catchError(err => {
        console.error('Failed to load entity actions:', err);
        return of([]);  // Graceful degradation
      })
    );
  }
}
