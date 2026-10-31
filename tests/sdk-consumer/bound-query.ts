/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// The generated `defineQuery` binds the instance's Database, so a custom app names only the entity.
// The @ts-expect-error lines are the gate: `tsc -p tests/sdk-consumer` (both tsconfigs) fails if any
// of them compiles. They sit in a function that is never called, so none of them runs.

import assert from 'node:assert/strict';
import type { QueryResult } from '@civic-os/core';
import { defineQuery } from '../golden/codegen/pothole.js';
import type { Database } from '../golden/codegen/pothole.js';

function wrongQueries(): void {
  // @ts-expect-error 'Nope' is not an entity of the generated Database
  defineQuery<'Nope'>();
  // @ts-expect-error 'no_such_column' is not a column of Issue
  defineQuery<'Issue'>()({ select: ['no_such_column'] });
  // @ts-expect-error 'no_such_relation' is not a relation of Issue
  defineQuery<'Issue'>()({ select: ['id'], with: { no_such_relation: true } });
}
void wrongQueries;

export async function runBoundQuery(): Promise<void> {
  const recent = defineQuery<'Issue'>()({
    select: ['id', 'status'],
    with: { work_package: { columns: ['display_name'] } },
  });
  type Recent = QueryResult<Database, 'Issue', typeof recent>;
  const sample: Recent = {
    id: 1,
    status: { id: 1, display_name: 'New', color: null, status_key: 'new' },
    work_package: null,
  };
  assert.equal(sample.status.status_key, 'new'); // literal status keys survive the bound form
  assert.deepEqual(recent.select, ['id', 'status']);
}
