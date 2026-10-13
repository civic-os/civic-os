/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';
import { CORE_CANARY } from './index.js';

describe('CORE_CANARY', () => {
  test('is exported from the package entry point', () => {
    expect(CORE_CANARY).toBe('civic-os-core-canary');
  });
});
