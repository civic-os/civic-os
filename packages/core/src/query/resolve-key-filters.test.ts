/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { SchemaEntityProperty } from '../model/entity.js';
import type { FilterCriteria } from '../model/query.js';
import { compileDataQuery } from './compile.js';
import { hasKeyFilters, KeyFilterError, resolveKeyFilters } from './resolve-key-filters.js';
import type { KeyFilterClient, KeyFilterReason } from './resolve-key-filters.js';

const STATUS_FK = { udt_name: 'int4', join_schema: 'metadata', join_table: 'statuses', join_column: 'id' };
const CATEGORY_FK = { udt_name: 'int4', join_schema: 'metadata', join_table: 'categories', join_column: 'id' };

const PROPERTIES = [
  { column_name: 'name', udt_name: 'varchar' },
  { column_name: 'status_id', status_entity_type: 'reservation', ...STATUS_FK },
  { column_name: 'workflow_status_id', status_entity_type: 'reservation_workflow', ...STATUS_FK },
  { column_name: 'tool_category', category_entity_type: 'tool_category', ...CATEGORY_FK },
  // Metadata names a type, but these are not integer FKs, so they are not Status or Category columns.
  { column_name: 'status_text', udt_name: 'varchar', status_entity_type: 'reservation' },
  { column_name: 'category_text', udt_name: 'varchar', category_entity_type: 'tool_category' },
  { column_name: 'status_no_fk', udt_name: 'int4', status_entity_type: 'reservation' },
] as SchemaEntityProperty[];

function fakeClient(overrides: Partial<KeyFilterClient> = {}) {
  const statuses: Record<string, { id: number; display_name: string; color: null; status_key: string }[]> = {
    reservation: [
      { id: 1, display_name: 'Open', color: null, status_key: 'open' },
      { id: 2, display_name: 'Closed', color: null, status_key: 'closed' },
    ],
    reservation_workflow: [
      { id: 11, display_name: 'Open', color: null, status_key: 'open' },
      { id: 12, display_name: 'Approved', color: null, status_key: 'approved' },
    ],
  };
  const categories = {
    tool_category: [{ id: 21, display_name: 'Hand', color: null, category_key: 'hand' }],
  };
  return {
    getStatuses: vi.fn(async (type: string) => statuses[type] ?? []),
    getCategories: vi.fn(async (type: string) => (type === 'tool_category' ? categories.tool_category : [])),
    invalidateStatuses: vi.fn(),
    invalidateCategories: vi.fn(),
    ...overrides,
  };
}

async function failure(filters: FilterCriteria[], client: KeyFilterClient): Promise<KeyFilterError> {
  const error = await resolveKeyFilters(filters, PROPERTIES, client).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(KeyFilterError);
  return error as KeyFilterError;
}

describe('hasKeyFilters', () => {
  it('finds status and category key columns', () => {
    expect(hasKeyFilters([{ column: 'status_id.status_key', operator: 'eq', value: 'open' }])).toBe(true);
    expect(hasKeyFilters([{ column: 'tool_category.category_key', operator: 'eq', value: 'hand' }])).toBe(true);
  });

  it('ignores plain filters, other dotted columns and a missing list', () => {
    expect(hasKeyFilters([{ column: 'status_id', operator: 'eq', value: 1 }])).toBe(false);
    expect(hasKeyFilters([{ column: 'owner_id.name', operator: 'eq', value: 'x' }])).toBe(false);
    expect(hasKeyFilters([{ column: 'a.b.status_key', operator: 'eq', value: 'x' }])).toBe(false);
    expect(hasKeyFilters(undefined)).toBe(false);
  });
});

describe('resolveKeyFilters', () => {
  it('resolves a status key to the column and id', async () => {
    await expect(
      resolveKeyFilters([{ column: 'status_id.status_key', operator: 'eq', value: 'closed' }], PROPERTIES, fakeClient()),
    ).resolves.toEqual([{ column: 'status_id', operator: 'eq', value: 2 }]);
  });

  it('resolves a category key to the column and id', async () => {
    await expect(
      resolveKeyFilters([{ column: 'tool_category.category_key', operator: 'eq', value: 'hand' }], PROPERTIES, fakeClient()),
    ).resolves.toEqual([{ column: 'tool_category', operator: 'eq', value: 21 }]);
  });

  it('resolves the same key against each column\'s own type', async () => {
    const client = fakeClient();
    await expect(
      resolveKeyFilters(
        [
          { column: 'status_id.status_key', operator: 'eq', value: 'open' },
          { column: 'workflow_status_id.status_key', operator: 'eq', value: 'open' },
        ],
        PROPERTIES,
        client,
      ),
    ).resolves.toEqual([
      { column: 'status_id', operator: 'eq', value: 1 },
      { column: 'workflow_status_id', operator: 'eq', value: 11 },
    ]);
    expect(vi.mocked(client.getStatuses).mock.calls).toEqual([['reservation'], ['reservation_workflow']]);
  });

  it.each([
    ['in', ['open', 'closed'], [1, 2], 'status_id=in.(1,2)'],
    ['not.in', ['open', 'closed'], [1, 2], 'status_id=not.in.(1,2)'],
    ['neq', 'open', 1, 'status_id=neq.1'],
    ['not.eq', 'open', 1, 'status_id=not.eq.1'],
  ])('resolves %s into the id form the query compiler sends', async (operator, value, ids, param) => {
    const [resolved] = await resolveKeyFilters(
      [{ column: 'status_id.status_key', operator, value }],
      PROPERTIES,
      fakeClient(),
    );
    expect(resolved).toEqual({ column: 'status_id', operator, value: ids });
    expect(compileDataQuery({ key: 'x', fields: [], filters: [resolved as FilterCriteria] }).params).toContain(param);
  });

  it('groups repeated resolved columns as the compiler does for id filters', async () => {
    const resolved = await resolveKeyFilters(
      [
        { column: 'status_id.status_key', operator: 'neq', value: 'open' },
        { column: 'status_id.status_key', operator: 'neq', value: 'closed' },
      ],
      PROPERTIES,
      fakeClient(),
    );
    expect(compileDataQuery({ key: 'x', fields: [], filters: resolved }).params).toContain('and=(status_id.neq.1,status_id.neq.2)');
  });

  it('passes every other filter through untouched and in order', async () => {
    const plain = { column: 'name', operator: 'ilike', value: '*a*' };
    const dotted = { column: 'owner_id.name', operator: 'eq', value: 'x' };
    const client = fakeClient();
    const resolved = await resolveKeyFilters(
      [plain, { column: 'status_id.status_key', operator: 'eq', value: 'open' }, dotted],
      PROPERTIES,
      client,
    );
    expect(resolved[0]).toBe(plain);
    expect(resolved[2]).toBe(dotted);
  });

  it('makes no lookup when no filter names a key', async () => {
    const client = fakeClient();
    await expect(resolveKeyFilters(undefined, PROPERTIES, client)).resolves.toEqual([]);
    await resolveKeyFilters([{ column: 'status_id', operator: 'eq', value: 1 }], PROPERTIES, client);
    expect(client.getStatuses).not.toHaveBeenCalled();
    expect(client.getCategories).not.toHaveBeenCalled();
  });

  it.each<[string, FilterCriteria, KeyFilterReason]>([
    ['the legacy embed name', { column: 'status.status_key', operator: 'eq', value: 'open' }, 'not_status_or_category'],
    ['a plain column', { column: 'name.status_key', operator: 'eq', value: 'open' }, 'not_status_or_category'],
    ['a text column naming a status type', { column: 'status_text.status_key', operator: 'eq', value: 'open' }, 'not_status_or_category'],
    ['a text column naming a category type', { column: 'category_text.category_key', operator: 'eq', value: 'hand' }, 'not_status_or_category'],
    ['an integer column with no FK', { column: 'status_no_fk.status_key', operator: 'eq', value: 'open' }, 'not_status_or_category'],
    ['a status key on a category column', { column: 'tool_category.status_key', operator: 'eq', value: 'x' }, 'not_status_or_category'],
    ['a category key on a status column', { column: 'status_id.category_key', operator: 'eq', value: 'x' }, 'not_status_or_category'],
    ['a range operator', { column: 'status_id.status_key', operator: 'gt', value: 'open' }, 'operator'],
    ['a pattern operator', { column: 'status_id.status_key', operator: 'ilike', value: 'open' }, 'operator'],
    ['a list for eq', { column: 'status_id.status_key', operator: 'eq', value: ['open'] }, 'invalid_value'],
    ['an id for eq', { column: 'status_id.status_key', operator: 'eq', value: 1 }, 'invalid_value'],
    ['an empty key', { column: 'status_id.status_key', operator: 'eq', value: '' }, 'invalid_value'],
    ['a key for in', { column: 'status_id.status_key', operator: 'in', value: 'open' }, 'invalid_value'],
    ['an empty list', { column: 'status_id.status_key', operator: 'in', value: [] }, 'invalid_value'],
    ['a list holding an id', { column: 'status_id.status_key', operator: 'not.in', value: ['open', 2] }, 'invalid_value'],
  ])('rejects %s without a lookup', async (_label, filter, reason) => {
    const client = fakeClient();
    const error = await failure([{ column: 'status_id.status_key', operator: 'eq', value: 'open' }, filter], client);
    expect(error.reason).toBe(reason);
    expect(error.column).toBe(filter.column);
    expect(client.getStatuses).not.toHaveBeenCalled();
    expect(client.getCategories).not.toHaveBeenCalled();
  });

  it('reports an unknown key with its type and key, and keeps the cache', async () => {
    const client = fakeClient();
    const error = await failure([{ column: 'status_id.status_key', operator: 'in', value: ['open', 'lost'] }], client);
    expect(error).toMatchObject({ reason: 'unknown_key', column: 'status_id.status_key', entityType: 'reservation', key: 'lost' });
    expect(client.invalidateStatuses).not.toHaveBeenCalled();
  });

  it('treats a category with no key from an older database as an unknown key', async () => {
    const client = fakeClient({
      getCategories: vi.fn(async () => [{ id: 21, display_name: 'Hand', color: null }]),
    });
    const error = await failure([{ column: 'tool_category.category_key', operator: 'eq', value: 'hand' }], client);
    expect(error.reason).toBe('unknown_key');
  });

  it('reports an empty status list as unavailable and invalidates that type', async () => {
    const client = fakeClient({ getStatuses: vi.fn(async () => []) });
    const error = await failure([{ column: 'status_id.status_key', operator: 'eq', value: 'open' }], client);
    expect(error).toMatchObject({ reason: 'unavailable', entityType: 'reservation' });
    expect(client.invalidateStatuses).toHaveBeenCalledExactlyOnceWith('reservation');
    expect(client.invalidateCategories).not.toHaveBeenCalled();
  });

  it('reports an empty category list as unavailable and invalidates that type', async () => {
    const client = fakeClient({ getCategories: vi.fn(async () => []) });
    const error = await failure([{ column: 'tool_category.category_key', operator: 'eq', value: 'hand' }], client);
    expect(error).toMatchObject({ reason: 'unavailable', entityType: 'tool_category' });
    expect(client.invalidateCategories).toHaveBeenCalledExactlyOnceWith('tool_category');
  });

  it('invalidates every empty type, not only the one it reports', async () => {
    const client = fakeClient({ getStatuses: vi.fn(async () => []), getCategories: vi.fn(async () => []) });
    await failure(
      [
        { column: 'status_id.status_key', operator: 'eq', value: 'open' },
        { column: 'tool_category.category_key', operator: 'eq', value: 'hand' },
      ],
      client,
    );
    expect(client.invalidateStatuses).toHaveBeenCalledExactlyOnceWith('reservation');
    expect(client.invalidateCategories).toHaveBeenCalledExactlyOnceWith('tool_category');
  });
});
