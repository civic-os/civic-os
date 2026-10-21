/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/index.js';
import type { SchemaEntityProperty } from '../model/index.js';
import { getPropertyType } from './property-type.js';
import { isSystemType } from './system-types.js';
import {
  propertyToSelectString,
  propertyToSelectStringForEdit,
  propertyToSelectStringForList,
} from './select.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function prop(over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty {
  return deepFreeze({
    table_catalog: '', table_schema: 'public', table_name: 't', column_name: 'c', display_name: 'C',
    sort_order: 0, column_default: '', is_nullable: true, data_type: 'text',
    character_maximum_length: 0, udt_schema: 'pg_catalog', udt_name: 'text',
    is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true,
    join_schema: '', join_table: '', join_column: null as never, geography_type: '',
    type: EntityPropertyType.Unknown,
    ...over,
  } as SchemaEntityProperty);
}

describe('getPropertyType', () => {
  const T = EntityPropertyType;
  const scalar: Array<[string, Partial<SchemaEntityProperty>, EntityPropertyType]> = [
    ['timestamp', { udt_name: 'timestamp' }, T.DateTime],
    ['timestamptz', { udt_name: 'timestamptz' }, T.DateTimeLocal],
    ['date', { udt_name: 'date' }, T.Date],
    ['bool', { udt_name: 'bool' }, T.Boolean],
    ['int4', { udt_name: 'int4' }, T.IntegerNumber],
    ['int8', { udt_name: 'int8' }, T.IntegerNumber],
    ['money', { udt_name: 'money' }, T.Money],
    ['numeric', { udt_name: 'numeric' }, T.DecimalNumber],
    ['float4', { udt_name: 'float4' }, T.DecimalNumber],
    ['float8', { udt_name: 'float8' }, T.DecimalNumber],
    ['hex_color', { udt_name: 'hex_color' }, T.Color],
    ['email_address', { udt_name: 'email_address' }, T.Email],
    ['phone_number', { udt_name: 'phone_number' }, T.Telephone],
    ['time_slot', { udt_name: 'time_slot' }, T.TimeSlot],
    ['recurring time_slot', { udt_name: 'time_slot', is_recurring: true }, T.RecurringTimeSlot],
    ['markdown', { udt_name: 'markdown' }, T.Markdown],
    ['varchar', { udt_name: 'varchar' }, T.TextShort],
    ['text', { udt_name: 'text' }, T.TextLong],
    ['unknown', { udt_name: 'weird' }, T.Unknown],
    ['geography point', { udt_name: 'geography', geography_type: 'Point' }, T.GeoPoint],
    ['geography polygon', { udt_name: 'geography', geography_type: 'Polygon' }, T.GeoPolygon],
    ['geography other', { udt_name: 'geography', geography_type: 'Line' }, T.Unknown],
    ['fk int4', { udt_name: 'int4', join_column: 'id', join_table: 'x', join_schema: 'public' }, T.ForeignKeyName],
    ['fk int8', { udt_name: 'int8', join_column: 'id' }, T.ForeignKeyName],
    ['status', { udt_name: 'int4', join_column: 'id', status_entity_type: 'issue' }, T.Status],
    ['category', { udt_name: 'int4', join_column: 'id', category_entity_type: 'k' }, T.Category],
    ['status wins over category', { udt_name: 'int4', join_column: 'id', status_entity_type: 's', category_entity_type: 'c' }, T.Status],
    ['status needs join_column', { udt_name: 'int4', status_entity_type: 's' }, T.IntegerNumber],
    ['category needs int udt', { udt_name: 'text', join_column: 'id', category_entity_type: 'c' }, T.TextLong],
  ];
  for (const [name, over, expected] of scalar) {
    it(name, () => expect(getPropertyType(prop(over))).toBe(expected));
  }

  const uuidFk = (join_table: string, extra: Partial<SchemaEntityProperty> = {}) =>
    prop({ udt_name: 'uuid', join_table, join_schema: 'metadata', ...extra });

  it('files: image, pdf, plain, and unrelated fileType', () => {
    const vr = (value: string) => [{ type: 'fileType', value } as never];
    expect(getPropertyType(uuidFk('files', { validation_rules: vr('image/png') }))).toBe(T.FileImage);
    expect(getPropertyType(uuidFk('files', { validation_rules: vr('application/pdf') }))).toBe(T.FilePDF);
    expect(getPropertyType(uuidFk('files', { validation_rules: vr('text/csv') }))).toBe(T.File);
    expect(getPropertyType(uuidFk('files', { validation_rules: [{ type: 'fileType' } as never] }))).toBe(T.File);
    expect(getPropertyType(uuidFk('files'))).toBe(T.File);
  });

  it('users, payments, galleries', () => {
    expect(getPropertyType(uuidFk('civic_os_users'))).toBe(T.User);
    expect(getPropertyType(uuidFk('payment_transactions'))).toBe(T.Payment);
    expect(getPropertyType(uuidFk('transactions', { join_schema: 'payments' }))).toBe(T.Payment);
    expect(getPropertyType(uuidFk('photo_galleries'))).toBe(T.PhotoGallery);
  });

  it('system table that is not a typed system FK falls through to the udt branches', () => {
    expect(getPropertyType(uuidFk('statuses'))).toBe(T.Unknown);
    expect(getPropertyType(uuidFk('transactions', { join_schema: 'public' }))).toBe(T.Unknown);
  });

  it('uuid FK to a non-system table is not a system type', () => {
    expect(getPropertyType(uuidFk('widgets'))).toBe(T.Unknown);
  });
});

describe('isSystemType', () => {
  it('matches unqualified and metadata-qualified names only', () => {
    expect(isSystemType('files')).toBe(true);
    expect(isSystemType('metadata.files')).toBe(true);
    expect(isSystemType('public.files')).toBe(false);
    expect(isSystemType('widgets')).toBe(false);
    expect(isSystemType('metadata.widgets')).toBe(false);
  });
});

describe('select string builders', () => {
  const T = EntityPropertyType;
  const m2m = (over: object = {}) => prop({
    column_name: 'tags_m2m', type: T.ManyToMany,
    many_to_many_meta: {
      junctionTable: 'issue_tags', sourceTable: 'issues', targetTable: 'tags',
      sourceColumn: 'issue_id', targetColumn: 'tag_id', relatedTable: 'tags',
      relatedTableDisplayName: 'Tags', showOnSource: true, showOnTarget: true,
      displayOrder: 100, relatedTableHasColor: false, extraColumns: [], ...over,
    },
  });

  it('M:M plain, with color, rich, and parent hops', () => {
    expect(propertyToSelectString(m2m())).toBe('tags_m2m:issue_tags!issue_id(tags!tag_id(id,display_name))');
    expect(propertyToSelectString(m2m({ relatedTableHasColor: true }))).toBe('tags_m2m:issue_tags!issue_id(tags!tag_id(id,display_name,color))');
    expect(propertyToSelectString(m2m({ extraColumns: [{ column_name: 'qty' }, { column_name: 'note' }] })))
      .toBe('tags_m2m:issue_tags!issue_id(qty,note,tags!tag_id(id,display_name))');
    expect(propertyToSelectString(m2m({
      targetTable: 'mid',
      parentHops: [{ table: 'gp', fkColumn: 'gp_id' }, { table: 'ggp', fkColumn: 'ggp_id' }],
    }))).toBe('tags_m2m:issue_tags!issue_id(mid!tag_id(gp!gp_id(ggp!ggp_id(id,display_name))))');
    // an empty hop list is falsy-length: normal path
    expect(propertyToSelectString(m2m({ parentHops: [] }))).toBe('tags_m2m:issue_tags!issue_id(tags!tag_id(id,display_name))');
  });

  it('M:M type without meta falls through to the column name', () => {
    expect(propertyToSelectString(prop({ column_name: 'x', type: T.ManyToMany }))).toBe('x');
  });

  const files = 'f:files!f(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,thumbnail_error,created_at)';
  const payment = 'p:payment_transactions!p(id,amount,currency,status,effective_status,total_refunded,refund_count,pending_refund_count,display_name,error_message,created_at)';
  const gallery = 'g:photo_galleries!g(id,created_at,photo_gallery_files(file_id,sort_order,caption,alt_text,file:files!file_id(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status)))';

  it('embedded system types', () => {
    for (const t of [T.File, T.FileImage, T.FilePDF]) {
      expect(propertyToSelectString(prop({ column_name: 'f', type: t }))).toBe(files);
      expect(propertyToSelectStringForEdit(prop({ column_name: 'f', type: t }))).toBe(files);
    }
    expect(propertyToSelectString(prop({ column_name: 'p', type: T.Payment }))).toBe(payment);
    expect(propertyToSelectStringForEdit(prop({ column_name: 'p', type: T.Payment }))).toBe(payment);
    expect(propertyToSelectString(prop({ column_name: 'g', type: T.PhotoGallery }))).toBe(gallery);
    expect(propertyToSelectStringForEdit(prop({ column_name: 'g', type: T.PhotoGallery }))).toBe(gallery);
    expect(propertyToSelectStringForList(prop({ column_name: 'g', type: T.PhotoGallery }))).toBe('g:photo_galleries!g(id,photo_gallery_files(file_id))');
    expect(propertyToSelectString(prop({ column_name: 's', type: T.Status }))).toBe('s:statuses!s(id,display_name,color,status_key)');
    expect(propertyToSelectString(prop({ column_name: 'k', type: T.Category }))).toBe('k:categories!k(id,display_name,color)');
    expect(propertyToSelectString(prop({ column_name: 'u', type: T.User }))).toBe('u:civic_os_users!u(id,display_name,full_name,phone,email)');
  });

  it('FK, geo and plain columns', () => {
    const fk = prop({ column_name: 'o', type: T.ForeignKeyName, join_schema: 'public', join_table: 'owners', join_column: 'id' });
    expect(propertyToSelectString(fk)).toBe('o:owners!o(id,display_name)');
    expect(propertyToSelectStringForList(fk)).toBe('o:owners!o(id,display_name)');
    expect(propertyToSelectStringForEdit(fk)).toBe('o');
    expect(propertyToSelectString(prop({ column_name: 'o', join_schema: 'other', join_column: 'id' }))).toBe('o');
    for (const t of [T.GeoPoint, T.GeoPolygon]) {
      const g = prop({ column_name: 'loc', type: t });
      expect(propertyToSelectString(g)).toBe('loc:loc_text');
      expect(propertyToSelectStringForEdit(g)).toBe('loc:loc_text');
    }
    expect(propertyToSelectString(prop({ column_name: 'name' }))).toBe('name');
    expect(propertyToSelectStringForEdit(prop({ column_name: 'name' }))).toBe('name');
  });

  it('edit form uses raw ids for status, category, user and M:M keeps the embed', () => {
    expect(propertyToSelectStringForEdit(prop({ column_name: 's', type: T.Status }))).toBe('s');
    expect(propertyToSelectStringForEdit(prop({ column_name: 'k', type: T.Category }))).toBe('k');
    expect(propertyToSelectStringForEdit(prop({ column_name: 'u', type: T.User }))).toBe('u');
    expect(propertyToSelectStringForEdit(m2m({ extraColumns: [{ column_name: 'qty' }] })))
      .toBe('tags_m2m:issue_tags!issue_id(qty,tags!tag_id(id,display_name))');
    expect(propertyToSelectStringForEdit(m2m({ relatedTableHasColor: true })))
      .toBe('tags_m2m:issue_tags!issue_id(tags!tag_id(id,display_name,color))');
    expect(propertyToSelectStringForEdit(prop({ column_name: 'x', type: T.ManyToMany }))).toBe('x');
  });
});
