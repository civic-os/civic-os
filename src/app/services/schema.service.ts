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
import { validationRules, inverseRelationships, displayNameForTable, getJunctionTableNamesFromProperties as coreGetJunctionTableNamesFromProperties, detectJunctionTables as coreDetectJunctionTables, detectParentHops as coreDetectParentHops, enrichPropertiesWithManyToMany as coreEnrichPropertiesWithManyToMany, ensureStructuralProps as coreEnsureStructuralProps, propsForList, propsForDetail, propsForCreate, propsForEdit, propsForFilter, getDefaultValueForProperty as coreGetDefaultValueForProperty, getColumnSpan as coreGetColumnSpan, getRenderableColumnSpan as coreGetRenderableColumnSpan, detailRenderables, createRenderables, editRenderables, getPropertyType as coreGetPropertyType, propertyToSelectString as corePropertyToSelectString, propertyToSelectStringForEdit as corePropertyToSelectStringForEdit, propertyToSelectStringForList as corePropertyToSelectStringForList } from '@civic-os/core';

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
    // The rules (which apply, in what order) come from core; this maps each onto Angular's Validators.
    return validationRules(prop).map(rule => {
      switch (rule.kind) {
        case 'required': return Validators.required;
        case 'min': return Validators.min(rule.value);
        case 'max': return Validators.max(rule.value);
        case 'minLength': return Validators.minLength(rule.value);
        case 'maxLength': return Validators.maxLength(rule.value);
        case 'pattern': return Validators.pattern(rule.value);
      }
    });
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
      map(props => inverseRelationships(props, this.tables(), targetTable, excludeTables))
    );
  }

  /**
   * Derive junction table names from enriched properties.
   * Looks for virtual M:M properties and extracts their junction table names.
   * This is cheaper than re-detecting from scratch since M:M properties are already identified.
   */
  private getJunctionTableNamesFromProperties(props: SchemaEntityProperty[]): Set<string> {
    return coreGetJunctionTableNamesFromProperties(props);
  }

  /**
   * Get cached display name for an entity
   */
  private getDisplayNameForTable(tableName: string): string {
    return displayNameForTable(this.tables(), tableName);
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
    return coreDetectJunctionTables(tables, properties);
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
    return coreDetectParentHops(intermediateTable, junctionTable, properties);
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
    return coreEnrichPropertiesWithManyToMany(properties, tables, m2mMetadata);
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
