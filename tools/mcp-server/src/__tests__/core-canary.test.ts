/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'vitest';
import { CORE_CANARY } from '@civic-os/core';
import { CORE_CANARY as SERVER_CORE_CANARY } from '../index.js';

// SDK P1.0 resolution canary; removed with CORE_CANARY in P1.1a.
describe('@civic-os/core resolution', () => {
  it('resolves the core package from MCP tests and from the server entry module', () => {
    expect(CORE_CANARY).toBe('civic-os-core-canary');
    expect(SERVER_CORE_CANARY).toBe(CORE_CANARY);
  });
});
