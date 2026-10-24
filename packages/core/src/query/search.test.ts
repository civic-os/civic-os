/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/entity.js';
import { QueryValidationError } from './encode.js';
import { buildHybridSearchParams, buildOrderField, buildSearchParams } from './search.js';

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

describe('buildSearchParams (Q-05)', () => {
  it('Q-05: bare wfts by default, the database default configuration', () => {
    expect(buildSearchParams('pot hole', { fulltextColumn: 'civic_os_text_search', stripReserved: false })).toEqual(['civic_os_text_search=wfts.pot%20hole']);
  });

  it('Q-05: an explicit config renders wfts(config), alone and inside or=()', () => {
    expect(buildSearchParams('a', { fulltextColumn: 'fts', textSearchConfig: 'simple' })).toEqual(['fts=wfts(simple).a']);
    expect(buildSearchParams('a', { fulltextColumn: 'fts', substringColumns: ['n'], textSearchConfig: 'simple' })).toEqual(['or=(fts.wfts(simple).a,n.ilike.*a*)']);
  });

  it('Q-05: an invalid config is rejected with QueryValidationError', () => {
    for (const bad of ['', 'English', '1abc', 'a-b', 'simple).x', 'a b', "a'b"]) {
      expect(() => buildSearchParams('a', { fulltextColumn: 'fts', textSearchConfig: bad }), bad).toThrow(QueryValidationError);
    }
  });

  it('Q-05: the display_name fallback is opt-in and only applies without search columns', () => {
    expect(buildSearchParams('smi')).toEqual([]);
    expect(buildSearchParams('smi', { displayNameFallback: true })).toEqual(['display_name=ilike.*smi*']);
    expect(buildSearchParams('smi', { fulltextColumn: 'fts', displayNameFallback: true })).toEqual(['fts=wfts.smi']);
    expect(buildSearchParams('smi', { substringColumns: ['n'], displayNameFallback: true })).toEqual(['n=ilike.*smi*']);
  });

  it('Q-05: fulltext + substring hybrid output is unchanged', () => {
    expect(buildHybridSearchParams('Smi, (x)', 'fts', ['a', 'b'])).toEqual(['or=(fts.wfts.Smi%20x,a.ilike.*Smi%20x*,b.ilike.*Smi%20x*)']);
    expect(buildSearchParams('Smi, (x)', { fulltextColumn: 'fts', substringColumns: ['a', 'b'] })).toEqual(buildHybridSearchParams('Smi, (x)', 'fts', ['a', 'b']));
  });
});
