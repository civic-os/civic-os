/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Typed accessors over the presence-checked handles (docs/notes/FRONTEND_SDK_DESIGN.md sections 6, 9, 12).
 *
 * Verify once, then trust: the app is generated against a `SCHEMA_HASH`; at bootstrap the instance's
 * `contract_hash` is compared once. On a match every accessor is non-optional. On a mismatch the
 * `onIncompatible` policy decides: `block` refuses to start, `warn` trusts after one warning, `verify`
 * re-checks presence on every accessor call.
 */

import type { SchemaClient } from '../client/schema-client.js';
import type { ActionHandle, EntityHandle, PropertyHandle } from '../handles/handles.js';
import type { DatabaseShape, EntityName, RowOf } from '../query/typed/types.js';
import { checkCompatibility } from '../version/compat.js';
import type { CompatibilityResult } from '../version/compat.js';
import type { DomainVersionInfo } from '../version/types.js';
import { ClientUpdateRequiredError, SchemaContractError, SchemaMismatchError } from './errors.js';
import type { SchemaMismatch } from './errors.js';

/**
 * What to do when the generated types do not match the instance (the hash differs or cannot be read, or the
 * app is ahead of the instance). The instance's `min_client_domain_version` floor is not a policy matter: it
 * always rejects.
 *
 * @consumer typed bootstrapTypedSchema
 */
export type IncompatiblePolicy = 'block' | 'warn' | 'verify';

/**
 * How far the accessors may be trusted.
 *
 * - `verified`: the hash matched; handles are resolved once and memoized.
 * - `trusted-after-warning`: the hash did not match, the policy was `warn`; same memoization, after one warning.
 * - `per-call`: the policy was `verify` and the hash did not match; presence is re-checked on every call.
 *
 * @consumer typed bootstrapTypedSchema
 */
export type TypedSchemaMode = 'verified' | 'trusted-after-warning' | 'per-call';

/**
 * Options of {@link bootstrapTypedSchema}.
 *
 * @consumer typed bootstrapTypedSchema
 */
export interface TypedSchemaOptions {
  schema: SchemaClient;
  /** The generated `DOMAIN_VERSION` and `SCHEMA_HASH`. */
  understands: { domain: string; schemaHash: string };
  onIncompatible: IncompatiblePolicy;
  /** Called once with the mismatch under `warn`, and may be called under `verify`. Defaults to `console.warn`. */
  onWarn?: (mismatch: SchemaMismatch) => void;
}

/**
 * The action keys of an entity in the generated `Database` (`never` when the entity has none).
 *
 * @consumer typed bootstrapTypedSchema
 */
export type ActionKeysOf<D extends DatabaseShape, E extends EntityName<D>> =
  D['entities'][E] extends { Actions: infer A } ? keyof A & string : never;

/**
 * Accessors for one entity. Handles stay live: they read the schema store on every getter, so they follow a
 * `use()` identity or locale switch. After `clear()` the store is empty: accessor calls throw
 * {@link SchemaContractError} until it is reloaded, and `mode` stays as it was (the hash is role-independent
 * and is only compared at bootstrap).
 *
 * @consumer typed bootstrapTypedSchema
 */
export interface EntityAccessor<D extends DatabaseShape, E extends EntityName<D>> {
  /** The entity's handle. Throws {@link SchemaContractError} on every call while the entity is absent from the live store. */
  readonly handle: EntityHandle;
  /**
   * A column the generated `Row` has. Throws {@link SchemaContractError} on every call while the entity or
   * the column is absent from the live store (a memoized handle is re-checked, never returned dead).
   */
  property(column: keyof RowOf<D, E> & string): PropertyHandle;
  /** Any column by name, for columns that vary by instance. `undefined` when absent; never throws. */
  optional(column: string): PropertyHandle | undefined;
  /**
   * An action the generated `Actions` has. Actions are loaded lazily by `SchemaClient.getEntityActions`;
   * call {@link EntityAccessor.loadActions} first. Throws {@link SchemaContractError} on every call while the
   * actions are not loaded (the message says so) or the action is absent from the live store.
   */
  action(key: ActionKeysOf<D, E>): ActionHandle;
  /** Loads the entity's actions, so that {@link EntityAccessor.action} can resolve them. */
  loadActions(): Promise<void>;
}

/**
 * The typed view of the live schema.
 *
 * @consumer typed bootstrapTypedSchema
 */
export interface TypedSchema<D extends DatabaseShape> {
  /**
   * One accessor per generated entity name. Built lazily from the live store through a Proxy, so the
   * generated file needs no runtime entity list; a name the live store lacks fails when the accessor's
   * `handle` or `property` is used, not when it is read. `then`, `toJSON` and symbol keys are `undefined`,
   * so the object can be awaited and serialized.
   */
  readonly entities: { readonly [E in EntityName<D>]: EntityAccessor<D, E> };
  readonly mode: TypedSchemaMode;
  /** The instance's version record; `undefined` when the instance has no `schema_domain_version` view. */
  readonly instance: DomainVersionInfo | undefined;
  /** The {@link checkCompatibility} result; `undefined` when the instance reports no versions. */
  readonly compatibility: CompatibilityResult | undefined;
}

function defaultWarn(mismatch: SchemaMismatch): void {
  const c = (globalThis as { console?: { warn(...args: unknown[]): void } }).console;
  c?.warn(`[civic-os] generated types do not match the instance: ${mismatch.reason}`, mismatch);
}

/**
 * Load the schema, compare it once with the generated `SCHEMA_HASH`, and return typed accessors.
 *
 * Order: (1) the instance's `min_client_domain_version` floor, always blocking: a
 * {@link ClientUpdateRequiredError} whatever `onIncompatible` says (design sections 9 and 12 name one
 * option; this reads the floor as the server's mandate and the policy as the client's choice for
 * everything else). The floor fails closed: when the instance sets one and a version is not valid semver
 * (so the floor cannot be compared), a {@link SchemaMismatchError} with reason `invalid` is thrown under
 * every policy. (2) The hash: equal means `verified`. A missing view is a mismatch with reason
 * `unverifiable`, and a client ahead of the instance or an invalid version is a mismatch too. (3) The
 * policy applies to a mismatch.
 *
 * @consumer typed bootstrapTypedSchema
 */
export async function bootstrapTypedSchema<D extends DatabaseShape>(opts: TypedSchemaOptions): Promise<TypedSchema<D>> {
  const { schema, understands, onIncompatible } = opts;
  await Promise.all([schema.getEntities(), schema.getProperties()]);
  const instance = await schema.getDomainVersion();

  const compatibility = instance
    ? checkCompatibility(
        { domainVersion: instance.domainVersion, minClientDomainVersion: instance.minClientDomainVersion },
        { domainVersion: understands.domain },
      )
    : undefined;
  if (compatibility?.status === 'client-too-old') {
    throw new ClientUpdateRequiredError(compatibility.appDomainVersion, compatibility.minClientDomainVersion);
  }
  // Fail closed: checkCompatibility reports `invalid` before it compares against the floor, so with a floor set an
  // invalid version means the floor could not be enforced. That rejects under every policy.
  if (compatibility?.status === 'invalid' && instance?.minClientDomainVersion != null) {
    throw new SchemaMismatchError({
      reason: 'invalid',
      expectedHash: understands.schemaHash,
      liveHash: instance.contractHash,
      appDomainVersion: understands.domain,
      instanceDomainVersion: instance.domainVersion,
    });
  }

  const base = {
    expectedHash: understands.schemaHash,
    liveHash: instance?.contractHash,
    appDomainVersion: understands.domain,
    instanceDomainVersion: instance?.domainVersion,
  };
  let mismatch: SchemaMismatch | undefined;
  if (!instance) mismatch = { ...base, reason: 'unverifiable' };
  else if (compatibility?.status === 'client-ahead') mismatch = { ...base, reason: 'client-ahead' };
  else if (compatibility?.status === 'invalid') mismatch = { ...base, reason: 'invalid' };
  else if (instance.contractHash !== understands.schemaHash) mismatch = { ...base, reason: 'hash-mismatch' };

  let mode: TypedSchemaMode = 'verified';
  if (mismatch) {
    if (onIncompatible === 'block') throw new SchemaMismatchError(mismatch);
    (opts.onWarn ?? defaultWarn)(mismatch);
    mode = onIncompatible === 'warn' ? 'trusted-after-warning' : 'per-call';
  }

  return { entities: makeEntities<D>(schema, mode), mode, instance, compatibility };
}

function makeAccessor(schema: SchemaClient, name: string, perCall: boolean): EntityAccessor<DatabaseShape, string> {
  let entity: EntityHandle | undefined;
  const properties = new Map<string, PropertyHandle>();
  const actions = new Map<string, ActionHandle>();

  // A memoized handle is only reused while it still exists in the live store (a cheap lookup); one that does not
  // is dropped and resolved again, so absence throws on every call, never a dead handle.
  const resolveEntity = (): EntityHandle => {
    if (!perCall && entity?.exists) return entity;
    const found = schema.entity(name);
    if (!found) throw new SchemaContractError(name);
    if (!perCall) entity = found;
    return found;
  };

  return {
    get handle() {
      return resolveEntity();
    },
    property(column) {
      const memo = perCall ? undefined : properties.get(column);
      if (memo?.exists) return memo;
      const found = resolveEntity().property(column);
      if (!found) throw new SchemaContractError(name, column);
      if (!perCall) properties.set(column, found);
      return found;
    },
    optional(column) {
      return schema.entity(name)?.property(column);
    },
    action(key) {
      const memo = perCall ? undefined : actions.get(key);
      if (memo?.exists) return memo;
      const handle = resolveEntity();
      if (schema.peekEntityActions(name) === undefined) {
        throw new SchemaContractError(name, key, `The actions of "${name}" are not loaded: await entities.${name}.loadActions() first.`);
      }
      const found = handle.action(key);
      if (!found) throw new SchemaContractError(name, key);
      if (!perCall) actions.set(key, found);
      return found;
    },
    async loadActions() {
      await schema.getEntityActions(name);
    },
  };
}

function makeEntities<D extends DatabaseShape>(schema: SchemaClient, mode: TypedSchemaMode): TypedSchema<D>['entities'] {
  const perCall = mode === 'per-call';
  const accessors = new Map<string, EntityAccessor<DatabaseShape, string>>();
  const liveNames = (): string[] => (schema.peekEntities() ?? []).map(e => e.table_name);
  return new Proxy({} as TypedSchema<D>['entities'], {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') return undefined;
      let accessor = accessors.get(prop);
      if (!accessor) {
        accessor = makeAccessor(schema, prop, perCall);
        accessors.set(prop, accessor);
      }
      return accessor;
    },
    has: (_target, prop) => typeof prop === 'string' && liveNames().includes(prop),
    ownKeys: () => liveNames(),
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === 'string' && liveNames().includes(prop) ? { enumerable: true, configurable: true } : undefined,
  });
}
