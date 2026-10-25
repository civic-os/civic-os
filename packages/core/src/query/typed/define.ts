/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseShape, EntityName, ExactQuery, TypedQuery } from './types.js';

/**
 * Typed allowlist for a hoisted query (decision 12): returns `q` unchanged,
 * typed as the exact literal, so a query defined away from its call site is
 * checked against the entity and keeps its inferred result type.
 *
 * `defineQuery<Database, 'Issue'>()({ select: ['id'] })`. Generated code
 * binds `Database` once and re-exports `defineQuery<E>()`.
 *
 * @consumer typed compileWith
 */
export function defineQuery<D extends DatabaseShape, E extends EntityName<D>>(): <const Q extends TypedQuery<D, E>>(
  q: Q & ExactQuery<D, E, Q>,
) => Q {
  return q => q;
}
