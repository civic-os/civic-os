/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataClient } from '../client/data-client.js';
import type { SchemaEntityProperty, SchemaEntityTable } from '../model/index.js';
import type { Clock } from '../state/clock.js';

/**
 * The schema as a facade reads it. The generic app implements it over
 * `SchemaService`; a consumer without one builds the same list from
 * `SchemaClient` with `getPropertyType`, `enrichPropertiesWithManyToMany` and
 * `compareBySortOrder`.
 *
 * @consumer typed FacadeDeps
 */
export interface FacadeSchema {
  /**
   * Every property of `entity`'s table: typed, with the M:M properties added,
   * in `compareBySortOrder` order. Rejects when the schema cannot load.
   */
  properties(entity: SchemaEntityTable): Promise<readonly SchemaEntityProperty[]>;
}

/**
 * What every record facade is given. Handles carry no data client, so a
 * facade takes its I/O explicitly; the Angular side injects these.
 *
 * @consumer typed recordList
 */
export interface FacadeDeps {
  readonly data: DataClient;
  readonly schema: FacadeSchema;
  readonly clock: Clock;
}
