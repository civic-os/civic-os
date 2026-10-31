/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createStore } from './store.js';

describe('createStore', () => {
  it('returns the initial value and a stable snapshot reference until set', () => {
    const initial = { n: 1 };
    const store = createStore(initial);
    expect(store.getSnapshot()).toBe(initial);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    const next = { n: 2 };
    store.set(next);
    expect(store.getSnapshot()).toBe(next);
    expect(store.getSnapshot()).toBe(next);
  });

  it('notifies subscribers after a change, with the new snapshot readable', () => {
    const store = createStore<number>(0);
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.set(1);
    store.set(2);
    expect(seen).toEqual([1, 2]);
  });

  it('ignores a set of the identical value and does not notify', () => {
    const value = { n: 1 };
    const store = createStore(value);
    let calls = 0;
    store.subscribe(() => calls++);
    store.set(value);
    expect(calls).toBe(0);
    store.set({ n: 1 });
    expect(calls).toBe(1);
  });

  it('treats NaN as identical to NaN and undefined as a real value', () => {
    const store = createStore<number | undefined>(undefined);
    let calls = 0;
    store.subscribe(() => calls++);
    store.set(undefined);
    expect(calls).toBe(0);
    store.set(Number.NaN);
    store.set(Number.NaN);
    expect(calls).toBe(1);
    store.set(undefined);
    expect(calls).toBe(2);
  });

  it('stops notifying after unsubscribe, and unsubscribe is idempotent', () => {
    const store = createStore(0);
    let a = 0;
    let b = 0;
    const offA = store.subscribe(() => a++);
    store.subscribe(() => b++);
    store.set(1);
    offA();
    offA();
    store.set(2);
    expect([a, b]).toEqual([1, 2]);
  });

  it('keeps two subscriptions of the same function independent', () => {
    const store = createStore(0);
    let calls = 0;
    const listener = () => calls++;
    const off1 = store.subscribe(listener);
    store.subscribe(listener);
    store.set(1);
    expect(calls).toBe(2);
    off1();
    store.set(2);
    expect(calls).toBe(3);
  });

  it('does not call a listener that an earlier listener unsubscribed during the same notification', () => {
    const store = createStore(0);
    const calls: string[] = [];
    let offSecond: () => void = () => undefined;
    store.subscribe(() => {
      calls.push('first');
      offSecond();
    });
    offSecond = store.subscribe(() => calls.push('second'));
    store.set(1);
    expect(calls).toEqual(['first']);
  });

  it('defers a listener added during a notification to the next change', () => {
    const store = createStore(0);
    const calls: string[] = [];
    let added = false;
    store.subscribe(() => {
      calls.push('first');
      if (!added) {
        added = true;
        store.subscribe(() => calls.push('late'));
      }
    });
    store.set(1);
    expect(calls).toEqual(['first']);
    store.set(2);
    expect(calls).toEqual(['first', 'first', 'late']);
  });

  it('keeps the same snapshot reference after a notification and after a no-op set', () => {
    const store = createStore({ n: 1 });
    const seen: object[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    const next = { n: 2 };
    store.set(next);
    expect(Object.is(store.getSnapshot(), seen[0])).toBe(true);
    expect(Object.is(store.getSnapshot(), store.getSnapshot())).toBe(true);
    store.set(next);
    expect(seen).toHaveLength(1);
    expect(Object.is(store.getSnapshot(), next)).toBe(true);
  });

  it('runs a listener only after the value changed', () => {
    const store = createStore(0);
    const during: number[] = [];
    store.subscribe(() => during.push(store.getSnapshot()));
    store.set(0);
    expect(during).toEqual([]);
    store.set(3);
    expect(during).toEqual([3]);
  });
});
