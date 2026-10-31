/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { assertInInjectionContext, DestroyRef, inject, Injector, signal, Signal } from '@angular/core';
import type { StoreLike } from './store-to-signal';

/** A signal over whichever core store is bound now; see {@link switchingStore}. */
export interface SwitchingStore<T> {
  /** The bound store's snapshot, or `undefined` while none is bound. */
  readonly value: Signal<T | undefined>;
  /** Drops the previous store's subscription and follows `store` (or nothing). Does not dispose the store. */
  bind(store: StoreLike<T> | undefined): void;
}

export interface SwitchingStoreOptions {
  /** Where to find the `DestroyRef` when called outside an injection context. */
  readonly injector?: Injector;
}

/**
 * Like `storeToSignal`, for a page whose store changes over its life (a record facade is made per entity).
 * Binding reads the new store's snapshot at once and re-reads it on each notification; the subscription is
 * dropped on every rebind and when the injection context is destroyed.
 */
export function switchingStore<T>(options?: SwitchingStoreOptions): SwitchingStore<T> {
  if (!options?.injector) assertInInjectionContext(switchingStore);
  const destroyRef = options?.injector ? options.injector.get(DestroyRef) : inject(DestroyRef);

  const state = signal<T | undefined>(undefined);
  let unsubscribe: (() => void) | undefined;
  const release = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
  };
  destroyRef.onDestroy(release);

  return {
    value: state.asReadonly(),
    bind(store) {
      release();
      if (!store) {
        state.set(undefined);
        return;
      }
      state.set(store.getSnapshot());
      unsubscribe = store.subscribe(() => state.set(store.getSnapshot()));
    },
  };
}
