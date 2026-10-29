/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PropertyItem } from '../model/index.js';
import type { ValidationRuleSpec } from '../schema/validation.js';
import type { ValidationFailure } from './validate.js';

/**
 * A field as the form store registers it with a backend.
 *
 * @consumer typed FormBackend
 */
export interface FormFieldSpec {
  readonly key: string;
  readonly property: PropertyItem;
  readonly initial: unknown;
  readonly rules: readonly ValidationRuleSpec[];
}

/**
 * Where form state lives: the facade owns form logic, the backend owns values, errors, touched, dirty and
 * enabled. Angular backs it with a FormGroup carrying today's Validators; a custom app or React may back it
 * with plain state.
 *
 * @consumer custom-app
 */
export interface FormBackend {
  /** Called once, by createFormStore. */
  register(fields: readonly FormFieldSpec[]): void;
  getValue(key: string): unknown;
  /**
   * Sets a value programmatically. Whether that marks the field dirty is the backend's own rule: a
   * FormGroup backend does not (Angular's `setValue` never does), a plain-state backend may compare
   * against the initial value. Facades must not rely on either.
   */
  setValue(key: string, value: unknown): void;
  /** The backend's current errors for a field; [] when valid or disabled. */
  getErrors(key: string): readonly ValidationFailure[];
  isTouched(key: string): boolean;
  markTouched(key: string): void;
  isDirty(key: string): boolean;
  isEnabled(key: string): boolean;
  setEnabled(key: string, enabled: boolean): void;
  /** Called after any change to values, errors, touched, dirty or enabled. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}
