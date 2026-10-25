/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Typed rows, queries and the `with` compiler (SDK P1.5b). */
export { compileWith } from './compile-with.js';
export type { CompiledWith, WithInput, WithQueryInput, WithSchemaContext, WithSubQueryInput } from './compile-with.js';
export { defaultColumns, isSelectableColumn, relationGraph } from './graph.js';
export type { GraphContext, RelationEdge } from './graph.js';
export { defineQuery } from './define.js';
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
} from './types.js';
