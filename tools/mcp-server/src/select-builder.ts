/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * PostgREST select string builder.
 * Builds `?select=` values with FK embedding based on property types.
 * Mirrors the Angular SchemaService.propertyToSelectString() logic.
 */

import { EntityPropertyType, type SchemaProperty } from './interfaces.js';

/**
 * Build a PostgREST select string for a property.
 * Handles FK embedding (depth 1), status/category, user, file, payment, etc.
 */
export function propertyToSelectString(prop: SchemaProperty): string {
  const col = prop.column_name;
  const type = prop.type ?? EntityPropertyType.Unknown;

  switch (type) {
    case EntityPropertyType.ForeignKeyName:
      // Embed FK → display_name: client_id(id,display_name)
      // Use column alias to keep the response key as the column name
      return `${col}:${prop.join_table}!${col}(id,display_name)`;

    case EntityPropertyType.User:
      return `${col}:civic_os_users!${col}(id,display_name,full_name)`;

    case EntityPropertyType.Status:
      return `${col}:statuses!${col}(id,display_name,color,status_key)`;

    case EntityPropertyType.Category:
      return `${col}:categories!${col}(id,display_name,color)`;

    case EntityPropertyType.File:
    case EntityPropertyType.FileImage:
    case EntityPropertyType.FilePDF:
      return `${col}:files!${col}(id,file_name,file_type,file_size)`;

    case EntityPropertyType.Payment:
      return `${col}:payment_transactions!${col}(id,amount,currency,status,effective_status,display_name)`;

    case EntityPropertyType.PhotoGallery:
      // For list views, just get the count info
      return `${col}:photo_galleries!${col}(id,photo_gallery_files(file_id))`;

    case EntityPropertyType.GeoPoint:
      // GeoPoint uses a computed _text column
      return `${col}:${col}_text`;

    case EntityPropertyType.GeoPolygon:
      return `${col}:${col}_text`;

    // Scalar types — just the column name
    default:
      return col;
  }
}

/**
 * Build a complete select string for a set of properties.
 * Includes 'id' only when the properties list contains a property with
 * column_name === 'id' or is_identity === true (report VIEWs without an id
 * column would get a PostgREST error if 'id' is unconditionally appended).
 */
export function buildSelectString(
  properties: SchemaProperty[],
  options?: { includeTimestamps?: boolean },
): string {
  const fields = new Set<string>();

  const hasIdColumn = properties.some(
    p => p.column_name === 'id' || p.is_identity === true,
  );
  if (hasIdColumn) {
    fields.add('id');
  }

  for (const prop of properties) {
    // Skip identity columns (already added above), generated columns, self-referencing
    if (prop.column_name === 'id') continue;
    fields.add(propertyToSelectString(prop));
  }

  if (options?.includeTimestamps) {
    fields.add('created_at');
    fields.add('updated_at');
  }

  return Array.from(fields).join(',');
}

/**
 * Build a select string for a raw ID (no embedding).
 * Used for create/update where we want the raw FK ID back.
 */
export function propertyToRawSelectString(prop: SchemaProperty): string {
  return prop.column_name;
}

/**
 * Filter properties based on visibility context.
 */
export function filterProperties(
  properties: SchemaProperty[],
  context: 'list' | 'detail' | 'create' | 'edit',
): SchemaProperty[] {
  return properties.filter(prop => {
    // Skip generated/identity columns for create/edit
    if ((context === 'create' || context === 'edit') && (prop.is_identity || prop.is_generated)) {
      return false;
    }

    switch (context) {
      case 'list': return prop.show_on_list !== false;
      case 'detail': return prop.show_on_detail !== false;
      case 'create': return prop.show_on_create !== false;
      case 'edit': return prop.show_on_edit !== false;
      default: return true;
    }
  });
}

/**
 * Validate that a custom columns list doesn't exceed max embedding depth.
 * Returns an error message if depth > 2, undefined if OK.
 */
export function validateEmbeddingDepth(columns: string[]): string | undefined {
  for (const col of columns) {
    // Count nesting depth by counting '(' characters
    const depth = (col.match(/\(/g) || []).length;
    if (depth > 2) {
      return `Column "${col}" exceeds maximum embedding depth of 2. Use separate list_records calls for deeply nested data.`;
    }
  }
  return undefined;
}
