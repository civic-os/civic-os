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

import { FormGroup } from '@angular/forms';
import { createFormStore, EntityPropertyType, resolvePlan } from '@civic-os/core';
import type { FormFieldSpec, PropertyItem, ValidationRuleSpec } from '@civic-os/core';
import { formGroupBackend } from './form-group-backend';

function spec(key: string, initial: unknown, rules: ValidationRuleSpec[] = []): FormFieldSpec {
  const property = {
    table_name: 't', column_name: key, display_name: key, type: EntityPropertyType.TextShort,
    is_nullable: true, is_updatable: true, itemType: 'property',
  } as unknown as PropertyItem;
  return { key, property, initial, rules };
}

function registered(...fields: FormFieldSpec[]) {
  const backend = formGroupBackend();
  backend.register(fields);
  return backend;
}

describe('formGroupBackend: registration', () => {
  it('builds one control per field with its initial value, in order', () => {
    const backend = registered(spec('a', 'x'), spec('b', 7));
    expect(backend.form).toBeInstanceOf(FormGroup);
    expect(Object.keys(backend.form.controls)).toEqual(['a', 'b']);
    expect(backend.getValue('a')).toBe('x');
    expect(backend.getValue('b')).toBe(7);
  });

  it('gives each control one validator per rule', () => {
    const backend = registered(spec('a', '', [{ kind: 'required' }, { kind: 'minLength', value: 3 }]));
    expect((backend.form.get('a') as any)._rawValidators).toHaveLength(2);
  });

  it('throws when register is called twice', () => {
    const backend = registered(spec('a', ''));
    expect(() => backend.register([spec('b', '')])).toThrowError(/already/);
  });

  it('throws a RangeError naming an unknown key from every key-taking method', () => {
    const backend = registered(spec('a', ''));
    const calls: Array<() => unknown> = [
      () => backend.getValue('zz'),
      () => backend.setValue('zz', 1),
      () => backend.setValues({ zz: 1 }),
      () => backend.reset({ zz: 1 }),
      () => backend.getErrors('zz'),
      () => backend.isTouched('zz'),
      () => backend.markTouched('zz'),
      () => backend.isDirty('zz'),
      () => backend.isEnabled('zz'),
      () => backend.setEnabled('zz', true),
    ];
    for (const call of calls) {
      expect(call).toThrowError(RangeError);
      expect(call).toThrowError(/zz/);
    }
  });
});

describe('formGroupBackend: errors and state', () => {
  it('maps each Angular error kind to a core failure', () => {
    const backend = registered(
      spec('req', '', [{ kind: 'required' }]),
      spec('min', 1, [{ kind: 'min', value: 5 }]),
      spec('max', 9, [{ kind: 'max', value: 5 }]),
      spec('minl', 'a', [{ kind: 'minLength', value: 3 }]),
      spec('maxl', 'abcd', [{ kind: 'maxLength', value: 3 }]),
      spec('pat', 'x1', [{ kind: 'pattern', value: '[0-9]+' }]),
    );
    expect(backend.getErrors('req')).toEqual([{ kind: 'required' }]);
    expect(backend.getErrors('min')).toEqual([{ kind: 'min', min: 5, actual: 1 }]);
    expect(backend.getErrors('max')).toEqual([{ kind: 'max', max: 5, actual: 9 }]);
    expect(backend.getErrors('minl')).toEqual([{ kind: 'minLength', requiredLength: 3, actualLength: 1 }]);
    expect(backend.getErrors('maxl')).toEqual([{ kind: 'maxLength', requiredLength: 3, actualLength: 4 }]);
    expect(backend.getErrors('pat')).toEqual([{ kind: 'pattern', requiredPattern: '^[0-9]+$', actualValue: 'x1' }]);
  });

  it('reports a key it does not know (a server error) as other, and keeps object order', () => {
    const backend = registered(spec('a', '', [{ kind: 'required' }]));
    backend.form.get('a')!.setErrors({ server: 'taken', required: true });
    expect(backend.getErrors('a')).toEqual([{ kind: 'other', key: 'server', detail: 'taken' }, { kind: 'required' }]);
  });

  it('is empty when valid and when disabled', () => {
    const backend = registered(spec('a', '', [{ kind: 'required' }]));
    expect(backend.getErrors('a')).toHaveLength(1);
    backend.setEnabled('a', false);
    expect(backend.isEnabled('a')).toBe(false);
    expect(backend.getErrors('a')).toEqual([]);
    backend.setEnabled('a', true);
    expect(backend.isEnabled('a')).toBe(true);
    backend.setValue('a', 'ok');
    expect(backend.getErrors('a')).toEqual([]);
  });

  it('collapses duplicate rules of one kind to one failure (Angular merges by key)', () => {
    const backend = registered(spec('a', '', [{ kind: 'required' }, { kind: 'required' }]));
    expect(backend.getErrors('a')).toEqual([{ kind: 'required' }]);
  });

  it('setValue changes the value and leaves the control pristine and untouched', () => {
    const backend = registered(spec('a', 'x'));
    backend.setValue('a', 'y');
    expect(backend.getValue('a')).toBe('y');
    expect(backend.isDirty('a')).toBe(false);
    expect(backend.isTouched('a')).toBe(false);
  });

  it('markTouched and isDirty follow the control', () => {
    const backend = registered(spec('a', ''));
    backend.markTouched('a');
    expect(backend.isTouched('a')).toBe(true);
    backend.form.get('a')!.markAsDirty();
    expect(backend.isDirty('a')).toBe(true);
  });
});

describe('formGroupBackend: setValues and reset', () => {
  it('setValues writes and validates every value, leaves them pristine, and notifies once', () => {
    const backend = registered(spec('a', '', [{ kind: 'required' }]), spec('b', 'x'), spec('c', 'keep'));
    let n = 0;
    backend.subscribe(() => n++);
    backend.setValues({ a: 'filled', b: 'y' });
    expect(n).toBe(1);
    expect(backend.getValue('a')).toBe('filled');
    expect(backend.getValue('b')).toBe('y');
    expect(backend.getValue('c')).toBe('keep');
    expect(backend.getErrors('a')).toEqual([]);
    expect(backend.form.valid).toBe(true);
    expect(backend.isDirty('a')).toBe(false);
  });

  it('reset() restores the registered initial values, not null, and clears touched and dirty, notifying once', () => {
    const backend = registered(spec('a', 'one'), spec('b', 7));
    backend.setValues({ a: 'changed', b: 8 });
    backend.markTouched('a');
    backend.form.get('b')!.markAsDirty();
    let n = 0;
    backend.subscribe(() => n++);
    backend.reset();
    expect(n).toBe(1);
    expect(backend.form.getRawValue()).toEqual({ a: 'one', b: 7 });
    expect(backend.isTouched('a')).toBe(false);
    expect(backend.isDirty('b')).toBe(false);
  });

  it('reset(values) takes the given values and the initial for a key left out, and keeps disabled fields disabled', () => {
    const backend = registered(spec('a', 'one'), spec('b', 7, [{ kind: 'min', value: 5 }]));
    backend.setEnabled('b', false);
    backend.setValue('b', 1);
    backend.reset({ a: 'saved' });
    expect(backend.form.getRawValue()).toEqual({ a: 'saved', b: 7 });
    expect(backend.isEnabled('b')).toBe(false);
    backend.setEnabled('b', true);
    backend.reset({ b: 2 });
    expect(backend.getErrors('b')).toEqual([{ kind: 'min', min: 5, actual: 2 }]);
  });

  it('writes nothing when a key is unknown', () => {
    const backend = registered(spec('a', 'one'));
    expect(() => backend.setValues({ a: 'two', zz: 1 })).toThrowError(RangeError);
    expect(() => backend.reset({ a: 'two', zz: 1 })).toThrowError(RangeError);
    expect(backend.getValue('a')).toBe('one');
  });
});

describe('formGroupBackend: subscribe', () => {
  it('throws when called before register', () => {
    expect(() => formGroupBackend().subscribe(() => {})).toThrowError(/before register/);
  });

  it('notifies on a value change', () => {
    const backend = registered(spec('a', ''), spec('b', ''));
    let n = 0;
    backend.subscribe(() => n++);
    backend.setValue('b', 'x');
    expect(n).toBeGreaterThan(0);
  });

  it('notifies when a second field is touched after the first (group.events misses this)', () => {
    const backend = registered(spec('a', ''), spec('b', ''));
    backend.markTouched('a');
    let groupEvents = 0;
    backend.form.events.subscribe(() => groupEvents++);
    let n = 0;
    backend.subscribe(() => n++);
    backend.markTouched('b');
    expect(groupEvents).toBe(0);
    expect(n).toBeGreaterThan(0);
  });

  it('notifies when a second field is marked dirty after the first', () => {
    const backend = registered(spec('a', ''), spec('b', ''));
    backend.form.get('a')!.markAsDirty();
    let n = 0;
    backend.subscribe(() => n++);
    backend.form.get('b')!.markAsDirty();
    expect(n).toBeGreaterThan(0);
  });

  it('notifies on setEnabled and on setErrors', () => {
    const backend = registered(spec('a', ''));
    let n = 0;
    backend.subscribe(() => n++);
    backend.setEnabled('a', false);
    expect(n).toBeGreaterThan(0);
    n = 0;
    backend.setEnabled('a', true);
    n = 0;
    backend.form.get('a')!.setErrors({ server: 'x' });
    expect(n).toBeGreaterThan(0);
  });

  it('notifies after a group reset', () => {
    const backend = registered(spec('a', ''));
    backend.setValue('a', 'x');
    let n = 0;
    backend.subscribe(() => n++);
    backend.form.reset();
    expect(n).toBeGreaterThan(0);
  });

  it('stops notifying after unsubscribe, per listener', () => {
    const backend = registered(spec('a', ''));
    let first = 0;
    let second = 0;
    const off = backend.subscribe(() => first++);
    backend.subscribe(() => second++);
    off();
    off();
    backend.setValue('a', 'x');
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(0);
  });
});

describe('formGroupBackend: under createFormStore', () => {
  const property = (name: string, extra: Record<string, unknown> = {}) => ({
    table_name: 't', column_name: name, display_name: name, type: EntityPropertyType.TextShort,
    is_nullable: true, is_updatable: true, sort_order: 1, ...extra,
  }) as any;

  it('keeps the snapshot in step with the FormGroup', () => {
    const backend = formGroupBackend();
    const plan = resolvePlan({
      properties: [
        property('name', { is_nullable: false, validation_rules: [{ type: 'minLength', value: '3', message: '' }] }),
        property('note', { sort_order: 2 }),
      ],
      staticTexts: [],
    }, 'create');
    const store = createFormStore(plan, backend);
    expect(Object.keys(backend.form.controls)).toEqual(['name', 'note']);

    let notified = 0;
    store.subscribe(() => notified++);
    const first = store.getSnapshot();
    expect(first.valid).toBe(false);
    expect(first.fields['name'].errors.map(e => e.kind)).toEqual(['required']);

    store.setValue('name', 'ab');
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.fields['name'].errors).toEqual([{ kind: 'minLength', requiredLength: 3, actualLength: 2 }]);
    expect(second.valid).toBe(false);
    expect(second.dirty).toBe(false);

    backend.form.get('name')!.setValue('abc');
    expect(store.getSnapshot().valid).toBe(true);

    store.markTouched('note');
    expect(store.getSnapshot().fields['note'].touched).toBe(true);
    backend.form.get('note')!.markAsDirty();
    expect(store.getSnapshot().dirty).toBe(true);
    expect(notified).toBeGreaterThan(0);
  });

  it('gives one snapshot for a whole record load through setValues, and one for a reset', () => {
    const backend = formGroupBackend();
    const plan = resolvePlan({
      properties: [property('name', { is_nullable: false }), property('note', { sort_order: 2 })],
      staticTexts: [],
    }, 'edit');
    const store = createFormStore(plan, backend);
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.setValues({ name: 'Ada', note: 'hi' });
    expect(seen).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({ valid: true, dirty: false });
    store.markTouched('name');
    seen.length = 0;
    store.reset({ name: 'Ada', note: 'hi' });
    expect(seen).toHaveLength(1);
    expect(store.getSnapshot().fields['name']).toMatchObject({ value: 'Ada', touched: false });
  });

  it('gives one new snapshot per change while another field has errors, however many events it fires', () => {
    const backend = formGroupBackend();
    const plan = resolvePlan({
      properties: [property('name', { is_nullable: false }), property('note', { sort_order: 2 })],
      staticTexts: [],
    }, 'create');
    const store = createFormStore(plan, backend);
    const before = store.getSnapshot();
    expect(before.fields['name'].errors).toEqual([{ kind: 'required' }]);

    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.setValue('note', 'x');
    expect(seen.length).toBeGreaterThan(1); // control and group, value and status
    expect(new Set(seen).size).toBe(1);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.fields['name']).toBe(before.fields['name']);
  });
});
