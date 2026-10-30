/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

export { getPropertyType } from './property-type.js';
export { METADATA_SYSTEM_TABLES, isSystemType } from './system-types.js';
export type { SystemTableName } from './system-types.js';
export {
  propertyToSelectString,
  propertyToSelectStringForEdit,
  propertyToSelectStringForList,
} from './select.js';
export {
  propsForList,
  propsForDetail,
  propsForCreate,
  propsForEdit,
  propsForFilter,
  getDefaultValueForProperty,
  getColumnSpan,
  getRenderableColumnSpan,
} from './property-views.js';
export { compareBySortOrder } from './sort-order.js';
export {
  inverseRelationships,
  getJunctionTableNamesFromProperties,
  detectJunctionTables,
  enrichPropertiesWithManyToMany,
} from './relations.js';
export { validationRules } from './validation.js';
export type { ValidationRuleSpec } from './validation.js';
