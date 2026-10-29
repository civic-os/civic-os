/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Parity gate for core's validation-as-data (packages/core/src/forms/validate.ts): for every golden
 * variant, every distinct validator signature and every value of its value matrix, core's
 * validateProperty must reach the same verdict, with the same payloads, as the REAL
 * SchemaService.getFormValidatorsForProperty run through Angular's Validators.compose (fingerprint()).
 * Nothing here reimplements an Angular validator.
 */
import { ValidationErrors } from '@angular/forms';
import { validateProperty, validationRules, ValidationFailure } from '@civic-os/core';
import { loadSchema } from './schema-harness';
import { listGoldenVariants } from './synthetic-fixtures';
import { fingerprint, label, validatorSignature, valueMatrix } from './validator-fingerprint';

/** The error object Angular's FormControl would hold for core's failures: later keys win, null when empty. */
function toAngularErrors(failures: ValidationFailure[]): ValidationErrors | null {
  let res: ValidationErrors = {};
  for (const f of failures) {
    switch (f.kind) {
      case 'required': res = { ...res, required: true }; break;
      case 'min': res = { ...res, min: { min: f.min, actual: f.actual } }; break;
      case 'max': res = { ...res, max: { max: f.max, actual: f.actual } }; break;
      case 'minLength': res = { ...res, minlength: { requiredLength: f.requiredLength, actualLength: f.actualLength } }; break;
      case 'maxLength': res = { ...res, maxlength: { requiredLength: f.requiredLength, actualLength: f.actualLength } }; break;
      case 'pattern': res = { ...res, pattern: { requiredPattern: f.requiredPattern, actualValue: f.actualValue } }; break;
      case 'other': res = { ...res, [f.key]: f.detail }; break;
    }
  }
  return Object.keys(res).length === 0 ? null : res;
}

let triples = 0;
let signaturesChecked = 0;

describe('validator parity: core validateProperty vs Angular Validators', { timeout: 60_000 }, () => {
  for (const v of listGoldenVariants()) {
    it(`${v.example}/${v.variant}: every validator signature agrees on every value`, async () => {
      const { props } = await loadSchema(v);
      const seen = new Set<string>();
      for (const p of props) {
        const sig = validatorSignature(p);
        if (seen.has(sig)) continue;
        seen.add(sig);
        signaturesChecked++;

        const expected = fingerprint(p);
        const where = `${v.example}/${v.variant} ${p.table_name}.${p.column_name} [${sig}]`;
        // validationRules and getFormValidatorsForProperty read the same rows: the counts must agree.
        expect(validationRules(p).length, `${where}: validator count`).toBe(expected.validatorCount);

        for (const value of valueMatrix(p.validation_rules ?? [])) {
          const key = label(value);
          expect(toAngularErrors(validateProperty(p, value)), `${where} value ${key}`).toEqual(expected.results[key]);
          triples++;
        }
      }
    });
  }

  it('checked a non-trivial number of (variant, signature, value) triples', () => {
    // eslint-disable-next-line no-console
    console.info(`validator parity: ${triples} (variant, signature, value) triples over ${signaturesChecked} (variant, signature) pairs`);
    expect(signaturesChecked).toBeGreaterThan(0);
    expect(triples).toBeGreaterThan(signaturesChecked);
  });
});
