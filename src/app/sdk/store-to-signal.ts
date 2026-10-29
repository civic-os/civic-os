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

/** Anything with core's store contract: `Store<T>` and `FormStore` both fit. */
export interface StoreLike<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface StoreToSignalOptions {
  /** Where to find the `DestroyRef` when called outside an injection context. */
  readonly injector?: Injector;
}

/**
 * A read-only signal over a core store. The initial value is the store's snapshot, read synchronously; each
 * store notification re-reads the snapshot into the signal. The signal keeps its default `Object.is` equality,
 * which matches the store's own rule that an identical value notifies nobody, so dependents do not recompute
 * for a no-op `set`. The store subscription is dropped when the injection context (component, service, or the
 * `options.injector` given) is destroyed.
 *
 * Like `toSignal`, it must run in an injection context unless `options.injector` is passed.
 */
export function storeToSignal<T>(store: StoreLike<T>, options?: StoreToSignalOptions): Signal<T> {
  if (!options?.injector) assertInInjectionContext(storeToSignal);
  const destroyRef = options?.injector ? options.injector.get(DestroyRef) : inject(DestroyRef);

  const state = signal<T>(store.getSnapshot());
  const unsubscribe = store.subscribe(() => state.set(store.getSnapshot()));
  destroyRef.onDestroy(unsubscribe);
  return state.asReadonly();
}
