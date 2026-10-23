/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from the create and edit pages; form values and raw PostgREST values are untyped (SDK P1.4+). */

import { EntityPropertyType } from '../model/entity.js';
import type { SchemaEntityProperty } from '../model/entity.js';
import { parseDatetimeLocal } from './datetime-local.js';

/** The slice of a property the value transforms read. */
export type TransformProp = Pick<SchemaEntityProperty, 'column_name' | 'type'>;

/**
 * Which page the form values come from. The two pages differ in how they treat
 * file and PhotoGallery values:
 * - `create`: PhotoGallery keys are removed from the POST body (the gallery is
 *   linked after the record exists); file values are passed through untouched.
 * - `edit`: File/FileImage/FilePDF and PhotoGallery object values are reduced to
 *   their `.id`.
 *
 * @consumer app
 */
export interface TransformValuesOptions {
  mode: 'create' | 'edit';
}

/**
 * TIMEZONE-SENSITIVE CODE: Load-time transformation for datetime fields
 *
 * This method handles two distinct timestamp types from PostgreSQL:
 *
 * 1. DateTime (timestamp without time zone):
 *    - Stores "wall clock" time without timezone context
 *    - Example: "2025-01-15T10:30:00" means 10:30 regardless of timezone
 *    - Transformation: Strip timezone suffix (if any), truncate to HH:MM format
 *    - User sees exactly what's stored in the database
 *
 * 2. DateTimeLocal (timestamptz):
 *    - Stores absolute point in time (always in UTC internally)
 *    - Example: "2025-01-15T10:30:00+00:00" = 10:30 UTC = 5:30 AM EST = 2:30 AM PST
 *    - Transformation: Convert UTC → User's local timezone for display
 *    - User sees the time in THEIR timezone, not UTC
 *
 * CRITICAL: The datetime-local input type expects a string like "2025-01-15T10:30"
 * in the USER'S LOCAL TIMEZONE. Do not just strip the timezone - that would show
 * UTC time as if it were local time, causing incorrect displays.
 *
 * WARNING: Modifying this code can cause timezone bugs. Always test with users
 * in different timezones (EST, PST, UTC) before deploying changes.
 *
 * @consumer app
 */
export function transformValueForControl(prop: TransformProp, rawValue: any): any {
  if (rawValue === null || rawValue === undefined) return rawValue;

  // DateTime (timestamp without time zone): Just format for input, no timezone conversion
  if (prop.type === EntityPropertyType.DateTime) {
    if (typeof rawValue === 'string') {
      // PostgreSQL may return: "2025-01-15T10:30:00" (no timezone)
      // datetime-local input needs: "2025-01-15T10:30"
      return rawValue.substring(0, 16);
    }
  }

  // DateTimeLocal (timestamptz): Convert UTC to user's local timezone
  if (prop.type === EntityPropertyType.DateTimeLocal) {
    if (typeof rawValue === 'string') {
      // PostgreSQL returns: "2025-01-15T10:30:00+00:00" or "2025-01-15T10:30:00.000Z" (UTC)
      // Parse as UTC, then convert to local time for display
      const utcDate = new Date(rawValue); // Parses as UTC
      // Format as local time for datetime-local input (YYYY-MM-DDTHH:MM)
      const year = utcDate.getFullYear();
      const month = String(utcDate.getMonth() + 1).padStart(2, '0');
      const day = String(utcDate.getDate()).padStart(2, '0');
      const hours = String(utcDate.getHours()).padStart(2, '0');
      const minutes = String(utcDate.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    }
  }

  // Money: Parse formatted string to number for ngx-currency
  if (prop.type === EntityPropertyType.Money) {
    if (typeof rawValue === 'string') {
      // PostgreSQL returns: "$100.00"
      // ngx-currency needs: 100.00 (number)
      const numericValue = parseFloat(rawValue.replace(/[$,]/g, ''));
      if (!isNaN(numericValue)) {
        return numericValue;
      }
    }
  }

  return rawValue;
}

/**
 * TIMEZONE-SENSITIVE CODE: Submit-time transformation for datetime fields
 *
 * This method transforms form values back to PostgreSQL-compatible formats:
 *
 * 1. DateTime (timestamp without time zone):
 *    - User enters "wall clock" time (e.g., "10:30")
 *    - Transformation: Add ":00" seconds → "2025-01-15T10:30:00"
 *    - PostgreSQL stores exactly as-is (no timezone conversion)
 *    - Result: Same wall clock time in database as user entered
 *
 * 2. DateTimeLocal (timestamptz):
 *    - User enters time in THEIR local timezone (e.g., "17:30" in EST)
 *    - Transformation: Convert to UTC with "Z" suffix → "2025-01-15T22:30:00.000Z"
 *    - PostgreSQL stores in UTC (internally converts and strips the Z)
 *    - Result: Absolute point in time preserved regardless of user's timezone
 *
 * CRITICAL: DateTimeLocal MUST be converted to UTC before sending to PostgreSQL.
 * The datetime-local input gives us a string like "2025-01-15T17:30" which represents
 * the time in the user's local timezone. We must interpret this as local time and
 * convert to UTC. Do NOT just add seconds - that would send local time as if it were UTC.
 *
 * Example: User in EST enters "5:30 PM" on Jan 15, 2025
 * - Input string: "2025-01-15T17:30"
 * - Interpret as: 5:30 PM EST = 10:30 PM UTC
 * - Send to database: "2025-01-15T22:30:00.000Z"
 * - Database stores: 2025-01-15 22:30:00+00 (10:30 PM UTC)
 *
 * WARNING: Timezone bugs here affect data integrity. Test with multiple timezones.
 *
 * @consumer app
 */
export function transformValuesForApi(
  formData: any,
  props: readonly TransformProp[],
  options: TransformValuesOptions
): any {
  const isEdit = options.mode === 'edit';
  const transformed = { ...formData };

  // Transform values back to database format for each property
  props.forEach(prop => {
    const value = transformed[prop.column_name];
    if (value === null || value === undefined) return;

    // File types (edit only): Extract UUID from file object or uploaded file reference
    if (isEdit && [EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
      if (typeof value === 'object' && value.id) {
        // Either embedded file object from initial load, or FileReference from upload
        transformed[prop.column_name] = value.id;
      }
      // If it's already a UUID string, leave it as-is
    }

    // PhotoGallery (edit only): Extract UUID from embedded gallery object (v0.47.0)
    if (isEdit && prop.type === EntityPropertyType.PhotoGallery) {
      if (typeof value === 'object' && value.id) {
        transformed[prop.column_name] = value.id;
      }
    }

    // DateTime (timestamp without time zone): Add seconds, no timezone conversion
    if (prop.type === EntityPropertyType.DateTime) {
      if (typeof value === 'string') {
        // Input gives us: "2025-01-15T10:30" (local wall clock time)
        // PostgreSQL expects: "2025-01-15T10:30:00" (with seconds, no timezone)
        if (value.length === 16) {
          transformed[prop.column_name] = value + ':00';
        }
      }
    }

    // DateTimeLocal (timestamptz): Convert local time to UTC ISO format
    if (prop.type === EntityPropertyType.DateTimeLocal) {
      if (typeof value === 'string') {
        // Input gives us: "2025-01-15T17:30" (time in user's local timezone)
        // PostgreSQL expects: ISO string with timezone (e.g., "2025-01-15T22:30:00.000Z")
        if (value.length === 16) {
          // Interpret input string as LOCAL time, then convert to UTC
          // Use Safari-safe parsing for datetime-local strings
          const localDate = parseDatetimeLocal(value);
          if (localDate) {
            const utcISO = localDate.toISOString(); // Converts to UTC with .000Z format
            transformed[prop.column_name] = utcISO;
          }
        }
      }
    }

    // Money: Keep as number, PostgREST accepts numeric values for money type

    // PhotoGallery (create only): gallery FK is managed by link_gallery_to_entity RPC in coordinated save.
    // Remove from POST data — entity is created with FK=null, then gallery is linked via RPC.
    if (!isEdit && prop.type === EntityPropertyType.PhotoGallery) {
      delete transformed[prop.column_name];
    }
  });

  // Remove audit fields AFTER transformation (managed by database triggers)
  // BUT only if they're NOT in props (i.e., they're read-only metadata, not user-editable fields)
  const editableColumns = new Set(props.map(p => p.column_name));
  if (!editableColumns.has('created_at')) {
    delete transformed.created_at;
  }
  if (!editableColumns.has('updated_at')) {
    delete transformed.updated_at;
  }

  return transformed;
}
