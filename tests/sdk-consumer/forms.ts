/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// A custom app's "report an issue" step: a form over three Issue properties, with the app's own state
// behind core's FormBackend port (plain objects and a listener set, no framework).

import assert from 'node:assert/strict';
import { checkRule, createFormStore, getPropertyType, SchemaClient, validateProperty, validateValue } from '@civic-os/core';
import type { FormBackend, FormFieldSpec, FormStore, PropertyItem, ValidationFailure } from '@civic-os/core';
import { API, fixtureTransport } from './transport.js';

/** The app's own form state: values, touched and disabled sets, and the listeners to tell. */
function plainBackend(): FormBackend {
  const specs = new Map<string, FormFieldSpec>();
  const values = new Map<string, unknown>();
  const baseline = new Map<string, unknown>();
  const touched = new Set<string>();
  const disabled = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach(l => l());
  return {
    register(fields) {
      for (const f of fields) {
        specs.set(f.key, f);
        values.set(f.key, f.initial);
        baseline.set(f.key, f.initial);
      }
    },
    getValue: key => values.get(key),
    setValue(key, value) {
      values.set(key, value);
      notify();
    },
    setValues(next) {
      for (const key of Object.keys(next)) values.set(key, next[key]);
      notify();
    },
    reset(next) {
      for (const [key, spec] of specs) {
        const value = next !== undefined && Object.hasOwn(next, key) ? next[key] : spec.initial;
        values.set(key, value);
        baseline.set(key, value);
      }
      touched.clear();
      notify();
    },
    getErrors(key): readonly ValidationFailure[] {
      return disabled.has(key) ? [] : validateValue(specs.get(key)!.rules, values.get(key));
    },
    isTouched: key => touched.has(key),
    markTouched(key) {
      touched.add(key);
      notify();
    },
    isDirty: key => !Object.is(values.get(key), baseline.get(key)),
    isEnabled: key => !disabled.has(key),
    setEnabled(key, enabled) {
      if (enabled) disabled.delete(key);
      else disabled.add(key);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export async function runForms(): Promise<void> {
  const schema = new SchemaClient({ transport: fixtureTransport(), apiUrl: API });
  const rows = (await schema.getProperties()).filter(p => p.table_name === 'Issue');
  const items: PropertyItem[] = ['description', 'severity_level', 'contact_phone'].map(name => {
    const row = rows.find(p => p.column_name === name);
    assert.ok(row, `Issue.${name} is in the fixture`);
    return { ...row, type: getPropertyType(row), itemType: 'property' };
  });
  const [description, severity, phone] = items as [PropertyItem, PropertyItem, PropertyItem];

  // The rules a custom app can check on their own, without a form.
  assert.deepEqual(validateProperty(description, 'too short'), [{ kind: 'minLength', requiredLength: 10, actualLength: 9 }]);
  assert.equal(checkRule({ kind: 'max', value: 5 }, '9.5abc')?.kind, 'max');

  const plan = {
    mode: 'create' as const,
    items: items.map(property => ({
      kind: 'property' as const,
      key: property.column_name,
      property,
      label: { text: property.display_name },
      span: 1,
    })),
    sections: [],
  };
  const backend = plainBackend();
  const store: FormStore = createFormStore(plan, backend, { initial: { severity_level: 3 } });

  // initial values: the record's value where given, the type default otherwise
  assert.deepEqual(store.fields.map(f => f.key), ['description', 'severity_level', 'contact_phone']);
  const first = store.getSnapshot();
  assert.equal(first.fields['severity_level']?.value, 3);
  assert.equal(first.fields['description']?.value, null);
  assert.equal(first.valid, true);
  assert.equal(store.getSnapshot(), first, 'a snapshot is stable between changes');

  // a value that breaks rules
  let notified = 0;
  const off = store.subscribe(() => notified++);
  store.setValue('severity_level', 9);
  store.setValue('contact_phone', '555-1234');
  assert.equal(notified, 2);
  const after = store.getSnapshot();
  assert.notEqual(after, first);
  assert.equal(after.valid, false);
  assert.equal(after.dirty, true);
  assert.deepEqual(after.fields['severity_level']?.errors, [{ kind: 'max', max: 5, actual: 9 }]);
  const verdict = store.validate();
  assert.equal(verdict.valid, false);
  assert.deepEqual(Object.keys(verdict.failures).sort(), ['contact_phone', 'severity_level']);
  assert.equal(verdict.failures['contact_phone']?.[0]?.kind, 'pattern');

  // touching and disabling
  store.markTouched('severity_level');
  assert.equal(store.getSnapshot().fields['severity_level']?.touched, true);
  store.setEnabled('severity_level', false);
  assert.deepEqual(Object.keys(store.validate().failures), ['contact_phone']);
  store.setEnabled('contact_phone', false);
  assert.deepEqual(store.validate(), { valid: true, failures: {} });
  assert.equal(store.getSnapshot().valid, true);

  // a record load, then starting over
  store.setEnabled('severity_level', true);
  store.setEnabled('contact_phone', true);
  const loads = notified;
  store.setValues({ description: 'pothole on Main Street', severity_level: 2, contact_phone: null });
  assert.equal(notified, loads + 1, 'a bulk write notifies once');
  assert.equal(store.getSnapshot().valid, true);
  store.reset();
  assert.equal(store.getSnapshot().fields['severity_level']?.value, 3);
  assert.equal(store.getSnapshot().dirty, false);

  assert.throws(() => store.setValue('no_such_field', 1), RangeError);
  assert.throws(() => store.setValues({ no_such_field: 1 }), RangeError);
  const beforeOff = notified;
  off();
  store.setValue('description', 'a long enough description');
  assert.equal(notified, beforeOff, 'an unsubscribed listener is not called');
}
