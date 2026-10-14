#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Dogfooding report for @civic-os/core: every export of
 * packages/core/src/index.ts should be exercised by a real consumer, so the
 * public API is the one the generic app and the MCP server actually run on.
 *
 * Each export may carry a TSDoc `@consumer` tag naming who is expected to use it:
 *   @consumer app              (default) a call site in the generic app: src/**, including the import worker
 *   @consumer mcp              a call site in the MCP server: tools/mcp-server/src/**
 *   @consumer typed <Export>   type-level API whose runtime counterpart is <Export>; exercised by
 *                              the typed fixture app (phase 3), so no call site is required here
 *   @consumer tooling          used by scripts or the CLI (codegen), not by the app or the MCP server
 *
 * References are found with the TypeScript language service (findReferences),
 * with the app resolving @civic-os/core through the root tsconfig paths. Specs
 * and MCP tests are counted separately and do not satisfy an expectation.
 *
 * Only real usages count: calls, property access, values, and type positions.
 * Import bindings and re-exports never count, whatever their form:
 * `export { X } from`, `export type { X } from`, `export { X as Y }`, a local
 * `export { X }` list, `export default X`, and `export * from` shims (which
 * have no reference at all; usages *through* such a shim do count). So the
 * app's `export * from '@civic-os/core'` interface shims are not usage.
 *
 * Usage:
 *   node scripts/check-dogfood.mjs              # report only, always exits 0 (until SDK P1.6)
 *   node scripts/check-dogfood.mjs --strict     # exit 1 when an expectation is unmet
 *   node scripts/check-dogfood.mjs --self-test  # run the checker against an in-memory fixture
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { repoRoot } from './lib/workspaces.mjs';

const strict = process.argv.includes('--strict');
const selfTest = process.argv.includes('--self-test');

// ---------------------------------------------------------------------------
// Analysis (shared by the real run and the self-test)
// ---------------------------------------------------------------------------

/** Which consumer area a file belongs to, relative to `root`; null = not counted. */
function areaOf(file, root) {
  const r = relative(root, file).split(sep).join('/');
  if (r.startsWith('packages/')) return null;
  if (r.startsWith('src/')) return r.endsWith('.spec.ts') ? 'appSpec' : 'app';
  if (r.startsWith('tools/mcp-server/src/')) return r.includes('/__tests__/') ? 'mcpTest' : 'mcp';
  return null;
}

/** Smallest node starting exactly at `pos` (findReferences spans start at the name). */
function nodeAt(sf, pos) {
  let found;
  const visit = (node) => {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) {
      if (pos < node.getFullStart() || pos >= node.getEnd()) return;
    } else if (node.getStart(sf) === pos) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * True when a reference is an import binding or a re-export rather than a use.
 * `export * from` produces no reference, so it never reaches this function.
 */
function isImportOrReExport(node) {
  const p = node?.parent;
  if (!p) return false;
  return ts.isImportSpecifier(p)            // import { X } / import { X as Y } / import type { X }
    || ts.isImportClause(p)                  // import X from
    || ts.isNamespaceImport(p)               // import * as X
    || ts.isImportEqualsDeclaration(p)       // import X = require(...)
    || ts.isExportSpecifier(p)               // export { X } [from], export { X as Y }, export type { X }
    || (ts.isExportAssignment(p) && p.expression === node); // export default X / export = X
}

function consumerTags(symbol, checker) {
  const tags = symbol.getJsDocTags(checker).filter((t) => t.name === 'consumer').map((t) => ts.displayPartsToString(t.text).trim());
  return tags.length > 0 ? tags : ['app'];
}

/** Count real usages of every export of `entryFile`, grouped by consumer area. */
function analyze({ service, entryFile, root }) {
  const program = service.getProgram();
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(entryFile);
  const moduleSymbol = entry && checker.getSymbolAtLocation(entry);
  if (!moduleSymbol) throw new Error(`cannot load ${entryFile}`);

  const exportsOfEntry = checker.getExportsOfModule(moduleSymbol);
  const exportNames = new Set(exportsOfEntry.map((s) => s.name));
  const rows = [];
  for (const exported of [...exportsOfEntry].sort((a, b) => a.name.localeCompare(b.name))) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const decl = symbol.declarations?.[0];
    const nameNode = decl && ts.getNameOfDeclaration(decl);
    const counts = { app: 0, appSpec: 0, mcp: 0, mcpTest: 0 };
    const sites = { app: [], mcp: [] };
    const skipped = { reExport: 0 };
    if (nameNode) {
      const seen = new Set();
      for (const group of service.findReferences(nameNode.getSourceFile().fileName, nameNode.getStart()) ?? []) {
        for (const ref of group.references) {
          const where = areaOf(ref.fileName, root);
          if (!where || ref.isDefinition) continue;
          const key = `${ref.fileName}:${ref.textSpan.start}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sf = program.getSourceFile(ref.fileName);
          if (sf && isImportOrReExport(nodeAt(sf, ref.textSpan.start))) {
            skipped.reExport++;
            continue;
          }
          counts[where]++;
          if (where === 'app' || where === 'mcp') {
            const line = sf ? sf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1 : 0;
            sites[where].push(`${relative(root, ref.fileName).split(sep).join('/')}:${line}`);
          }
        }
      }
    }

    const tags = consumerTags(symbol, checker);
    const unmet = [];
    for (const tag of tags) {
      const [kind, counterpart] = tag.split(/\s+/);
      if (kind === 'app' && counts.app === 0) unmet.push('no call site in the app');
      else if (kind === 'mcp' && counts.mcp === 0) unmet.push('no call site in the MCP server');
      else if (kind === 'typed' && (!counterpart || !exportNames.has(counterpart))) unmet.push(`typed counterpart "${counterpart ?? ''}" is not a core export`);
      else if (!['app', 'mcp', 'typed', 'tooling'].includes(kind)) unmet.push(`unknown @consumer tag "${tag}"`);
    }
    rows.push({ name: exported.name, tags, counts, sites, skipped, unmet });
  }
  return rows;
}

function createService(rootNames, options, readFile = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : undefined), fileExists = ts.sys.fileExists) {
  const host = {
    getScriptFileNames: () => rootNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (f) => {
      const text = readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => repoRoot,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists,
    readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: (d) => ts.sys.directoryExists(d) || rootNames.some((f) => f.startsWith(d + '/')),
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

// ---------------------------------------------------------------------------
// Self-test: re-exports and imports must not count; usages through shims must
// ---------------------------------------------------------------------------

function runSelfTest() {
  const root = '/virtual-dogfood-fixture';
  const files = new Map(Object.entries({
    'packages/core/src/index.ts': [
      'export function usedByCall(): number { return 1; }',
      'export interface UsedViaStarShim { a: number }',
      'export const usedAsValue = 1;',
      'export const onlyReExported = 2;',
      'export const onlyRenamedReExport = 3;',
      'export interface OnlyTypeReExported { b: number }',
      'export const onlyImported = 4;',
      'export const onlyLocalExportList = 5;',
      'export const onlyDefaultExported = 6;',
      'export const onlyStarShimmed = 7;',
      '/** @consumer mcp */',
      'export const mcpOnlyReExported = 8;',
      '/** @consumer mcp */',
      'export const mcpUsed = 9;',
    ].join('\n'),
    // The P1.1a shim shape: a pure `export *` re-export of the core.
    'src/app/interfaces/shim.ts': "export * from '@civic-os/core';\n",
    'src/app/reexports.ts': [
      "export { onlyReExported } from '@civic-os/core';",
      "export { onlyRenamedReExport as renamed } from '@civic-os/core';",
      "export type { OnlyTypeReExported } from '@civic-os/core';",
    ].join('\n'),
    'src/app/imports.ts': [
      "import { onlyImported, onlyLocalExportList, onlyDefaultExported } from '@civic-os/core';",
      'export { onlyLocalExportList };',
      'export default onlyDefaultExported;',
      'void 0 as unknown as typeof import("@civic-os/core");',
    ].join('\n'),
    'src/app/uses.ts': [
      "import { usedByCall, usedAsValue } from '@civic-os/core';",
      "import type { UsedViaStarShim } from './interfaces/shim';",
      'export const v: UsedViaStarShim = { a: usedByCall() + usedAsValue };',
    ].join('\n'),
    'src/app/uses.spec.ts': "import { onlyImported } from '@civic-os/core';\nexport const s = onlyImported;\n",
    'tools/mcp-server/src/index.ts': [
      "export { mcpOnlyReExported } from '@civic-os/core';",
      "import { mcpUsed } from '@civic-os/core';",
      'export const m = mcpUsed + 1;',
    ].join('\n'),
  }).map(([k, v]) => [`${root}/${k}`, v]));

  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { '@civic-os/core': [`${root}/packages/core/src/index.ts`] },
    noEmit: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
  };
  const service = createService(
    [...files.keys()],
    options,
    (f) => files.get(f) ?? (existsSync(f) ? readFileSync(f, 'utf8') : undefined),
    (f) => files.has(f) || ts.sys.fileExists(f),
  );
  const rows = Object.fromEntries(analyze({ service, entryFile: `${root}/packages/core/src/index.ts`, root }).map((r) => [r.name, r]));

  // name -> [app, appSpec, mcp, mcpTest, unmet?]
  const expected = {
    usedByCall: [1, 0, 0, 0, false],
    UsedViaStarShim: [1, 0, 0, 0, false],      // used through the export * shim: counts
    usedAsValue: [1, 0, 0, 0, false],
    onlyReExported: [0, 0, 0, 0, true],        // export { X } from
    onlyRenamedReExport: [0, 0, 0, 0, true],   // export { X as Y } from
    OnlyTypeReExported: [0, 0, 0, 0, true],    // export type { X } from
    onlyImported: [0, 1, 0, 0, true],          // import only in app code; the spec use does not satisfy @consumer app
    onlyLocalExportList: [0, 0, 0, 0, true],   // import + local export { X }
    onlyDefaultExported: [0, 0, 0, 0, true],   // import + export default X
    onlyStarShimmed: [0, 0, 0, 0, true],       // reachable only through the export * shim
    mcpOnlyReExported: [0, 0, 0, 0, true],     // @consumer mcp, only re-exported by the server entry
    mcpUsed: [0, 0, 1, 0, false],
  };
  const failures = [];
  for (const [name, [app, appSpec, mcp, mcpTest, unmet]] of Object.entries(expected)) {
    const row = rows[name];
    if (!row) { failures.push(`${name}: missing from the analysis`); continue; }
    const got = [row.counts.app, row.counts.appSpec, row.counts.mcp, row.counts.mcpTest, row.unmet.length > 0];
    const want = [app, appSpec, mcp, mcpTest, unmet];
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got [app, spec, mcp, mcp-test, unmet] = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  if (Object.keys(rows).length !== Object.keys(expected).length) failures.push(`analysis returned ${Object.keys(rows).length} exports, expected ${Object.keys(expected).length}`);
  if (failures.length > 0) {
    console.error('check:dogfood --self-test FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`check:dogfood --self-test ok: ${Object.keys(expected).length} fixture exports classified as expected (re-exports, import-only, and export * shims are unreferenced; usages through shims count).`);
}

// ---------------------------------------------------------------------------
// Real run over the app and the MCP server
// ---------------------------------------------------------------------------

function walk(dir, filter) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') out.push(...walk(full, filter));
    } else if (filter(entry.name)) out.push(full);
  }
  return out;
}

function runReport() {
  const coreEntry = join(repoRoot, 'packages/core/src/index.ts');
  const isTs = (name) => name.endsWith('.ts') && !name.endsWith('.d.ts');
  const rootNames = [
    ...walk(join(repoRoot, 'packages/core/src'), isTs),
    ...walk(join(repoRoot, 'src'), isTs),
    ...walk(join(repoRoot, 'tools/mcp-server/src'), isTs),
  ];
  // Root compiler options (bundler resolution + @civic-os/core paths), without
  // the root tsconfig's implicit "every file in the repo" include.
  const rootConfig = ts.getParsedCommandLineOfConfigFile(join(repoRoot, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  const options = { ...rootConfig.options, noEmit: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.webworker.importscripts.d.ts'], types: [] };
  const rows = analyze({ service: createService(rootNames, options), entryFile: coreEntry, root: repoRoot });

  const pad = (s, n) => String(s).padEnd(n);
  const nameWidth = Math.max(6, ...rows.map((r) => r.name.length));
  const tagWidth = Math.max(8, ...rows.map((r) => r.tags.join(', ').length));
  console.log(`check:dogfood: ${rows.length} export(s) of packages/core/src/index.ts${strict ? '' : ' (report only)'}`);
  console.log('');
  console.log(`  ${pad('export', nameWidth)}  ${pad('consumer', tagWidth)}  app  spec  mcp  mcp-test  re-exports(ignored)  status`);
  for (const r of rows) {
    const status = r.unmet.length === 0 ? 'ok' : `UNMET: ${r.unmet.join('; ')}`;
    console.log(`  ${pad(r.name, nameWidth)}  ${pad(r.tags.join(', '), tagWidth)}  ${pad(r.counts.app, 3)}  ${pad(r.counts.appSpec, 4)}  ${pad(r.counts.mcp, 3)}  ${pad(r.counts.mcpTest, 8)}  ${pad(r.skipped.reExport, 19)}  ${status}`);
  }

  const byTag = new Map();
  for (const r of rows) for (const t of r.tags) {
    const kind = t.split(/\s+/)[0];
    const entry = byTag.get(kind) ?? { exports: 0, unmet: 0 };
    entry.exports++;
    if (r.unmet.length > 0) entry.unmet++;
    byTag.set(kind, entry);
  }
  console.log('');
  console.log('  per @consumer tag: ' + ([...byTag].map(([k, v]) => `${k} ${v.exports} (${v.unmet} unmet)`).join(', ') || 'none'));
  const unreferenced = rows.filter((r) => r.counts.app + r.counts.mcp === 0 && !r.tags.some((t) => /^(typed|tooling)\b/.test(t)));
  console.log(`  unreferenced by app or MCP code: ${unreferenced.length === 0 ? 'none' : unreferenced.map((r) => r.name).join(', ')}`);
  for (const r of rows) {
    if (r.sites.app.length + r.sites.mcp.length === 0) continue;
    console.log(`  ${r.name}: ${[...r.sites.app, ...r.sites.mcp].join(', ')}`);
  }

  const failing = rows.filter((r) => r.unmet.length > 0);
  if (strict && failing.length > 0) {
    console.error(`check:dogfood --strict: ${failing.length} export(s) with unmet consumer expectations.`);
    process.exit(1);
  }
}

if (selfTest) runSelfTest();
else runReport();
