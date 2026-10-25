/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

// Design Appendix A, parameterised over `DatabaseShape`, plus the cases §8 listed as not yet tested.
// Runs under tsconfig.test.json and tsconfig.test-exact.json (exactOptionalPropertyTypes), so every
// expectation here must hold under both.

import { expectTypeOf, test } from 'vitest';
import type {
  EmbeddedOf, EntityName, ExactQuery, InsertOf, QueryResult, RelationsOf, RowOf, TypedQuery, UpdateOf,
} from './types.js';

type IssueStatusKey = 'reported' | 'triaged' | 'in_progress' | 'closed';

type None = Record<never, never>;

interface Database {
  entities: {
    Issue: {
      Row: { id: number; display_name: string; status: number; work_package: number | null; created_user: string; contact_phone: string | null; created_at: string; tags: string[] | null; notes: string };
      Insert: { display_name: string; status?: number; work_package?: number | null; created_user?: string };
      Update: Partial<{ display_name: string; status?: number; work_package?: number | null; created_user?: string }>;
      Embedded: {
        status: { id: number; display_name: string; status_key: IssueStatusKey; color: string };
        work_package: { id: number; display_name: string } | null;
        created_user: { id: string; display_name: string };
      };
      Relations: {
        status: { kind: 'one'; target: 'IssueStatus'; nullable: false };
        work_package: { kind: 'one'; target: 'WorkPackage'; nullable: true };
        tags: { kind: 'many'; target: 'Tag'; via: 'junction' }; // collides with the jsonb-ish Row column `tags`
        labels: { kind: 'many'; target: 'WorkPackageStatus'; via: 'junction' }; // an M:M target without color
        work_details: { kind: 'many'; target: 'WorkDetail' };
      };
    };
    WorkPackage: {
      Row: { id: number; display_name: string; cost: number | null; status: number | null };
      Insert: { display_name: string };
      Update: { display_name?: string };
      Embedded: { status: { id: number; display_name: string } | null };
      Relations: {
        status: { kind: 'one'; target: 'WorkPackageStatus'; nullable: true };
        bids: { kind: 'many'; target: 'Bid' };
        parent: { kind: 'one'; target: 'WorkPackage'; nullable: true };
      };
    };
    IssueStatus: { Row: { id: number; display_name: string; status_key: string; color: string }; Insert: None; Update: None; Embedded: None; Relations: None };
    WorkPackageStatus: { Row: { id: number; display_name: string }; Insert: None; Update: None; Embedded: None; Relations: None };
    Tag: { Row: { id: number; display_name: string; color: string; description: string | null; created_at: string }; Insert: None; Update: None; Embedded: None; Relations: None };
    WorkDetail: { Row: { id: number; display_name: string; issue: number; added_by: string }; Insert: None; Update: None; Embedded: { added_by: { id: string; display_name: string } }; Relations: None };
    Bid: { Row: { id: number; display_name: string; total_cost: number }; Insert: None; Update: None; Embedded: None; Relations: None };
  };
}

declare function query<E extends EntityName<Database>, const Q extends TypedQuery<Database, E>>(
  entity: E,
  q: Q & ExactQuery<Database, E, Q>,
): QueryResult<Database, E, Q>;

test('named accessors read the generated members', () => {
  expectTypeOf<RowOf<Database, 'Bid'>>().toEqualTypeOf<{ id: number; display_name: string; total_cost: number }>();
  expectTypeOf<InsertOf<Database, 'WorkPackage'>>().toEqualTypeOf<{ display_name: string }>();
  expectTypeOf<UpdateOf<Database, 'WorkPackage'>>().toEqualTypeOf<{ display_name?: string }>();
  expectTypeOf<EmbeddedOf<Database, 'WorkPackage'>['status']>().toEqualTypeOf<{ id: number; display_name: string } | null>();
  expectTypeOf<RelationsOf<Database, 'Tag'>>().toEqualTypeOf<None>();
});

test('select embeds the default shape of a plainly selected FK', () => {
  const r = query('Issue', { select: ['id', 'display_name', 'status'] });
  expectTypeOf(r).toEqualTypeOf<{ id: number; display_name: string; status: Database['entities']['Issue']['Embedded']['status'] }>();
});

test('nested with: columns, nullable one', () => {
  const r = query('Issue', { select: ['id'], with: { work_package: { columns: ['id', 'cost'], with: { status: true } } } });
  expectTypeOf(r).toEqualTypeOf<{
    id: number;
    work_package: { id: number; cost: number | null; status: { id: number; display_name: string } | null } | null;
  }>();
});

test('many relations are arrays (M:M and inverse)', () => {
  const r = query('Issue', { select: ['id'], with: { tags: true, work_details: { columns: ['id', 'display_name'], limit: 5 } } });
  expectTypeOf(r).toEqualTypeOf<{
    id: number;
    tags: Array<{ id: number; display_name: string; color: string }>;
    work_details: Array<{ id: number; display_name: string }>;
  }>();
});

test('a many-to-many default embed is id, display_name and color, not the whole target row', () => {
  // compileWith sends the property's own embed (manyToManySelect) for true and for a limit-only sub-query.
  const r = query('Issue', { select: ['id'], with: { tags: true, labels: true } });
  expectTypeOf(r).toEqualTypeOf<{
    id: number;
    tags: Array<{ id: number; display_name: string; color: string }>;
    labels: Array<{ id: number; display_name: string }>;
  }>();
  const limited = query('Issue', { select: ['id'], with: { tags: { limit: 2 } } });
  expectTypeOf(limited.tags).toEqualTypeOf<Array<{ id: number; display_name: string; color: string }>>();
  // columns pick from the whole target row
  const chosen = query('Issue', { select: ['id'], with: { tags: { columns: ['description'] } } });
  expectTypeOf(chosen.tags).toEqualTypeOf<Array<{ description: string | null }>>();
});

test('an inverse relation embedded with true is the whole target row', () => {
  const r = query('WorkPackage', { select: ['id'], with: { bids: true } });
  expectTypeOf(r).toEqualTypeOf<{ id: number; bids: Array<{ id: number; display_name: string; total_cost: number }> }>();
});

test('order is accepted on an embed', () => {
  const r = query('Issue', { select: ['id'], with: { work_details: { columns: ['id'], order: { column: 'display_name', direction: 'desc' } } } });
  expectTypeOf(r).toEqualTypeOf<{ id: number; work_details: Array<{ id: number }> }>();
});

test('no select returns the full row with default embeds', () => {
  const r = query('Issue', {});
  expectTypeOf(r).toEqualTypeOf<{
    id: number; display_name: string;
    status: { id: number; display_name: string; status_key: IssueStatusKey; color: string };
    work_package: { id: number; display_name: string } | null;
    created_user: { id: string; display_name: string };
    contact_phone: string | null; created_at: string; tags: string[] | null; notes: string;
  }>();
});

test('with wins over a same-named FK in select', () => {
  const r = query('Issue', { select: ['id', 'work_package'], with: { work_package: { columns: ['id'] } } });
  expectTypeOf(r).toEqualTypeOf<{ id: number; work_package: { id: number } | null }>();
});

test('a 5-level nesting resolves', () => {
  const r = query('Issue', {
    select: ['id'],
    with: { work_package: { columns: ['id'], with: { parent: { columns: ['id'], with: { parent: { columns: ['id'], with: { parent: { columns: ['id', 'cost'], with: { parent: { columns: ['id', 'display_name'], with: { bids: true } } } } } } } } } } },
  });
  type P5 = { id: number; display_name: string; bids: Array<{ id: number; display_name: string; total_cost: number }> } | null;
  type P4 = { id: number; cost: number | null; parent: P5 } | null;
  type P3 = { id: number; parent: P4 } | null;
  type P2 = { id: number; parent: P3 } | null;
  type P1 = { id: number; parent: P2 } | null;
  expectTypeOf(r).toEqualTypeOf<{ id: number; work_package: P1 }>();
});

test('negatives', () => {
  // @ts-expect-error unknown relation
  query('Issue', { with: { bogus: true } });
  // @ts-expect-error unknown nested column
  query('Issue', { with: { work_package: { columns: ['nope'] } } });
  // @ts-expect-error unknown top-level select column
  query('Issue', { select: ['nope'] });
  // @ts-expect-error `with` on a relation absent from the nested target (Tag has none)
  query('Issue', { with: { tags: { with: { anything: true } } } });
  // @ts-expect-error bogus mixed with a valid relation (needs ExactQuery)
  query('Issue', { with: { tags: true, bogus: true } });
  // @ts-expect-error bogus mixed with valid keys inside a nested sub-query
  query('Issue', { with: { work_package: { columns: ['id'], bogus: 1 } } });
  // @ts-expect-error unknown top-level query key
  query('Issue', { selct: ['id'] });
  // @ts-expect-error unknown entity
  query('Nope', {});
  // @ts-expect-error order column must be a Row column of the target
  query('Issue', { with: { work_details: { order: { column: 'nope', direction: 'asc' } } } });
  // @ts-expect-error direction is asc or desc
  query('Issue', { with: { work_details: { order: { column: 'id', direction: 'up' } } } });
  // @ts-expect-error limit is a number
  query('Issue', { with: { work_details: { limit: '5' } } });
  // @ts-expect-error a relation takes true or options, not false
  query('Issue', { with: { tags: false } });
});

test('an unselected property is not on the result', () => {
  const r = query('Issue', { select: ['id'] });
  // @ts-expect-error not selected
  void r.display_name;
});

test('a relation that was not requested is not on the result', () => {
  const r = query('Issue', { select: ['id'] });
  // @ts-expect-error tags was not requested
  void r.tags;
});

test('with: { x: undefined } is rejected under both optional-property settings', () => {
  // @ts-expect-error an undefined relation value would read as present in the result type
  query('Issue', { with: { tags: undefined } });
  // @ts-expect-error nested undefined too
  query('Issue', { with: { work_package: { with: { status: undefined } } } });
  // @ts-expect-error select: undefined is not a select
  query('Issue', { select: undefined });
  // @ts-expect-error nested columns: undefined
  query('Issue', { with: { work_package: { columns: undefined } } });
  // @ts-expect-error nested limit: undefined
  query('Issue', { with: { work_package: { limit: undefined } } });
});

test('a with key that is only a Row column, not a relation, is rejected', () => {
  // @ts-expect-error `notes` is a column, not a relation
  query('Issue', { with: { notes: true } });
  // @ts-expect-error `display_name` is a column, not a relation
  query('Issue', { with: { display_name: true } });
});

test('a relation key that collides with a Row column: with wins, in both select and default row', () => {
  // `tags` is both a Row column (string[] | null) and an M:M relation.
  const sel = query('Issue', { select: ['id', 'tags'], with: { tags: true } });
  expectTypeOf(sel).toEqualTypeOf<{ id: number; tags: Array<{ id: number; display_name: string; color: string }> }>();

  const full = query('Issue', { with: { tags: { columns: ['id'] } } });
  expectTypeOf(full.tags).toEqualTypeOf<Array<{ id: number }>>();
  expectTypeOf(full.notes).toEqualTypeOf<string>();

  // Without the with, `tags` is the plain column.
  const plain = query('Issue', { select: ['id', 'tags'] });
  expectTypeOf(plain).toEqualTypeOf<{ id: number; tags: string[] | null }>();
});

test('a collision on a non-FK, non-embedded column keeps the other columns intact', () => {
  const r = query('Issue', { select: ['id', 'notes', 'tags'], with: { tags: { columns: ['display_name'], limit: 1 } } });
  expectTypeOf(r).toEqualTypeOf<{ id: number; notes: string; tags: Array<{ display_name: string }> }>();
});

test('selecting a relation-named FK without with keeps its default embed', () => {
  const r = query('Issue', { select: ['status', 'work_package'] });
  expectTypeOf(r).toEqualTypeOf<{
    status: { id: number; display_name: string; status_key: IssueStatusKey; color: string };
    work_package: { id: number; display_name: string } | null;
  }>();
});
