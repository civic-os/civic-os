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

import { FormControl, Validators } from '@angular/forms';
import { validatorForRule } from './validators';

const run = (rule: Parameters<typeof validatorForRule>[0], value: unknown) => validatorForRule(rule)(new FormControl(value));

describe('validatorForRule', () => {
  it('maps required to Validators.required itself', () => {
    expect(validatorForRule({ kind: 'required' })).toBe(Validators.required);
    expect(run({ kind: 'required' }, 'x')).toBeNull();
    expect(run({ kind: 'required' }, '')).toEqual({ required: true });
  });

  it('maps min to Validators.min', () => {
    expect(run({ kind: 'min', value: 5 }, 5)).toBeNull();
    expect(run({ kind: 'min', value: 5 }, 4)).toEqual({ min: { min: 5, actual: 4 } });
  });

  it('maps max to Validators.max', () => {
    expect(run({ kind: 'max', value: 5 }, 5)).toBeNull();
    expect(run({ kind: 'max', value: 5 }, 6)).toEqual({ max: { max: 5, actual: 6 } });
  });

  it('maps minLength to Validators.minLength', () => {
    expect(run({ kind: 'minLength', value: 3 }, 'abc')).toBeNull();
    expect(run({ kind: 'minLength', value: 3 }, 'ab')).toEqual({ minlength: { requiredLength: 3, actualLength: 2 } });
  });

  it('maps maxLength to Validators.maxLength', () => {
    expect(run({ kind: 'maxLength', value: 3 }, 'abc')).toBeNull();
    expect(run({ kind: 'maxLength', value: 3 }, 'abcd')).toEqual({ maxlength: { requiredLength: 3, actualLength: 4 } });
  });

  it('maps pattern to Validators.pattern, wrapping a bare string in ^$', () => {
    expect(run({ kind: 'pattern', value: '[0-9]+' }, '123')).toBeNull();
    expect(run({ kind: 'pattern', value: '[0-9]+' }, '12a')).toEqual({ pattern: { requiredPattern: '^[0-9]+$', actualValue: '12a' } });
  });
});
