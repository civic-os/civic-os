#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * License and dependency boundary check for the Apache-2.0 workspace packages
 * (docs/notes/FRONTEND_SDK_DESIGN.md, "Licensing and publishing": dependency
 * direction is a license boundary). Complements the ESLint block for
 * packages/** in eslint.config.js; this script is the CI gate and does not
 * depend on lint configuration.
 *
 * 1. Manifests:
 *    - no workspace package depends on an AGPL package of this repo (the root
 *      app, tools/* such as @civic-os/mcp-server);
 *    - @civic-os/core has zero runtime dependencies: `dependencies`,
 *      `peerDependencies`, and `optionalDependencies` are empty;
 *    - every runtime dependency of an Apache package (dependencies,
 *      peerDependencies, optionalDependencies; devDependencies are not
 *      distributed) carries a permissive license from LICENSE_ALLOWLIST, read
 *      from the installed package's manifest. AGPL, GPL, LGPL, missing, or
 *      unresolvable licenses fail. SPDX `OR` passes if any alternative is
 *      allowed; `AND` needs every part allowed.
 * 2. Imports (every import/export-from/import()/require()/import-type and
 *    triple-slash directive in packages/<name>/src):
 *    - relative imports must stay inside their own package (no reaching into
 *      src/app/**, tools/**, or another package's files);
 *    - bare imports must be declared in the package's dependencies or
 *      peerDependencies (test files may also use the test toolchain);
 *    - @civic-os/core declares no dependencies, so it may import only relative
 *      paths: no @angular/*, rxjs, node: builtins, or anything else;
 *    - @civic-os/core may not pull in ambient globals through
 *      /// <reference lib|types|path> directives.
 *
 * Usage: node scripts/check-boundaries.mjs   (exit 1 with a per-import report)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { DEP_FIELDS, readJson, rel, repoRoot, toolPackages, workspacePackages } from './lib/workspaces.mjs';

const CODE_FILE = /\.(c|m)?(t|j)sx?$/;
const TEST_FILE = /\.test(-d)?\.(c|m)?(t|j)sx?$/;
/** Bare specifiers test files may import even though they are not runtime dependencies. */
const TEST_TOOLCHAIN = new Set(['vitest', 'fast-check']);

const problems = [];
const workspaces = workspacePackages();

// AGPL (non-Apache) packages in this repo: the root app and every tools/* package.
const rootManifest = readJson(join(repoRoot, 'package.json'));
const agplPackages = new Map([[rootManifest.name, 'package.json']]);
for (const tool of toolPackages()) agplPackages.set(tool.manifest.name, rel(tool.manifestPath));
for (const pkg of workspaces) {
  if (pkg.manifest.license !== 'Apache-2.0') agplPackages.set(pkg.manifest.name, rel(pkg.manifestPath));
}

// ---------------------------------------------------------------------------
// 1. Manifest dependencies
// ---------------------------------------------------------------------------
/** Licenses an Apache-2.0 package may depend on at runtime. */
const LICENSE_ALLOWLIST = new Set(['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']);
/** Dependency fields that ship with (or are required by) a published package. */
const RUNTIME_DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/** License expression of an installed dependency, or null if it cannot be found. */
function dependencyLicense(pkg, name) {
  const workspace = workspaces.find((w) => w.manifest.name === name);
  if (workspace) return { license: workspace.manifest.license, from: rel(workspace.manifestPath) };
  for (const base of [pkg.dir, repoRoot]) {
    const manifestPath = join(base, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    let license = manifest.license;
    if (license && typeof license === 'object') license = license.type;
    if (!license && Array.isArray(manifest.licenses)) {
      license = manifest.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' OR ');
    }
    return { license: typeof license === 'string' && license.trim() ? license.trim() : null, from: rel(manifestPath) };
  }
  return null;
}

/** Evaluate an SPDX expression against the allowlist (OR: any branch; AND: all parts; WITH ignored). */
function licenseAllowed(expression) {
  const cleaned = expression.replace(/[()]/g, ' ').trim();
  return cleaned.split(/\s+OR\s+/i).some((branch) =>
    branch.split(/\s+AND\s+/i).every((part) => LICENSE_ALLOWLIST.has(part.replace(/\s+WITH\s+.*$/i, '').trim())));
}

for (const pkg of workspaces) {
  const where = rel(pkg.manifestPath);
  if (pkg.manifest.license !== 'Apache-2.0') {
    problems.push(`${where}: workspace packages are Apache-2.0 (found license ${JSON.stringify(pkg.manifest.license)})`);
  }
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg.manifest[field] ?? {})) {
      if (agplPackages.has(name)) {
        problems.push(`${where}: ${field} includes ${name} (${agplPackages.get(name)}), an AGPL package; Apache packages must never depend on it`);
      }
    }
  }
  if (pkg.manifest.name === '@civic-os/core') {
    for (const field of [...RUNTIME_DEP_FIELDS, 'bundleDependencies', 'bundledDependencies']) {
      const value = pkg.manifest[field];
      const names = Array.isArray(value) ? value : Object.keys(value ?? {});
      if (names.length > 0) {
        problems.push(`${where}: @civic-os/core has zero runtime dependencies, but ${field} lists ${names.join(', ')}`);
      }
    }
  }
  if (pkg.manifest.license === 'Apache-2.0') {
    for (const field of RUNTIME_DEP_FIELDS) {
      for (const name of Object.keys(pkg.manifest[field] ?? {})) {
        if (agplPackages.has(name)) continue; // already reported above
        const found = dependencyLicense(pkg, name);
        if (!found) {
          problems.push(`${where}: ${field} ${name} is not installed, so its license is unknown (run npm ci; allowed: ${[...LICENSE_ALLOWLIST].join(', ')})`);
        } else if (!found.license) {
          problems.push(`${where}: ${field} ${name} declares no license (${found.from})`);
        } else if (!licenseAllowed(found.license)) {
          problems.push(`${where}: ${field} ${name} is licensed ${JSON.stringify(found.license)} (${found.from}); Apache packages may depend only on ${[...LICENSE_ALLOWLIST].join(', ')}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Imports
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (CODE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts.map')) out.push(full);
  }
  return out;
}

/** Every module specifier a file references, with its 1-based line. */
function moduleReferences(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const refs = [];
  const add = (node, specifier, kind) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    refs.push({ specifier, kind, line });
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text, ts.isImportDeclaration(node) ? 'import' : 'export from');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node, node.moduleReference.expression.text, 'import =');
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (ts.isStringLiteralLike(arg)) add(node, arg.text, isDynamicImport ? 'import()' : 'require()');
        else add(node, '<non-literal>', isDynamicImport ? 'import()' : 'require()');
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node, node.argument.literal.text, 'import type()');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const r of sf.referencedFiles) refs.push({ specifier: r.fileName, kind: '/// <reference path>', line: sf.getLineAndCharacterOfPosition(r.pos).line + 1 });
  for (const r of sf.typeReferenceDirectives) refs.push({ specifier: r.fileName, kind: '/// <reference types>', line: sf.getLineAndCharacterOfPosition(r.pos).line + 1 });
  for (const r of sf.libReferenceDirectives) refs.push({ specifier: r.fileName, kind: '/// <reference lib>', line: sf.getLineAndCharacterOfPosition(r.pos).line + 1 });
  return refs;
}

const packageName = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

let scannedFiles = 0;
let scannedImports = 0;
for (const pkg of workspaces) {
  const srcDir = join(pkg.dir, 'src');
  let files = [];
  try {
    if (statSync(srcDir).isDirectory()) files = walk(srcDir);
  } catch {
    continue;
  }
  const isCore = pkg.manifest.name === '@civic-os/core';
  const runtimeDeps = new Set([
    ...Object.keys(pkg.manifest.dependencies ?? {}),
    ...Object.keys(pkg.manifest.peerDependencies ?? {}),
  ]);

  for (const file of files) {
    scannedFiles++;
    const isTest = TEST_FILE.test(file);
    for (const { specifier, kind, line } of moduleReferences(file)) {
      scannedImports++;
      const where = `${rel(file)}:${line} (${kind} "${specifier}")`;

      if (kind === '/// <reference lib>' || kind === '/// <reference types>') {
        if (isCore) problems.push(`${where}: @civic-os/core must not add ambient globals; it compiles with lib ES2022 and types []`);
        continue;
      }
      if (specifier === '<non-literal>') {
        problems.push(`${where}: non-literal module specifiers cannot be checked; use a static string`);
        continue;
      }
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || kind === '/// <reference path>';
      if (isRelative) {
        const target = resolve(dirname(file), specifier);
        if (target !== pkg.dir && !target.startsWith(pkg.dir + sep)) {
          problems.push(`${where}: resolves to ${rel(target)}, outside ${pkg.relDir}; packages may not import the app, tools/, or other packages by path`);
        }
        continue;
      }
      if (specifier.startsWith('/')) {
        problems.push(`${where}: absolute import paths are not allowed`);
        continue;
      }
      // Bare specifier.
      const name = packageName(specifier);
      if (agplPackages.has(name)) {
        problems.push(`${where}: imports AGPL package ${name}; Apache packages must never import it`);
        continue;
      }
      if (isTest && TEST_TOOLCHAIN.has(name)) continue;
      if (isCore) {
        problems.push(`${where}: @civic-os/core may import only relative paths (no @angular/*, rxjs, node: builtins, or other packages)`);
        continue;
      }
      if (name !== pkg.manifest.name && !runtimeDeps.has(name)) {
        problems.push(`${where}: ${name} is not declared in ${pkg.relDir}/package.json dependencies or peerDependencies`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check:boundaries failed (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check:boundaries ok: ${workspaces.length} package manifest(s), ${scannedImports} import(s) in ${scannedFiles} file(s).`);
