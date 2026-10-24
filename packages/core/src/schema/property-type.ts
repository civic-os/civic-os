/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType } from '../model/index.js';
import type { SchemaEntityProperty } from '../model/index.js';
import { isSystemType } from './system-types.js';

/**
 * Determine the {@link EntityPropertyType} of a raw `schema_properties` row from its
 * PostgreSQL type and metadata. Pure: the caller assigns the result to `prop.type`.
 *
 * @consumer app
 */
export function getPropertyType(val: SchemaEntityProperty): EntityPropertyType {
  // T-01: a foreign key needs both join_table and join_column (join_column alone cannot be embedded or offered as options)
  const hasFK = !!val.join_table && !!val.join_column;

  // Status type detection: Integer FK with status_entity_type configured in metadata.properties
  // This takes precedence over generic ForeignKeyName to show status badges instead of plain text
  if (val.status_entity_type && ['int4', 'int8'].includes(val.udt_name) && hasFK) {
    return EntityPropertyType.Status;
  }

  // Category detection: Integer FK with category_entity_type configured in metadata.properties (v0.34.0)
  // Like Status but for non-guidedForm categorization (rich enums). Must come before ForeignKeyName.
  if (val.category_entity_type && ['int4', 'int8'].includes(val.udt_name) && hasFK) {
    return EntityPropertyType.Category;
  }

  // System type detection: foreign keys to metadata tables (File, User, Payment types)
  // T-03: whatever the column type; the view-FK inference fix (v0.76.10) removed the false FKs this once risked.
  // Uses centralized isSystemType() for consistency with Schema Editor/Inspector filtering
  if (hasFK && isSystemType(val.join_table)) {
    // Discriminate between file, user, and payment system types
    if (val.join_table === 'files') {
      // File type detection: Check fileType validation to determine specific subtype
      const fileTypeValidation = val.validation_rules?.find(v => v.type === 'fileType');
      if (fileTypeValidation?.value) {
        if (fileTypeValidation.value.startsWith('image/')) {
          return EntityPropertyType.FileImage;
        } else if (fileTypeValidation.value === 'application/pdf') {
          return EntityPropertyType.FilePDF;
        }
      }
      return EntityPropertyType.File;
    } else if (val.join_table === 'civic_os_users') {
      return EntityPropertyType.User;
    } else if (val.join_table === 'payment_transactions' ||
               (val.join_table === 'transactions' && val.join_schema === 'payments')) {
      // Payment type: FK to payment_transactions view OR payments.transactions table
      return EntityPropertyType.Payment;
    } else if (val.join_table === 'photo_galleries') {
      // PhotoGallery type: FK to photo_galleries (v0.47.0)
      return EntityPropertyType.PhotoGallery;
    }
  }

  // T-08: int2 joins int4/int8 as an integer or an FK. T-09: a uuid FK is a ForeignKeyName; a plain uuid is
  // display-only TextShort (the edit control renders it read-only).
  return (['int2', 'int4', 'int8', 'uuid'].includes(val.udt_name) && hasFK) ? EntityPropertyType.ForeignKeyName :
    // T-07: only Point and Polygon are geography types (MultiPolygon stays Unknown); data_type is not checked
    (['geography'].includes(val.udt_name) && val.geography_type == 'Polygon') ? EntityPropertyType.GeoPolygon :
    (['geography'].includes(val.udt_name) && val.geography_type == 'Point') ? EntityPropertyType.GeoPoint :
    ['timestamp'].includes(val.udt_name) ? EntityPropertyType.DateTime :
    ['timestamptz'].includes(val.udt_name) ? EntityPropertyType.DateTimeLocal :
    ['date'].includes(val.udt_name) ? EntityPropertyType.Date :
    ['bool'].includes(val.udt_name) ? EntityPropertyType.Boolean :
    ['int2', 'int4', 'int8'].includes(val.udt_name) ? EntityPropertyType.IntegerNumber :
    ['money'].includes(val.udt_name) ? EntityPropertyType.Money :
    ['numeric', 'float4', 'float8'].includes(val.udt_name) ? EntityPropertyType.DecimalNumber :
    ['hex_color'].includes(val.udt_name) ? EntityPropertyType.Color :
    ['email_address'].includes(val.udt_name) ? EntityPropertyType.Email :
    ['phone_number'].includes(val.udt_name) ? EntityPropertyType.Telephone :
    (['time_slot'].includes(val.udt_name) && val.is_recurring) ? EntityPropertyType.RecurringTimeSlot :
    ['time_slot'].includes(val.udt_name) ? EntityPropertyType.TimeSlot :
    ['markdown'].includes(val.udt_name) ? EntityPropertyType.Markdown :
    ['varchar', 'bpchar', 'uuid'].includes(val.udt_name) ? EntityPropertyType.TextShort :
    ['text'].includes(val.udt_name) ? EntityPropertyType.TextLong :
    EntityPropertyType.Unknown;
}
