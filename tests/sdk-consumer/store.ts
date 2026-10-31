/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// A custom app keeps its triage selection in a core store, the way a React app would feed it to
// useSyncExternalStore: subscribe + getSnapshot, with immutable updates.

import assert from 'node:assert/strict';
import { createStore } from '@civic-os/core';
import type { Store } from '@civic-os/core';

type Selection = { readonly issueIds: readonly number[] };

export async function runStore(): Promise<void> {
  const selection: Store<Selection> = createStore<Selection>({ issueIds: [] });
  const seen: Selection[] = [];
  const unsubscribe = selection.subscribe(() => seen.push(selection.getSnapshot()));

  const empty = selection.getSnapshot();
  assert.equal(selection.getSnapshot(), empty); // reference-stable between sets

  selection.set({ issueIds: [...selection.getSnapshot().issueIds, 4] });
  selection.set({ issueIds: [...selection.getSnapshot().issueIds, 9] });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(s => s.issueIds), [[4], [4, 9]]);
  assert.equal(selection.getSnapshot(), seen[1]);
  assert.equal(selection.getSnapshot(), selection.getSnapshot());

  selection.set(selection.getSnapshot()); // identical value: nobody is told
  assert.equal(seen.length, 2);

  unsubscribe();
  selection.set({ issueIds: [] });
  assert.equal(seen.length, 2);
}
