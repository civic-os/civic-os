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

import { AbstractControl, FormControl, FormGroup, ValidationErrors } from '@angular/forms';
import { merge } from 'rxjs';
import type { FormBackend, FormFieldSpec, ValidationFailure } from '@civic-os/core';
import { validatorForRule } from './validators';

/** A FormBackend whose state is an Angular FormGroup, for templates that bind `formControlName`. */
export interface FormGroupBackend extends FormBackend {
  readonly form: FormGroup;
}

/** Maps one Angular error key and payload onto core's failure shape; unknown keys become `other`. */
function toFailure(key: string, detail: any): ValidationFailure {
  switch (key) {
    case 'required': return { kind: 'required' };
    case 'min': return { kind: 'min', min: detail.min, actual: detail.actual };
    case 'max': return { kind: 'max', max: detail.max, actual: detail.actual };
    case 'minlength': return { kind: 'minLength', requiredLength: detail.requiredLength, actualLength: detail.actualLength };
    case 'maxlength': return { kind: 'maxLength', requiredLength: detail.requiredLength, actualLength: detail.actualLength };
    case 'pattern': return { kind: 'pattern', requiredPattern: detail.requiredPattern, actualValue: detail.actualValue };
    default: return { kind: 'other', key, detail };
  }
}

/**
 * Creates a form backend over a new FormGroup. `createFormStore` registers the fields: each becomes a
 * `FormControl` holding the field's initial value and the validators `validatorForRule` gives the field's
 * rules, in rule order, which are the validators `SchemaService.getFormValidatorsForProperty` builds. The
 * group is exposed as `form` for `[formGroup]` / `formControlName` binding.
 *
 * Behavior worth knowing:
 * - `setValue` is programmatic and, like Angular's `setValue`, does not mark the control dirty or touched.
 *   User input through `formControlName` marks dirty as it always has.
 * - `getErrors` reports what the control holds, mapped to core's failure shapes. Angular merges errors by
 *   key, so two rules of one kind give one failure here, where core's `validateValue` keeps both. An error
 *   set with `setErrors` (for example from the server) comes back as `{ kind: 'other', key, detail }`.
 * - A disabled control reports no errors.
 * - `subscribe` notifies on any change of any field's value, status, errors, touched, pristine or enabled
 *   state, and after a group reset.
 */
export function formGroupBackend(): FormGroupBackend {
  const form = new FormGroup<Record<string, AbstractControl>>({});
  let registered = false;

  const need = (key: string): AbstractControl => {
    const control = form.get(key);
    if (!control) throw new RangeError(`Form has no control "${key}"`);
    return control;
  };

  return {
    form,
    register(fields: readonly FormFieldSpec[]) {
      if (registered) throw new Error('formGroupBackend: register was already called');
      registered = true;
      for (const spec of fields) {
        form.addControl(spec.key, new FormControl(spec.initial, spec.rules.map(validatorForRule)));
      }
    },
    getValue: key => need(key).value,
    setValue(key, value) {
      need(key).setValue(value);
    },
    getErrors(key) {
      const control = need(key);
      if (control.disabled) return [];
      const errors: ValidationErrors | null = control.errors;
      if (!errors) return [];
      return Object.keys(errors).map(k => toFailure(k, errors[k]));
    },
    isTouched: key => need(key).touched,
    markTouched(key) {
      need(key).markAsTouched();
    },
    isDirty: key => need(key).dirty,
    isEnabled: key => need(key).enabled,
    setEnabled(key, enabled) {
      const control = need(key);
      if (enabled) control.enable();
      else control.disable();
    },
    subscribe(listener) {
      if (!registered) throw new Error('formGroupBackend: subscribe called before register');
      // A group's own `events` fire only when the group's flag flips: once one field is touched, a second
      // field's blur never reaches `group.events`. Each control's own events do fire for its own changes, so
      // merge every control's with the group's (which carries a reset).
      const sources = [form.events, ...Object.values(form.controls).map(c => c.events)];
      const subscription = merge(...sources).subscribe(() => listener());
      return () => subscription.unsubscribe();
    },
  };
}
