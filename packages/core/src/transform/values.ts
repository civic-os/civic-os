/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from the create and edit pages; form values and raw PostgREST values are untyped (SDK P1.4+). */

import { EntityPropertyType } from '../model/entity.js';
import type { SchemaEntityProperty } from '../model/entity.js';
import {
  formatControlValue,
  instantOfWallClock,
  parseTimestamp,
  parseWallClock,
  wallClockAt,
} from './zone.js';

/**
 * The slice of a property the value transforms read.
 *
 * @consumer typed transformValuesForApi
 */
export type TransformProp = Pick<SchemaEntityProperty, 'column_name' | 'type'>;

/**
 * Which page the form values come from. The two pages differ in how they treat
 * file and PhotoGallery values:
 * - `create`: PhotoGallery keys are removed from the POST body (the gallery is
 *   linked after the record exists); file values are passed through untouched.
 * - `edit`: File/FileImage/FilePDF and PhotoGallery object values are reduced to
 *   their `.id`.
 *
 * @consumer typed transformValuesForApi
 */
export interface TransformValuesOptions {
  mode: 'create' | 'edit';
  /**
   * IANA zone (e.g. "America/New_York") that a DateTimeLocal control value is
   * read in. The app passes the browser's resolved zone; core never reads the
   * ambient zone (X-01).
   */
  timeZone: string;
}

/**
 * Options for {@link transformValueForControl}.
 *
 * @consumer typed transformValueForControl
 */
export interface TransformControlOptions {
  /** IANA zone a DateTimeLocal value is shown in (the app passes the browser's resolved zone). */
  timeZone: string;
}

/**
 * Why a form value could not be sent.
 *
 * @consumer typed ValueTransformError
 */
export type ValueTransformReason = 'invalid_datetime' | 'invalid_money' | 'missing_offset';

/**
 * A form or tool value that cannot be sent as written (F-09, F-08, X-01). The
 * message is English and names the column; the app shows it in its error
 * modal, the MCP returns it to the model.
 *
 * @consumer app
 */
export class ValueTransformError extends Error {
  constructor(
    readonly column: string,
    readonly reason: ValueTransformReason,
    readonly value: unknown,
    message: string
  ) {
    super(message);
    this.name = 'ValueTransformError';
  }
}

/**
 * Parses the text PostgreSQL's money output (or a client) produces into a number.
 * Explicit rules (F-11): an optional `$`, an optional minus sign before or after
 * it or parentheses for a negative, digits with either no thousands separators or
 * properly grouped ones (`1,234`), and an optional fraction. Anything else (other
 * currency symbols, misplaced commas, text) is rejected with null.
 *
 * @consumer app
 */
export function parseMoneyOutput(text: string): number | null {
  let s = text.trim();
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const takeMinus = (): boolean => {
    if (!s.startsWith('-')) return true;
    if (negative) return false; // "(-1.00)" has two signs
    negative = true;
    s = s.slice(1).trim();
    return true;
  };
  if (!takeMinus()) return null;
  if (s.startsWith('$')) {
    s = s.slice(1).trim();
    if (!takeMinus()) return null;
  }
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^\.\d+$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : negative ? -n : n;
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
export function transformValueForControl(prop: TransformProp, rawValue: any, options: TransformControlOptions): any {
  if (rawValue === null || rawValue === undefined) return rawValue;

  // DateTime (timestamp without time zone): Just format for input, no timezone conversion
  if (prop.type === EntityPropertyType.DateTime) {
    if (typeof rawValue === 'string') {
      // PostgreSQL may return: "2025-01-15T10:30:00" (no timezone)
      // datetime-local input needs: "2025-01-15T10:30"
      return rawValue.substring(0, 16);
    }
  }

  // DateTimeLocal (timestamptz): Convert the instant to the user's zone
  if (prop.type === EntityPropertyType.DateTimeLocal) {
    if (typeof rawValue === 'string') {
      // PostgreSQL returns: "2025-01-15T10:30:00+00:00" or "2025-01-15T10:30:00.000Z"
      // (F-10 parse rules in parseTimestamp: an offset makes an instant, an offset-less
      // time is already wall-clock in the user's zone, a bare date is that day's midnight
      // there). A value that is not a date or time becomes empty, never "NaN-NaN-..." (F-03).
      const parsed = parseTimestamp(rawValue);
      if (parsed === null) return '';
      if (parsed.kind === 'instant') {
        return formatControlValue(wallClockAt(options.timeZone, parsed.epochMs));
      }
      return formatControlValue(parsed.wallClock);
    }
  }

  // Money: Parse formatted string to number for ngx-currency
  if (prop.type === EntityPropertyType.Money) {
    if (typeof rawValue === 'string') {
      // PostgreSQL returns: "$100.00", "-$1,234.50" or "($1,234.50)"
      // ngx-currency needs: 100.00 (number). Text that is not money output is rejected
      // with null (F-11), not passed through as a string.
      return parseMoneyOutput(rawValue);
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
    // PhotoGallery (create only): gallery FK is managed by link_gallery_to_entity RPC in coordinated save.
    // Remove from POST data — entity is created with FK=null, then gallery is linked via RPC.
    // The key is omitted whatever its value, null included (F-12).
    if (!isEdit && prop.type === EntityPropertyType.PhotoGallery) {
      delete transformed[prop.column_name];
      return;
    }

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
      if (typeof value === 'string' && (value.length === 16 || value.length === 19)) {
        // Input gives us: "2025-01-15T10:30" (local wall clock time) or "...T10:30:00"
        // PostgreSQL expects: "2025-01-15T10:30:00" (with seconds, no timezone).
        // The value is validated first (F-08): garbage and impossible dates are rejected.
        if (parseWallClock(value) === null) {
          throw invalidLocalTime(prop, value);
        }
        if (value.length === 16) {
          transformed[prop.column_name] = value + ':00';
        }
      }
    }

    // DateTimeLocal (timestamptz): Convert local time to UTC ISO format
    if (prop.type === EntityPropertyType.DateTimeLocal) {
      if (typeof value === 'string' && (value.length === 16 || value.length === 19)) {
        // Input gives us: "2025-01-15T17:30" (time in the user's zone), with or without seconds (F-06)
        // PostgreSQL expects: ISO string with timezone (e.g., "2025-01-15T22:30:00.000Z")
        // An invalid local time is rejected, never sent as written (F-09).
        const wallClock = parseWallClock(value);
        if (wallClock === null) {
          throw invalidLocalTime(prop, value);
        }
        transformed[prop.column_name] = new Date(instantOfWallClock(options.timeZone, wallClock)).toISOString();
      }
    }

    // Money: Keep as number, PostgREST accepts numeric values for money type
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

function invalidLocalTime(prop: TransformProp, value: string): ValueTransformError {
  return new ValueTransformError(
    prop.column_name,
    'invalid_datetime',
    value,
    `"${value}" is not a valid date and time for ${prop.column_name}. Use YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS with a real calendar date and a 00:00 to 23:59 time.`
  );
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const ISO_WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

/**
 * Normalizes values supplied without a form, for the MCP to use in P1.4 (X-01).
 * There is no browser zone, so nothing is read in a local zone:
 * - DateTimeLocal (timestamptz) must be an ISO 8601 value with an explicit offset
 *   and is sent as a UTC ISO string; an offset-less value is rejected with an
 *   instructive error rather than read in whatever zone the server runs in;
 * - DateTime (timestamp) is wall-clock and is sent verbatim;
 * - Money text ("$1,234.50") becomes a number, or is rejected;
 * - File, FileImage, FilePDF and PhotoGallery objects with an id become the id.
 * Other values and other keys are untouched. Throws {@link ValueTransformError}.
 *
 * @consumer mcp
 */
export function normalizeValuesForApi(values: any, props: readonly TransformProp[]): any {
  const out = { ...values };
  for (const prop of props) {
    const value = out[prop.column_name];
    if (value === null || value === undefined) continue;

    if (prop.type === EntityPropertyType.DateTimeLocal && typeof value === 'string') {
      const parsed = ISO_WITH_OFFSET.test(value) ? parseTimestamp(value) : null;
      if (parsed !== null && parsed.kind === 'instant') {
        out[prop.column_name] = new Date(parsed.epochMs).toISOString();
      } else if (ISO_WITHOUT_OFFSET.test(value)) {
        throw new ValueTransformError(
          prop.column_name,
          'missing_offset',
          value,
          `${prop.column_name} is a timestamp with time zone, so "${value}" is ambiguous: it has no UTC offset. ` +
            'Send an ISO 8601 value with an offset, for example 2026-07-04T10:30:00-04:00 or 2026-07-04T14:30:00Z.'
        );
      } else {
        throw new ValueTransformError(
          prop.column_name,
          'invalid_datetime',
          value,
          `"${value}" is not a valid timestamp for ${prop.column_name}. Send an ISO 8601 value with a UTC offset, for example 2026-07-04T10:30:00-04:00 or 2026-07-04T14:30:00Z.`
        );
      }
    } else if (prop.type === EntityPropertyType.Money && typeof value === 'string') {
      const n = parseMoneyOutput(value);
      if (n === null) {
        throw new ValueTransformError(
          prop.column_name,
          'invalid_money',
          value,
          `"${value}" is not an amount of money for ${prop.column_name}. Send a number such as 1234.5, or text such as "$1,234.50".`
        );
      }
      out[prop.column_name] = n;
    } else if (
      [EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF, EntityPropertyType.PhotoGallery].includes(prop.type) &&
      typeof value === 'object' && value.id
    ) {
      out[prop.column_name] = value.id;
    }
  }
  return out;
}
