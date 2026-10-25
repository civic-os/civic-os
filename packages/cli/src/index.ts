/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** The code generation behind `civic-os gen types` (SDK P1.5c). */
export { emitTypes } from './emit.js';
export { generateTypes, generatorName } from './generate.js';
export { CodegenError, fixtureSource, loadRawSchema, urlSource } from './load.js';
export type { RawSchema, SchemaSource, StatusRow } from './load.js';
export { buildModel, prepareContext } from './model.js';
export type {
  ActionModel,
  CodegenModel,
  EmbeddedColumn,
  EntityModel,
  FeatureFlags,
  FieldNode,
  RelationModel,
  RowColumn,
  TypeNode,
} from './model.js';
export { parseSelect } from './embed.js';
export type { SelectItem } from './embed.js';
export { actionParamType, columnType } from './ts-types.js';
