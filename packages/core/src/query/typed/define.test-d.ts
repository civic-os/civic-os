/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { expectTypeOf, test } from 'vitest';
import { defineQuery } from './define.js';
import type { EntityName, ExactQuery, QueryResult, TypedQuery } from './types.js';

type None = Record<never, never>;

interface Database {
  entities: {
    Issue: {
      Row: { id: number; display_name: string };
      Insert: None;
      Update: None;
      Embedded: None;
      Relations: { tags: { kind: 'many'; target: 'Tag' } };
    };
    Tag: { Row: { id: number; color: string }; Insert: None; Update: None; Embedded: None; Relations: None };
  };
}

declare function query<E extends EntityName<Database>, const Q extends TypedQuery<Database, E>>(
  entity: E,
  q: Q & ExactQuery<Database, E, Q>,
): QueryResult<Database, E, Q>;

test('a hoisted query keeps its literal type, so as const is not needed', () => {
  const q = defineQuery<Database, 'Issue'>()({ select: ['id'], with: { tags: true } });
  expectTypeOf(query('Issue', q)).toEqualTypeOf<{ id: number; tags: Array<{ id: number; color: string }> }>();
});

test('the allowlist rejects what the inline form rejects', () => {
  // @ts-expect-error unknown relation
  defineQuery<Database, 'Issue'>()({ with: { bogus: true } });
  // @ts-expect-error unknown column
  defineQuery<Database, 'Issue'>()({ select: ['nope'] });
  // @ts-expect-error bogus mixed with a valid relation
  defineQuery<Database, 'Issue'>()({ with: { tags: true, bogus: true } });
  // @ts-expect-error unknown entity
  defineQuery<Database, 'Nope'>();
});
