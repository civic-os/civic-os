/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Vitest reporter that writes the per-test assertion ledger.
 *
 * Inert unless SDK_LEDGER_OUT is set to an output file path, so it can stay
 * registered in angular.json without changing a normal `npm run test:headless`.
 * Assertion counts come from the afterEach hook in src/test-setup.ts
 * (task.meta.ledgerAssertions).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

export default class LedgerReporter {
  onInit(vitest) {
    this.root = vitest?.config?.root ?? process.cwd();
  }

  onTestRunEnd(testModules) {
    const out = process.env.SDK_LEDGER_OUT;
    if (!out) return;
    const tests = {};
    for (const mod of testModules) {
      const file = relative(this.root ?? process.cwd(), mod.moduleId).split('\\').join('/');
      for (const t of mod.children.allTests()) {
        let key = `${file} :: ${t.fullName}`;
        for (let n = 2; key in tests; n++) key = `${file} :: ${t.fullName} #${n}`;
        const state = t.result().state; // passed | failed | skipped | pending
        const meta = t.meta();
        tests[key] = {
          state: t.options?.todo ? 'todo' : state,
          assertions: Number.isInteger(meta.ledgerAssertions) ? meta.ledgerAssertions : 0,
        };
      }
    }
    const sorted = {};
    for (const k of Object.keys(tests).sort()) sorted[k] = tests[k];
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ tests: sorted }, null, 2) + '\n');
  }
}
