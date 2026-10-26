/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ActionParamType, SchemaEntityProperty } from '@civic-os/core';

/** A TypeScript type as text, without `null`; nullability travels next to it. */
type Ts = 'string' | 'number' | 'boolean' | 'unknown';

/**
 * PostgreSQL type (`udt_name`, which for a domain column is the domain's name) to TypeScript. The single
 * mapping table; anything not listed falls through to {@link DATA_TYPES} and then `unknown`.
 */
const UDT_TYPES: Readonly<Record<string, Ts>> = {
  int2: 'number', int4: 'number', int8: 'number', float4: 'number', float8: 'number', numeric: 'number', oid: 'number',
  bool: 'boolean',
  text: 'string', varchar: 'string', bpchar: 'string', char: 'string', name: 'string', citext: 'string', uuid: 'string',
  date: 'string', time: 'string', timetz: 'string', timestamp: 'string', timestamptz: 'string', interval: 'string',
  json: 'unknown', jsonb: 'unknown',
  // Civic OS domains and range types, as PostgREST serialises them
  money: 'number', hex_color: 'string', email_address: 'string', phone_number: 'string', markdown: 'string',
  time_slot: 'string',
  // GeoPoint and GeoPolygon: the default select returns the `<column>_text` WKT string aliased to the column
  geography: 'string',
};

/** information_schema `data_type`, which for a domain column names the base type: covers integrator domains. */
const DATA_TYPES: Readonly<Record<string, Ts>> = {
  smallint: 'number', integer: 'number', bigint: 'number', numeric: 'number', real: 'number', 'double precision': 'number',
  boolean: 'boolean',
  text: 'string', 'character varying': 'string', character: 'string', uuid: 'string', date: 'string',
  'timestamp without time zone': 'string', 'timestamp with time zone': 'string', 'time without time zone': 'string',
  json: 'unknown', jsonb: 'unknown',
};

/**
 * The TypeScript type of a stored column, without `null`. `unknown` is the fallback; there is no `any`.
 *
 * @consumer tooling
 */
export function columnType(prop: Pick<SchemaEntityProperty, 'udt_name' | 'data_type'>): string {
  const udt = prop.udt_name;
  if (udt.startsWith('_')) {
    const element = UDT_TYPES[udt.slice(1)];
    return element && element !== 'unknown' ? `${element}[]` : 'unknown[]';
  }
  return UDT_TYPES[udt] ?? DATA_TYPES[prop.data_type] ?? 'unknown';
}

/**
 * The TypeScript type of an entity action parameter. A `foreign_key` parameter takes the id type of its
 * `join_table`, resolved by the caller (`idType`).
 *
 * @consumer tooling
 */
export function actionParamType(type: ActionParamType, idType: string | undefined): string {
  switch (type) {
    case 'number':
    case 'money':
    case 'status':
    case 'category':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'foreign_key':
      return idType ?? 'unknown';
    case 'text':
    case 'text_short':
    case 'date':
    case 'datetime':
    case 'datetime_local':
    case 'color':
    case 'email':
    case 'telephone':
    case 'user':
    case 'file':
    case 'geo_point':
    case 'time_slot':
    case 'photo_gallery':
      return 'string';
    default:
      return 'unknown';
  }
}
