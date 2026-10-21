/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { expectTypeOf, test } from 'vitest';
import {
  EntityPropertyType,
  isProperty,
  isStaticText,
  type PropertyItem,
  type RenderableItem,
  type StaticText,
} from './index.js';

test('EntityPropertyType members are enum members', () => {
  expectTypeOf<typeof EntityPropertyType.Money>().toEqualTypeOf<EntityPropertyType.Money>();
  expectTypeOf<EntityPropertyType.Markdown>().toExtend<EntityPropertyType>();
});

test('isStaticText and isProperty narrow RenderableItem', () => {
  expectTypeOf(isStaticText).guards.toEqualTypeOf<StaticText>();
  expectTypeOf(isProperty).guards.toEqualTypeOf<PropertyItem>();
  expectTypeOf<RenderableItem>().toEqualTypeOf<PropertyItem | StaticText>();
});
