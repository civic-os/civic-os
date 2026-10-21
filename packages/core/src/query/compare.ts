/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from DataService; PostgREST payloads are untyped JSON. */
/* eslint-disable @typescript-eslint/no-unused-vars, no-useless-escape, prefer-const -- moved verbatim from DataService; byte-identical behavior is the P1.1 contract, so lint cleanups are deferred. */

import type { ApiResponse } from '../model/api.js';

/**
 * Parses EWKB hex string for POINT geometry and returns EWKT.
 * EWKB format for Point with SRID: [byte order][type][SRID][X][Y]
 * Example: 0101000020E6100000... = SRID=4326;POINT(x y)
 *
 * @consumer app
 */
export function parseEWKBPoint(hexString: string): string | null {
  try {
    // EWKB Point with SRID is 50 hex chars (25 bytes)
    if (hexString.length < 50) {
      return null;
    }

    // Byte order (01 = little-endian)
    const byteOrder = hexString.substring(0, 2);
    if (byteOrder !== '01') {
      return null; // Only support little-endian
    }

    // Geometry type (20000001 for Point with SRID in little-endian)
    const geomType = hexString.substring(2, 10);
    if (geomType !== '01000020') {
      return null; // Only support Point
    }

    // SRID (4 bytes little-endian)
    const sridHex = hexString.substring(10, 18);
    const srid = parseLE32(sridHex);

    // X coordinate (8 bytes little-endian double)
    const xHex = hexString.substring(18, 34);
    const x = parseLE64Double(xHex);

    // Y coordinate (8 bytes little-endian double)
    const yHex = hexString.substring(34, 50);
    const y = parseLE64Double(yHex);

    return `SRID=${srid};POINT(${x} ${y})`;
  } catch (error) {
    (globalThis as { console?: { error(...args: unknown[]): void } }).console?.error('Error parsing EWKB:', error);
    return null;
  }
}

/** Parse 32-bit little-endian integer from hex */
function parseLE32(hex: string): number {
  const bytes = hex.match(/.{2}/g)!.reverse();
  return parseInt(bytes.join(''), 16);
}

/** Parse 64-bit little-endian double from hex */
function parseLE64Double(hex: string): number {
  const bytes = hex.match(/.{2}/g)!.reverse().join('');
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint8(i, parseInt(bytes.substring(i * 2, i * 2 + 2), 16));
  }
  return view.getFloat64(0, false); // false = big-endian (since we reversed bytes)
}

/**
 * Compares datetime values, handling timezone differences.
 * Input: "2025-10-31T17:00:00" (may or may not have seconds)
 * Response: "2025-10-31T17:00:00+00:00" (PostgreSQL always includes timezone)
 *
 * @consumer app
 */
export function compareDateTimeValues(inputValue: any, responseValue: any): { isDateTime: boolean, matches: boolean } {
  if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
    return { isDateTime: false, matches: false };
  }

  // Check if values look like ISO 8601 datetime strings
  const dateTimePattern = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
  if (!dateTimePattern.test(inputValue) || !dateTimePattern.test(responseValue)) {
    return { isDateTime: false, matches: false };
  }

  try {
    // Normalize both to just date+time, strip timezone and milliseconds
    // Input:    "2025-10-31T17:00:00"
    // Response: "2025-10-31T17:00:00+00:00" or "2025-10-31T17:00:00.000Z"
    const normalizeDateTime = (dt: string) => {
      // Strip timezone suffix and milliseconds, take first 19 chars (YYYY-MM-DDTHH:mm:ss)
      return dt.replace(/(\.\d{3})?([+-]\d{2}:\d{2}|Z)$/, '').substring(0, 19);
    };

    const normalizedInput = normalizeDateTime(inputValue);
    const normalizedResponse = normalizeDateTime(responseValue);

    return { isDateTime: true, matches: normalizedInput === normalizedResponse };
  } catch (error) {
    return { isDateTime: false, matches: false };
  }
}

/**
 * Compares date-only values (PostgreSQL 'date' type).
 * Input: "2025-01-15" (HTML date input format)
 * Response: "2025-01-15T05:00:00.000Z" (PostgreSQL JSON serialization adds time component)
 *
 * PostgreSQL's JSON serializer converts 'date' columns to ISO 8601 format with a
 * midnight timestamp in the server's timezone, resulting in values like "T05:00:00.000Z"
 * (midnight EST = 5 AM UTC).
 *
 * @consumer app
 */
export function compareDateValues(inputValue: any, responseValue: any): { isDate: boolean, matches: boolean } {
  if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
    return { isDate: false, matches: false };
  }

  // Check if input is date-only format (YYYY-MM-DD) - exactly 10 characters
  const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
  const isInputDateOnly = dateOnlyPattern.test(inputValue);

  // Check if response has a time component (from PostgreSQL JSON serialization)
  const dateTimePattern = /^\d{4}-\d{2}-\d{2}[T ]/;
  const isResponseDateTime = dateTimePattern.test(responseValue);

  // This comparison handles: date-only input vs datetime response
  // Also handles: date-only input vs date-only response (direct match)
  if (!isInputDateOnly) {
    return { isDate: false, matches: false };
  }

  try {
    // Extract just the date portion (first 10 characters: YYYY-MM-DD)
    const inputDate = inputValue.substring(0, 10);
    const responseDate = responseValue.substring(0, 10);

    return { isDate: true, matches: inputDate === responseDate };
  } catch (error) {
    return { isDate: false, matches: false };
  }
}

/**
 * Compares money values.
 * Input: 100 (number) or "100" (string)
 * Response: "$100.00" (formatted string from PostgreSQL)
 *
 * @consumer app
 */
export function compareMoneyValues(inputValue: any, responseValue: any): { isMoney: boolean, matches: boolean } {
  // Response must be a formatted money string (starts with $ or currency symbol)
  if (typeof responseValue !== 'string' || !responseValue.match(/^[\$€£¥]/)) {
    return { isMoney: false, matches: false };
  }

  try {
    // Parse both to numeric values for comparison
    const inputNumeric = typeof inputValue === 'number' ? inputValue : parseFloat(String(inputValue).replace(/[^0-9.-]/g, ''));
    const responseNumeric = parseFloat(responseValue.replace(/[^0-9.-]/g, ''));

    if (isNaN(inputNumeric) || isNaN(responseNumeric)) {
      return { isMoney: false, matches: false };
    }

    // Compare with small epsilon for floating point precision
    const matches = Math.abs(inputNumeric - responseNumeric) < 0.01;

    return { isMoney: true, matches };
  } catch (error) {
    return { isMoney: false, matches: false };
  }
}

/**
 * Compares hex color values (case-insensitive).
 * Input: "#3b82f6" or "#3B82F6" (from HTML5 color picker)
 * Response: "#3b82f6" or "#3B82F6" (from database)
 *
 * @consumer app
 */
export function compareColorValues(inputValue: any, responseValue: any): { isColor: boolean, matches: boolean } {
  if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
    return { isColor: false, matches: false };
  }

  // Check if both values look like hex colors (#RRGGBB format)
  const hexColorPattern = /^#[0-9A-Fa-f]{6}$/;
  if (!hexColorPattern.test(inputValue) || !hexColorPattern.test(responseValue)) {
    return { isColor: false, matches: false };
  }

  // Compare case-insensitively
  const matches = inputValue.toUpperCase() === responseValue.toUpperCase();
  return { isColor: true, matches };
}

/**
 * Compares time_slot (tstzrange) values.
 * Input: [2025-11-07T15:00:00Z,2025-11-07T22:00:00Z) (ISO 8601 format we send)
 * Response: [\"2025-11-07 15:00:00+00\",\"2025-11-07 22:00:00+00\") (PostgreSQL format with escaped quotes)
 *
 * @consumer app
 */
export function compareTimeSlotValues(inputValue: any, responseValue: any): { isTimeSlot: boolean, matches: boolean } {
  if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
    return { isTimeSlot: false, matches: false };
  }

  // Check if both values look like tstzrange format: [start,end)
  const tstzrangePattern = /^\[.+,.+\)$/;
  if (!tstzrangePattern.test(inputValue) || !tstzrangePattern.test(responseValue)) {
    return { isTimeSlot: false, matches: false };
  }

  try {
    // Parse both values to extract start and end timestamps
    const parseRange = (range: string): { start: string, end: string } | null => {
      // Handle both formats:
      // - ISO: [2025-11-07T15:00:00.000Z,2025-11-07T22:00:00.000Z) (with milliseconds)
      // - ISO: [2025-11-07T15:00:00Z,2025-11-07T22:00:00Z) (without milliseconds)
      // - PG:  [\"2025-11-07 15:00:00+00\",\"2025-11-07 22:00:00+00\")

      // First try to match quoted format (PostgreSQL response)
      let match = range.match(/\[\"([^\"]+)\",\"([^\"]+)\"\)/);
      if (match) {
        return { start: match[1], end: match[2] };
      }

      // Then try unquoted format (our input)
      // Remove the [ and ) brackets first
      if (!range.startsWith('[') || !range.endsWith(')')) {
        return null;
      }
      const content = range.substring(1, range.length - 1);

      // Find the middle comma by looking for the pattern: Z, or .000Z,
      // This works because ISO timestamps end with Z (or +00) before the comma separator
      const separatorIndex = content.search(/Z,|(?:\.\d{3}Z),/);
      if (separatorIndex === -1) {
        return null;
      }

      // Find the actual comma position (after the Z)
      const commaIndex = content.indexOf(',', separatorIndex);
      const start = content.substring(0, commaIndex).trim();
      const end = content.substring(commaIndex + 1).trim();

      return { start, end };
    };

    const inputParsed = parseRange(inputValue);
    const responseParsed = parseRange(responseValue);

    if (!inputParsed || !responseParsed) {
      return { isTimeSlot: false, matches: false };
    }

    // Normalize timestamps to ISO 8601 for comparison
    const normalizeTimestamp = (ts: string): string => {
      // Convert "2025-11-07 15:00:00+00" to "2025-11-07T15:00:00Z"
      // Also strip milliseconds (.000) since PostgreSQL doesn't return them
      let normalized = ts.replace(' ', 'T').replace(/\+00$/, 'Z');
      // Remove milliseconds if present (e.g., "2025-11-07T15:00:00.000Z" -> "2025-11-07T15:00:00Z")
      normalized = normalized.replace(/\.\d{3}Z$/, 'Z');
      return normalized;
    };

    const inputStartNormalized = normalizeTimestamp(inputParsed.start);
    const inputEndNormalized = normalizeTimestamp(inputParsed.end);
    const responseStartNormalized = normalizeTimestamp(responseParsed.start);
    const responseEndNormalized = normalizeTimestamp(responseParsed.end);

    // Compare as Date objects to handle any remaining format quirks
    const inputStartDate = new Date(inputStartNormalized).getTime();
    const inputEndDate = new Date(inputEndNormalized).getTime();
    const responseStartDate = new Date(responseStartNormalized).getTime();
    const responseEndDate = new Date(responseEndNormalized).getTime();

    const matches = inputStartDate === responseStartDate && inputEndDate === responseEndDate;

    return { isTimeSlot: true, matches };
  } catch (error) {
    // Error parsing - not a time_slot field
    return { isTimeSlot: false, matches: false };
  }
}

/**
 * Compares geography/geometry fields by converting EWKB to EWKT.
 * Input: EWKT format like "SRID=4326;POINT(-83 43)"
 * Response: EWKB hex format like "0101000020E6100000..."
 *
 * @consumer app
 */
export function compareGeographyValues(inputValue: any, responseValue: any): { isGeography: boolean, matches: boolean } {
  if (typeof inputValue !== 'string' || typeof responseValue !== 'string') {
    return { isGeography: false, matches: false };
  }

  // Check if input looks like EWKT (starts with SRID= or is WKT geometry type)
  const isInputEWKT = inputValue.startsWith('SRID=') ||
                      /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*\(/i.test(inputValue);

  // Check if response looks like EWKB hex (long hex string starting with 01)
  const isResponseEWKB = /^01[0-9A-F]{10,}$/i.test(responseValue);

  if (!isInputEWKT || !isResponseEWKB) {
    return { isGeography: false, matches: false };
  }

  try {
    // Parse EWKB to EWKT
    const responseEWKT = parseEWKBPoint(responseValue);

    if (!responseEWKT) {
      // Could not parse EWKB - only POINT geometries are supported
      // Fall back to trusting PostgREST for complex geometries
      return { isGeography: true, matches: true };
    }

    // Normalize: strip SRID, normalize case and whitespace
    const stripSRID = (ewkt: string) => ewkt.replace(/^SRID=\d+;/i, '');
    const normalizedInput = stripSRID(inputValue).toUpperCase().replace(/\s+/g, ' ').trim();
    const normalizedResponse = stripSRID(responseEWKT).toUpperCase().replace(/\s+/g, ' ').trim();

    const matches = normalizedInput === normalizedResponse;

    return { isGeography: true, matches };
  } catch (error) {
    // Error converting EWKB to EWKT - fall back to trusting PostgREST
    return { isGeography: true, matches: true };
  }
}

/**
 * Compares a submitted value with the value PostgREST returned after the write.
 *
 * @consumer app
 */
export function checkEditResult(input: any, representation: any): any {
  // If it's already an error response, return it as-is
  if (representation?.success === false) {
    return representation;
  }

  let identical: boolean;
  const mismatches: string[] = [];  // Track fields that don't match

  if(representation?.body?.[0] === undefined) {
    // Empty response - likely RLS blocking SELECT after UPDATE
    // This could be due to permissions, token expiration, or validation issues
    // Note: Token expiration is handled by explicit refresh in create/edit pages
    identical = false;
  } else {
    identical = (representation !== undefined) && Object.keys(input).every(key => {
      const inputValue = input[key];
      const responseValue = representation.body[0][key];

      // Handle FK fields: PostgREST returns embedded objects {id: 1, display_name: "..."}
      // but we submit primitive IDs
      let match: boolean;
      if (responseValue && typeof responseValue === 'object' && 'id' in responseValue) {
        // FK field returned as embedded object - compare with id property
        match = inputValue == responseValue.id;  // Use == for type coercion
      } else {
        // Check if this is a geography field and compare properly
        const geoComparison = compareGeographyValues(inputValue, responseValue);
        if (geoComparison.isGeography) {
          match = geoComparison.matches;
        } else {
          // Check if this is a datetime field and compare properly
          const dateTimeComparison = compareDateTimeValues(inputValue, responseValue);
          if (dateTimeComparison.isDateTime) {
            match = dateTimeComparison.matches;
          } else {
            // Check if this is a date-only field (PostgreSQL 'date' type)
            const dateComparison = compareDateValues(inputValue, responseValue);
            if (dateComparison.isDate) {
              match = dateComparison.matches;
            } else {
            // Check if this is a money field and compare properly
            const moneyComparison = compareMoneyValues(inputValue, responseValue);
            if (moneyComparison.isMoney) {
              match = moneyComparison.matches;
            } else {
              // Check if this is a hex color field and compare properly (case-insensitive)
              const colorComparison = compareColorValues(inputValue, responseValue);
              if (colorComparison.isColor) {
                match = colorComparison.matches;
              } else {
                // Check if this is a time_slot field and compare properly
                const timeSlotComparison = compareTimeSlotValues(inputValue, responseValue);
                if (timeSlotComparison.isTimeSlot) {
                  match = timeSlotComparison.matches;
                } else {
                  // Primitive value - use loose equality to handle string vs number (e.g., "4" vs 4)
                  match = inputValue == responseValue;  // Use == for type coercion
                }
              }
            }
            }
          }
        }
      }

      // Track fields that don't match
      if (!match) {
        mismatches.push(key);
      }

      return match;
    });
  }

  if (identical) {
    return <ApiResponse>{success: true, body: representation.body};
  } else {
    // Build enhanced error message with field-level details
    const mismatchList = mismatches.length > 0 ? mismatches.join(', ') : 'unknown fields';
    return <ApiResponse>{
      success: false,
      error: {
        httpCode: 400,
        message: "Your changes may not have been saved. The returned data does not match the submitted data.",
        humanMessage: "Changes may not have been saved",
        hint: `Some fields were modified by the database (possibly: ${mismatchList}). This may indicate a configuration issue - contact your administrator if this persists.`,
        details: `Field mismatches: ${mismatchList}`
      }
    };
  }
}
