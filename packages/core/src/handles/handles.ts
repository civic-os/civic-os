/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Presence-checked handles over the live schema store (docs/notes/FRONTEND_SDK_DESIGN.md
 * section 6). A handle stores only a name or key. Every getter re-reads the source,
 * so a handle never keeps a row alive: after an invalidation, or a refresh that
 * removes the entity, it reports absence (`exists === false`, getters return
 * `undefined`) instead of throwing or serving stale data.
 *
 * Handles are branded: the constructors are private and demand a module-private
 * token, so only core (through `mintEntityHandle`) can make one.
 */

import { evaluateActionCondition } from '../conditions/action-condition.js';
import type {
  EntityAction,
  EntityActionParam,
  EntityPropertyType,
  SchemaEntityProperty,
  SchemaEntityTable,
} from '../model/entity.js';
import { getPropertyType } from '../schema/property-type.js';
import { validationRules } from '../schema/validation.js';
import type { ValidationRuleSpec } from '../schema/validation.js';

/**
 * What handles read from. {@link SchemaClient} implements it; each call must return the
 * current store contents (or `undefined` while cold).
 *
 * @consumer typed EntityHandle
 */
export interface HandleSource {
  peekEntities(): readonly SchemaEntityTable[] | undefined;
  peekProperties(): readonly SchemaEntityProperty[] | undefined;
  peekEntityActions(tableName: string): readonly EntityAction[] | undefined;
}

/**
 * Schema truth of a property: facts every consumer wants, independent of how a UI shows it.
 *
 * @consumer typed PropertyHandle
 */
export interface PropertySchemaTruth {
  readonly type: EntityPropertyType;
  readonly validators: readonly ValidationRuleSpec[];
  readonly dataType: string;
  readonly udtName: string;
  readonly isNullable: boolean;
  readonly isGenerated: boolean;
  readonly isIdentity: boolean;
  readonly isUpdatable: boolean;
  readonly joinTable: string | null;
  readonly joinColumn: string | null;
  readonly statusEntityType: string | null;
  readonly categoryEntityType: string | null;
}

/**
 * Presentation defaults of a property: metadata a custom app may override or ignore.
 *
 * @consumer typed PropertyHandle
 */
export interface PropertyPresentation {
  readonly showOn: {
    readonly list: boolean;
    readonly create: boolean;
    readonly edit: boolean;
    readonly detail: boolean;
  };
  readonly sortOrder: number;
  readonly columnWidth: number | undefined;
  readonly displayName: string;
  readonly sortable: boolean | undefined;
  readonly filterable: boolean | undefined;
}

/**
 * Structural facts of a property: always fetched, whatever its visibility.
 *
 * @consumer typed PropertyHandle
 */
export interface PropertyStructural {
  readonly name: string;
  readonly tableName: string;
  readonly description: string | undefined;
  readonly optionsSourceRpc: string | undefined;
  readonly dependsOnColumns: readonly string[];
  readonly fkSearchModal: boolean;
}

/**
 * Schema truth of an entity.
 *
 * @consumer typed EntityHandle
 */
export interface EntitySchemaTruth {
  readonly isView: boolean;
  readonly isRichJunction: boolean;
}

/**
 * Presentation defaults of an entity.
 *
 * @consumer typed EntityHandle
 */
export interface EntityPresentation {
  readonly sortOrder: number;
  readonly showInSidebar: boolean;
}

/**
 * Structural facts of an entity: always fetched, whatever its visibility.
 *
 * @consumer typed EntityHandle
 */
export interface EntityStructural {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly searchFields: readonly string[];
  readonly fulltextSearchColumn: string | null;
  readonly substringSearchColumn: string | null;
}

/**
 * The `schema_entities` permission flags of the caller. Presence and permission
 * stay separate checks.
 *
 * @consumer typed EntityHandle
 */
export interface EntityPermissions {
  readonly insert: boolean;
  readonly select: boolean;
  readonly update: boolean;
  readonly delete: boolean;
}

/**
 * Optional features an entity opted into through `metadata.entities`.
 *
 * @consumer typed EntityHandle
 */
export interface EntityFeatures {
  readonly notes: boolean;
  readonly calendar: boolean;
  readonly calendarProperty: string | null;
  readonly calendarColorProperty: string | null;
  readonly map: boolean;
  readonly mapProperty: string | null;
  readonly mapColorProperty: string | null;
  readonly payment: boolean;
  readonly paymentInitiationRpc: string | null;
  readonly paymentCaptureMode: 'immediate' | 'deferred' | null;
  readonly recurring: boolean;
  readonly recurringProperty: string | null;
  readonly guidedFormKey: string | null;
}

const MINT = Symbol('civic-os.handle');

// Assigned by the static blocks below; the only way to reach the private constructors.
let mintProperty: (source: HandleSource, tableName: string, name: string) => PropertyHandle;
let mintAction: (source: HandleSource, tableName: string, key: string) => ActionHandle;
let mintEntity: (source: HandleSource, name: string) => EntityHandle;

function assertMinted(token: symbol): void {
  if (token !== MINT) {
    throw new TypeError('Handles are created by the schema client; use client.entity(name)');
  }
}

function findEntity(source: HandleSource, name: string): SchemaEntityTable | undefined {
  return source.peekEntities()?.find(e => e.table_name === name);
}

function findProperty(source: HandleSource, table: string, column: string): SchemaEntityProperty | undefined {
  return source.peekProperties()?.find(p => p.table_name === table && p.column_name === column);
}

/**
 * A property of an entity. Only an {@link EntityHandle} hands these out.
 *
 * @consumer typed EntityHandle
 */
export class PropertyHandle {
  private constructor(
    token: symbol,
    private readonly source: HandleSource,
    private readonly tableName: string,
    readonly name: string,
  ) {
    assertMinted(token);
  }

  static {
    mintProperty = (source, tableName, name) => new PropertyHandle(MINT, source, tableName, name);
  }

  private row(): SchemaEntityProperty | undefined {
    if (!findEntity(this.source, this.tableName)) return undefined;
    return findProperty(this.source, this.tableName, this.name);
  }

  /** Whether the entity and the column are in the live store right now. */
  get exists(): boolean {
    return this.row() !== undefined;
  }

  get schema(): PropertySchemaTruth | undefined {
    const p = this.row();
    if (!p) return undefined;
    return Object.freeze({
      type: getPropertyType(p),
      validators: Object.freeze(validationRules(p)),
      dataType: p.data_type,
      udtName: p.udt_name,
      isNullable: p.is_nullable,
      isGenerated: p.is_generated,
      isIdentity: p.is_identity,
      isUpdatable: p.is_updatable,
      joinTable: p.join_table || null,
      joinColumn: p.join_column || null,
      statusEntityType: p.status_entity_type ?? null,
      categoryEntityType: p.category_entity_type ?? null,
    });
  }

  get presentation(): PropertyPresentation | undefined {
    const p = this.row();
    if (!p) return undefined;
    return Object.freeze({
      showOn: Object.freeze({
        list: p.show_on_list ?? true,
        create: p.show_on_create ?? true,
        edit: p.show_on_edit ?? true,
        detail: p.show_on_detail ?? true,
      }),
      sortOrder: p.sort_order,
      columnWidth: p.column_width,
      displayName: p.display_name,
      sortable: p.sortable,
      filterable: p.filterable,
    });
  }

  get structural(): PropertyStructural | undefined {
    const p = this.row();
    if (!p) return undefined;
    return Object.freeze({
      name: p.column_name,
      tableName: p.table_name,
      description: p.description,
      optionsSourceRpc: p.options_source_rpc,
      dependsOnColumns: Object.freeze([...(p.depends_on_columns ?? [])]),
      fkSearchModal: p.fk_search_modal ?? false,
    });
  }
}

/**
 * An entity action. Only an {@link EntityHandle} hands these out; it reads the last
 * action rows the client loaded for the entity.
 *
 * @consumer typed EntityHandle
 */
export class ActionHandle {
  private constructor(
    token: symbol,
    private readonly source: HandleSource,
    private readonly tableName: string,
    readonly key: string,
  ) {
    assertMinted(token);
  }

  static {
    mintAction = (source, tableName, key) => new ActionHandle(MINT, source, tableName, key);
  }

  private row(): EntityAction | undefined {
    if (!findEntity(this.source, this.tableName)) return undefined;
    return this.source.peekEntityActions(this.tableName)?.find(a => a.action_name === this.key);
  }

  get exists(): boolean {
    return this.row() !== undefined;
  }

  get displayName(): string | undefined {
    return this.row()?.display_name;
  }

  get rpcFunction(): string | undefined {
    return this.row()?.rpc_function;
  }

  get parameters(): readonly EntityActionParam[] | undefined {
    return this.row()?.parameters;
  }

  /** Whether the caller may execute the action (`can_execute` from the view). `undefined` when absent. */
  get canExecute(): boolean | undefined {
    return this.row()?.can_execute;
  }

  /** The visibility condition against `record`; no condition means visible. `undefined` when absent. */
  isVisible(record: Record<string, unknown> | null | undefined): boolean | undefined {
    const a = this.row();
    return a ? evaluateActionCondition(a.visibility_condition, record) : undefined;
  }

  /** The enabled condition against `record`; no condition means enabled. `undefined` when absent. */
  isEnabled(record: Record<string, unknown> | null | undefined): boolean | undefined {
    const a = this.row();
    return a ? evaluateActionCondition(a.enabled_condition, record) : undefined;
  }
}

/**
 * An entity (table or view) of the live schema. Obtain one from `SchemaClient.entity(name)`.
 *
 * @consumer app
 */
export class EntityHandle {
  private constructor(
    token: symbol,
    private readonly source: HandleSource,
    readonly name: string,
  ) {
    assertMinted(token);
  }

  static {
    mintEntity = (source, name) => new EntityHandle(MINT, source, name);
  }

  private row(): SchemaEntityTable | undefined {
    return findEntity(this.source, this.name);
  }

  /** Whether the entity is in the live store right now. */
  get exists(): boolean {
    return this.row() !== undefined;
  }

  /**
   * The live `schema_entities` row, for adapters that still hand rows to legacy code.
   * Read it fresh on every use and do not keep it: it is the one place a row escapes.
   */
  get liveRow(): SchemaEntityTable | undefined {
    return this.row();
  }

  /** The column `name`, or `undefined` when the entity or the column is not in the live store. */
  property(name: string): PropertyHandle | undefined {
    if (!this.exists || !findProperty(this.source, this.name, name)) return undefined;
    return mintProperty(this.source, this.name, name);
  }

  /** The action `key` (its `action_name`) from the actions loaded for this entity, or `undefined`. */
  action(key: string): ActionHandle | undefined {
    if (!this.exists || !this.source.peekEntityActions(this.name)?.some(a => a.action_name === key)) return undefined;
    return mintAction(this.source, this.name, key);
  }

  get schema(): EntitySchemaTruth | undefined {
    const e = this.row();
    if (!e) return undefined;
    return Object.freeze({ isView: e.is_view ?? false, isRichJunction: e.is_rich_junction ?? false });
  }

  get presentation(): EntityPresentation | undefined {
    const e = this.row();
    if (!e) return undefined;
    return Object.freeze({ sortOrder: e.sort_order, showInSidebar: e.show_in_sidebar ?? true });
  }

  get structural(): EntityStructural | undefined {
    const e = this.row();
    if (!e) return undefined;
    return Object.freeze({
      name: e.table_name,
      displayName: e.display_name,
      description: e.description,
      searchFields: Object.freeze([...(e.search_fields ?? [])]),
      fulltextSearchColumn: e.fulltext_search_column ?? null,
      substringSearchColumn: e.substring_search_column ?? null,
    });
  }

  get can(): EntityPermissions | undefined {
    const e = this.row();
    if (!e) return undefined;
    return Object.freeze({ insert: e.insert, select: e.select, update: e.update, delete: e.delete });
  }

  get features(): EntityFeatures | undefined {
    const e = this.row();
    if (!e) return undefined;
    return Object.freeze({
      notes: e.enable_notes ?? false,
      calendar: e.show_calendar,
      calendarProperty: e.calendar_property_name,
      calendarColorProperty: e.calendar_color_property,
      map: e.show_map,
      mapProperty: e.map_property_name,
      mapColorProperty: e.map_color_property ?? null,
      payment: !!e.payment_initiation_rpc,
      paymentInitiationRpc: e.payment_initiation_rpc ?? null,
      paymentCaptureMode: e.payment_capture_mode ?? null,
      recurring: e.supports_recurring ?? false,
      recurringProperty: e.recurring_property_name ?? null,
      guidedFormKey: e.guided_form_key ?? null,
    });
  }
}

/**
 * Makes an entity handle over `source`. Not exported from the package barrel:
 * only the schema client calls it.
 *
 * @internal
 */
export function mintEntityHandle(source: HandleSource, name: string): EntityHandle {
  return mintEntity(source, name);
}
