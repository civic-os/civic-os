/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Why the generated types cannot be vouched for against the live instance.
 *
 * - `hash-mismatch`: the instance's `contract_hash` differs from the `SCHEMA_HASH` the app was generated from.
 * - `unverifiable`: the instance has no `schema_domain_version` view (older than v0.77.0), so there is no hash to compare.
 * - `client-ahead`: the app was generated against a newer domain version than the instance runs.
 * - `invalid`: a domain version is not valid semver.
 *
 * @consumer typed bootstrapTypedSchema
 */
export type SchemaMismatchReason = 'hash-mismatch' | 'unverifiable' | 'client-ahead' | 'invalid';

/**
 * A mismatch between the generated types and the live instance, handed to `onWarn` and carried by
 * {@link SchemaMismatchError}.
 *
 * @consumer typed bootstrapTypedSchema
 */
export interface SchemaMismatch {
  reason: SchemaMismatchReason;
  /** The `SCHEMA_HASH` the app understands. */
  expectedHash: string;
  /** The instance's `contract_hash`; `undefined` when the instance has no domain version view. */
  liveHash: string | undefined;
  /** The `DOMAIN_VERSION` the app understands. */
  appDomainVersion: string;
  /** The instance's domain version; `undefined` when the instance has no domain version view. */
  instanceDomainVersion: string | undefined;
}

/**
 * The instance requires a newer client (its `min_client_domain_version` is above the app's
 * `DOMAIN_VERSION`). Raised under every mismatch policy: the floor is the server's mandate and a client
 * policy cannot waive it.
 *
 * @consumer typed bootstrapTypedSchema
 */
export class ClientUpdateRequiredError extends Error {
  readonly appDomainVersion: string;
  readonly minClientDomainVersion: string;

  constructor(appDomainVersion: string, minClientDomainVersion: string) {
    super(
      `This app understands domain version ${appDomainVersion}, but the instance requires at least ${minClientDomainVersion}. Update the app.`,
    );
    this.name = 'ClientUpdateRequiredError';
    this.appDomainVersion = appDomainVersion;
    this.minClientDomainVersion = minClientDomainVersion;
  }
}

/**
 * Raised by `onIncompatible: 'block'` when the generated types do not match the instance.
 *
 * @consumer typed bootstrapTypedSchema
 */
export class SchemaMismatchError extends Error {
  readonly mismatch: SchemaMismatch;

  constructor(mismatch: SchemaMismatch) {
    super(describeMismatch(mismatch));
    this.name = 'SchemaMismatchError';
    this.mismatch = mismatch;
  }
}

/**
 * An entity, column or action the generated types promise is not in the live schema.
 *
 * @consumer typed bootstrapTypedSchema
 */
export class SchemaContractError extends Error {
  readonly entity: string;
  /** The column or action key; `undefined` when the entity itself is missing. */
  readonly member: string | undefined;

  constructor(entity: string, member?: string, detail?: string) {
    super(
      member === undefined
        ? `Entity "${entity}" is not in the live schema.${detail ? ` ${detail}` : ''}`
        : `"${entity}.${member}" is not in the live schema.${detail ? ` ${detail}` : ''}`,
    );
    this.name = 'SchemaContractError';
    this.entity = entity;
    this.member = member;
  }
}

function describeMismatch(m: SchemaMismatch): string {
  switch (m.reason) {
    case 'hash-mismatch':
      return `The instance's schema contract (${m.liveHash}) differs from the one this app was generated from (${m.expectedHash}).`;
    case 'unverifiable':
      return 'The instance does not report a schema contract hash (older than Civic OS v0.77.0), so the generated types cannot be verified.';
    case 'client-ahead':
      return `This app was generated for domain version ${m.appDomainVersion}, but the instance runs ${m.instanceDomainVersion}.`;
    case 'invalid':
      return 'A domain version is not valid semver, so the generated types cannot be checked against the instance.';
  }
}
