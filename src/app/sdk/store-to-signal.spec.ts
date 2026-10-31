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

import { Component, computed, createEnvironmentInjector, EnvironmentInjector, Injector, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createFormStore, createStore, EntityPropertyType, resolvePlan } from '@civic-os/core';
import type { SchemaEntityProperty } from '@civic-os/core';
import { formGroupBackend } from './form-group-backend';
import type { Store } from '@civic-os/core';
import { StoreLike, storeToSignal } from './store-to-signal';

function textProperty(name: string, extra: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty {
  return {
    table_name: 't', column_name: name, display_name: name, type: EntityPropertyType.TextShort,
    is_nullable: true, is_updatable: true, sort_order: 1, ...extra,
  } as SchemaEntityProperty;
}

/** Wraps a store so the test can count live listeners. */
function counting<T>(store: Store<T>): { like: StoreLike<T>; live: () => number } {
  let live = 0;
  return {
    like: {
      getSnapshot: () => store.getSnapshot(),
      subscribe(listener) {
        live++;
        const off = store.subscribe(listener);
        let done = false;
        return () => {
          if (!done) {
            done = true;
            live--;
          }
          off();
        };
      },
    },
    live: () => live,
  };
}

describe('storeToSignal', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] }));

  it('starts at the store snapshot and follows set', () => {
    const store = createStore(1);
    const sig = TestBed.runInInjectionContext(() => storeToSignal(store));
    expect(sig()).toBe(1);
    store.set(2);
    expect(sig()).toBe(2);
  });

  it('does not notify dependents for a same-value set', () => {
    const store = createStore({ n: 1 });
    const sig = TestBed.runInInjectionContext(() => storeToSignal(store));
    let runs = 0;
    const doubled = computed(() => {
      runs++;
      return sig().n * 2;
    });
    expect(doubled()).toBe(2);
    store.set(store.getSnapshot());
    expect(doubled()).toBe(2);
    expect(runs).toBe(1);
    store.set({ n: 2 });
    expect(doubled()).toBe(4);
    expect(runs).toBe(2);
  });

  it('unsubscribes when the injector is destroyed', () => {
    const { like, live } = counting(createStore(0));
    const env = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    storeToSignal(like, { injector: env });
    expect(live()).toBe(1);
    env.destroy();
    expect(live()).toBe(0);
  });

  it('unsubscribes when a component is destroyed', () => {
    const store = createStore(0);
    const { like, live } = counting(store);
    @Component({ selector: 'app-probe', template: '{{ value() }}' })
    class Probe {
      readonly value = storeToSignal(like);
    }
    const fixture = TestBed.createComponent(Probe);
    expect(live()).toBe(1);
    fixture.destroy();
    expect(live()).toBe(0);
  });

  it('works outside a context with an explicit injector', () => {
    const store = createStore('a');
    const sig = storeToSignal(store, { injector: TestBed.inject(Injector) });
    store.set('b');
    expect(sig()).toBe('b');
  });

  it('throws outside an injection context without an injector', () => {
    expect(() => storeToSignal(createStore(0))).toThrowError(/injection context/i);
  });

  it('works over a FormStore: the signal holds the store snapshot by identity', () => {
    const backend = formGroupBackend();
    const store = createFormStore(resolvePlan({ properties: [textProperty('name', { is_nullable: false })], staticTexts: [] }, 'create'), backend);
    const sig = TestBed.runInInjectionContext(() => storeToSignal(store));
    expect(sig()).toBe(store.getSnapshot());
    expect(sig().valid).toBe(false);
    backend.form.get('name')!.setValue('abc');
    expect(sig()).toBe(store.getSnapshot());
    expect(sig().fields['name'].value).toBe('abc');
    expect(sig().valid).toBe(true);
  });
});
