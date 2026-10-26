/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType, isStaticText } from '../model/index.js';
import type {
  PropertyItem,
  RenderableItem,
  SchemaEntityProperty,
  SchemaEntityTable,
  StaticText,
} from '../model/index.js';

/**
 * Ensure display_name is always fetched: used structurally for page headers,
 * map markers, calendar titles, and delete confirmation modals.
 *
 * Pure: returns a new array (visible props, then any missing structural props
 * in the order display_name, status_id, submitted_at); the inputs are untouched.
 *
 * @consumer app
 */
export function ensureStructuralProps(
  allProps: readonly SchemaEntityProperty[],
  visibleProps: readonly SchemaEntityProperty[],
): SchemaEntityProperty[] {
  const result = [...visibleProps];
  const structuralColumns = ['display_name', 'status_id', 'submitted_at'];
  for (const col of structuralColumns) {
    const prop = allProps.find(p => p.column_name === col);
    if (prop && !result.includes(prop)) {
      result.push(prop);
    }
  }
  return result;
}

/**
 * Properties of one entity to fetch and show on its List page, in input order.
 * Includes the map property even when hidden from the list, plus structural props.
 *
 * @param props The entity's properties, already sorted by sort_order
 * @consumer app
 */
export function propsForList(
  table: SchemaEntityTable,
  props: readonly SchemaEntityProperty[],
): SchemaEntityProperty[] {
  // Include properties visible on list
  let visibleProps = props.filter(p =>
    p.show_on_list !== false
  );

  // If map is enabled, ensure the map property is included even if hidden from list
  if (table.show_map && table.map_property_name) {
    const mapProperty = props.find(p => p.column_name === table.map_property_name);
    if (mapProperty && !visibleProps.includes(mapProperty)) {
      // Add the map property so it's included in the PostgREST select query
      visibleProps.push(mapProperty);
    }
  }

  // Ensure display_name is always fetched for map markers and calendar titles
  visibleProps = ensureStructuralProps(props, visibleProps);

  return visibleProps;
}

/**
 * Properties to fetch for an entity's Detail page (structural props included).
 *
 * @consumer app
 */
export function propsForDetail(props: readonly SchemaEntityProperty[]): SchemaEntityProperty[] {
  const visibleProps = props.filter(p => p.show_on_detail !== false);

  // Ensure display_name is always fetched for page header and delete modal
  return ensureStructuralProps(props, visibleProps);
}

/**
 * Properties shown on an entity's Create form. Excludes generated/identity,
 * non-updatable and auto-managed timestamp columns.
 *
 * @consumer app
 */
export function propsForCreate(props: readonly SchemaEntityProperty[]): SchemaEntityProperty[] {
  return props.filter(p => {
    // Exclude auto-managed timestamp fields (created_at, updated_at)
    // These are managed by database triggers and should never be in create forms
    if (p.column_name === 'created_at' || p.column_name === 'updated_at') {
      return false;
    }
    return !(p.is_generated || p.is_identity) &&
      p.is_updatable &&
      p.show_on_create !== false;
  });
}

/**
 * Properties to fetch for an entity's Edit page.
 *
 * NOTE: includes show_on_edit=false props only when structural (display_name,
 * status_id, submitted_at); the edit form and renderables filter them out
 * separately for display.
 *
 * @consumer app
 */
export function propsForEdit(props: readonly SchemaEntityProperty[]): SchemaEntityProperty[] {
  const visibleProps = props.filter(p => {
    // Exclude auto-managed timestamp fields (created_at, updated_at)
    // These are managed by database triggers and should never be in edit forms
    if (p.column_name === 'created_at' || p.column_name === 'updated_at') {
      return false;
    }
    return !(p.is_generated || p.is_identity) &&
      p.is_updatable &&
      p.show_on_edit !== false;
  });

  // Ensure structural props (display_name, status_id, submitted_at) are always fetched
  return ensureStructuralProps(props, visibleProps);
}

/** Property types the List page filter UI supports. */
const FILTERABLE_TYPES: readonly EntityPropertyType[] = [
  EntityPropertyType.ForeignKeyName,
  EntityPropertyType.DateTime,
  EntityPropertyType.DateTimeLocal,
  EntityPropertyType.Date,
  EntityPropertyType.Boolean,
  EntityPropertyType.IntegerNumber,
  EntityPropertyType.Money,
  EntityPropertyType.User,
  EntityPropertyType.Status,  // Status uses same filter pattern as ForeignKeyName
  EntityPropertyType.Category  // Category uses same filter pattern as Status (v0.34.0)
];

/**
 * Properties that can drive List page filters: marked filterable and of a
 * supported type.
 *
 * @consumer app
 */
export function propsForFilter(props: readonly SchemaEntityProperty[]): SchemaEntityProperty[] {
  return props.filter(p => {
    // Only include properties marked as filterable
    if (p.filterable !== true) {
      return false;
    }
    // Only include supported property types
    return FILTERABLE_TYPES.includes(p.type);
  });
}

/**
 * Default form value for a property: `false` for Boolean, otherwise `null`.
 *
 * @consumer app
 */
export function getDefaultValueForProperty(prop: SchemaEntityProperty): boolean | null {
  if(prop.type == EntityPropertyType.Boolean) {
    return false;
  }
  return null;
}

/**
 * Get the column span for a property based on custom width or type-based defaults
 *
 * @consumer app
 */
export function getColumnSpan(property: SchemaEntityProperty): number {
  // Use custom width if set, otherwise use type-based defaults
  if (property.column_width) {
    return property.column_width;
  }

  // Default widths based on property type
  switch (property.type) {
    case EntityPropertyType.Markdown:
      return 4;
    case EntityPropertyType.TextLong:
    case EntityPropertyType.GeoPoint:
    case EntityPropertyType.GeoPolygon:
    case EntityPropertyType.File:
    case EntityPropertyType.FileImage:
    case EntityPropertyType.FilePDF:
      return 2;
    default:
      return 1;
  }
}

/**
 * Get the column span for any renderable item (property or static text).
 * Static text uses column_width directly; properties use type-based defaults.
 *
 * @consumer app
 */
export function getRenderableColumnSpan(item: RenderableItem): number {
  if (isStaticText(item)) {
    return item.column_width;
  }
  return getColumnSpan(item);
}

function tagProperties(props: readonly SchemaEntityProperty[]): PropertyItem[] {
  return props.map(p => ({
    ...p,
    itemType: 'property' as const
  }));
}

function mergeRenderables(
  taggedProps: PropertyItem[],
  filteredStaticText: StaticText[],
): RenderableItem[] {
  // Merge and sort by sort_order
  const merged: RenderableItem[] = [...taggedProps, ...filteredStaticText];
  return merged.sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Renderable items (properties plus static text) for the Detail page, sorted by
 * sort_order. Properties are copies tagged `itemType: 'property'`.
 *
 * @param props Result of {@link propsForDetail}
 * @consumer app
 */
export function detailRenderables(
  props: readonly SchemaEntityProperty[],
  staticTexts: readonly StaticText[],
): RenderableItem[] {
  // Re-filter: structural props (e.g. display_name) are fetched for headers
  // but should not render as property cards
  const renderableProps = props.filter(p => p.show_on_detail !== false);

  // Filter static text for detail page
  const filteredStaticText = staticTexts.filter(st => st.show_on_detail);

  return mergeRenderables(tagProperties(renderableProps), filteredStaticText);
}

/**
 * Renderable items for the Create page, sorted by sort_order.
 *
 * @param props Result of {@link propsForCreate}
 * @consumer app
 */
export function createRenderables(
  props: readonly SchemaEntityProperty[],
  staticTexts: readonly StaticText[],
): RenderableItem[] {
  // Filter static text for create page
  const filteredStaticText = staticTexts.filter(st => st.show_on_create);

  return mergeRenderables(tagProperties(props), filteredStaticText);
}

/**
 * Renderable items for the Edit page, sorted by sort_order.
 *
 * @param props Result of {@link propsForEdit}
 * @consumer app
 */
export function editRenderables(
  props: readonly SchemaEntityProperty[],
  staticTexts: readonly StaticText[],
): RenderableItem[] {
  // Re-filter: structural props (e.g. display_name) are fetched for headers
  // but should not render as form fields
  const renderableProps = props.filter(p => p.show_on_edit !== false);

  // Filter static text for edit page
  const filteredStaticText = staticTexts.filter(st => st.show_on_edit);

  return mergeRenderables(tagProperties(renderableProps), filteredStaticText);
}
