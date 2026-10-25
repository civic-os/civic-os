/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs under tsconfig.test.json and tsconfig.test-exact.json (exactOptionalPropertyTypes). The Database below
// mirrors the shape the generator emits for pothole's Issue and WorkPackage (tests/golden/codegen/pothole.ts,
// with an Actions entry added); packages/cli/src/typed-client.test.ts checks the real snapshot.

import { expectTypeOf, test } from 'vitest';
import type { ActionHandle, EntityHandle, PropertyHandle } from '../handles/handles.js';
import type { ActionKeysOf, EntityAccessor, TypedSchema } from './bootstrap.js';

type None = Record<never, never>;

interface Database {
  entities: {
    Issue: {
      Row: { id: number; display_name: string; status: number; work_package: number | null };
      Insert: { id?: number; display_name: string; status?: number; work_package?: number | null };
      Update: Partial<Database['entities']['Issue']['Insert']>;
      Embedded: None;
      Relations: None;
      Statuses: 'reported' | 'closed';
      Actions: { close_issue: { params: None } };
      Features: { notes: false };
    };
    WorkPackage: {
      Row: { id: number; display_name: string };
      Insert: { id?: number; display_name: string };
      Update: Partial<Database['entities']['WorkPackage']['Insert']>;
      Embedded: None;
      Relations: None;
      Statuses: never;
      Actions: None;
      Features: { notes: false };
    };
  };
}

declare const typed: TypedSchema<Database>;

test('non-optional accessors', () => {
  expectTypeOf(typed.entities.Issue.handle).toEqualTypeOf<EntityHandle>();
  expectTypeOf(typed.entities.Issue.property('status')).toEqualTypeOf<PropertyHandle>();
  expectTypeOf(typed.entities.Issue.action('close_issue')).toEqualTypeOf<ActionHandle>();
  expectTypeOf(typed.entities.Issue).toEqualTypeOf<EntityAccessor<Database, 'Issue'>>();
});

test('names are checked', () => {
  // @ts-expect-error not an entity of this Database
  void typed.entities.Isue;
  // @ts-expect-error not a column of Issue
  void typed.entities.Issue.property('nope');
  // @ts-expect-error a column of WorkPackage is not a column of Issue
  void typed.entities.Issue.property('nonexistent_on_issue');
  // @ts-expect-error not an action of Issue
  void typed.entities.Issue.action('open_issue');
  // @ts-expect-error WorkPackage has no actions
  void typed.entities.WorkPackage.action('close_issue');
});

test('optional takes any string and may be undefined', () => {
  expectTypeOf(typed.entities.Issue.optional('nope')).toEqualTypeOf<PropertyHandle | undefined>();
  expectTypeOf(typed.entities.Issue.optional('status')).toEqualTypeOf<PropertyHandle | undefined>();
});

test('action keys', () => {
  expectTypeOf<ActionKeysOf<Database, 'Issue'>>().toEqualTypeOf<'close_issue'>();
  expectTypeOf<ActionKeysOf<Database, 'WorkPackage'>>().toEqualTypeOf<never>();
});
