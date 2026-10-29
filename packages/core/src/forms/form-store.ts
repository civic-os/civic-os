/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDefaultValueForProperty } from '../schema/property-views.js';
import { validationRules } from '../schema/validation.js';
import type { ValidationRuleSpec } from '../schema/validation.js';
import type { PropertyItem } from '../model/index.js';
import type { RenderPlan } from '../plan/types.js';
import type { FormBackend } from './backend.js';
import { validateValue } from './validate.js';
import type { ValidationFailure } from './validate.js';

/**
 * A registered form field: one property item of the plan.
 *
 * @consumer typed createFormStore
 */
export interface FormField {
  readonly key: string;
  readonly property: PropertyItem;
  readonly initial: unknown;
  readonly rules: readonly ValidationRuleSpec[];
}

/**
 * One field's state as the backend reports it.
 *
 * @consumer typed createFormStore
 */
export interface FieldState {
  readonly value: unknown;
  readonly errors: readonly ValidationFailure[];
  readonly touched: boolean;
  readonly dirty: boolean;
  readonly enabled: boolean;
}

/**
 * The whole form's state at one moment.
 *
 * @consumer typed createFormStore
 */
export interface FormSnapshot {
  readonly fields: Readonly<Record<string, FieldState>>;
  /** Every enabled field's backend errors are empty. */
  readonly valid: boolean;
  /** Any field is dirty. */
  readonly dirty: boolean;
}

/**
 * Core's verdict over the current values.
 *
 * @consumer typed createFormStore
 */
export interface FormValidation {
  readonly valid: boolean;
  /** Only the fields that failed, by key. */
  readonly failures: Readonly<Record<string, readonly ValidationFailure[]>>;
}

/**
 * @consumer typed createFormStore
 */
export interface FormStoreOptions {
  /** Starting values by key (an edit form's record); a key absent here starts at getDefaultValueForProperty. */
  readonly initial?: Readonly<Record<string, unknown>>;
}

/**
 * A form over a render plan, with state held by a {@link FormBackend}.
 *
 * @consumer custom-app
 */
export interface FormStore {
  readonly fields: readonly FormField[];
  field(key: string): FormField | undefined;
  /** Stable between backend notifications, and across one that changed nothing (the `useSyncExternalStore` contract). */
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  setValue(key: string, value: unknown): void;
  markTouched(key: string): void;
  setEnabled(key: string, enabled: boolean): void;
  /** Core's verdict from validationRules over current values; disabled fields are skipped (as Angular does). */
  validate(): FormValidation;
}

function sameErrors(a: readonly ValidationFailure[], b: readonly ValidationFailure[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((f, i) => f === b[i]);
}

/**
 * Creates a form store for the plan's property items, in plan order (static text items are not fields),
 * and registers them with the backend exactly once. Which property types become fields (for example
 * leaving out File properties or non-inline many-to-many ones, as the Create page does) is the facade's
 * decision, made before it builds the plan it passes here; this store treats every property item as a field.
 *
 * The store subscribes to the backend for its whole life (it has no dispose): its snapshot cache must see
 * every notification to stay correct, so it lives and dies with its backend.
 *
 * @consumer custom-app
 */
export function createFormStore(plan: RenderPlan, backend: FormBackend, options: FormStoreOptions = {}): FormStore {
  const initial = options.initial;
  const fields: FormField[] = [];
  for (const item of plan.items) {
    if (item.kind !== 'property') continue;
    fields.push({
      key: item.key,
      property: item.property,
      initial: initial !== undefined && Object.prototype.hasOwnProperty.call(initial, item.key) ? initial[item.key] : getDefaultValueForProperty(item.property),
      rules: validationRules(item.property),
    });
  }
  const byKey = new Map(fields.map(f => [f.key, f] as const));
  backend.register(fields);

  const listeners = new Set<() => void>();
  let cached: FormSnapshot | null = null;
  backend.subscribe(() => {
    cached = null;
    for (const entry of [...listeners]) {
      if (listeners.has(entry)) entry();
    }
  });

  const need = (key: string): FormField => {
    const f = byKey.get(key);
    if (!f) throw new RangeError(`Form has no field "${key}"`);
    return f;
  };

  const build = (previous: FormSnapshot | null): FormSnapshot => {
    const states: Record<string, FieldState> = {};
    let valid = true;
    let dirty = false;
    let allKept = previous !== null;
    for (const f of fields) {
      const next: FieldState = {
        value: backend.getValue(f.key),
        errors: backend.getErrors(f.key),
        touched: backend.isTouched(f.key),
        dirty: backend.isDirty(f.key),
        enabled: backend.isEnabled(f.key),
      };
      const old = previous?.fields[f.key];
      // Keep the previous FieldState object when nothing about it changed, so memoized field views stay put.
      const keep =
        old !== undefined &&
        Object.is(old.value, next.value) &&
        old.touched === next.touched &&
        old.dirty === next.dirty &&
        old.enabled === next.enabled &&
        sameErrors(old.errors, next.errors);
      states[f.key] = keep ? old : next;
      if (!keep) allKept = false;
      if (next.enabled && next.errors.length > 0) valid = false;
      if (next.dirty) dirty = true;
    }
    // A notification that changed nothing (one backend change can notify more than once) keeps the snapshot itself.
    if (allKept && previous !== null && previous.valid === valid && previous.dirty === dirty) return previous;
    return { fields: states, valid, dirty };
  };

  let last: FormSnapshot | null = null;
  return {
    fields,
    field: key => byKey.get(key),
    getSnapshot() {
      if (cached === null) {
        cached = build(last);
        last = cached;
      }
      return cached;
    },
    subscribe(listener) {
      const entry = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    setValue(key, value) {
      need(key);
      backend.setValue(key, value);
    },
    markTouched(key) {
      need(key);
      backend.markTouched(key);
    },
    setEnabled(key, enabled) {
      need(key);
      backend.setEnabled(key, enabled);
    },
    validate() {
      const failures: Record<string, readonly ValidationFailure[]> = {};
      let valid = true;
      for (const f of fields) {
        if (!backend.isEnabled(f.key)) continue;
        const failed = validateValue(f.rules, backend.getValue(f.key));
        if (failed.length > 0) {
          failures[f.key] = failed;
          valid = false;
        }
      }
      return { valid, failures };
    },
  };
}
