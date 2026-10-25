/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { interpretNameMatches, matchName, normalizeNameKey } from './match.js';
import { exactCaseInsensitivePattern, resolveNameToId } from './resolve.js';

describe('normalizeNameKey (N-03)', () => {
  it('trims and lowercases', () => {
    expect(normalizeNameKey('  Website Redesign ')).toBe('website redesign');
    expect(normalizeNameKey(42)).toBe('42');
    expect(normalizeNameKey(null)).toBe('');
  });
});

describe('interpretNameMatches (N-06)', () => {
  it('is none, found or ambiguous with every candidate listed', () => {
    expect(interpretNameMatches([])).toEqual({ kind: 'none' });
    expect(interpretNameMatches([{ id: 7, name: 'A' }])).toEqual({ kind: 'found', id: 7 });
    expect(interpretNameMatches([{ id: 7, name: 'A' }, { id: 9, name: 'A' }])).toEqual({
      kind: 'ambiguous',
      candidates: [{ id: 7, name: 'A' }, { id: 9, name: 'A' }],
    });
  });
});

describe('matchName (N-02, N-03, N-06)', () => {
  const statuses = [
    { id: 1, name: 'Open', key: 'open' },
    { id: 2, name: 'Closed', key: 'done' },
    { id: 3, name: 'done', key: 'archived' },
  ];

  it('matches the key before the display name', () => {
    expect(matchName('done', statuses)).toEqual({ kind: 'found', id: 2 });
  });

  it('falls back to the display name, trimmed and case-insensitive', () => {
    expect(matchName('  CLOSED ', statuses)).toEqual({ kind: 'found', id: 2 });
  });

  it('reports duplicate display names as ambiguous', () => {
    const dup = [{ id: 1, name: 'Same' }, { id: 2, name: 'same' }];
    expect(matchName('SAME', dup)).toEqual({
      kind: 'ambiguous',
      candidates: [{ id: 1, name: 'Same' }, { id: 2, name: 'same' }],
    });
  });

  it('matches nothing for a blank or unknown name', () => {
    expect(matchName('  ', statuses)).toEqual({ kind: 'none' });
    expect(matchName('nope', statuses)).toEqual({ kind: 'none' });
  });
});

describe('exactCaseInsensitivePattern', () => {
  it('escapes every regex metacharacter', () => {
    expect(exactCaseInsensitivePattern('a.b*c(1)')).toBe('^a\\.b\\*c\\(1\\)$');
  });

  it('escapes the full metacharacter set, including brackets, braces, pipe and backslash', () => {
    expect(exactCaseInsensitivePattern('a.b(c)[d]{e}|f+g?h^i$j\\k*'))
      .toBe('^a\\.b\\(c\\)\\[d\\]\\{e\\}\\|f\\+g\\?h\\^i\\$j\\\\k\\*$');
  });
});

describe('resolveNameToId', () => {
  const source = (...pages: unknown[][]) => {
    const getData = vi.fn();
    for (const page of pages) getData.mockResolvedValueOnce(page);
    return { getData } as unknown as Parameters<typeof resolveNameToId>[0] & { getData: ReturnType<typeof vi.fn> };
  };

  it('finds an exact match with one request, trimming the name (N-03)', async () => {
    const data = source([{ id: 5, display_name: 'Acme' }]);
    expect(await resolveNameToId(data, 'clients', '  Acme ')).toEqual({ kind: 'found', id: 5 });
    expect(data.getData).toHaveBeenCalledTimes(1);
    expect(data.getData.mock.calls[0][0]).toMatchObject({
      key: 'clients',
      filters: [{ column: 'display_name', operator: 'eq', value: 'Acme' }],
      limit: 5,
    });
  });

  it('retries with an anchored imatch when nothing matches exactly', async () => {
    const data = source([], [{ id: 8, display_name: 'ACME' }]);
    expect(await resolveNameToId(data, 'clients', 'a.me')).toEqual({ kind: 'found', id: 8 });
    expect(data.getData.mock.calls[1][0].filters).toEqual([{ column: 'display_name', operator: 'imatch', value: '^a\\.me$' }]);
  });

  it('reports duplicates at either stage with every candidate (N-06)', async () => {
    const exact = source([{ id: 1, display_name: 'A' }, { id: 2, display_name: 'A' }]);
    expect(await resolveNameToId(exact, 't', 'A')).toEqual({
      kind: 'ambiguous',
      stage: 'exact',
      candidates: [{ id: 1, name: 'A' }, { id: 2, name: 'A' }],
    });
    const insensitive = source([], [{ id: 1, display_name: 'a' }, { id: 2, display_name: 'A' }]);
    expect(await resolveNameToId(insensitive, 't', 'a ')).toMatchObject({ kind: 'ambiguous', stage: 'caseInsensitive' });
  });

  it('matches nothing for a blank name without a request (Q-08)', async () => {
    const data = source();
    expect(await resolveNameToId(data, 't', '   ')).toEqual({ kind: 'none' });
    expect(data.getData).not.toHaveBeenCalled();
  });

  it('is none when both stages find nothing', async () => {
    expect(await resolveNameToId(source([], []), 't', 'x')).toEqual({ kind: 'none' });
  });
});
