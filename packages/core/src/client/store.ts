/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal observable cell with the `useSyncExternalStore` contract:
 * `getSnapshot` returns the same reference until `set` stores a different
 * value, and `subscribe` returns an unsubscribe function. An Angular adapter
 * can wrap it in a signal; a React adapter can pass it straight through.
 *
 * @consumer typed SchemaClient
 */
export interface Store<T> {
  /** The current value. Stable: the same reference is returned until the value changes. */
  getSnapshot(): T;
  /** Registers a listener called after each change. Returns an idempotent unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Replaces the value. A value identical (`Object.is`) to the current one is ignored and notifies nobody. */
  set(next: T): void;
}

/**
 * Creates a {@link Store} holding `initial`. Listeners run synchronously
 * inside `set`, in subscription order; a listener added or removed during a
 * notification takes effect from the next one.
 *
 * @consumer custom-app
 */
export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      // A distinct wrapper per subscription, so subscribing the same function twice yields two independent entries.
      const entry = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const entry of [...listeners]) {
        // Skip a listener unsubscribed by an earlier one during this notification.
        if (listeners.has(entry)) entry();
      }
    },
  };
}
