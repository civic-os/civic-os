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

//
// WORKSPACE PACKAGES: `eslint packages` (part of `npm run lint`) applies the
// license-boundary blocks at the end of this file to packages/**. The Apache-2.0
// packages must never import the AGPL app or tools; @civic-os/core imports only
// relative paths. scripts/check-boundaries.mjs enforces the same in CI.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import { importX, createNodeResolver } from 'eslint-plugin-import-x';

// Import specifiers no Apache-2.0 package may use (license boundary, see
// docs/notes/FRONTEND_SDK_DESIGN.md "Licensing and publishing").
const AGPL_IMPORT_PATTERNS = [
  { regex: '(^|/)src/app(/|$)', message: 'Apache-2.0 packages must never import the AGPL app (src/app/**).' },
  { regex: '(^|/)tools/', message: 'Apache-2.0 packages must never import tools/** (AGPL MCP server and tooling).' },
  { regex: '^(civic-os|@civic-os/mcp-server)(/|$)', message: 'Apache-2.0 packages must never import AGPL packages.' },
];

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
      'packages/*/dist/**',
      'packages/*/node_modules/**',
    ],
  },
  {
    // Angular rules apply to the app only (ng lint's lintFilePatterns is src/**).
    files: ['src/**/*.ts'],
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
      '@angular-eslint/prefer-on-push-component-change-detection': 'off', // Angular 22 added Eager to legacy Default components; non-a11y
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

      // The pre-audit backlog (128 label + 253 button hits) was cleared in the
      // July 2026 mechanical sweep (all typeless buttons given type="button";
      // DaisyUI caption-wrapper `<label class="label">` misuse converted to
      // `<div>`), so these are now enforced as errors alongside the rest of the
      // a11y guardrail.
      '@angular-eslint/template/label-has-associated-control': 'error',
      '@angular-eslint/template/button-has-type': 'error',

      // Non-a11y template rules downgraded (see TS block rationale).
      '@angular-eslint/template/eqeqeq': 'off',
    },
  },
  {
    // === WORKSPACE PACKAGES (Apache-2.0): license-boundary guardrail ===
    files: ['packages/**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'import-x': importX },
    settings: {
      // Resolve the `.js` suffixes NodeNext requires back to their `.ts` sources.
      'import-x/resolver-next': [
        createNodeResolver({ extensions: ['.ts', '.js'], extensionAlias: { '.js': ['.ts', '.js'] } }),
      ],
    },
    rules: {
      // A relative import that lands in another package (or the app) is an
      // undeclared, license-crossing dependency.
      'import-x/no-relative-packages': 'error',
      'no-restricted-imports': ['error', { patterns: AGPL_IMPORT_PATTERNS }],
    },
  },
  {
    // @civic-os/core is framework-agnostic with zero dependencies: relative
    // imports only (no @angular/*, rxjs, node: builtins, or other packages).
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts', 'packages/core/src/**/*.test-d.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          ...AGPL_IMPORT_PATTERNS,
          { regex: '^(?!\\.\\.?/)', message: '@civic-os/core may import only relative paths (no @angular/*, rxjs, node: builtins, or other packages).' },
        ],
      }],
    },
  },
  {
    // Core tests may additionally use the test toolchain.
    files: ['packages/core/src/**/*.test.ts', 'packages/core/src/**/*.test-d.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          ...AGPL_IMPORT_PATTERNS,
          { regex: '^(?!\\.\\.?/|vitest$|fast-check$)', message: '@civic-os/core tests may import only relative paths, vitest, and fast-check.' },
        ],
      }],
    },
  },
);
