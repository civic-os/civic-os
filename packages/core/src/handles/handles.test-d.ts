/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { expectTypeOf, test } from 'vitest';
import type { SchemaClient } from '../client/schema-client.js';
import { ActionHandle, EntityHandle, PropertyHandle } from './index.js';
import type { EntityPermissions, PropertySchemaTruth } from './index.js';

test('handles cannot be constructed', () => {
  // @ts-expect-error the constructor is private
  void new EntityHandle(Symbol('x'), {}, 'issues');
  // @ts-expect-error the constructor is private
  void new PropertyHandle(Symbol('x'), {}, 'issues', 'title');
  // @ts-expect-error the constructor is private
  void new ActionHandle(Symbol('x'), {}, 'issues', 'close');
});

test('an object literal is not a handle', () => {
  // @ts-expect-error handles are branded by their private members
  const e: EntityHandle = { name: 'issues', exists: true };
  // @ts-expect-error handles are branded by their private members
  const p: PropertyHandle = { name: 'title', exists: true };
  void e;
  void p;
});

test('presence is part of the types', () => {
  expectTypeOf<ReturnType<SchemaClient['entity']>>().toEqualTypeOf<EntityHandle | undefined>();
  expectTypeOf<ReturnType<EntityHandle['property']>>().toEqualTypeOf<PropertyHandle | undefined>();
  expectTypeOf<ReturnType<EntityHandle['action']>>().toEqualTypeOf<ActionHandle | undefined>();
  expectTypeOf<EntityHandle['can']>().toEqualTypeOf<EntityPermissions | undefined>();
  expectTypeOf<PropertyHandle['schema']>().toEqualTypeOf<PropertySchemaTruth | undefined>();
});
