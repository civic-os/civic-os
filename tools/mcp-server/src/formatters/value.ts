/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Value formatting for MCP server output.
 * Converts raw PostgREST values to human-readable text based on property type.
 */

import { EntityPropertyType, type SchemaProperty } from '../interfaces.js';

/**
 * Format a raw value from PostgREST into human-readable text.
 * Handles FK embedding, status/category objects, money, dates, booleans, etc.
 */
export function formatValue(value: unknown, property: SchemaProperty): string {
  if (value === null || value === undefined) return '';

  const type = property.type ?? EntityPropertyType.Unknown;

  switch (type) {
    case EntityPropertyType.Boolean:
      return value ? 'Yes' : 'No';

    case EntityPropertyType.Money:
      return formatMoney(value);

    case EntityPropertyType.Date:
      return formatDate(value as string);

    case EntityPropertyType.DateTime:
      return formatDateTime(value as string);

    case EntityPropertyType.DateTimeLocal:
      return formatDateTimeLocal(value as string);

    case EntityPropertyType.ForeignKeyName:
      return formatForeignKey(value);

    case EntityPropertyType.User:
      return formatUser(value);

    case EntityPropertyType.Status:
    case EntityPropertyType.Category:
      return formatStatusOrCategory(value);

    case EntityPropertyType.Email:
      return String(value);

    case EntityPropertyType.Telephone:
      return String(value);

    case EntityPropertyType.Color:
      return String(value);

    case EntityPropertyType.GeoPoint:
      return formatGeoPoint(value as string);

    case EntityPropertyType.GeoPolygon:
      return '[Polygon]';

    case EntityPropertyType.Payment:
      return formatPayment(value);

    case EntityPropertyType.File:
    case EntityPropertyType.FileImage:
    case EntityPropertyType.FilePDF:
      return formatFile(value);

    case EntityPropertyType.PhotoGallery:
      return formatPhotoGallery(value);

    case EntityPropertyType.ManyToMany:
      return formatManyToMany(value);

    case EntityPropertyType.TimeSlot:
    case EntityPropertyType.RecurringTimeSlot:
      return String(value);

    case EntityPropertyType.Markdown:
      // Return raw markdown — the LLM can interpret it
      return String(value);

    case EntityPropertyType.IntegerNumber:
      return String(value);

    case EntityPropertyType.DecimalNumber:
      return typeof value === 'number' ? value.toFixed(2) : String(value);

    default:
      return String(value);
  }
}

/** Format embedded FK object: { id, display_name } → "Display Name" */
function formatForeignKey(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('display_name' in obj && obj.display_name) {
      return String(obj.display_name);
    }
    if ('id' in obj) return `#${obj.id}`;
  }
  // Raw ID (not embedded)
  return String(value);
}

/** Format embedded User object */
function formatUser(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return String(obj.display_name ?? obj.full_name ?? obj.id ?? value);
  }
  return String(value);
}

/** Format embedded Status/Category object: { id, display_name, color } → "Display Name" */
function formatStatusOrCategory(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('display_name' in obj) return String(obj.display_name);
    if ('id' in obj) return `#${obj.id}`;
  }
  return String(value);
}

/** Format money value — PostgREST returns money as string like "$1,234.56" or number */
function formatMoney(value: unknown): string {
  if (typeof value === 'string') {
    // PostgREST returns money as "$1,234.56" format
    return value;
  }
  if (typeof value === 'number') {
    return `$${value.toFixed(2)}`;
  }
  return String(value);
}

/** Format date string to readable format */
function formatDate(value: string): string {
  try {
    const d = new Date(value);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return value;
  }
}

/** Format timestamp (wall-clock, no timezone conversion) */
function formatDateTime(value: string): string {
  try {
    // timestamp without tz — display as-is
    const d = new Date(value + 'Z'); // treat as UTC to avoid local conversion
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  } catch {
    return value;
  }
}

/** Format timestamptz (convert to user's local timezone) */
export function formatDateTimeLocal(value: string): string {
  try {
    const d = new Date(value);
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return value;
  }
}

/** Format GeoPoint WKT: "POINT(lng lat)" → "lat, lng" */
function formatGeoPoint(value: string): string {
  const match = String(value).match(/POINT\(([^ ]+) ([^ ]+)\)/i);
  if (match) {
    return `${parseFloat(match[2]).toFixed(6)}, ${parseFloat(match[1]).toFixed(6)}`;
  }
  return String(value);
}

/** Format embedded payment object */
function formatPayment(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const status = String(obj.effective_status ?? obj.status ?? 'unknown');
    const amount = obj.amount != null ? formatMoney(obj.amount) : '';
    return amount ? `${amount} (${status})` : status;
  }
  return String(value);
}

/** Format embedded file object */
function formatFile(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return String(obj.file_name ?? obj.id ?? value);
  }
  return String(value);
}

/** Format photo gallery — count of images */
function formatPhotoGallery(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const files = obj.photo_gallery_files;
    if (Array.isArray(files)) {
      return `${files.length} photo${files.length !== 1 ? 's' : ''}`;
    }
  }
  return String(value);
}

/** Format M:M embedded array — list of display names */
function formatManyToMany(value: unknown): string {
  if (!Array.isArray(value)) return String(value);
  if (value.length === 0) return '';

  const names = value
    .map(item => {
      if (typeof item === 'object' && item !== null) {
        // Navigate through PostgREST embedding to find display_name
        const values = Object.values(item as Record<string, unknown>);
        for (const v of values) {
          if (typeof v === 'object' && v !== null && 'display_name' in (v as Record<string, unknown>)) {
            return String((v as Record<string, unknown>).display_name);
          }
        }
        if ('display_name' in (item as Record<string, unknown>)) {
          return String((item as Record<string, unknown>).display_name);
        }
      }
      return String(item);
    })
    .filter(Boolean);

  return names.join(', ');
}

/**
 * Get a human-readable type label for a property type.
 * Used in describe_entity output.
 */
export function getTypeLabel(property: SchemaProperty): string {
  const type = property.type ?? EntityPropertyType.Unknown;

  switch (type) {
    case EntityPropertyType.TextShort: return 'Text';
    case EntityPropertyType.TextLong: return 'Text (long)';
    case EntityPropertyType.Boolean: return 'Yes/No';
    case EntityPropertyType.Date: return 'Date';
    case EntityPropertyType.DateTime: return 'Date & Time';
    case EntityPropertyType.DateTimeLocal: return 'Date & Time (local timezone)';
    case EntityPropertyType.Money: return 'Money';
    case EntityPropertyType.IntegerNumber: return 'Integer';
    case EntityPropertyType.DecimalNumber: return 'Decimal';
    case EntityPropertyType.ForeignKeyName:
      return property.join_table ? `Foreign Key → ${property.join_table}` : 'Foreign Key';
    case EntityPropertyType.User: return 'User';
    case EntityPropertyType.GeoPoint: return 'Geographic Point';
    case EntityPropertyType.GeoPolygon: return 'Geographic Polygon';
    case EntityPropertyType.Color: return 'Color';
    case EntityPropertyType.Email: return 'Email';
    case EntityPropertyType.Telephone: return 'Phone Number';
    case EntityPropertyType.TimeSlot: return 'Time Slot';
    case EntityPropertyType.RecurringTimeSlot: return 'Recurring Time Slot';
    case EntityPropertyType.ManyToMany: return 'Many-to-Many';
    case EntityPropertyType.File: return 'File';
    case EntityPropertyType.FileImage: return 'Image File';
    case EntityPropertyType.FilePDF: return 'PDF File';
    case EntityPropertyType.Payment: return 'Payment';
    case EntityPropertyType.Status:
      return property.status_entity_type ? `Status` : 'Status';
    case EntityPropertyType.Category:
      return property.category_entity_type ? `Category` : 'Category';
    case EntityPropertyType.PhotoGallery: return 'Photo Gallery';
    case EntityPropertyType.Markdown: return 'Markdown';
    default: return 'Unknown';
  }
}
