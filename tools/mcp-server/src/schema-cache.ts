/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Schema cache for the Civic OS MCP server.
 *
 * Entities, properties (typed by core, with M:M enrichment), constraint messages
 * and version tracking come from core's SchemaClient; this class adds what is
 * MCP-specific: the bulk `schema_entity_actions`, `statuses` and `categories`
 * reads, the derived lookups, per-user caches (entities, properties and actions
 * are role-dependent) and the version-based refresh policy.
 */

import {
  SchemaClient,
  enrichPropertiesWithManyToMany,
  getPropertyType,
} from '@civic-os/core';
import type { PostgRESTClient } from './postgrest-client.js';
import { MaintenanceError, toRequestError } from './postgrest-client.js';
import type {
  CategoryOption,
  ConstraintMessage,
  SchemaEntity,
  SchemaEntityAction,
  SchemaProperty,
  StatusOption,
} from './interfaces.js';

interface LoadedSchema {
  entities: SchemaEntity[];
  properties: SchemaProperty[];
  constraintMessages: ConstraintMessage[];
}

/** `schema_entities` order the server used to apply: sort_order, then display_name. */
function compareEntities(a: SchemaEntity, b: SchemaEntity): number {
  if (a.sort_order !== b.sort_order) return a.sort_order < b.sort_order ? -1 : 1;
  if (a.display_name !== b.display_name) return a.display_name < b.display_name ? -1 : 1;
  return 0;
}

/** `schema_properties` order the server used to apply: table_name, then sort_order. */
function compareProperties(a: SchemaProperty, b: SchemaProperty): number {
  if (a.table_name !== b.table_name) return a.table_name < b.table_name ? -1 : 1;
  if (a.sort_order !== b.sort_order) return a.sort_order < b.sort_order ? -1 : 1;
  return 0;
}

export class SchemaCache {
  // Primary data
  private _entities: SchemaEntity[] = [];
  private _properties: SchemaProperty[] = [];
  private _actions: SchemaEntityAction[] = [];
  private _statuses: StatusOption[] = [];
  private _categories: CategoryOption[] = [];
  private _constraintMessages: ConstraintMessage[] = [];

  // Derived lookups
  private _entityByTable = new Map<string, SchemaEntity>();
  private _entityByDisplayName = new Map<string, SchemaEntity>();
  private _propertiesByTable = new Map<string, SchemaProperty[]>();
  private _actionsByTable = new Map<string, SchemaEntityAction[]>();
  private _statusesByEntityType = new Map<string, StatusOption[]>();
  private _categoriesByEntityType = new Map<string, CategoryOption[]>();

  // Per-user permission caches (entities, properties, actions are role-dependent)
  private perUserCache = new Map<string, {
    entities: SchemaEntity[];
    properties: SchemaProperty[];
    actions: SchemaEntityAction[];
    entityByTable: Map<string, SchemaEntity>;
    entityByDisplayName: Map<string, SchemaEntity>;
    propertiesByTable: Map<string, SchemaProperty[]>;
    actionsByTable: Map<string, SchemaEntityAction[]>;
    entitiesVersion: string;
    propertiesVersion: string;
  }>();

  private initialized = false;

  /** Core client for the shared (startup) identity; also tracks the known cache versions. */
  private readonly schemaClient: SchemaClient;

  /** Versions whose sections have been loaded; ensureFresh() re-fetches any section whose known version differs. */
  private appliedVersions: Record<string, string> = {};

  /** PostgREST base URL — exposed so per-session clients can target the same instance. */
  readonly baseUrl: string;

  constructor(private client: PostgRESTClient, baseUrl: string) {
    this.baseUrl = baseUrl;
    this.schemaClient = new SchemaClient({ transport: client.transport, apiUrl: baseUrl });
  }

  // ---- Public accessors ----

  get entities(): SchemaEntity[] { return this._entities; }
  get properties(): SchemaProperty[] { return this._properties; }
  get actions(): SchemaEntityAction[] { return this._actions; }
  get statuses(): StatusOption[] { return this._statuses; }
  get categories(): CategoryOption[] { return this._categories; }
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

  // ---- Per-user accessors (entities + actions are role-dependent) ----

  /** Return entities with user-specific permission flags, or shared data if no cacheKey. */
  getEntitiesForUser(cacheKey?: string): SchemaEntity[] {
    if (!cacheKey) return this._entities;
    return this.perUserCache.get(cacheKey)?.entities ?? this._entities;
  }

  /** Lookup entity by table name with user-specific permissions. */
  getEntityForUser(cacheKey: string | undefined, tableName: string): SchemaEntity | undefined {
    if (!cacheKey) return this._entityByTable.get(tableName);
    return this.perUserCache.get(cacheKey)?.entityByTable.get(tableName)
      ?? this._entityByTable.get(tableName);
  }

  /** Lookup entity by display name with user-specific permissions. */
  getEntityByDisplayNameForUser(cacheKey: string | undefined, displayName: string): SchemaEntity | undefined {
    if (!cacheKey) return this._entityByDisplayName.get(displayName.toLowerCase());
    return this.perUserCache.get(cacheKey)?.entityByDisplayName.get(displayName.toLowerCase())
      ?? this._entityByDisplayName.get(displayName.toLowerCase());
  }

  /** Return properties for a table, checking per-user cache first for role-filtered visibility. */
  getPropertiesForUser(cacheKey: string | undefined, tableName: string): SchemaProperty[] {
    if (!cacheKey) return this._propertiesByTable.get(tableName) ?? [];
    return this.perUserCache.get(cacheKey)?.propertiesByTable.get(tableName)
      ?? this._propertiesByTable.get(tableName) ?? [];
  }

  /** Return actions for a table with user-specific can_execute flags. */
  getActionsForUser(cacheKey: string | undefined, tableName: string): SchemaEntityAction[] {
    if (!cacheKey) return this._actionsByTable.get(tableName) ?? [];
    return this.perUserCache.get(cacheKey)?.actionsByTable.get(tableName)
      ?? this._actionsByTable.get(tableName) ?? [];
  }

  /**
   * Ensure shared data is fresh, then ensure per-user permission data is fresh.
   * Called before each tool execution for authenticated users.
   */
  async ensureFreshForUser(userClient: PostgRESTClient, cacheKey?: string): Promise<void> {
    // Always refresh shared data first
    await this.ensureFresh();

    // Anonymous callers use shared (anonymous) cache — no per-user fetch needed
    if (!cacheKey) return;

    const versions = this.schemaClient.getKnownVersions();
    const entitiesVersion = versions['entities'] ?? '';
    const propertiesVersion = versions['properties'] ?? '';
    const cached = this.perUserCache.get(cacheKey);

    // If per-user cache exists and both versions match, it's still fresh
    if (cached && cached.entitiesVersion === entitiesVersion && cached.propertiesVersion === propertiesVersion) return;

    // Fetch entities, properties, and actions with the user's JWT (a throwaway core
    // client over the user's transport: its results live in perUserCache)
    try {
      const userSchema = new SchemaClient({ transport: userClient.transport, apiUrl: this.baseUrl });
      const [loaded, actions] = await Promise.all([
        this.loadSchema(userSchema),
        this.fetchActionRows(userClient),
      ]);
      const { entities, properties } = loaded;

      // Build derived lookups
      const entityByTable = new Map<string, SchemaEntity>();
      const entityByDisplayName = new Map<string, SchemaEntity>();
      for (const e of entities) {
        entityByTable.set(e.table_name, e);
        entityByDisplayName.set(e.display_name.toLowerCase(), e);
      }

      const propertiesByTable = new Map<string, SchemaProperty[]>();
      for (const prop of properties) {
        const list = propertiesByTable.get(prop.table_name) ?? [];
        list.push(prop);
        propertiesByTable.set(prop.table_name, list);
      }

      const actionsByTable = new Map<string, SchemaEntityAction[]>();
      for (const a of actions) {
        const list = actionsByTable.get(a.table_name) ?? [];
        list.push(a);
        actionsByTable.set(a.table_name, list);
      }

      this.perUserCache.set(cacheKey, {
        entities,
        properties,
        actions,
        entityByTable,
        entityByDisplayName,
        propertiesByTable,
        actionsByTable,
        entitiesVersion,
        propertiesVersion,
      });
    } catch (err) {
      if (err instanceof MaintenanceError) throw err;
      // If per-user fetch fails, tools will fall back to shared cache via accessors
    }
  }

  // ---- Initialization ----

  /**
   * Load all schema data from PostgREST.
   * Call once at server startup. Subsequent calls are no-ops unless force=true.
   */
  async initialize(force = false): Promise<void> {
    if (this.initialized && !force) return;

    if (force) {
      this.schemaClient.invalidateEntities();
      this.schemaClient.invalidateProperties();
      this.schemaClient.invalidateConstraintMessages();
    }

    const [loaded, actions, statuses, categories] = await Promise.all([
      this.loadSchema(this.schemaClient),
      this.fetchActionRows(this.client),
      this.client.getAll<StatusOption>('statuses', 'entity_type.asc,sort_order.asc,display_name.asc'),
      this.client.getAll<CategoryOption>('categories', 'entity_type.asc,sort_order.asc,display_name.asc'),
    ]);
    this._entities = loaded.entities;
    this._properties = loaded.properties;
    this._constraintMessages = loaded.constraintMessages;
    this._actions = actions;
    this._statuses = statuses;
    this._categories = categories;

    // Record current versions for future delta checks
    await this.checkVersions();
    this.appliedVersions = this.schemaClient.getKnownVersions();

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
      await this.schemaClient.checkVersions();
      const known = this.schemaClient.getKnownVersions();

      let needsRebuild = false;

      for (const [name, version] of Object.entries(known)) {
        if (this.appliedVersions[name] !== version) {
          // This section is stale — re-fetch it. The version counts as applied only once the
          // re-fetch succeeds, so a failed refresh is retried on the next call.
          await this.refreshSection(name);
          this.appliedVersions[name] = version;
          needsRebuild = true;
        }
      }

      if (needsRebuild) {
        this.buildDerivedLookups();
      }
    } catch (err) {
      const mapped = toRequestError(err);
      if (mapped instanceof MaintenanceError) throw mapped;
      // If version check fails (e.g., view doesn't exist), skip
      // Schema will be refreshed on next force initialize
    }
  }

  // ---- Private fetchers ----

  /**
   * Entities, properties and constraint messages through a core SchemaClient.
   * Properties are typed by core and enriched with M:M relations; ordering that
   * the server used to apply (`order=`) is applied here, because core reads the
   * views unordered. Entity and property failures reject (PT503 as MaintenanceError);
   * constraint messages and M:M metadata degrade to empty, as in core.
   */
  private async loadSchema(sc: SchemaClient): Promise<LoadedSchema> {
    try {
      const [entityRows, propertyRows, m2m, constraintMessages] = await Promise.all([
        sc.getEntities(),
        sc.getProperties(),
        sc.getM2mMetadata(),
        sc.getConstraintMessages(),
      ]);
      const entities = [...entityRows].sort(compareEntities);
      for (const prop of propertyRows) {
        prop.type = getPropertyType(prop);
      }
      // T-12: core enriches in the order of the entities it is given, so pass them as served (the frontend does)
      // and let the stable sort keep that order for properties with an equal sort_order.
      const properties = enrichPropertiesWithManyToMany(propertyRows, entityRows, m2m).sort(compareProperties);
      return { entities, properties, constraintMessages };
    } catch (err) {
      throw toRequestError(err);
    }
  }

  private async fetchActionRows(client: PostgRESTClient): Promise<SchemaEntityAction[]> {
    return client.getAll<SchemaEntityAction>('schema_entity_actions', 'table_name.asc,sort_order.asc');
  }

  /** Record the current `schema_cache_versions` (a missing view just skips version tracking). */
  private async checkVersions(): Promise<void> {
    try {
      await this.schemaClient.checkVersions();
    } catch {
      // View may not exist — skip version tracking
    }
  }

  private async refreshSection(name: string): Promise<void> {
    // Map cache_name values to refresh functions
    switch (name) {
      case 'entities': {
        this.schemaClient.invalidateEntities();
        const sc = this.schemaClient;
        this._entities = (await sc.getEntities()).slice().sort(compareEntities);
        // Property enrichment depends on the entity list
        await this.refreshProperties();
        break;
      }
      case 'properties':
        await this.refreshProperties();
        break;
      case 'constraint_messages':
        this.schemaClient.invalidateConstraintMessages();
        this._constraintMessages = await this.schemaClient.getConstraintMessages();
        break;
      default:
        // Unknown section — do a full refresh to be safe
        await this.initialize(true);
    }
  }

  private async refreshProperties(): Promise<void> {
    this.schemaClient.invalidateProperties();
    const loaded = await this.loadSchema(this.schemaClient);
    this._entities = loaded.entities;
    this._properties = loaded.properties;
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
  }
}
