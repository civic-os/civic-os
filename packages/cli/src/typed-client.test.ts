/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCore, repoRoot, typecheck } from './test-support/typecheck.js';

// The typed accessors against the real generated pothole snapshot.
const usage = `import type { PropertyHandle, TypedSchema } from '@civic-os/core';
import type { Database } from './pothole.js';

declare const typed: TypedSchema<Database>;

export const status: PropertyHandle = typed.entities.Issue.property('status');
export const maybe: PropertyHandle | undefined = typed.entities.Issue.optional('nope');
// @ts-expect-error not a property handle or undefined
export const notOptional: undefined = typed.entities.Issue.property('status');

// @ts-expect-error not an entity
void typed.entities.Isue;
// @ts-expect-error not a column
void typed.entities.Issue.property('nope');
`;

describe('typed accessors against tests/golden/codegen/pothole.ts', () => {
  beforeAll(() => buildCore(), 120_000);

  it.each([false, true])('exactOptionalPropertyTypes %s', exact => {
    const r = typecheck(
      { 'pothole.ts': readFileSync(join(repoRoot, 'tests', 'golden', 'codegen', 'pothole.ts'), 'utf8'), 'usage.ts': usage },
      exact,
    );
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  }, 120_000);
});
