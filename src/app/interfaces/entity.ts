/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Definitions live in packages/core/src/model/entity.ts.
export type {
  SchemaEntityTable,
  ValidationRule,
  FileReference,
  SchemaEntityProperty,
  StatusValue,
  CategoryValue,
  GalleryImage,
  PhotoGalleryConfig,
  PhotoGalleryValue,
  MapPolygon,
  EntityNote,
  PaymentValue,
  EntityPropertyValue,
  EntityData,
  InverseRelationshipMeta,
  InverseRelationshipData,
  ParentHop,
  ManyToManyMeta,
  ForeignKeyLookup,
  ImportError,
  ValidationErrorSummary,
  ValidationProgress,
  ValidationComplete,
  ValidationCancelled,
  ValidationError,
  StaticText,
  PropertyItem,
  RenderableItem,
  SimpleCondition,
  OrCondition,
  AndCondition,
  ActionCondition,
  EntityAction,
  ActionParamType,
  EntityActionParam,
  EntityActionResult,
  SeriesGroup,
  SeriesInstanceSummary,
  SeriesVersionSummary,
  Series,
  SeriesInstance,
  SeriesMembership,
  ConflictInfo,
  CreateSeriesResult,
  SeriesEditScope,
  RRuleFrequency,
  RRuleDayOfWeek,
  RRuleConfig,
} from '@civic-os/core';
export {
  EntityPropertyType,
  isStaticText,
  isProperty,
} from '@civic-os/core';
