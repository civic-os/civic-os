/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Typed entity accessors with a bootstrap schema hash check (P1.5c). */
export { bootstrapTypedSchema } from './bootstrap.js';
export type {
  ActionKeysOf,
  EntityAccessor,
  IncompatiblePolicy,
  TypedSchema,
  TypedSchemaMode,
  TypedSchemaOptions,
} from './bootstrap.js';
export { ClientUpdateRequiredError, SchemaContractError, SchemaMismatchError } from './errors.js';
export type { SchemaMismatch, SchemaMismatchReason } from './errors.js';
