/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Query compiler and response helpers (P1.1c). */
export { compileDataQuery, FILTER_OPERATORS, QueryValidationError } from './compile.js';
export type { CompileDataQueryOptions, CompiledDataQuery, FilterOperator } from './compile.js';
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
export { compileWith, defineQuery } from './typed/index.js';
export type {
  CompiledWith,
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
  WithInput,
  WithQueryInput,
  WithSchemaContext,
  WithSubQueryInput,
} from './typed/index.js';
