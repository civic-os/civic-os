/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { buildHybridSearchParams } from './search.utils';

describe('buildHybridSearchParams', () => {
  it('combines fulltext and substring columns via or=()', () => {
    expect(buildHybridSearchParams('Smi', 'civic_os_text_search', ['display_name'])).toEqual([
      'or=(civic_os_text_search.wfts.Smi,display_name.ilike.*Smi*)'
    ]);
  });

  it('supports multiple substring columns', () => {
    expect(buildHybridSearchParams('Smi', 'civic_os_text_search', ['display_name', 'email'])).toEqual([
      'or=(civic_os_text_search.wfts.Smi,display_name.ilike.*Smi*,email.ilike.*Smi*)'
    ]);
  });

  it('renders a single fulltext column as a plain query param', () => {
    expect(buildHybridSearchParams('pothole', 'civic_os_text_search', [])).toEqual([
      'civic_os_text_search=wfts.pothole'
    ]);
  });

  it('renders a single substring column as a plain query param', () => {
    expect(buildHybridSearchParams('Smi', null, ['display_name'])).toEqual([
      'display_name=ilike.*Smi*'
    ]);
  });

  it('returns empty for a blank term', () => {
    expect(buildHybridSearchParams('   ', 'civic_os_text_search', ['display_name'])).toEqual([]);
  });

  it('returns empty when no columns are configured', () => {
    expect(buildHybridSearchParams('term', null, [])).toEqual([]);
  });

  it('strips PostgREST-reserved characters and encodes the term', () => {
    expect(buildHybridSearchParams('a(b),c d', 'fts_col', ['name'])).toEqual([
      'or=(fts_col.wfts.abc%20d,name.ilike.*abc%20d*)'
    ]);
  });
});
