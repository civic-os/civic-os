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

import { Component, createEnvironmentInjector, EnvironmentInjector, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStore } from '@civic-os/core';
import { switchingStore } from './switching-store';

describe('switchingStore', () => {
  let injector: EnvironmentInjector;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
  });

  afterEach(() => {
    // One case destroys the injector itself; destroying twice throws.
    try { injector.destroy(); } catch { /* already destroyed */ }
  });

  it('is undefined until a store is bound', () => {
    expect(switchingStore<number>({ injector }).value()).toBeUndefined();
  });

  it('reads the bound snapshot at once and follows its changes', () => {
    const binding = switchingStore<number>({ injector });
    const store = createStore(1);
    binding.bind(store);
    expect(binding.value()).toBe(1);

    store.set(2);
    expect(binding.value()).toBe(2);
  });

  it('stops following the previous store after a rebind', () => {
    const binding = switchingStore<string>({ injector });
    const first = createStore('a');
    const second = createStore('x');
    binding.bind(first);
    binding.bind(second);
    expect(binding.value()).toBe('x');

    first.set('b');
    expect(binding.value()).toBe('x');
    second.set('y');
    expect(binding.value()).toBe('y');
  });

  it('clears the value when bound to nothing and ignores the old store', () => {
    const binding = switchingStore<number>({ injector });
    const store = createStore(1);
    binding.bind(store);
    binding.bind(undefined);
    expect(binding.value()).toBeUndefined();

    store.set(5);
    expect(binding.value()).toBeUndefined();
  });

  it('drops the subscription when the injection context is destroyed', () => {
    const binding = switchingStore<number>({ injector });
    const store = createStore(1);
    binding.bind(store);
    injector.destroy();

    store.set(9);
    expect(binding.value()).toBe(1);
  });

  it('requires an injection context unless an injector is given', () => {
    expect(() => switchingStore<number>()).toThrow();
  });

  it('works inside a component', () => {
    @Component({ template: '' })
    class Host {
      readonly binding = switchingStore<number>();
    }
    const host = TestBed.createComponent(Host).componentInstance;
    const store = createStore(3);
    host.binding.bind(store);
    store.set(4);
    expect(host.binding.value()).toBe(4);
  });
});
