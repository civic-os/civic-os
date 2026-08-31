/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Schema cache for the Civic OS MCP server.
 * Fetches and caches schema_entities, schema_properties, schema_entity_actions,
 * statuses, categories, and constraint_messages from PostgREST on startup.
 * Supports version-check refresh via schema_cache_versions.
 */

import type { PostgRESTClient } from './postgrest-client.js';
import {
  EntityPropertyType,
  type CategoryOption,
  type ConstraintMessage,
  type SchemaEntity,
  type SchemaEntityAction,
  type SchemaCacheVersion,
  type SchemaProperty,
  type StatusOption,
  type StatusTransition,
} from './interfaces.js';

export class SchemaCache {
  // Primary data
  private _entities: SchemaEntity[] = [];
  private _properties: SchemaProperty[] = [];
  private _actions: SchemaEntityAction[] = [];
  private _statuses: StatusOption[] = [];
  private _categories: CategoryOption[] = [];
  private _transitions: StatusTransition[] = [];
  private _constraintMessages: ConstraintMessage[] = [];

  // Derived lookups
  private _entityByTable = new Map<string, SchemaEntity>();
  private _entityByDisplayName = new Map<string, SchemaEntity>();
  private _propertiesByTable = new Map<string, SchemaProperty[]>();
  private _actionsByTable = new Map<string, SchemaEntityAction[]>();
  private _statusesByEntityType = new Map<string, StatusOption[]>();
  private _categoriesByEntityType = new Map<string, CategoryOption[]>();
  private _transitionsByEntityType = new Map<string, StatusTransition[]>();

  // Version tracking for incremental refresh
  private cachedVersions = new Map<string, string>();

  private initialized = false;

  constructor(private client: PostgRESTClient) {}

  // ---- Public accessors ----

  get entities(): SchemaEntity[] { return this._entities; }
  get properties(): SchemaProperty[] { return this._properties; }
  get actions(): SchemaEntityAction[] { return this._actions; }
  get statuses(): StatusOption[] { return this._statuses; }
  get categories(): CategoryOption[] { return this._categories; }
  get transitions(): StatusTransition[] { return this._transitions; }
  get constraintMessages(): ConstraintMessage[] { return this._constraintMessages; }

  getEntity(tableName: string): SchemaEntity | undefined {
    return this._entityByTable.get(tableName);
  }

  getEntityByDisplayName(displayName: string): SchemaEntity | undefined {
    return this._entityByDisplayName.get(displayName.toLowerCase());
  }

  getProperties(tableName: string): SchemaProperty[] {
    return this._propertiesByTable.get(tableName) ?? [];
  }

  getActions(tableName: string): SchemaEntityAction[] {
    return this._actionsByTable.get(tableName) ?? [];
  }

  getStatuses(entityType: string): StatusOption[] {
    return this._statusesByEntityType.get(entityType) ?? [];
  }

  getCategories(entityType: string): CategoryOption[] {
    return this._categoriesByEntityType.get(entityType) ?? [];
  }

  getTransitions(entityType: string): StatusTransition[] {
    return this._transitionsByEntityType.get(entityType) ?? [];
  }

  // ---- Initialization ----

  /**
   * Load all schema data from PostgREST.
   * Call once at server startup. Subsequent calls are no-ops unless force=true.
   */
  async initialize(force = false): Promise<void> {
    if (this.initialized && !force) return;

    await Promise.all([
      this.fetchEntities(),
      this.fetchProperties(),
      this.fetchActions(),
      this.fetchStatuses(),
      this.fetchCategories(),
      this.fetchTransitions(),
      this.fetchConstraintMessages(),
    ]);

    // Fetch current versions for future delta checks
    await this.fetchVersions();

    this.buildDerivedLookups();
    this.initialized = true;
  }

  /**
   * Check schema_cache_versions and re-fetch stale sections.
   * Called before each tool execution to ensure freshness.
   * Lightweight: one small query in the common case (no changes).
   */
  async ensureFresh(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      return;
    }

    try {
      const response = await this.client.get<SchemaCacheVersion[]>('schema_cache_versions');
      const versions = response.data;

      let needsRebuild = false;

      for (const v of versions) {
        const cached = this.cachedVersions.get(v.view_name);
        if (cached !== v.max_updated_at) {
          // This section is stale — re-fetch it
          await this.refreshSection(v.view_name);
          this.cachedVersions.set(v.view_name, v.max_updated_at);
          needsRebuild = true;
        }
      }

      if (needsRebuild) {
        this.buildDerivedLookups();
      }
    } catch {
      // If version check fails (e.g., view doesn't exist), skip
      // Schema will be refreshed on next force initialize
    }
  }

  // ---- Private fetchers ----

  private async fetchEntities(): Promise<void> {
    const response = await this.client.get<SchemaEntity[]>('schema_entities', {
      order: 'sort_order.asc,display_name.asc',
    });
    this._entities = response.data;
  }

  private async fetchProperties(): Promise<void> {
    const response = await this.client.get<SchemaProperty[]>('schema_properties', {
      order: 'table_name.asc,sort_order.asc',
    });
    this._properties = response.data;
    // Compute property types
    for (const prop of this._properties) {
      prop.type = detectPropertyType(prop);
    }
  }

  private async fetchActions(): Promise<void> {
    const response = await this.client.get<SchemaEntityAction[]>('schema_entity_actions', {
      order: 'table_name.asc,sort_order.asc',
    });
    this._actions = response.data;
  }

  private async fetchStatuses(): Promise<void> {
    const response = await this.client.get<StatusOption[]>('statuses', {
      order: 'entity_type.asc,sort_order.asc,display_name.asc',
    });
    this._statuses = response.data;
  }

  private async fetchCategories(): Promise<void> {
    const response = await this.client.get<CategoryOption[]>('categories', {
      order: 'entity_type.asc,sort_order.asc,display_name.asc',
    });
    this._categories = response.data;
  }

  private async fetchTransitions(): Promise<void> {
    try {
      const response = await this.client.get<StatusTransition[]>('status_transitions');
      this._transitions = response.data;
    } catch {
      // View may not exist in older instances
      this._transitions = [];
    }
  }

  private async fetchConstraintMessages(): Promise<void> {
    try {
      const response = await this.client.get<ConstraintMessage[]>('constraint_messages');
      this._constraintMessages = response.data;
    } catch {
      this._constraintMessages = [];
    }
  }

  private async fetchVersions(): Promise<void> {
    try {
      const response = await this.client.get<SchemaCacheVersion[]>('schema_cache_versions');
      for (const v of response.data) {
        this.cachedVersions.set(v.view_name, v.max_updated_at);
      }
    } catch {
      // View may not exist — skip version tracking
    }
  }

  private async refreshSection(viewName: string): Promise<void> {
    // Map view_name values to refresh functions
    switch (viewName) {
      case 'entities':
        await this.fetchEntities();
        break;
      case 'properties':
        await this.fetchProperties();
        break;
      case 'constraint_messages':
        await this.fetchConstraintMessages();
        break;
      default:
        // Unknown section — do a full refresh to be safe
        await this.initialize(true);
    }
  }

  // ---- Derived lookups ----

  private buildDerivedLookups(): void {
    // Entity lookups
    this._entityByTable.clear();
    this._entityByDisplayName.clear();
    for (const entity of this._entities) {
      this._entityByTable.set(entity.table_name, entity);
      this._entityByDisplayName.set(entity.display_name.toLowerCase(), entity);
    }

    // Properties by table
    this._propertiesByTable.clear();
    for (const prop of this._properties) {
      const list = this._propertiesByTable.get(prop.table_name) ?? [];
      list.push(prop);
      this._propertiesByTable.set(prop.table_name, list);
    }

    // Actions by table
    this._actionsByTable.clear();
    for (const action of this._actions) {
      const list = this._actionsByTable.get(action.table_name) ?? [];
      list.push(action);
      this._actionsByTable.set(action.table_name, list);
    }

    // Statuses by entity type
    this._statusesByEntityType.clear();
    for (const status of this._statuses) {
      const list = this._statusesByEntityType.get(status.entity_type) ?? [];
      list.push(status);
      this._statusesByEntityType.set(status.entity_type, list);
    }

    // Categories by entity type
    this._categoriesByEntityType.clear();
    for (const category of this._categories) {
      const list = this._categoriesByEntityType.get(category.entity_type) ?? [];
      list.push(category);
      this._categoriesByEntityType.set(category.entity_type, list);
    }

    // Transitions by entity type
    this._transitionsByEntityType.clear();
    for (const transition of this._transitions) {
      const list = this._transitionsByEntityType.get(transition.entity_type) ?? [];
      list.push(transition);
      this._transitionsByEntityType.set(transition.entity_type, list);
    }
  }
}

// ============================================================================
// Property Type Detection
// ============================================================================

/**
 * Detect the EntityPropertyType for a schema property.
 * Mirrors the Angular SchemaService.getPropertyType() logic.
 * Detection follows a priority order — status/category before FK, etc.
 */
export function detectPropertyType(prop: SchemaProperty): EntityPropertyType {
  const { udt_name, join_table, join_column, data_type, geography_type } = prop;
  const hasFK = !!join_table && !!join_column;

  // 1. Status type (priority — before FK)
  if (prop.status_entity_type && hasFK) {
    return EntityPropertyType.Status;
  }

  // 2. Category type (priority — before FK)
  if (prop.category_entity_type && hasFK) {
    return EntityPropertyType.Category;
  }

  // 3. System FK types (UUID targets)
  if (hasFK) {
    if (join_table === 'files') {
      // Determine file subtype from validation rules
      const fileTypeRule = prop.validation_rules?.find(r => r.type === 'fileType');
      if (fileTypeRule?.value?.startsWith('image')) return EntityPropertyType.FileImage;
      if (fileTypeRule?.value === 'application/pdf') return EntityPropertyType.FilePDF;
      return EntityPropertyType.File;
    }
    if (join_table === 'civic_os_users' || join_table === 'civic_os_users_private') {
      return EntityPropertyType.User;
    }
    if (join_table === 'payment_transactions' || join_table === 'transactions') {
      return EntityPropertyType.Payment;
    }
    if (join_table === 'photo_galleries') {
      return EntityPropertyType.PhotoGallery;
    }
  }

  // 4. Geographic types
  if (data_type === 'USER-DEFINED' && udt_name === 'geography') {
    if (geography_type === 'Polygon' || geography_type === 'MultiPolygon') {
      return EntityPropertyType.GeoPolygon;
    }
    return EntityPropertyType.GeoPoint;
  }

  // 5. Domain types by udt_name
  switch (udt_name) {
    case 'timestamp': return EntityPropertyType.DateTime;
    case 'timestamptz': return EntityPropertyType.DateTimeLocal;
    case 'date': return EntityPropertyType.Date;
    case 'bool': return EntityPropertyType.Boolean;
    case 'money': return EntityPropertyType.Money;
    case 'numeric':
    case 'float4':
    case 'float8': return EntityPropertyType.DecimalNumber;
    case 'hex_color': return EntityPropertyType.Color;
    case 'email_address': return EntityPropertyType.Email;
    case 'phone_number': return EntityPropertyType.Telephone;
    case 'markdown': return EntityPropertyType.Markdown;
    case 'time_slot':
      return prop.is_recurring ? EntityPropertyType.RecurringTimeSlot : EntityPropertyType.TimeSlot;
    case 'int4':
    case 'int8':
      // FK with integer ID — if has join info, it's a foreign key
      if (hasFK) return EntityPropertyType.ForeignKeyName;
      return EntityPropertyType.IntegerNumber;
    case 'int2':
      if (hasFK) return EntityPropertyType.ForeignKeyName;
      return EntityPropertyType.IntegerNumber;
    case 'uuid':
      if (hasFK) return EntityPropertyType.ForeignKeyName;
      return EntityPropertyType.TextShort;
    case 'varchar':
    case 'bpchar': return EntityPropertyType.TextShort;
    case 'text': return EntityPropertyType.TextLong;
  }

  // 6. Fallback: if it has FK info, treat as foreign key
  if (hasFK) return EntityPropertyType.ForeignKeyName;

  return EntityPropertyType.Unknown;
}
