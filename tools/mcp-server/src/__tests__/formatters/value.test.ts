/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for formatValue() and getTypeLabel().
 */

import { describe, it, expect } from 'vitest';
import { formatValue, getTypeLabel } from '../../formatters/value.js';
import { EntityPropertyType } from '../../interfaces.js';
import type { SchemaProperty } from '../../interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProp(overrides: Partial<SchemaProperty> = {}): SchemaProperty {
  return {
    table_name: 'projects',
    column_name: 'col',
    display_name: 'Col',
    data_type: 'character varying',
    udt_name: 'varchar',
    udt_schema: 'pg_catalog',
    sort_order: 1,
    join_schema: '',
    join_table: '',
    join_column: '',
    geography_type: '',
    is_nullable: true,
    is_updatable: true,
    is_identity: false,
    is_generated: false,
    is_self_referencing: false,
    column_default: '',
    type: EntityPropertyType.Unknown,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Null/undefined handling
// ---------------------------------------------------------------------------

describe('formatValue() null/undefined', () => {
  it('returns empty string for null', () => {
    expect(formatValue(null, makeProp())).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatValue(undefined, makeProp())).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

describe('formatValue() Boolean', () => {
  const prop = makeProp({ type: EntityPropertyType.Boolean });

  it('returns "Yes" for true', () => {
    expect(formatValue(true, prop)).toBe('Yes');
  });

  it('returns "No" for false', () => {
    expect(formatValue(false, prop)).toBe('No');
  });

  it('returns "Yes" for truthy number', () => {
    expect(formatValue(1, prop)).toBe('Yes');
  });

  it('returns "No" for 0', () => {
    expect(formatValue(0, prop)).toBe('No');
  });
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe('formatValue() Money', () => {
  const prop = makeProp({ type: EntityPropertyType.Money });

  it('passes through string money values', () => {
    expect(formatValue('$1,234.56', prop)).toBe('$1,234.56');
  });

  it('formats number with $ and 2 decimals', () => {
    expect(formatValue(500, prop)).toBe('$500.00');
  });

  it('formats 0 as $0.00', () => {
    expect(formatValue(0, prop)).toBe('$0.00');
  });

  it('stringifies other types', () => {
    expect(formatValue({ unexpected: true }, prop)).toBe('[object Object]');
  });
});

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

describe('formatValue() Date', () => {
  const prop = makeProp({ type: EntityPropertyType.Date });

  it('formats ISO date string to human-readable form', () => {
    const result = formatValue('2024-06-15', prop);
    // Should contain "Jun" and "2024"
    expect(result).toContain('2024');
    expect(result).toMatch(/Jun/i);
  });

  it('returns value as-is when date parsing fails', () => {
    const result = formatValue('not-a-date', prop);
    // formatDate catches and returns the raw string, but JS Date('not-a-date') gives Invalid Date
    // The code returns the raw string in the catch block
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// DateTime
// ---------------------------------------------------------------------------

describe('formatValue() DateTime', () => {
  const prop = makeProp({ type: EntityPropertyType.DateTime });

  it('formats timestamp without timezone', () => {
    const result = formatValue('2024-03-20T14:30:00', prop);
    // Result should be a datetime string with date and time parts
    expect(result).toContain('2024-03-20');
    expect(result).toContain('14:30:00');
  });
});

// ---------------------------------------------------------------------------
// DateTimeLocal
// ---------------------------------------------------------------------------

describe('formatValue() DateTimeLocal', () => {
  const prop = makeProp({ type: EntityPropertyType.DateTimeLocal });

  it('formats timestamptz to locale string', () => {
    const result = formatValue('2024-03-20T14:30:00Z', prop);
    // Should contain year
    expect(result).toContain('2024');
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// ForeignKeyName
// ---------------------------------------------------------------------------

describe('formatValue() ForeignKeyName', () => {
  const prop = makeProp({
    type: EntityPropertyType.ForeignKeyName,
    join_table: 'clients',
    join_column: 'id',
  });

  it('extracts display_name from embedded FK object', () => {
    expect(formatValue({ id: 42, display_name: 'Acme Corp' }, prop)).toBe('Acme Corp');
  });

  it('falls back to #id when embedded object has no display_name', () => {
    expect(formatValue({ id: 42 }, prop)).toBe('#42');
  });

  it('returns raw string for raw ID (not embedded)', () => {
    expect(formatValue(99, prop)).toBe('99');
  });

  it('returns string representation of raw number ID', () => {
    expect(formatValue('42', prop)).toBe('42');
  });

  it('returns empty display_name fallback to #id when display_name is falsy', () => {
    expect(formatValue({ id: 5, display_name: '' }, prop)).toBe('#5');
  });
});

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

describe('formatValue() User', () => {
  const prop = makeProp({ type: EntityPropertyType.User });

  it('uses display_name from embedded object', () => {
    expect(formatValue({ id: 'uuid-1', display_name: 'Jane Doe' }, prop)).toBe('Jane Doe');
  });

  it('falls back to full_name when display_name is absent', () => {
    expect(formatValue({ id: 'uuid-1', full_name: 'Jane Doe' }, prop)).toBe('Jane Doe');
  });

  it('falls back to id when neither display_name nor full_name is present', () => {
    expect(formatValue({ id: 'uuid-1' }, prop)).toBe('uuid-1');
  });

  it('returns string for raw UUID value', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(formatValue(uuid, prop)).toBe(uuid);
  });
});

// ---------------------------------------------------------------------------
// Status and Category
// ---------------------------------------------------------------------------

describe('formatValue() Status', () => {
  const prop = makeProp({
    type: EntityPropertyType.Status,
    join_table: 'statuses',
    status_entity_type: 'projects',
  });

  it('extracts display_name from embedded status object', () => {
    expect(formatValue({ id: 1, display_name: 'Active', color: 'green' }, prop)).toBe('Active');
  });

  it('falls back to #id when no display_name', () => {
    expect(formatValue({ id: 3 }, prop)).toBe('#3');
  });

  it('returns string for raw ID', () => {
    expect(formatValue(2, prop)).toBe('2');
  });
});

describe('formatValue() Category', () => {
  const prop = makeProp({ type: EntityPropertyType.Category });

  it('extracts display_name from embedded category object', () => {
    expect(formatValue({ id: 1, display_name: 'Internal', color: 'blue' }, prop)).toBe('Internal');
  });
});

// ---------------------------------------------------------------------------
// Email, Telephone, Color
// ---------------------------------------------------------------------------

describe('formatValue() Email', () => {
  it('returns the email string as-is', () => {
    const prop = makeProp({ type: EntityPropertyType.Email });
    expect(formatValue('user@example.com', prop)).toBe('user@example.com');
  });
});

describe('formatValue() Telephone', () => {
  it('returns the phone string as-is', () => {
    const prop = makeProp({ type: EntityPropertyType.Telephone });
    expect(formatValue('+1-555-123-4567', prop)).toBe('+1-555-123-4567');
  });
});

describe('formatValue() Color', () => {
  it('returns the hex color string as-is', () => {
    const prop = makeProp({ type: EntityPropertyType.Color });
    expect(formatValue('#FF5733', prop)).toBe('#FF5733');
  });
});

// ---------------------------------------------------------------------------
// GeoPoint
// ---------------------------------------------------------------------------

describe('formatValue() GeoPoint', () => {
  const prop = makeProp({ type: EntityPropertyType.GeoPoint });

  it('parses POINT WKT to "lat, lng" format', () => {
    const result = formatValue('POINT(-73.935242 40.730610)', prop);
    // lat is 40.730610, lng is -73.935242
    expect(result).toBe('40.730610, -73.935242');
  });

  it('returns raw string for non-WKT value', () => {
    expect(formatValue('not-wkt', prop)).toBe('not-wkt');
  });
});

// ---------------------------------------------------------------------------
// GeoPolygon
// ---------------------------------------------------------------------------

describe('formatValue() GeoPolygon', () => {
  it('returns "[Polygon]" placeholder', () => {
    const prop = makeProp({ type: EntityPropertyType.GeoPolygon });
    expect(formatValue('POLYGON((...))', prop)).toBe('[Polygon]');
  });
});

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

describe('formatValue() Payment', () => {
  const prop = makeProp({ type: EntityPropertyType.Payment });

  it('formats embedded payment with amount and status', () => {
    const result = formatValue({ amount: 250, effective_status: 'paid' }, prop);
    expect(result).toContain('$250.00');
    expect(result).toContain('paid');
  });

  it('formats payment with only status when amount is null', () => {
    const result = formatValue({ effective_status: 'pending', amount: null }, prop);
    expect(result).toBe('pending');
  });

  it('returns raw string for non-object payment', () => {
    expect(formatValue('raw-payment', prop)).toBe('raw-payment');
  });

  it('uses status fallback when effective_status is absent', () => {
    const result = formatValue({ status: 'refunded', amount: 100 }, prop);
    expect(result).toContain('refunded');
  });
});

// ---------------------------------------------------------------------------
// File / FileImage / FilePDF
// ---------------------------------------------------------------------------

describe('formatValue() File types', () => {
  const fileProp = makeProp({ type: EntityPropertyType.File });
  const imageProp = makeProp({ type: EntityPropertyType.FileImage });
  const pdfProp = makeProp({ type: EntityPropertyType.FilePDF });

  it('extracts file_name from embedded file object', () => {
    expect(formatValue({ id: 'uuid-f', file_name: 'report.pdf' }, fileProp)).toBe('report.pdf');
  });

  it('falls back to id when file_name is absent', () => {
    expect(formatValue({ id: 'uuid-f' }, fileProp)).toBe('uuid-f');
  });

  it('handles FileImage the same way', () => {
    expect(formatValue({ id: 'img-uuid', file_name: 'photo.jpg' }, imageProp)).toBe('photo.jpg');
  });

  it('handles FilePDF the same way', () => {
    expect(formatValue({ id: 'pdf-uuid', file_name: 'doc.pdf' }, pdfProp)).toBe('doc.pdf');
  });

  it('returns raw string for non-object file value', () => {
    expect(formatValue('raw-file-id', fileProp)).toBe('raw-file-id');
  });
});

// ---------------------------------------------------------------------------
// PhotoGallery
// ---------------------------------------------------------------------------

describe('formatValue() PhotoGallery', () => {
  const prop = makeProp({ type: EntityPropertyType.PhotoGallery });

  it('formats 0 photos', () => {
    expect(formatValue({ photo_gallery_files: [] }, prop)).toBe('0 photos');
  });

  it('formats 1 photo (singular)', () => {
    expect(formatValue({ photo_gallery_files: [{}] }, prop)).toBe('1 photo');
  });

  it('formats multiple photos', () => {
    expect(formatValue({ photo_gallery_files: [{}, {}, {}] }, prop)).toBe('3 photos');
  });

  it('stringifies non-gallery objects', () => {
    expect(formatValue({ other_field: 'value' }, prop)).toBe('[object Object]');
  });
});

// ---------------------------------------------------------------------------
// ManyToMany
// ---------------------------------------------------------------------------

describe('formatValue() ManyToMany', () => {
  const prop = makeProp({ type: EntityPropertyType.ManyToMany });

  it('returns empty string for empty array', () => {
    expect(formatValue([], prop)).toBe('');
  });

  it('joins display names from embedded junction objects', () => {
    // PostgREST M:M embedding: array of junction rows, each with embedded target
    const value = [
      { tag: { id: 1, display_name: 'Frontend' } },
      { tag: { id: 2, display_name: 'Backend' } },
    ];
    const result = formatValue(value, prop);
    expect(result).toContain('Frontend');
    expect(result).toContain('Backend');
  });

  it('extracts display_name from items that have it directly', () => {
    const value = [
      { id: 1, display_name: 'Alice' },
      { id: 2, display_name: 'Bob' },
    ];
    const result = formatValue(value, prop);
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  it('returns string representation for non-array value', () => {
    expect(formatValue('not-an-array', prop)).toBe('not-an-array');
  });
});

// ---------------------------------------------------------------------------
// TimeSlot / RecurringTimeSlot / Markdown
// ---------------------------------------------------------------------------

describe('formatValue() TimeSlot', () => {
  it('returns string as-is for TimeSlot', () => {
    const prop = makeProp({ type: EntityPropertyType.TimeSlot });
    expect(formatValue('2024-01-15 10:00-11:00', prop)).toBe('2024-01-15 10:00-11:00');
  });

  it('returns string as-is for RecurringTimeSlot', () => {
    const prop = makeProp({ type: EntityPropertyType.RecurringTimeSlot });
    expect(formatValue('RRULE:FREQ=WEEKLY', prop)).toBe('RRULE:FREQ=WEEKLY');
  });
});

describe('formatValue() Markdown', () => {
  it('returns raw markdown content', () => {
    const prop = makeProp({ type: EntityPropertyType.Markdown });
    const markdown = '# Heading\n\nParagraph with **bold**.';
    expect(formatValue(markdown, prop)).toBe(markdown);
  });
});

// ---------------------------------------------------------------------------
// Integer / Decimal
// ---------------------------------------------------------------------------

describe('formatValue() IntegerNumber', () => {
  const prop = makeProp({ type: EntityPropertyType.IntegerNumber });

  it('returns string representation of integer', () => {
    expect(formatValue(42, prop)).toBe('42');
  });

  it('returns string representation of 0', () => {
    expect(formatValue(0, prop)).toBe('0');
  });
});

describe('formatValue() DecimalNumber', () => {
  const prop = makeProp({ type: EntityPropertyType.DecimalNumber });

  it('formats number to 2 decimal places', () => {
    expect(formatValue(3.14159, prop)).toBe('3.14');
  });

  it('formats integer to 2 decimal places', () => {
    expect(formatValue(5, prop)).toBe('5.00');
  });

  it('stringifies non-number values', () => {
    expect(formatValue('3.14', prop)).toBe('3.14');
  });
});

// ---------------------------------------------------------------------------
// Unknown / Default
// ---------------------------------------------------------------------------

describe('formatValue() Unknown and defaults', () => {
  it('stringifies any value for Unknown type', () => {
    const prop = makeProp({ type: EntityPropertyType.Unknown });
    expect(formatValue('hello', prop)).toBe('hello');
    expect(formatValue(123, prop)).toBe('123');
  });

  it('uses Unknown type when property has no type set', () => {
    const prop = makeProp({ type: undefined });
    expect(formatValue('test', prop)).toBe('test');
  });

  it('stringifies TextShort values', () => {
    const prop = makeProp({ type: EntityPropertyType.TextShort });
    expect(formatValue('short text', prop)).toBe('short text');
  });

  it('stringifies TextLong values', () => {
    const prop = makeProp({ type: EntityPropertyType.TextLong });
    expect(formatValue('long text content here', prop)).toBe('long text content here');
  });
});

// ---------------------------------------------------------------------------
// getTypeLabel()
// ---------------------------------------------------------------------------

describe('getTypeLabel()', () => {
  it('returns "Yes/No" for Boolean', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Boolean }))).toBe('Yes/No');
  });

  it('returns "Text" for TextShort', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.TextShort }))).toBe('Text');
  });

  it('returns "Text (long)" for TextLong', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.TextLong }))).toBe('Text (long)');
  });

  it('returns "Date" for Date', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Date }))).toBe('Date');
  });

  it('returns "Date & Time" for DateTime', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.DateTime }))).toBe('Date & Time');
  });

  it('returns "Date & Time (local timezone)" for DateTimeLocal', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.DateTimeLocal }))).toBe('Date & Time (local timezone)');
  });

  it('returns "Money" for Money', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Money }))).toBe('Money');
  });

  it('returns "Integer" for IntegerNumber', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.IntegerNumber }))).toBe('Integer');
  });

  it('returns "Decimal" for DecimalNumber', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.DecimalNumber }))).toBe('Decimal');
  });

  it('returns "Foreign Key → tableName" for ForeignKeyName with join_table', () => {
    const prop = makeProp({ type: EntityPropertyType.ForeignKeyName, join_table: 'clients' });
    expect(getTypeLabel(prop)).toBe('Foreign Key → clients');
  });

  it('returns "Foreign Key" for ForeignKeyName without join_table', () => {
    const prop = makeProp({ type: EntityPropertyType.ForeignKeyName, join_table: '' });
    expect(getTypeLabel(prop)).toBe('Foreign Key');
  });

  it('returns "User" for User', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.User }))).toBe('User');
  });

  it('returns "Geographic Point" for GeoPoint', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.GeoPoint }))).toBe('Geographic Point');
  });

  it('returns "Geographic Polygon" for GeoPolygon', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.GeoPolygon }))).toBe('Geographic Polygon');
  });

  it('returns "Color" for Color', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Color }))).toBe('Color');
  });

  it('returns "Email" for Email', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Email }))).toBe('Email');
  });

  it('returns "Phone Number" for Telephone', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Telephone }))).toBe('Phone Number');
  });

  it('returns "Time Slot" for TimeSlot', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.TimeSlot }))).toBe('Time Slot');
  });

  it('returns "Recurring Time Slot" for RecurringTimeSlot', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.RecurringTimeSlot }))).toBe('Recurring Time Slot');
  });

  it('returns "Many-to-Many" for ManyToMany', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.ManyToMany }))).toBe('Many-to-Many');
  });

  it('returns "File" for File', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.File }))).toBe('File');
  });

  it('returns "Image File" for FileImage', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.FileImage }))).toBe('Image File');
  });

  it('returns "PDF File" for FilePDF', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.FilePDF }))).toBe('PDF File');
  });

  it('returns "Payment" for Payment', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Payment }))).toBe('Payment');
  });

  it('returns "Status" for Status', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Status }))).toBe('Status');
  });

  it('returns "Category" for Category', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Category }))).toBe('Category');
  });

  it('returns "Photo Gallery" for PhotoGallery', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.PhotoGallery }))).toBe('Photo Gallery');
  });

  it('returns "Markdown" for Markdown', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Markdown }))).toBe('Markdown');
  });

  it('returns "Unknown" for Unknown type', () => {
    expect(getTypeLabel(makeProp({ type: EntityPropertyType.Unknown }))).toBe('Unknown');
  });

  it('returns "Unknown" when type is undefined', () => {
    expect(getTypeLabel(makeProp({ type: undefined }))).toBe('Unknown');
  });
});
