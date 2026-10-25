/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Query compiler and response helpers (P1.1c). */
export { compileDataQuery, QueryValidationError } from './compile.js';
export type { CompileDataQueryOptions, CompiledDataQuery } from './compile.js';
export { parseContentRangeTotal, transformManyToManyData } from './response.js';
export { buildHybridSearchParams, buildOrderField, buildSearchParams } from './search.js';
export type { SearchParamsOptions } from './search.js';
export {
  parseEWKBPoint,
  compareDateTimeValues,
  compareDateValues,
  compareMoneyValues,
  compareColorValues,
  compareTimeSlotValues,
  compareGeographyValues,
  checkEditResult,
} from './compare.js';

/** Typed rows, queries and the `with` compiler (SDK P1.5b). */
export type {
  DatabaseShape,
  EmbeddedOf,
  EntityName,
  EntityShape,
  ExactQuery,
  InsertOf,
  QueryResult,
  RelationResult,
  RelationShape,
  RelationsOf,
  ResultShape,
  RowOf,
  SubQuery,
  TargetOf,
  TypedQuery,
  UpdateOf,
  With,
} from './typed/index.js';
