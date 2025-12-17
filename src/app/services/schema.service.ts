/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
import { inject, Injectable, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable, combineLatest, filter, map, of, tap, shareReplay, finalize, catchError, take } from 'rxjs';
import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable, InverseRelationshipMeta, ManyToManyMeta, StatusValue, StaticText, RenderableItem, PropertyItem, isStaticText, isProperty, EntityAction } from '../interfaces/entity';
import { ValidatorFn, Validators } from '@angular/forms';
import { getPostgrestUrl } from '../config/runtime';
import { isSystemType } from '../constants/system-types';
import { ConstraintMessage } from '../interfaces/api';

/**
 * Status option for dropdowns and filters.
 * Simplified version of StatusValue for UI components.
 */
export interface StatusOption {
  id: number;
  display_name: string;
  color: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class SchemaService {
  private http = inject(HttpClient);

  public properties?: SchemaEntityProperty[];
  public constraintMessages?: ConstraintMessage[];
  private tables = signal<SchemaEntityTable[] | undefined>(undefined);

  // Cached observables for HTTP requests (with shareReplay)
  private schemaCache$?: Observable<SchemaEntityTable[]>;
  private propertiesCache$?: Observable<SchemaEntityProperty[]>;
  private constraintMessagesCache$?: Observable<ConstraintMessage[]>;

  // Status cache: keyed by entity_type (e.g., 'reservation_request', 'issue')
  // Each entity_type has its own set of statuses from metadata.statuses
  private statusesCache = new Map<string, Observable<StatusOption[]>>();
  private loadingStatuses = new Set<string>();

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
    this.constraintMessagesCache$ = undefined;
    this.staticTextCache$ = undefined;
    // Clear processed cache
    this.constraintMessages = undefined;
    // Clear status cache (keyed by entity_type)
    this.statusesCache.clear();
    this.loadingStatuses.clear();
    // Reset loading flags to allow new fetches
    this.loadingEntities = false;
    this.loadingProperties = false;
    this.loadingConstraintMessages = false;
    this.loadingStaticText = false;
    // Refresh schema in background - new values will emit to subscribers
    this.getSchema().subscribe();
    this.getProperties().subscribe();
    this.getConstraintMessages().subscribe();
  }

  /**
   * Refresh only the statuses cache.
   * Use when metadata.statuses or metadata.status_types change.
   */
  public refreshStatusesCache(): void {
    this.statusesCache.clear();
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

    // Note: getEntities() returns a signal-derived observable that never completes.
    // We use take(1) to complete after first emission, enabling use with forkJoin/combineLatest.
    return combineLatest([
      this.propertiesCache$,
      this.getEntities().pipe(take(1))
    ]).pipe(
      map(([props, tables]) => {
        // First, set property types
        const typedProps = props.map(p => {
          p.type = this.getPropertyType(p);
          return p;
        });

        // Then enrich with M:M virtual properties
        return this.enrichPropertiesWithManyToMany(typedProps, tables);
      }),
      tap(enrichedProps => {
        this.properties = enrichedProps;
      })
    );
  }

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
        color: s.color
      }))),
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

  public getPropertiesForEntity(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getProperties().pipe(map(props => {
      return props.filter(p => p.table_name == table.table_name);
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
    // Status type detection: Integer FK with status_entity_type configured in metadata.properties
    // This takes precedence over generic ForeignKeyName to show status badges instead of plain text
    if (val.status_entity_type && ['int4', 'int8'].includes(val.udt_name) && val.join_column != null) {
      return EntityPropertyType.Status;
    }

    // System type detection: UUID foreign keys to metadata tables (File, User, Payment types)
    // Uses centralized isSystemType() for consistency with Schema Editor/Inspector filtering
    if (val.udt_name === 'uuid' && val.join_table && isSystemType(val.join_table)) {
      // Discriminate between file, user, and payment system types
      if (val.join_table === 'files') {
        // File type detection: Check fileType validation to determine specific subtype
        const fileTypeValidation = val.validation_rules?.find(v => v.type === 'fileType');
        if (fileTypeValidation?.value) {
          if (fileTypeValidation.value.startsWith('image/')) {
            return EntityPropertyType.FileImage;
          } else if (fileTypeValidation.value === 'application/pdf') {
            return EntityPropertyType.FilePDF;
          }
        }
        return EntityPropertyType.File;
      } else if (val.join_table === 'civic_os_users') {
        return EntityPropertyType.User;
      } else if (val.join_table === 'payment_transactions' ||
                 (val.join_table === 'transactions' && val.join_schema === 'payments')) {
        // Payment type: UUID FK to payment_transactions view OR payments.transactions table
        return EntityPropertyType.Payment;
      }
    }

    return (['int4', 'int8'].includes(val.udt_name) && val.join_column != null) ? EntityPropertyType.ForeignKeyName :
      (['geography'].includes(val.udt_name) && val.geography_type == 'Point') ? EntityPropertyType.GeoPoint :
      ['timestamp'].includes(val.udt_name) ? EntityPropertyType.DateTime :
      ['timestamptz'].includes(val.udt_name) ? EntityPropertyType.DateTimeLocal :
      ['date'].includes(val.udt_name) ? EntityPropertyType.Date :
      ['bool'].includes(val.udt_name) ? EntityPropertyType.Boolean :
      ['int4', 'int8'].includes(val.udt_name) ? EntityPropertyType.IntegerNumber :
      ['money'].includes(val.udt_name) ? EntityPropertyType.Money :
      ['hex_color'].includes(val.udt_name) ? EntityPropertyType.Color :
      ['email_address'].includes(val.udt_name) ? EntityPropertyType.Email :
      ['phone_number'].includes(val.udt_name) ? EntityPropertyType.Telephone :
      (['time_slot'].includes(val.udt_name) && val.is_recurring) ? EntityPropertyType.RecurringTimeSlot :
      ['time_slot'].includes(val.udt_name) ? EntityPropertyType.TimeSlot :
      ['varchar'].includes(val.udt_name) ? EntityPropertyType.TextShort :
      ['text'].includes(val.udt_name) ? EntityPropertyType.TextLong :
      EntityPropertyType.Unknown;
  }
  public static propertyToSelectString(prop: SchemaEntityProperty): string {
    // M:M: Embed junction records with related entity data
    // Format: junction_table_m2m:junction_table!source_column(related_table!target_column(id,display_name[,color]))
    if (prop.type == EntityPropertyType.ManyToMany && prop.many_to_many_meta) {
      const meta = prop.many_to_many_meta;
      // Build the embedded select string with FK hints
      // Example: issue_tags_m2m:issue_tags!issue_id(Tag!tag_id(id,display_name,color))
      // The ! syntax tells PostgREST which FK to follow (required when table has multiple FKs)
      const fields = meta.relatedTableHasColor ? 'id,display_name,color' : 'id,display_name';
      return `${prop.column_name}:${meta.junctionTable}!${meta.sourceColumn}(${meta.relatedTable}!${meta.targetColumn}(${fields}))`;
    }

    // File types: Embed file metadata from files table (system type - see METADATA_SYSTEM_TABLES)
    if ([EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
      return `${prop.column_name}:files!${prop.column_name}(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,thumbnail_error,created_at)`;
    }

    // Payment type: Embed payment data from payment_transactions view (system type)
    // Includes effective_status computed field for refund-aware status display
    // Includes aggregated refund data for tooltip showing refund breakdown (1:M support)
    if (prop.type === EntityPropertyType.Payment) {
      return `${prop.column_name}:payment_transactions!${prop.column_name}(id,amount,currency,status,effective_status,total_refunded,refund_count,pending_refund_count,display_name,error_message,created_at)`;
    }

    // Status type: Embed status data from metadata.statuses table
    // Uses FK hint to metadata schema since statuses live in metadata, not public
    if (prop.type === EntityPropertyType.Status) {
      return `${prop.column_name}:statuses!${prop.column_name}(id,display_name,color)`;
    }

    // User type: Embed user data from civic_os_users table (system type - see METADATA_SYSTEM_TABLES)
    return (prop.type == EntityPropertyType.User) ? prop.column_name + ':civic_os_users!' + prop.column_name + '(id,display_name,full_name,phone,email)' :
      (prop.join_schema == 'public' && prop.join_column) ? prop.column_name + ':' + prop.join_table + '(' + prop.join_column + ',display_name)' :
      (prop.type == EntityPropertyType.GeoPoint) ? prop.column_name + ':' + prop.column_name + '_text' :
      prop.column_name;
  }

  /**
   * Returns the PostgREST select string for a property in edit forms.
   * For FK fields, returns only the column name (raw ID) instead of embedded objects.
   * Edit forms need primitive IDs for form controls, not display objects.
   */
  public static propertyToSelectStringForEdit(prop: SchemaEntityProperty): string {
    // M:M: Need full junction data with IDs for edit forms
    // Format same as detail view - we'll extract IDs in the component
    if (prop.type === EntityPropertyType.ManyToMany && prop.many_to_many_meta) {
      const meta = prop.many_to_many_meta;
      // The ! syntax tells PostgREST which FK to follow (required when table has multiple FKs)
      const fields = meta.relatedTableHasColor ? 'id,display_name,color' : 'id,display_name';
      return `${prop.column_name}:${meta.junctionTable}!${meta.sourceColumn}(${meta.relatedTable}!${meta.targetColumn}(${fields}))`;
    }

    // File types: Need full file data to show current file and allow replacement
    if ([EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
      return `${prop.column_name}:files!${prop.column_name}(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,thumbnail_error,created_at)`;
    }

    // For FK fields in edit forms, we only need the raw ID value
    if (prop.type === EntityPropertyType.ForeignKeyName) {
      return prop.column_name;
    }

    // Status fields also need just the ID for edit forms (dropdown value)
    if (prop.type === EntityPropertyType.Status) {
      return prop.column_name;
    }

    // GeoPoint still needs the computed _text field
    if (prop.type === EntityPropertyType.GeoPoint) {
      return prop.column_name + ':' + prop.column_name + '_text';
    }

    // User fields also need just the ID for edit forms
    if (prop.type === EntityPropertyType.User) {
      return prop.column_name;
    }

    // Payment fields are read-only (show embedded data, not editable)
    // Includes effective_status computed field for refund-aware status display
    // Includes aggregated refund data for tooltip showing refund breakdown (1:M support)
    if (prop.type === EntityPropertyType.Payment) {
      return `${prop.column_name}:payment_transactions!${prop.column_name}(id,amount,currency,status,effective_status,total_refunded,refund_count,pending_refund_count,display_name,error_message,created_at)`;
    }

    // Everything else uses the column name directly
    return prop.column_name;
  }
  public getPropsForList(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => {
        // Include properties visible on list
        const visibleProps = props.filter(p => p.show_on_list !== false);

        // If map is enabled, ensure the map property is included even if hidden from list
        if (table.show_map && table.map_property_name) {
          const mapProperty = props.find(p => p.column_name === table.map_property_name);
          if (mapProperty && !visibleProps.includes(mapProperty)) {
            // Add the map property so it's included in the PostgREST select query
            visibleProps.push(mapProperty);
          }
        }

        return visibleProps.sort((a, b) => a.sort_order - b.sort_order);
      }));
  }
  public getPropsForDetail(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => {
        return props
          .filter(p => p.show_on_detail !== false)
          .sort((a, b) => a.sort_order - b.sort_order);
      }));
  }
  public getPropsForCreate(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => {
        return props
          .filter(p =>{
            // Exclude auto-managed timestamp fields (created_at, updated_at)
            // These are managed by database triggers and should never be in create forms
            if (p.column_name === 'created_at' || p.column_name === 'updated_at') {
              return false;
            }
            return !(p.is_generated || p.is_identity) &&
              p.is_updatable &&
              p.show_on_create !== false;
          })
          .sort((a, b) => a.sort_order - b.sort_order);
      }));
  }
  public getPropsForEdit(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => {
        return props
          .filter(p =>{
            // Exclude auto-managed timestamp fields (created_at, updated_at)
            // These are managed by database triggers and should never be in edit forms
            if (p.column_name === 'created_at' || p.column_name === 'updated_at') {
              return false;
            }
            return !(p.is_generated || p.is_identity) &&
              p.is_updatable &&
              p.show_on_edit !== false;
          })
          .sort((a, b) => a.sort_order - b.sort_order);
      }));
  }
  public getPropsForFilter(table: SchemaEntityTable): Observable<SchemaEntityProperty[]> {
    return this.getPropertiesForEntity(table)
      .pipe(map(props => {
        return props
          .filter(p => {
            // Only include properties marked as filterable
            if (p.filterable !== true) {
              return false;
            }
            // Only include supported property types
            const supportedTypes = [
              EntityPropertyType.ForeignKeyName,
              EntityPropertyType.DateTime,
              EntityPropertyType.DateTimeLocal,
              EntityPropertyType.Date,
              EntityPropertyType.Boolean,
              EntityPropertyType.IntegerNumber,
              EntityPropertyType.Money,
              EntityPropertyType.User,
              EntityPropertyType.Status  // Status uses same filter pattern as ForeignKeyName
            ];
            return supportedTypes.includes(p.type);
          })
          .sort((a, b) => a.sort_order - b.sort_order);
      }));
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
    if(prop.type == EntityPropertyType.Boolean) {
      return false;
    }
    return null;
  }

  /**
   * Get the column span for a property based on custom width or type-based defaults
   */
  public static getColumnSpan(property: SchemaEntityProperty): number {
    // Use custom width if set, otherwise use type-based defaults
    if (property.column_width) {
      return property.column_width;
    }

    // Default widths based on property type
    switch (property.type) {
      case EntityPropertyType.TextLong:
      case EntityPropertyType.GeoPoint:
      case EntityPropertyType.File:
      case EntityPropertyType.FileImage:
      case EntityPropertyType.FilePDF:
        return 2;
      default:
        return 1;
    }
  }

  /**
   * Get all inverse relationships for a given entity.
   * Returns tables that have foreign keys pointing to this entity.
   *
   * Example: For entity 'issue_statuses', finds all tables with FK to issue_statuses
   * (e.g., issues.status -> issue_statuses.id)
   */
  public getInverseRelationships(targetTable: string): Observable<InverseRelationshipMeta[]> {
    return this.getProperties().pipe(
      map(props => {
        // Derive junction tables on-demand from properties (no caching needed)
        const junctionTables = this.getJunctionTableNamesFromProperties(props);

        // Find all properties where join_table matches target
        // But exclude properties from junction tables (they're handled by M:M)
        const inverseProps = props.filter(p =>
          p.join_table === targetTable &&
          p.join_schema === 'public' &&
          !junctionTables.has(p.table_name)  // Filter out junction tables
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
          previewLimit: this.getPreviewLimit(g)
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
      const hasExtraColumns = tableProps.some(p =>
        !metadataColumns.includes(p.column_name) &&
        !fkProps.includes(p) &&
        p.type !== EntityPropertyType.ForeignKeyName &&
        p.type !== EntityPropertyType.User
      );

      if (hasExtraColumns) {
        return;
      }

      // This is a junction table! Create M:M metadata for both directions
      const [fk1, fk2] = fkProps;

      // Check if related tables have 'color' column
      const fk2TableHasColor = properties.some(p =>
        p.table_name === fk2.join_table && p.column_name === 'color'
      );
      const fk1TableHasColor = properties.some(p =>
        p.table_name === fk1.join_table && p.column_name === 'color'
      );

      // Direction 1: fk1.join_table -> fk2.join_table via this junction
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
        relatedTableHasColor: fk2TableHasColor
      };

      // Direction 2: fk2.join_table -> fk1.join_table via this junction
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
        relatedTableHasColor: fk1TableHasColor
      };

      // Store both directions
      if (!junctions.has(fk1.join_table)) {
        junctions.set(fk1.join_table, []);
      }
      junctions.get(fk1.join_table)!.push(meta1);

      if (!junctions.has(fk2.join_table)) {
        junctions.set(fk2.join_table, []);
      }
      junctions.get(fk2.join_table)!.push(meta2);
    });

    return junctions;
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
    tables: SchemaEntityTable[]
  ): SchemaEntityProperty[] {
    const junctions = this.detectJunctionTables(tables, properties);
    const enriched: SchemaEntityProperty[] = [...properties];

    // For each junction table, create virtual M:M properties on source/target
    junctions.forEach((metas, tableName) => {
      metas.forEach(meta => {
        // Create a virtual property for the M:M relationship
        // Use empty string for fields we don't have from database
        const virtualProp: SchemaEntityProperty = {
          table_catalog: '',
          table_schema: 'public',
          table_name: meta.sourceTable,
          column_name: `${meta.junctionTable}_m2m`,  // Virtual column name
          display_name: meta.relatedTableDisplayName,
          description: `Many-to-many relationship via ${meta.junctionTable}`,
          sort_order: meta.displayOrder,
          column_width: 2,  // Full width for multi-select
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
          show_on_list: false,  // Don't show M:M in list by default (too wide)
          show_on_create: true,
          show_on_edit: true,
          show_on_detail: true,
          type: EntityPropertyType.ManyToMany,
          many_to_many_meta: meta
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
    return this.getDetectedJunctionTables().pipe(
      map(junctions => {
        const allTables = this.tables();
        if (!allTables) return [];
        return allTables.filter(t => !junctions.has(t.table_name));
      })
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
      map(([props, staticTexts]) => {
        // Add itemType discriminator to properties
        const taggedProps: PropertyItem[] = props.map(p => ({
          ...p,
          itemType: 'property' as const
        }));

        // Filter static text for detail page
        const filteredStaticText = staticTexts.filter(st => st.show_on_detail);

        // Merge and sort by sort_order
        const merged: RenderableItem[] = [...taggedProps, ...filteredStaticText];
        return merged.sort((a, b) => a.sort_order - b.sort_order);
      })
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
      map(([props, staticTexts]) => {
        // Add itemType discriminator to properties
        const taggedProps: PropertyItem[] = props.map(p => ({
          ...p,
          itemType: 'property' as const
        }));

        // Filter static text for create page
        const filteredStaticText = staticTexts.filter(st => st.show_on_create);

        // Merge and sort by sort_order
        const merged: RenderableItem[] = [...taggedProps, ...filteredStaticText];
        return merged.sort((a, b) => a.sort_order - b.sort_order);
      })
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
      map(([props, staticTexts]) => {
        // Add itemType discriminator to properties
        const taggedProps: PropertyItem[] = props.map(p => ({
          ...p,
          itemType: 'property' as const
        }));

        // Filter static text for edit page
        const filteredStaticText = staticTexts.filter(st => st.show_on_edit);

        // Merge and sort by sort_order
        const merged: RenderableItem[] = [...taggedProps, ...filteredStaticText];
        return merged.sort((a, b) => a.sort_order - b.sort_order);
      })
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
    if (isStaticText(item)) {
      return item.column_width;
    }
    return SchemaService.getColumnSpan(item);
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
