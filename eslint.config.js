// @ts-check
// ESLint flat config for Civic OS.
//
// PURPOSE: This config exists primarily as an *accessibility guardrail*. The
// `@angular-eslint/template` a11y rules below are enabled as errors so the
// remediation work from the July 2026 accessibility audit
// (docs/notes/ACCESSIBILITY_AUDIT_2026-07.md) does not regress. New user-facing
// features must pass these rules in CI (.github/workflows/accessibility.yml).
//
// SCOPE: This is deliberately NOT a general lint cleanup. TypeScript rules are
// kept light (recommended, not strict-type-checked) and the noisy non-a11y
// rules that fire broadly across the pre-audit codebase are downgraded to
// 'warn'/'off' below (each with a reason) so the a11y errors are the signal.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default tseslint.config(
  {
    // Only lint application source. Tooling/scripts/generated code and specs are
    // out of scope for the a11y guardrail.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.angular/**',
      '**/*.spec.ts',
      'scripts/**',
      'tools/**',
      'examples/**',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // Project uses two component prefixes: 'app' (default) and 'cos'
      // (cos-modal). Allow both so the legitimate cos-modal selector passes.
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: ['app', 'cos'], style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: ['app', 'cos'], style: 'kebab-case' },
      ],

      // --- Non-a11y rules downgraded to keep the guardrail focused ---
      // These fire broadly across the existing (pre-audit) codebase and are not
      // accessibility concerns. Downgraded so a11y errors are the signal; a
      // future dedicated lint-cleanup pass can promote them back.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off', // pervasive optional-chaining call style
      '@angular-eslint/prefer-inject': 'off',      // constructor DI still widely used; non-a11y migration
      '@angular-eslint/no-output-native': 'warn',  // pre-existing @Output naming; non-a11y
      '@angular-eslint/no-input-rename': 'warn',   // intentional input aliases; non-a11y
      'no-empty': 'off',
      'no-case-declarations': 'off',
      'no-fallthrough': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['**/*.html'],
    extends: [
      ...angular.configs.templateRecommended,
    ],
    rules: {
      // === ACCESSIBILITY GUARDRAIL (errors — the enforceable gate) ===
      // These catch the keyboard/screen-reader blockers the audit remediated.
      '@angular-eslint/template/alt-text': 'error',
      '@angular-eslint/template/click-events-have-key-events': 'error',
      '@angular-eslint/template/interactive-supports-focus': 'error',
      '@angular-eslint/template/valid-aria': 'error',
      '@angular-eslint/template/role-has-required-aria': 'error',
      '@angular-eslint/template/elements-content': 'error',
      '@angular-eslint/template/no-autofocus': 'error',
      '@angular-eslint/template/table-scope': 'error',
      '@angular-eslint/template/mouse-events-have-key-events': 'error',

      // Enabled and visible, but at 'warn' (not a blocking error) because they
      // reveal a large pre-audit backlog (128 label + 253 button hits) that is
      // out of scope for this guardrail batch — fixing all of them is a
      // dedicated mechanical sweep with form-submit risk, tracked separately.
      // Keeping them as warnings surfaces every hit and every NEW violation
      // without blocking CI on the legacy backlog. Promote to 'error' after the
      // backlog sweep lands.
      '@angular-eslint/template/label-has-associated-control': 'warn',
      '@angular-eslint/template/button-has-type': 'warn',

      // Non-a11y template rules downgraded (see TS block rationale).
      '@angular-eslint/template/eqeqeq': 'off',
    },
  },
);
