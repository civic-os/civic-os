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
 * and MCP tests are counted separately and do not satisfy an expectation;
 * import statements are not usages.
 *
 * Usage:
 *   node scripts/check-dogfood.mjs            # report only, always exits 0 (until SDK P1.6)
 *   node scripts/check-dogfood.mjs --strict   # exit 1 when an expectation is unmet
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { rel, repoRoot } from './lib/workspaces.mjs';

const strict = process.argv.includes('--strict');
const CORE_ENTRY = join(repoRoot, 'packages/core/src/index.ts');

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

const versions = new Map(rootNames.map((f) => [f, '0']));
const host = {
  getScriptFileNames: () => rootNames,
  getScriptVersion: (f) => versions.get(f) ?? '0',
  getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8')) : undefined),
  getCurrentDirectory: () => repoRoot,
  getCompilationSettings: () => options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const program = service.getProgram();
const checker = program.getTypeChecker();

function area(file) {
  const r = rel(file);
  if (r.startsWith('packages/')) return null;
  if (r.startsWith('src/')) return r.endsWith('.spec.ts') ? 'appSpec' : 'app';
  if (r.startsWith('tools/mcp-server/src/')) return r.includes('/__tests__/') ? 'mcpTest' : 'mcp';
  return null;
}

/** Identifier at an exact position (findReferences spans start at the identifier). */
function nodeAt(sf, pos) {
  let found;
  const visit = (node) => {
    if (found || pos < node.getFullStart() || pos >= node.getEnd()) return;
    if (ts.isIdentifier(node) && node.getStart(sf) === pos) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const isImportBinding = (node) => {
  const p = node?.parent;
  return !!p && (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p));
};

function consumerTags(symbol) {
  const tags = symbol.getJsDocTags(checker).filter((t) => t.name === 'consumer').map((t) => ts.displayPartsToString(t.text).trim());
  return tags.length > 0 ? tags : ['app'];
}

const entry = program.getSourceFile(CORE_ENTRY);
const moduleSymbol = entry && checker.getSymbolAtLocation(entry);
if (!moduleSymbol) {
  console.error(`check:dogfood: cannot load ${rel(CORE_ENTRY)}`);
  process.exit(strict ? 1 : 0);
}

const exportNames = new Set(checker.getExportsOfModule(moduleSymbol).map((s) => s.name));
const rows = [];
for (const exported of [...checker.getExportsOfModule(moduleSymbol)].sort((a, b) => a.name.localeCompare(b.name))) {
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const decl = symbol.declarations?.[0];
  const nameNode = decl && ts.getNameOfDeclaration(decl);
  const counts = { app: 0, appSpec: 0, mcp: 0, mcpTest: 0 };
  const sites = { app: [], mcp: [] };
  if (nameNode) {
    const declFile = nameNode.getSourceFile().fileName;
    const seen = new Set();
    for (const group of service.findReferences(declFile, nameNode.getStart()) ?? []) {
      for (const ref of group.references) {
        const where = area(ref.fileName);
        if (!where || ref.isDefinition) continue;
        const key = `${ref.fileName}:${ref.textSpan.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sf = program.getSourceFile(ref.fileName);
        if (sf && isImportBinding(nodeAt(sf, ref.textSpan.start))) continue;
        counts[where]++;
        if (where === 'app' || where === 'mcp') {
          const line = sf ? sf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1 : 0;
          sites[where].push(`${rel(ref.fileName)}:${line}`);
        }
      }
    }
  }

  const tags = consumerTags(symbol);
  const unmet = [];
  for (const tag of tags) {
    const [kind, counterpart] = tag.split(/\s+/);
    if (kind === 'app' && counts.app === 0) unmet.push('no call site in the app');
    else if (kind === 'mcp' && counts.mcp === 0) unmet.push('no call site in the MCP server');
    else if (kind === 'typed' && (!counterpart || !exportNames.has(counterpart))) unmet.push(`typed counterpart "${counterpart ?? ''}" is not a core export`);
    else if (!['app', 'mcp', 'typed', 'tooling'].includes(kind)) unmet.push(`unknown @consumer tag "${tag}"`);
  }
  rows.push({ name: exported.name, tags, counts, sites, unmet });
}

// --- Report
const pad = (s, n) => String(s).padEnd(n);
const nameWidth = Math.max(6, ...rows.map((r) => r.name.length));
const tagWidth = Math.max(8, ...rows.map((r) => r.tags.join(', ').length));
console.log(`check:dogfood: ${rows.length} export(s) of ${rel(CORE_ENTRY)}${strict ? '' : ' (report only)'}`);
console.log('');
console.log(`  ${pad('export', nameWidth)}  ${pad('consumer', tagWidth)}  app  spec  mcp  mcp-test  status`);
for (const r of rows) {
  const status = r.unmet.length === 0 ? 'ok' : `UNMET: ${r.unmet.join('; ')}`;
  console.log(`  ${pad(r.name, nameWidth)}  ${pad(r.tags.join(', '), tagWidth)}  ${pad(r.counts.app, 3)}  ${pad(r.counts.appSpec, 4)}  ${pad(r.counts.mcp, 3)}  ${pad(r.counts.mcpTest, 8)}  ${status}`);
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
