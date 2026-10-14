/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { expectTypeOf, test } from 'vitest';
import type { CORE_CANARY } from './index.js';

test('CORE_CANARY keeps its string literal type', () => {
  expectTypeOf<typeof CORE_CANARY>().toEqualTypeOf<'civic-os-core-canary'>();
  // @ts-expect-error the literal type is not widened to string
  expectTypeOf<typeof CORE_CANARY>().toEqualTypeOf<string>();
});
