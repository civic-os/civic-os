/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * SchemaClient: the framework-free replacement for the I/O half of the app's
 * SchemaService. Same URLs, headers and bodies; the caching moves from
 * `shareReplay` observables to promise slots keyed by (identity, locale).
 *
 * SchemaService -> SchemaClient
 *
 * | SchemaService                         | SchemaClient                                    | Stays in the app |
 * | ------------------------------------- | ----------------------------------------------- | ---------------- |
 * | `getEntities()` (`schema_entities`)   | `getEntities()` / `peekEntities()` / `entitiesStore` | `tables` signal wiring, `getEntitiesForMenu` and friends |
 * | `getProperties()`                     | `getProperties()` (raw rows) + `getM2mMetadata()` | `getPropertyType()` typing, M:M enrichment, `p.type = ...` |
 * | `getPropertiesForEntity(table)`       | `getProperties()` (filter by `table_name` in the app) | the filter |
 * | `getPropertiesForEntityFresh(table)`  | `fetchPropertiesFresh()` (uncached, raw rows)   | typing, the filter |
 * | `getConstraintMessages()`             | `getConstraintMessages()` / `peekConstraintMessages()` | the `constraintMessages` field mirror |
 * | `getStatusesForEntity(type)`          | `getStatuses(type)` / `peekStatuses(type)`      | the `statusOptionsCache` signal |
 * | `getCategoriesForEntity(type)`        | `getCategories(type)` / `peekCategories(type)`  | the `categoryOptionsCache` signal |
 * | `getGuidedFormDefinitions()`          | `getGuidedFormDefinitions()`                    | `getEntityGuidedFormKey` and friends |
 * | `getGuidedFormSteps()`                | `getGuidedFormSteps()`                          | |
 * | `getStaticText()`                     | `getStaticText()` (adds `itemType`)             | per-entity filtering |
 * | `getEntityActions(table)`             | `getEntityActions(table)` (never cached)        | |
 * | (new in v0.77.0)                      | `getDomainVersion()` (never cached)             | |
 * | `refreshEntitiesCache()`              | `invalidateEntities()` (the app refetches)      | the eager refetch |
 * | `refreshPropertiesCache()`            | `invalidateProperties()` (the app refetches)    | the eager refetch |
 * | `refreshCache()` on locale change     | `use({ locale })`: nothing is cleared           | |
 * | VersionService + `schemaVersionGuard` | `checkVersions()` / `applyVersions(rows)`       | `profile_extensions` handling |
 *
 * Error behaviour, as today:
 * - `schema_entities` and `schema_properties`: the error rejects and is not
 *   cached; the next call retries.
 * - Every other resource logged the error and cached `[]`. Here the error goes
 *   to the `onError` option (instead of `console.error`), `[]` is resolved and
 *   it stays cached until an invalidation or `clear()`.
 * - `getEntityActions` logged and resolved `[]` too, and is never cached
 *   (`can_execute` depends on the caller's JWT).
 *
 * Not reproduced on purpose: `getStatusesForEntity` returned `of([])` to a
 * second caller that arrived while the first request was in flight (the
 * `loadingStatuses` guard). Here concurrent callers share the one in-flight
 * promise and all receive the real result.
 */

import type { ConstraintMessage } from '../model/api.js';
import type { EntityAction, SchemaEntityProperty, SchemaEntityTable, StaticText } from '../model/entity.js';
import type { GuidedFormDefinition, GuidedFormStep } from '../model/guided-form.js';
import type { CategoryOption, M2mPropertyMetadata, StatusOption } from '../model/schema.js';
import type { DomainVersionInfo, DomainVersionRow } from '../version/types.js';
import type { Transport } from '../transport/types.js';
import { mintEntityHandle } from '../handles/handles.js';
import type { EntityHandle, HandleSource } from '../handles/handles.js';
import { normalizeApiUrl, send } from './http.js';
import { createStore } from './store.js';
import type { Store } from './store.js';

/**
 * One row of the `schema_cache_versions` view.
 *
 * @consumer app
 */
export interface CacheVersionRow {
  cache_name: string;
  /** ISO timestamp; compared for equality only. */
  version: string;
}

/**
 * Which server-side metadata changed since the previous check. A flag is set
 * only when both the new and the previously seen version exist and differ (the
 * first value ever seen is just recorded).
 *
 * @consumer app
 */
export interface CacheVersionCheck {
  entitiesNeedsRefresh: boolean;
  propertiesNeedsRefresh: boolean;
  constraintMessagesNeedsRefresh: boolean;
  profileExtensionsNeedsRefresh: boolean;
  hasChanges: boolean;
}

/**
 * The cache context: which user and which language the cached metadata
 * belongs to.
 *
 * @consumer app
 */
export interface SchemaContext {
  /** Opaque cache key for "who is asking" (for example the user id, or `anonymous`). Never sent anywhere. */
  identity: string;
  /** Sent as `Accept-Language` unless it is `en` (the default, which sends no header, like the app's interceptor). */
  locale: string;
}

/**
 * Resource names passed to {@link SchemaClientOptions.onError}.
 *
 * @consumer app
 */
export type SchemaResource =
  | 'entities'
  | 'properties'
  | 'm2m_properties'
  | 'constraint_messages'
  | 'statuses'
  | 'categories'
  | 'guided_forms'
  | 'guided_form_steps'
  | 'static_text'
  | 'entity_actions'
  | 'domain_version';

/**
 * @consumer app
 */
export interface SchemaClientOptions {
  transport: Transport;
  /** PostgREST base URL; a trailing `/` is added when missing. */
  apiUrl: string;
  /** Initial cache identity. Default `''`. */
  identity?: string;
  /** Initial locale. Default `en`. */
  locale?: string;
  /**
   * Called when a resource that degrades to `[]` fails (today's `console.error`).
   * The error is a `TransportError` or a `DataClientError`.
   */
  onError?: (resource: SchemaResource, error: unknown, detail?: string) => void;
  /** Versions already known (for example persisted by the host), so the first check can detect a change. */
  knownVersions?: Record<string, string>;
}

interface Slot<T> {
  has: boolean;
  value: T | undefined;
  inflight: Promise<T> | undefined;
  /** Bumped by every invalidation; a response from an older generation is returned to its callers but not stored. */
  gen: number;
}

function newSlot<T>(): Slot<T> {
  return { has: false, value: undefined, inflight: undefined, gen: 0 };
}

function resetSlot<T>(slot: Slot<T>): void {
  slot.has = false;
  slot.value = undefined;
  slot.inflight = undefined;
  slot.gen++;
}

interface Bucket {
  identity: string;
  locale: string;
  entities: Slot<SchemaEntityTable[]>;
  properties: Slot<SchemaEntityProperty[]>;
  m2m: Slot<M2mPropertyMetadata[]>;
  constraintMessages: Slot<ConstraintMessage[]>;
  staticText: Slot<StaticText[]>;
  guidedForms: Slot<GuidedFormDefinition[]>;
  guidedFormSteps: Slot<GuidedFormStep[]>;
  statuses: Map<string, Slot<StatusOption[]>>;
  categories: Map<string, Slot<CategoryOption[]>>;
  /** Last successful `getEntityActions` result per table: a peek for handles only, never served by `getEntityActions`. */
  actions: Map<string, EntityAction[]>;
}

function newBucket(identity: string, locale: string): Bucket {
  return {
    identity,
    locale,
    entities: newSlot(),
    properties: newSlot(),
    m2m: newSlot(),
    constraintMessages: newSlot(),
    staticText: newSlot(),
    guidedForms: newSlot(),
    guidedFormSteps: newSlot(),
    statuses: new Map(),
    categories: new Map(),
    actions: new Map(),
  };
}

function bucketKey(identity: string, locale: string): string {
  return JSON.stringify([identity, locale]);
}

const DEFAULT_LOCALE = 'en';

/**
 * Same encoding as Angular's `HttpParams` (`encodeURIComponent`, then a few
 * characters restored), so the entity-actions query string is byte-identical
 * to today's.
 */
function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/%(\d[a-f0-9])/gi, (match, hex: string) => {
    switch (match.toLowerCase()) {
      case '%40':
        return '@';
      case '%3a':
        return ':';
      case '%24':
        return '$';
      case '%2c':
        return ',';
      case '%3b':
        return ';';
      case '%3d':
        return '=';
      case '%3f':
        return '?';
      case '%2f':
        return '/';
      default:
        return '%' + hex;
    }
  });
}

/**
 * Loads and caches the metadata the generic UI is built from. Every load
 * method calls `transport.request` synchronously (before returning its
 * promise) when the cache is cold, so a host can issue the request inside
 * `subscribe`.
 *
 * @consumer app
 */
export class SchemaClient implements HandleSource {
  private readonly transport: Transport;
  private readonly apiUrl: string;
  private readonly onError: ((resource: SchemaResource, error: unknown, detail?: string) => void) | undefined;
  private readonly buckets = new Map<string, Bucket>();
  private readonly versions = new Map<string, string>();
  private current: Bucket;
  private readonly entities$: Store<SchemaEntityTable[] | undefined>;

  constructor(options: SchemaClientOptions) {
    this.transport = options.transport;
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.onError = options.onError;
    for (const [name, version] of Object.entries(options.knownVersions ?? {})) {
      this.versions.set(name, version);
    }
    this.current = this.bucketFor(options.identity ?? '', options.locale ?? DEFAULT_LOCALE);
    this.entities$ = createStore<SchemaEntityTable[] | undefined>(undefined);
  }

  /**
   * Loaded entities of the current context, `undefined` while cold (also right
   * after an identity or locale switch to a context that is not cached yet,
   * and after {@link invalidateEntities}). The snapshot reference changes only
   * when the entities are (re)loaded or the context switches.
   */
  get entitiesStore(): Store<SchemaEntityTable[] | undefined> {
    return this.entities$;
  }

  /** The active cache context. */
  get context(): SchemaContext {
    return { identity: this.current.identity, locale: this.current.locale };
  }

  /**
   * Switches the active context. Nothing is cleared: a context seen before is
   * served from its own cache, a new one starts cold. Requests already in
   * flight finish into the context that issued them.
   */
  use(next: { identity?: string; locale?: string }): void {
    const identity = next.identity ?? this.current.identity;
    const locale = next.locale ?? this.current.locale;
    if (identity === this.current.identity && locale === this.current.locale) return;
    this.current = this.bucketFor(identity, locale);
    this.entities$.set(this.current.entities.value);
  }

  /** Drops every cached context (for example on sign-out). In-flight responses are discarded, not stored. */
  clear(): void {
    for (const bucket of this.buckets.values()) {
      resetBucket(bucket);
    }
    this.buckets.clear();
    this.current = this.bucketFor(this.current.identity, this.current.locale);
    this.entities$.set(undefined);
  }

  // ---------------------------------------------------------------------------
  // Cached loads
  // ---------------------------------------------------------------------------

  /** `GET schema_entities`. Errors reject and are not cached. */
  getEntities(): Promise<SchemaEntityTable[]> {
    const bucket = this.current;
    return this.load(
      bucket.entities,
      () => this.get<SchemaEntityTable[]>(bucket, 'schema_entities'),
      value => {
        if (bucket === this.current) this.entities$.set(value);
      },
    );
  }

  /** `GET schema_properties`, raw rows (the app assigns `type` and enriches M:M). Errors reject and are not cached. */
  getProperties(): Promise<SchemaEntityProperty[]> {
    const bucket = this.current;
    return this.load(bucket.properties, () => this.get<SchemaEntityProperty[]>(bucket, 'schema_properties'));
  }

  /** `GET schema_properties`, never cached and never stored (today's `getPropertiesForEntityFresh`). Errors reject. */
  fetchPropertiesFresh(): Promise<SchemaEntityProperty[]> {
    return this.get<SchemaEntityProperty[]>(this.current, 'schema_properties');
  }

  /** `GET schema_m2m_properties`. An error resolves `[]` and is cached. */
  getM2mMetadata(): Promise<M2mPropertyMetadata[]> {
    const bucket = this.current;
    return this.load(bucket.m2m, () => this.getList<M2mPropertyMetadata>(bucket, 'schema_m2m_properties', 'm2m_properties'));
  }

  /** `GET constraint_messages`. An error resolves `[]` and is cached. */
  getConstraintMessages(): Promise<ConstraintMessage[]> {
    const bucket = this.current;
    return this.load(bucket.constraintMessages, () =>
      this.getList<ConstraintMessage>(bucket, 'constraint_messages', 'constraint_messages'),
    );
  }

  /** `GET static_text`, each row tagged `itemType: 'static_text'`. An error resolves `[]` and is cached. */
  getStaticText(): Promise<StaticText[]> {
    const bucket = this.current;
    return this.load(bucket.staticText, () =>
      this.getList<Omit<StaticText, 'itemType'>>(bucket, 'static_text', 'static_text').then(rows =>
        rows.map(row => ({ ...row, itemType: 'static_text' as const })),
      ),
    );
  }

  /** `GET schema_guided_forms`. An error resolves `[]` and is cached. */
  getGuidedFormDefinitions(): Promise<GuidedFormDefinition[]> {
    const bucket = this.current;
    return this.load(bucket.guidedForms, () =>
      this.getList<GuidedFormDefinition>(bucket, 'schema_guided_forms', 'guided_forms'),
    );
  }

  /** `GET schema_guided_form_steps`. An error resolves `[]` and is cached. */
  getGuidedFormSteps(): Promise<GuidedFormStep[]> {
    const bucket = this.current;
    return this.load(bucket.guidedFormSteps, () =>
      this.getList<GuidedFormStep>(bucket, 'schema_guided_form_steps', 'guided_form_steps'),
    );
  }

  /** `POST rpc/get_statuses_for_entity`, cached per entity type. An error resolves `[]` and is cached. */
  getStatuses(entityType: string): Promise<StatusOption[]> {
    const bucket = this.current;
    return this.load(slotFor(bucket.statuses, entityType), () =>
      this.postList<StatusOption>(bucket, 'rpc/get_statuses_for_entity', entityType, 'statuses').then(rows =>
        rows.map(s => ({ id: s.id, display_name: s.display_name, color: s.color, status_key: s.status_key })),
      ),
    );
  }

  /** `POST rpc/get_categories_for_entity`, cached per entity type. An error resolves `[]` and is cached. */
  getCategories(entityType: string): Promise<CategoryOption[]> {
    const bucket = this.current;
    return this.load(slotFor(bucket.categories, entityType), () =>
      this.postList<CategoryOption>(bucket, 'rpc/get_categories_for_entity', entityType, 'categories').then(rows =>
        rows.map(c => ({ id: c.id, display_name: c.display_name, color: c.color })),
      ),
    );
  }

  /**
   * `GET schema_entity_actions` for one table, sorted by `sort_order`. Never
   * cached (`can_execute` depends on the caller's JWT). An error resolves `[]`.
   */
  getEntityActions(tableName: string): Promise<EntityAction[]> {
    const bucket = this.current;
    const path =
      'schema_entity_actions?table_name=' + encodeParam(`eq.${tableName}`) + '&order=' + encodeParam('sort_order.asc');
    const gen = bucket.entities.gen;
    return this.get<EntityAction[]>(bucket, path).then(
      rows => {
        // An invalidation while the request was in flight abandons the result, as for the cached slots
        if (bucket.entities.gen === gen) bucket.actions.set(tableName, rows);
        return rows;
      },
      err => {
        this.onError?.('entity_actions', err, tableName);
        return [];
      },
    );
  }

  /**
   * `GET schema_domain_version`: the instance's domain and framework versions,
   * camelCased. Never cached: it is read on demand (the about modal), not
   * during bootstrap, and a stale floor would be worse than one extra request.
   * Resolves `undefined`, and reports the error through `onError`, when the
   * view is absent (an instance older than v0.77.0 answers 404 / PGRST205) or
   * returns no row.
   */
  getDomainVersion(): Promise<DomainVersionInfo | undefined> {
    return this.get<DomainVersionRow[]>(this.current, 'schema_domain_version').then(
      rows => {
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row) return undefined;
        return {
          frameworkVersion: row.framework_version ?? null,
          domainVersion: row.domain_version,
          minClientDomainVersion: row.min_client_domain_version ?? null,
          setByMigration: row.set_by_migration,
          decisionId: row.decision_id ?? null,
          contractHash: row.contract_hash,
        };
      },
      err => {
        this.onError?.('domain_version', err);
        return undefined;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Synchronous warm accessors (undefined when cold)
  // ---------------------------------------------------------------------------

  peekEntities(): SchemaEntityTable[] | undefined {
    return this.current.entities.value;
  }

  peekProperties(): SchemaEntityProperty[] | undefined {
    return this.current.properties.value;
  }

  /**
   * The actions of the last successful {@link getEntityActions} for `tableName`,
   * `undefined` before one or after {@link invalidateEntities}. Only a peek for
   * handles: `getEntityActions` itself still requests every time.
   */
  peekEntityActions(tableName: string): EntityAction[] | undefined {
    return this.current.actions.get(tableName);
  }

  /**
   * A live handle for the entity `name`, or `undefined` when the entities are
   * cold or have no such entity. The handle keeps only the name and re-reads
   * this client on every access: after an invalidation, or a refresh that drops
   * the entity, it reports absence.
   */
  entity(name: string): EntityHandle | undefined {
    if (!this.peekEntities()?.some(e => e.table_name === name)) return undefined;
    return mintEntityHandle(this, name);
  }

  peekM2mMetadata(): M2mPropertyMetadata[] | undefined {
    return this.current.m2m.value;
  }

  peekConstraintMessages(): ConstraintMessage[] | undefined {
    return this.current.constraintMessages.value;
  }

  peekStaticText(): StaticText[] | undefined {
    return this.current.staticText.value;
  }

  peekGuidedFormDefinitions(): GuidedFormDefinition[] | undefined {
    return this.current.guidedForms.value;
  }

  peekGuidedFormSteps(): GuidedFormStep[] | undefined {
    return this.current.guidedFormSteps.value;
  }

  peekStatuses(entityType: string): StatusOption[] | undefined {
    return this.current.statuses.get(entityType)?.value;
  }

  peekCategories(entityType: string): CategoryOption[] | undefined {
    return this.current.categories.get(entityType)?.value;
  }

  // ---------------------------------------------------------------------------
  // Invalidation and version refresh
  // ---------------------------------------------------------------------------

  /** Forgets the entities of every cached context. The caller refetches if it wants them eagerly. */
  invalidateEntities(): void {
    for (const bucket of this.buckets.values()) {
      resetSlot(bucket.entities);
      bucket.actions.clear();
    }
    this.entities$.set(undefined);
  }

  /** Forgets properties and M:M metadata of every cached context (today's `refreshPropertiesCache`). */
  invalidateProperties(): void {
    for (const bucket of this.buckets.values()) {
      resetSlot(bucket.properties);
      resetSlot(bucket.m2m);
    }
  }

  /** Forgets constraint messages of every cached context. */
  invalidateConstraintMessages(): void {
    for (const bucket of this.buckets.values()) {
      resetSlot(bucket.constraintMessages);
    }
  }

  /**
   * Forgets cached statuses (today's `invalidateStatusCache(type?)`; with no
   * type it is also `refreshStatusesCache()`). A request in flight is
   * abandoned: its callers still get the result, but it is not stored.
   */
  invalidateStatuses(entityType?: string): void {
    invalidateKeyed(this.buckets, b => b.statuses, entityType);
  }

  /** Forgets cached categories (today's `invalidateCategoryCache(type?)`). Same rules as {@link invalidateStatuses}. */
  invalidateCategories(entityType?: string): void {
    invalidateKeyed(this.buckets, b => b.categories, entityType);
  }

  /** Forgets cached static text (today's `refreshStaticTextCache()`). */
  invalidateStaticText(): void {
    for (const bucket of this.buckets.values()) {
      resetSlot(bucket.staticText);
    }
  }

  /** Forgets guided form definitions and steps (today's `invalidateGuidedFormCache()`). */
  invalidateGuidedForms(): void {
    for (const bucket of this.buckets.values()) {
      resetSlot(bucket.guidedForms);
      resetSlot(bucket.guidedFormSteps);
    }
  }

  /**
   * `GET schema_cache_versions`, then {@link applyVersions}. Not shared between
   * concurrent calls.
   */
  checkVersions(): Promise<CacheVersionCheck> {
    return send(this.transport, {
      method: 'GET',
      url: this.apiUrl + 'schema_cache_versions',
      headers: this.headersFor(this.current),
    }).then(({ body }) => this.applyVersions(body as CacheVersionRow[]));
  }

  /**
   * Compares `rows` with the versions seen before, records the new versions,
   * and invalidates what changed, as `schemaVersionGuard` does today:
   * `entities` clears the entities, `properties` clears the properties and M:M
   * metadata. A changed `constraint_messages` or `profile_extensions` is only
   * reported (the guard ignores the former and hands the latter to
   * ProfileService); call {@link invalidateConstraintMessages} to act on it.
   * Invalidation covers every cached context, not only the current one.
   */
  applyVersions(rows: CacheVersionRow[]): CacheVersionCheck {
    const result: CacheVersionCheck = {
      entitiesNeedsRefresh: false,
      propertiesNeedsRefresh: false,
      constraintMessagesNeedsRefresh: false,
      profileExtensionsNeedsRefresh: false,
      hasChanges: false,
    };
    const changed = (name: string): boolean => {
      const next = rows.find(r => r.cache_name === name)?.version;
      const previous = this.versions.get(name);
      if (next) this.versions.set(name, next);
      return Boolean(next && previous && next !== previous);
    };
    result.entitiesNeedsRefresh = changed('entities');
    result.propertiesNeedsRefresh = changed('properties');
    result.constraintMessagesNeedsRefresh = changed('constraint_messages');
    result.profileExtensionsNeedsRefresh = changed('profile_extensions');
    result.hasChanges =
      result.entitiesNeedsRefresh ||
      result.propertiesNeedsRefresh ||
      result.constraintMessagesNeedsRefresh ||
      result.profileExtensionsNeedsRefresh;

    if (result.entitiesNeedsRefresh) this.invalidateEntities();
    if (result.propertiesNeedsRefresh) this.invalidateProperties();
    return result;
  }

  /** The versions recorded so far, for a host that persists them. */
  getKnownVersions(): Record<string, string> {
    return Object.fromEntries(this.versions);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private bucketFor(identity: string, locale: string): Bucket {
    const key = bucketKey(identity, locale);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = newBucket(identity, locale);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private headersFor(bucket: Bucket): Record<string, string> | undefined {
    return bucket.locale === DEFAULT_LOCALE ? undefined : { 'Accept-Language': bucket.locale };
  }

  /** Cache-or-share-or-fetch for one slot. `run` is called synchronously on a cold slot. */
  private load<T>(slot: Slot<T>, run: () => Promise<T>, after?: (value: T) => void): Promise<T> {
    if (slot.has) return Promise.resolve(slot.value as T);
    if (slot.inflight) return slot.inflight;
    const gen = slot.gen;
    const promise = run().then(
      value => {
        if (slot.gen === gen) {
          slot.has = true;
          slot.value = value;
          slot.inflight = undefined;
          after?.(value);
        }
        return value;
      },
      error => {
        if (slot.gen === gen) slot.inflight = undefined;
        throw error;
      },
    );
    slot.inflight = promise;
    return promise;
  }

  private get<T>(bucket: Bucket, path: string): Promise<T> {
    return send(this.transport, {
      method: 'GET',
      url: this.apiUrl + path,
      headers: this.headersFor(bucket),
    }).then(({ body }) => body as T);
  }

  private getList<T>(bucket: Bucket, path: string, resource: SchemaResource): Promise<T[]> {
    return this.get<T[]>(bucket, path).then(
      rows => rows,
      err => {
        this.onError?.(resource, err);
        return [];
      },
    );
  }

  private postList<T>(bucket: Bucket, path: string, entityType: string, resource: SchemaResource): Promise<T[]> {
    return send(this.transport, {
      method: 'POST',
      url: this.apiUrl + path,
      headers: this.headersFor(bucket),
      body: JSON.stringify({ p_entity_type: entityType }),
    }).then(
      ({ body }) => body as T[],
      err => {
        this.onError?.(resource, err, entityType);
        return [];
      },
    );
  }
}

function slotFor<T>(map: Map<string, Slot<T>>, key: string): Slot<T> {
  let slot = map.get(key);
  if (!slot) {
    slot = newSlot<T>();
    map.set(key, slot);
  }
  return slot;
}

function invalidateKeyed<T>(buckets: Map<string, Bucket>, pick: (b: Bucket) => Map<string, Slot<T>>, key?: string): void {
  for (const bucket of buckets.values()) {
    const map = pick(bucket);
    if (key === undefined) {
      for (const slot of map.values()) resetSlot(slot);
      map.clear();
    } else {
      const slot = map.get(key);
      if (slot) resetSlot(slot);
      map.delete(key);
    }
  }
}

function resetBucket(bucket: Bucket): void {
  resetSlot(bucket.entities);
  resetSlot(bucket.properties);
  resetSlot(bucket.m2m);
  resetSlot(bucket.constraintMessages);
  resetSlot(bucket.staticText);
  resetSlot(bucket.guidedForms);
  resetSlot(bucket.guidedFormSteps);
  for (const slot of bucket.statuses.values()) resetSlot(slot);
  for (const slot of bucket.categories.values()) resetSlot(slot);
  bucket.actions.clear();
}
