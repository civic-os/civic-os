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

import { ValidatorFn, Validators } from '@angular/forms';
import type { ValidationRuleSpec } from '@civic-os/core';

/**
 * Maps one core validation rule onto the Angular validator it has always mapped to. Core decides which rules
 * apply and in what order (`validationRules`); this is the only place that turns a rule into an Angular
 * `ValidatorFn`, shared by `SchemaService.getFormValidatorsForProperty` and the FormGroup form backend so the
 * two can never drift apart.
 */
export function validatorForRule(rule: ValidationRuleSpec): ValidatorFn {
  switch (rule.kind) {
    case 'required': return Validators.required;
    case 'min': return Validators.min(rule.value);
    case 'max': return Validators.max(rule.value);
    case 'minLength': return Validators.minLength(rule.value);
    case 'maxLength': return Validators.maxLength(rule.value);
    case 'pattern': return Validators.pattern(rule.value);
  }
}
