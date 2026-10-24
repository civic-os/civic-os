/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType } from '../model/index.js';
import type { SchemaEntityProperty } from '../model/index.js';

/**
 * PostgREST select fragment for a property on detail pages (FK, file, user,
 * status, category, payment, gallery and M:M properties embed related rows).
 *
 * @consumer app
 */
export function propertyToSelectString(prop: SchemaEntityProperty): string {
  // M:M: Embed junction records with related entity data
  // Format: junction_table_m2m:junction_table!source_column(related_table!target_column(id,display_name[,color]))
  // Rich: junction_table_m2m:junction_table!source_column(quantity,related_table!target_column(id,display_name[,color]))
  if (prop.type == EntityPropertyType.ManyToMany && prop.many_to_many_meta) {
    const meta = prop.many_to_many_meta;
    // Build the embedded select string with FK hints
    // Example: issue_tags_m2m:issue_tags!issue_id(Tag!tag_id(id,display_name,color))
    // The ! syntax tells PostgREST which FK to follow (required when table has multiple FKs)
    const fields = meta.relatedTableHasColor ? 'id,display_name,color' : 'id,display_name';

    // v0.51.0: Parent hop M:M — build nested embed inside-out for multi-level traversal
    // Example: junction!sourceCol(intermediate!targetCol(grandparent!fkCol(id,display_name)))
    if (meta.parentHops?.length) {
      let inner = `(${fields})`;
      for (let i = meta.parentHops.length - 1; i >= 0; i--) {
        const hop = meta.parentHops[i];
        inner = `(${hop.table}!${hop.fkColumn}${inner})`;
      }
      return `${prop.column_name}:${meta.junctionTable}!${meta.sourceColumn}(${meta.targetTable}!${meta.targetColumn}${inner})`;
    }

    // v0.51.0: Include extra columns at junction level for rich junctions
    const extraFieldNames = meta.extraColumns.map(c => c.column_name).join(',');
    const extraPrefix = extraFieldNames ? extraFieldNames + ',' : '';
    return `${prop.column_name}:${meta.junctionTable}!${meta.sourceColumn}(${extraPrefix}${meta.relatedTable}!${meta.targetColumn}(${fields}))`;
  }

  // File types: Embed file metadata from files table (system type - see METADATA_SYSTEM_TABLES)
  if ([EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
    return `${prop.column_name}:files!${prop.column_name}(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,thumbnail_error,created_at)`;
  }

  // Payment type: Embed payment data from payment_transactions view (system type)
  // Includes effective_status computed field for refund-aware status display
  // Includes aggregated refund data for tooltip showing refund breakdown (1:M support)
  if (prop.type === EntityPropertyType.Payment) {
    return `${prop.column_name}:payment_transactions!${prop.column_name}(id,amount,currency,status,effective_status,total_refunded,refund_count,pending_refund_count,display_name,error_message,created_at)`;
  }

  // Status type: Embed status data from metadata.statuses table
  // Uses FK hint to metadata schema since statuses live in metadata, not public
  // Includes status_key for condition evaluation (e.g. visibility_condition: {"field": "status_id.status_key", ...})
  if (prop.type === EntityPropertyType.Status) {
    return `${prop.column_name}:statuses!${prop.column_name}(id,display_name,color,status_key)`;
  }

  // Category: Embed category data from metadata.categories table (v0.34.0)
  if (prop.type === EntityPropertyType.Category) {
    return `${prop.column_name}:categories!${prop.column_name}(id,display_name,color)`;
  }

  // PhotoGallery: Embed gallery with nested files and file metadata (v0.47.0)
  if (prop.type === EntityPropertyType.PhotoGallery) {
    return `${prop.column_name}:photo_galleries!${prop.column_name}(id,created_at,photo_gallery_files(file_id,sort_order,caption,alt_text,file:files!file_id(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status)))`;
  }

  // User type: Embed user data from civic_os_users table (system type - see METADATA_SYSTEM_TABLES)
  return (prop.type == EntityPropertyType.User) ? prop.column_name + ':civic_os_users!' + prop.column_name + '(id,display_name,full_name,phone,email)' :
    foreignKeyEmbeds(prop) ? prop.column_name + ':' + prop.join_table + '!' + prop.column_name + '(' + foreignKeyEmbedFields(prop) + ')' :
    (prop.type == EntityPropertyType.GeoPoint || prop.type == EntityPropertyType.GeoPolygon) ? prop.column_name + ':' + prop.column_name + '_text' :
    prop.column_name;
}

/** Metadata tables PostgREST embeds through a same-named public view (S-02). */
const METADATA_EMBED_TABLES: readonly string[] = ['statuses', 'categories'];

/**
 * True when the FK is embedded with related-row names: any FK into `public`, plus (S-02) a plain FK into
 * `metadata.statuses` / `metadata.categories` (no entity type configured), reached through the public view of
 * the same name.
 */
function foreignKeyEmbeds(prop: SchemaEntityProperty): boolean {
  if (!prop.join_table || !prop.join_column) return false;
  if (prop.join_schema === 'public') return true;
  return prop.type === EntityPropertyType.ForeignKeyName && METADATA_EMBED_TABLES.includes(prop.join_table);
}

/** S-07: select the key once; when the FK references display_name the embed is just `display_name`. */
function foreignKeyEmbedFields(prop: SchemaEntityProperty): string {
  return prop.join_column === 'display_name' ? 'display_name' : prop.join_column + ',display_name';
}

/**
 * Returns the PostgREST select string for a property in edit forms.
 * For FK fields, returns only the column name (raw ID) instead of embedded objects.
 * Edit forms need primitive IDs for form controls, not display objects.
 *
 * @consumer app
 */
export function propertyToSelectStringForEdit(prop: SchemaEntityProperty): string {
  // M:M: Need full junction data with IDs for edit forms; same embed as the detail view,
  // including the nested parent hops of a parent-hop M:M (F-07)
  if (prop.type === EntityPropertyType.ManyToMany && prop.many_to_many_meta) {
    return propertyToSelectString(prop);
  }

  // File types: Need full file data to show current file and allow replacement
  if ([EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
    return `${prop.column_name}:files!${prop.column_name}(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,thumbnail_error,created_at)`;
  }

  // For FK fields in edit forms, we only need the raw ID value
  if (prop.type === EntityPropertyType.ForeignKeyName) {
    return prop.column_name;
  }

  // Status fields also need just the ID for edit forms (dropdown value)
  if (prop.type === EntityPropertyType.Status) {
    return prop.column_name;
  }

  // Category fields also need just the ID for edit forms (dropdown value, v0.34.0)
  if (prop.type === EntityPropertyType.Category) {
    return prop.column_name;
  }

  // GeoPoint/GeoPolygon still need the computed _text field
  if (prop.type === EntityPropertyType.GeoPoint || prop.type === EntityPropertyType.GeoPolygon) {
    return prop.column_name + ':' + prop.column_name + '_text';
  }

  // User fields also need just the ID for edit forms
  if (prop.type === EntityPropertyType.User) {
    return prop.column_name;
  }

  // Payment fields are read-only (show embedded data, not editable)
  // Includes effective_status computed field for refund-aware status display
  // Includes aggregated refund data for tooltip showing refund breakdown (1:M support)
  if (prop.type === EntityPropertyType.Payment) {
    return `${prop.column_name}:payment_transactions!${prop.column_name}(id,amount,currency,status,effective_status,total_refunded,refund_count,pending_refund_count,display_name,error_message,created_at)`;
  }

  // PhotoGallery: Need full gallery data with files for edit form (same as detail view)
  // Editor component shows current images and allows add/remove/reorder
  if (prop.type === EntityPropertyType.PhotoGallery) {
    return `${prop.column_name}:photo_galleries!${prop.column_name}(id,created_at,photo_gallery_files(file_id,sort_order,caption,alt_text,file:files!file_id(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status)))`;
  }

  // Everything else uses the column name directly
  return prop.column_name;
}

/**
 * Returns a lightweight PostgREST select string optimized for list pages.
 * PhotoGallery fetches only file IDs (for client-side count) instead of full file metadata.
 * All other types delegate to propertyToSelectString().
 *
 * @consumer app
 */
export function propertyToSelectStringForList(prop: SchemaEntityProperty): string {
  if (prop.type === EntityPropertyType.PhotoGallery) {
    return `${prop.column_name}:photo_galleries!${prop.column_name}(id,photo_gallery_files(file_id))`;
  }
  return propertyToSelectString(prop);
}
