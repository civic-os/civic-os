/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EntityPropertyType } from '../model/index.js';
import type { PropertyItem, StaticText } from '../model/index.js';
import type { PlanItem, RenderPlan } from '../plan/types.js';
import type { FormBackend, FormFieldSpec } from './backend.js';
import { createFormStore } from './form-store.js';
import { validateValue } from './validate.js';
import type { ValidationFailure } from './validate.js';

function property(name: string, type: EntityPropertyType, extra: Record<string, unknown> = {}): PropertyItem {
  return {
    column_name: name, table_name: 't', display_name: name, is_nullable: true, type,
    itemType: 'property', ...extra,
  } as unknown as PropertyItem;
}

const item = (p: PropertyItem): PlanItem => ({ kind: 'property', key: p.column_name, property: p, label: { text: p.display_name }, span: 1 });
const text: PlanItem = { kind: 'static_text', key: 'static_text:1', block: { id: 1 } as unknown as StaticText, span: 2 };

function plan(items: PlanItem[]): RenderPlan {
  return { mode: 'create', items, sections: [{ title: undefined, items }] };
}

/** A custom app's plain-state backend: what a fixture would write. */
function memoryBackend() {
  const specs = new Map<string, FormFieldSpec>();
  const values = new Map<string, unknown>();
  const baseline = new Map<string, unknown>();
  const touched = new Set<string>();
  const disabled = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => [...listeners].forEach(l => l());
  const backend: FormBackend = {
    register: vi.fn((fields: readonly FormFieldSpec[]) => {
      for (const f of fields) {
        specs.set(f.key, f);
        values.set(f.key, f.initial);
        baseline.set(f.key, f.initial);
      }
    }),
    getValue: key => values.get(key),
    setValue(key, value) { values.set(key, value); emit(); },
    setValues(next) { for (const key of Object.keys(next)) values.set(key, next[key]); emit(); },
    reset(next) {
      for (const [key, spec] of specs) {
        const value = next !== undefined && Object.prototype.hasOwnProperty.call(next, key) ? next[key] : spec.initial;
        values.set(key, value);
        baseline.set(key, value);
      }
      touched.clear();
      emit();
    },
    getErrors: (key): readonly ValidationFailure[] =>
      disabled.has(key) ? [] : validateValue(specs.get(key)!.rules, values.get(key)),
    isTouched: key => touched.has(key),
    markTouched(key) { touched.add(key); emit(); },
    isDirty: key => !Object.is(values.get(key), baseline.get(key)),
    isEnabled: key => !disabled.has(key),
    setEnabled(key, enabled) { if (enabled) disabled.delete(key); else disabled.add(key); emit(); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return { backend, listeners };
}

const name = property('name', EntityPropertyType.TextShort, { is_nullable: false, validation_rules: [{ type: 'minLength', value: '3', message: '' }] });
const active = property('active', EntityPropertyType.Boolean);
const note = property('note', EntityPropertyType.TextLong);

describe('createFormStore: registry', () => {
  it('registers property items in plan order, skips static text, and calls register once', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), text, item(active), item(note)]), backend);
    expect(store.fields.map(f => f.key)).toEqual(['name', 'active', 'note']);
    expect(backend.register).toHaveBeenCalledTimes(1);
    expect(store.field('active')?.property).toBe(active);
    expect(store.field('static_text:1')).toBeUndefined();
    expect(store.field('name')?.rules).toEqual([{ kind: 'required' }, { kind: 'minLength', value: 3 }]);
  });

  it('starts at the type default: false for Boolean, null otherwise', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    expect(store.field('active')?.initial).toBe(false);
    expect(store.field('name')?.initial).toBeNull();
    expect(store.getSnapshot().fields['active']?.value).toBe(false);
  });

  it('lets options.initial win for every key it holds, including explicit null and undefined', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active), item(note)]), backend, {
      initial: { name: 'Ada', active: undefined, note: null },
    });
    expect(store.field('name')?.initial).toBe('Ada');
    expect(store.field('active')?.initial).toBeUndefined(); // present as undefined: not the Boolean default
    expect(store.field('note')?.initial).toBeNull();
    const second = createFormStore(plan([item(active)]), memoryBackend().backend, { initial: {} });
    expect(second.field('active')?.initial).toBe(false);
  });

  it('reads only own keys of options.initial, never inherited ones', () => {
    const inherited = property('toString', EntityPropertyType.TextShort);
    const store = createFormStore(plan([item(inherited)]), memoryBackend().backend, { initial: {} });
    expect(store.field('toString')?.initial).toBeNull(); // not Object.prototype.toString
  });

  it('throws a RangeError naming an unknown key', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name)]), backend);
    expect(() => store.setValue('nope', 1)).toThrow(RangeError);
    expect(() => store.markTouched('nope')).toThrow(/nope/);
    expect(() => store.setEnabled('static_text:1', false)).toThrow(RangeError);
  });
});

describe('createFormStore: snapshot', () => {
  it('is reference-stable until the backend notifies, then rebuilt', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    store.setValue('name', 'Ada');
    const b = store.getSnapshot();
    expect(b).not.toBe(a);
    expect(store.getSnapshot()).toBe(b);
    expect(b.fields['name']?.value).toBe('Ada');
    // an untouched field keeps its state object
    expect(b.fields['active']).toBe(a.fields['active']);
  });

  it('keeps the same snapshot when a notification changed nothing', () => {
    const { backend, listeners } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    store.setValue('name', 'Ada');
    const a = store.getSnapshot();
    for (const l of [...listeners]) l();
    expect(store.getSnapshot()).toBe(a);
    store.setValue('name', 'Ada');
    expect(store.getSnapshot()).toBe(a);
    store.markTouched('name');
    expect(store.getSnapshot()).not.toBe(a);
  });

  it('keeps the snapshot across a notification that changed nothing while a field has errors', () => {
    // memoryBackend maps errors to new objects on every getErrors, as formGroupBackend does
    const { backend, listeners } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    const a = store.getSnapshot();
    expect(a.fields['name']?.errors).toEqual([{ kind: 'required' }]);
    expect(backend.getErrors('name')[0]).not.toBe(backend.getErrors('name')[0]);
    for (const l of [...listeners]) l();
    expect(store.getSnapshot()).toBe(a);
    store.setValue('name', 'Al');
    const b = store.getSnapshot();
    for (const l of [...listeners]) l();
    expect(store.getSnapshot()).toBe(b);
    expect(b.fields['name']?.errors).toEqual([{ kind: 'minLength', requiredLength: 3, actualLength: 2 }]);
  });

  it('treats a failure whose payload changed as a change', () => {
    let detail = 'taken';
    const { backend, listeners } = memoryBackend();
    const errors = backend.getErrors;
    backend.getErrors = key => (key === 'active' ? [{ kind: 'other', key: 'server', detail }] : errors(key));
    const store = createFormStore(plan([item(active)]), backend);
    const a = store.getSnapshot();
    for (const l of [...listeners]) l();
    expect(store.getSnapshot()).toBe(a);
    detail = 'reserved';
    for (const l of [...listeners]) l();
    expect(store.getSnapshot()).not.toBe(a);
    expect(store.getSnapshot().fields['active']?.errors).toEqual([{ kind: 'other', key: 'server', detail: 'reserved' }]);
  });

  it('aggregates valid and dirty, counting only enabled fields for validity', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    expect(store.getSnapshot().valid).toBe(false); // name is required
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.getSnapshot().fields['name']?.errors).toEqual([{ kind: 'required' }]);
    store.setValue('name', 'Ada');
    expect(store.getSnapshot().valid).toBe(true);
    expect(store.getSnapshot().dirty).toBe(true);
    store.setValue('name', 'Al');
    expect(store.getSnapshot().valid).toBe(false);
    store.setEnabled('name', false);
    expect(store.getSnapshot().valid).toBe(true);
    expect(store.getSnapshot().fields['name']?.enabled).toBe(false);
    store.markTouched('active');
    expect(store.getSnapshot().fields['active']?.touched).toBe(true);
  });
});

describe('createFormStore: setValues and reset', () => {
  it('setValues writes several values with one notification and one new snapshot', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active), item(note)]), backend);
    const before = store.getSnapshot();
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.setValues({ name: 'Ada', note: 'hi' });
    expect(seen).toHaveLength(1);
    const after = store.getSnapshot();
    expect(after.fields['name']?.value).toBe('Ada');
    expect(after.fields['note']?.value).toBe('hi');
    expect(after.fields['active']).toBe(before.fields['active']);
    expect(after.valid).toBe(true);
  });

  it('reset() restores every initial value and clears touched and dirty, with one notification', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend, { initial: { name: 'Ada' } });
    store.setValues({ name: 'Grace', active: true });
    store.markTouched('name');
    expect(store.getSnapshot().dirty).toBe(true);
    const seen = vi.fn();
    store.subscribe(seen);
    store.reset();
    expect(seen).toHaveBeenCalledTimes(1);
    const s = store.getSnapshot();
    expect(s.fields['name']).toMatchObject({ value: 'Ada', touched: false, dirty: false });
    expect(s.fields['active']).toMatchObject({ value: false, touched: false, dirty: false });
    expect(s.dirty).toBe(false);
  });

  it('reset(values) takes the given values, the initial for a key left out, and measures dirty from them', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    store.setValue('active', true);
    store.reset({ name: 'Saved' });
    expect(store.getSnapshot().fields['name']).toMatchObject({ value: 'Saved', dirty: false });
    expect(store.getSnapshot().fields['active']?.value).toBe(false);
    store.setValue('name', 'Edited');
    expect(store.getSnapshot().dirty).toBe(true);
    store.setValue('name', 'Saved');
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.field('name')?.initial).toBeNull(); // the registered value stays
  });

  it('throws a RangeError for an unknown key and writes nothing', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name)]), backend);
    const before = store.getSnapshot();
    expect(() => store.setValues({ name: 'Ada', nope: 1 })).toThrow(/nope/);
    expect(() => store.reset({ nope: 1 })).toThrow(RangeError);
    expect(store.getSnapshot()).toBe(before);
  });
});

describe('createFormStore: validate', () => {
  it('reports core failures for enabled fields and skips disabled ones', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    store.setValue('name', 'Al');
    expect(store.validate()).toEqual({
      valid: false,
      failures: { name: [{ kind: 'minLength', requiredLength: 3, actualLength: 2 }] },
    });
    store.setEnabled('name', false);
    expect(store.validate()).toEqual({ valid: true, failures: {} });
  });

  it('judges from the backend values, not the initial ones', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name)]), backend, { initial: { name: 'Ada' } });
    expect(store.validate().valid).toBe(true);
    store.setValue('name', null);
    expect(store.validate().failures['name']).toEqual([{ kind: 'required' }]);
  });
});

describe('createFormStore: subscribe', () => {
  it('notifies store subscribers on backend changes until they unsubscribe', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name)]), backend);
    const one = vi.fn();
    const two = vi.fn();
    const offOne = store.subscribe(one);
    store.subscribe(two);
    store.setValue('name', 'a');
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
    offOne();
    offOne();
    store.setValue('name', 'ab');
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(2);
  });

  it('hands subscribers a fresh snapshot, and holds exactly one backend listener however many subscribe', () => {
    const { backend, listeners } = memoryBackend();
    const store = createFormStore(plan([item(name)]), backend);
    const seen: unknown[] = [];
    const before = store.getSnapshot();
    const off1 = store.subscribe(() => seen.push(store.getSnapshot()));
    const off2 = store.subscribe(() => undefined);
    expect(listeners.size).toBe(1);
    store.setValue('name', 'x');
    expect(seen[0]).not.toBe(before);
    off1();
    off2();
    expect(listeners.size).toBe(1); // the store's own, until dispose
  });
});

describe('createFormStore: dispose', () => {
  it('unsubscribes from the backend and drops its listeners', () => {
    const { backend, listeners } = memoryBackend();
    const store = createFormStore(plan([item(name)]), backend);
    const seen = vi.fn();
    store.subscribe(seen);
    expect(listeners.size).toBe(1);
    store.dispose();
    expect(listeners.size).toBe(0);
    backend.setValue('name', 'x');
    expect(seen).not.toHaveBeenCalled();
  });

  it('makes later subscribes no-ops and leaves the last snapshot in place', () => {
    const { backend, listeners } = memoryBackend();
    const store = createFormStore(plan([item(name)]), backend);
    const last = store.getSnapshot();
    store.dispose();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    backend.setValue('name', 'x');
    off();
    expect(seen).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    expect(store.getSnapshot()).toBe(last);
  });

  it('ignores writes after dispose, and validate still reads the backend', () => {
    const { backend } = memoryBackend();
    const store = createFormStore(plan([item(name), item(active)]), backend);
    store.dispose();
    store.setValue('name', 'Ada');
    store.setValues({ name: 'Ada' });
    store.markTouched('name');
    store.setEnabled('name', false);
    store.reset({ name: 'Grace' });
    expect(backend.getValue('name')).toBeNull();
    expect(backend.isTouched('name')).toBe(false);
    expect(backend.isEnabled('name')).toBe(true);
    expect(store.validate().failures['name']).toEqual([{ kind: 'required' }]);
  });

  it('is idempotent, and does not stop a listener of another store on the same backend', () => {
    const { backend, listeners } = memoryBackend();
    const a = createFormStore(plan([item(name)]), backend);
    const b = createFormStore(plan([item(name)]), backend);
    const seenB = vi.fn();
    b.subscribe(seenB);
    a.dispose();
    a.dispose();
    expect(listeners.size).toBe(1);
    backend.setValue('name', 'x');
    expect(seenB).toHaveBeenCalledTimes(1);
  });
});
