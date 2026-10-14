/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { FormControl, ValidationErrors, Validators } from '@angular/forms';
import { SchemaEntityProperty, ValidationRule } from '../../interfaces/entity';
import { SchemaService } from '../../services/schema.service';

/** Rule types getFormValidatorsForProperty reads (others, e.g. fileType, are ignored by it). */
const RELEVANT = new Set(['required', 'min', 'max', 'minLength', 'maxLength', 'pattern']);

const PATTERN_PROBES = [
  '1234567890', '0123456789', '12345678901', '123456789', 'a', 'A', 'abc', '123', 'a1', 'ABC-123', '12345', '12345-6789', 'foo bar', 'xyz!',
  'test@example.com', '(555) 123-4567', '555-123-4567', '+15551234567', '#ff00aa', '2026-03-08',
];

function label(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array:${v.length}`;
  if (typeof v === 'number') return Number.isNaN(v) ? 'number:NaN' : `number:${v}`;
  if (typeof v === 'object') return 'object';
  return `${typeof v}:${JSON.stringify(v)}`;
}

/**
 * The fixed value matrix for one rule set: base values plus boundaries derived
 * from each min/max/minLength/maxLength rule and pattern probes.
 */
export function valueMatrix(rules: ValidationRule[]): unknown[] {
  const values: unknown[] = [
    null, undefined, '', ' ', '   ', '  x  ', 'abc', '0', '1', '-1', 'true',
    0, 1, -1, 0.5, 100, NaN, true, false, [], [1], {},
  ];
  for (const r of rules) {
    if (r.value === null || r.value === undefined || r.value === '') continue;
    const n = Number(r.value);
    if (r.type === 'min' || r.type === 'max') {
      if (!Number.isNaN(n)) {
        for (const d of [-1, -0.01, 0, 0.01, 1]) {
          const x = Math.round((n + d) * 1e6) / 1e6;
          values.push(x, String(x));
        }
      }
    } else if (r.type === 'minLength' || r.type === 'maxLength') {
      if (!Number.isNaN(n)) {
        for (const len of [n - 1, n, n + 1]) {
          if (len >= 0) values.push('x'.repeat(len), new Array(len).fill(1));
        }
      }
    } else if (r.type === 'pattern') {
      values.push(...PATTERN_PROBES);
    }
  }
  const seen = new Set<string>();
  return values.filter(v => {
    const k = label(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Canonical key of everything getFormValidatorsForProperty depends on. */
export function validatorSignature(prop: Pick<SchemaEntityProperty, 'is_nullable' | 'validation_rules'>): string {
  const rules = (prop.validation_rules ?? [])
    .filter(r => RELEVANT.has(r.type))
    .map(r => `${r.type}=${r.value === undefined ? '__undef__' : JSON.stringify(r.value)}`)
    .join(',');
  return `nullable=${prop.is_nullable};rules=[${rules}]`;
}

export interface Fingerprint {
  validatorCount: number;
  /** value label -> merged Angular error object (null = valid) */
  results: Record<string, ValidationErrors | null>;
}

/**
 * Run the REAL SchemaService.getFormValidatorsForProperty over the value
 * matrix. Errors are the exact objects Angular produces (keys and payloads),
 * merged the way a FormControl merges validators.
 */
export function fingerprint(prop: SchemaEntityProperty): Fingerprint {
  const validators = SchemaService.getFormValidatorsForProperty(prop);
  const composed = Validators.compose(validators);
  const results: Record<string, ValidationErrors | null> = {};
  for (const v of valueMatrix(prop.validation_rules ?? [])) {
    const control = new FormControl(v);
    results[label(v)] = composed ? composed(control) : null;
  }
  return { validatorCount: validators.length, results };
}
