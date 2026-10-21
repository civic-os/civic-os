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
  // Status type detection: Integer FK with status_entity_type configured in metadata.properties
  // This takes precedence over generic ForeignKeyName to show status badges instead of plain text
  if (val.status_entity_type && ['int4', 'int8'].includes(val.udt_name) && val.join_column != null) {
    return EntityPropertyType.Status;
  }

  // Category detection: Integer FK with category_entity_type configured in metadata.properties (v0.34.0)
  // Like Status but for non-guidedForm categorization (rich enums). Must come before ForeignKeyName.
  if (val.category_entity_type && ['int4', 'int8'].includes(val.udt_name) && val.join_column != null) {
    return EntityPropertyType.Category;
  }

  // System type detection: UUID foreign keys to metadata tables (File, User, Payment types)
  // Uses centralized isSystemType() for consistency with Schema Editor/Inspector filtering
  if (val.udt_name === 'uuid' && val.join_table && isSystemType(val.join_table)) {
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
      // Payment type: UUID FK to payment_transactions view OR payments.transactions table
      return EntityPropertyType.Payment;
    } else if (val.join_table === 'photo_galleries') {
      // PhotoGallery type: UUID FK to photo_galleries (v0.47.0)
      return EntityPropertyType.PhotoGallery;
    }
  }

  return (['int4', 'int8'].includes(val.udt_name) && val.join_column != null) ? EntityPropertyType.ForeignKeyName :
    (['geography'].includes(val.udt_name) && val.geography_type == 'Polygon') ? EntityPropertyType.GeoPolygon :
    (['geography'].includes(val.udt_name) && val.geography_type == 'Point') ? EntityPropertyType.GeoPoint :
    ['timestamp'].includes(val.udt_name) ? EntityPropertyType.DateTime :
    ['timestamptz'].includes(val.udt_name) ? EntityPropertyType.DateTimeLocal :
    ['date'].includes(val.udt_name) ? EntityPropertyType.Date :
    ['bool'].includes(val.udt_name) ? EntityPropertyType.Boolean :
    ['int4', 'int8'].includes(val.udt_name) ? EntityPropertyType.IntegerNumber :
    ['money'].includes(val.udt_name) ? EntityPropertyType.Money :
    ['numeric', 'float4', 'float8'].includes(val.udt_name) ? EntityPropertyType.DecimalNumber :
    ['hex_color'].includes(val.udt_name) ? EntityPropertyType.Color :
    ['email_address'].includes(val.udt_name) ? EntityPropertyType.Email :
    ['phone_number'].includes(val.udt_name) ? EntityPropertyType.Telephone :
    (['time_slot'].includes(val.udt_name) && val.is_recurring) ? EntityPropertyType.RecurringTimeSlot :
    ['time_slot'].includes(val.udt_name) ? EntityPropertyType.TimeSlot :
    ['markdown'].includes(val.udt_name) ? EntityPropertyType.Markdown :
    ['varchar'].includes(val.udt_name) ? EntityPropertyType.TextShort :
    ['text'].includes(val.udt_name) ? EntityPropertyType.TextLong :
    EntityPropertyType.Unknown;
}
