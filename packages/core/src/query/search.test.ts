/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/entity.js';
import { buildHybridSearchParams, buildOrderField } from './search.js';

describe('buildHybridSearchParams', () => {
  it('returns [] for blank terms or no columns', () => {
    expect(buildHybridSearchParams('  ', 'fts', ['a'])).toEqual([]);
    expect(buildHybridSearchParams('(,)', 'fts', ['a'])).toEqual([]);
    expect(buildHybridSearchParams('x')).toEqual([]);
  });

  it('renders a single clause as a plain param', () => {
    expect(buildHybridSearchParams('Smith', 'fts')).toEqual(['fts=wfts.Smith']);
    expect(buildHybridSearchParams('Sm th', null, ['name'])).toEqual(['name=ilike.*Sm%20th*']);
  });

  it('combines several clauses in or=() and strips (),', () => {
    const substringColumns = Object.freeze(['a', 'b']) as unknown as string[];
    expect(buildHybridSearchParams('Sm(i,th)', 'fts', substringColumns)).toEqual(['or=(fts.wfts.Smith,a.ilike.*Smith*,b.ilike.*Smith*)']);
  });
});

describe('buildOrderField', () => {
  it('orders FK and User columns by the embedded display_name', () => {
    expect(buildOrderField({ column_name: 'owner_id', type: EntityPropertyType.ForeignKeyName })).toBe('owner_id(display_name)');
    expect(buildOrderField({ column_name: 'created_by', type: EntityPropertyType.User })).toBe('created_by(display_name)');
  });

  it('uses the column name otherwise', () => {
    expect(buildOrderField({ column_name: 'name', type: EntityPropertyType.TextShort })).toBe('name');
  });
});
