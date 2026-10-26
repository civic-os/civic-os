#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Public API report for each workspace package: every name exported from each
 * `exports` subpath, its kind, its signature as the TypeScript checker sees
 * it, and its `@consumer` tag. The committed report
 * (packages/<name>/api-report.md) makes every public-API change a reviewed
 * diff.
 *
 * Usage:
 *   node scripts/api-report.mjs          # (re)write packages/<name>/api-report.md   (npm run api:report)
 *   node scripts/api-report.mjs --check  # exit 1 if a committed report is stale    (npm run api:check)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { rel, workspacePackages } from './lib/workspaces.mjs';

const check = process.argv.includes('--check');
const SOURCE_CONDITION = '@civic-os/source';

const FORMAT = ts.TypeFormatFlags.NoTruncation
  | ts.TypeFormatFlags.UseFullyQualifiedType
  | ts.TypeFormatFlags.WriteArrayAsGenericType
  | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

/** Map each `exports` subpath to its TypeScript source entry (the @civic-os/source condition). */
function entryPoints(pkg) {
  const entries = [];
  for (const [subpath, target] of Object.entries(pkg.manifest.exports ?? {})) {
    if (typeof target !== 'object' || target === null) continue;
    const sourceTarget = target[SOURCE_CONDITION];
    if (typeof sourceTarget !== 'string') {
      throw new Error(`${rel(pkg.manifestPath)}: exports["${subpath}"] has no "${SOURCE_CONDITION}" condition`);
    }
    const specifier = subpath === '.' ? pkg.manifest.name : `${pkg.manifest.name}/${subpath.replace(/^\.\//, '')}`;
    entries.push({ specifier, file: resolve(pkg.dir, sourceTarget) });
  }
  return entries;
}

function loadProgram(pkg) {
  const configPath = join(pkg.dir, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
}

function kindOf(symbol) {
  const f = symbol.flags;
  const decl = symbol.declarations?.[0];
  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Interface) return 'interface';
  if (f & ts.SymbolFlags.TypeAlias) return 'type';
  if (f & ts.SymbolFlags.Enum) return (f & ts.SymbolFlags.ConstEnum) ? 'const enum' : 'enum';
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) return 'namespace';
  if (f & ts.SymbolFlags.Variable) {
    const list = decl && ts.isVariableDeclaration(decl) ? decl.parent : undefined;
    if (list && (list.flags & ts.NodeFlags.Const)) return 'const';
    if (list && (list.flags & ts.NodeFlags.Let)) return 'let';
    return 'var';
  }
  return 'unknown';
}

function membersOf(checker, type, at, { classStatic = false } = {}) {
  const lines = [];
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) lines.push(`  ${checker.signatureToString(sig, at, FORMAT)};`);
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
    const text = checker.signatureToString(sig, at, FORMAT);
    // A class's construct signatures print as constructors (without the instance return type).
    lines.push(classStatic ? `  constructor${text.slice(0, text.lastIndexOf('): ') + 1)};` : `  new ${text};`);
  }
  for (const info of checker.getIndexInfosOfType(type)) {
    lines.push(`  ${info.isReadonly ? 'readonly ' : ''}[key: ${checker.typeToString(info.keyType, at, FORMAT)}]: ${checker.typeToString(info.type, at, FORMAT)};`);
  }
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const modifiers = decl ? ts.getCombinedModifierFlags(decl) : 0;
    if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
    const readonly = modifiers & ts.ModifierFlags.Readonly ? 'readonly ' : '';
    const optional = prop.flags & ts.SymbolFlags.Optional ? '?' : '';
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl ?? at);
    const calls = checker.getSignaturesOfType(propType, ts.SignatureKind.Call);
    if (decl && (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) && calls.length > 0) {
      for (const sig of calls) lines.push(`  ${prop.name}${optional}${checker.signatureToString(sig, at, FORMAT)};`);
    } else {
      lines.push(`  ${readonly}${prop.name}${optional}: ${checker.typeToString(propType, at, FORMAT)};`);
    }
  }
  return lines;
}

function signatureOf(checker, symbol, kind, name, at) {
  const decl = symbol.declarations?.[0];
  switch (kind) {
    case 'function':
      return checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, decl ?? at), ts.SignatureKind.Call)
        .map((sig) => `function ${name}${checker.signatureToString(sig, at, FORMAT)};`).join('\n');
    case 'const': case 'let': case 'var':
      return `${kind} ${name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, decl ?? at), at, FORMAT)};`;
    case 'type': {
      const params = decl && ts.isTypeAliasDeclaration(decl) && decl.typeParameters ? `<${decl.typeParameters.map((p) => p.getText()).join(', ')}>` : '';
      return `type ${name}${params} = ${checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol), at, FORMAT | ts.TypeFormatFlags.InTypeAlias)};`;
    }
    case 'interface': {
      const params = decl && ts.isInterfaceDeclaration(decl) && decl.typeParameters ? `<${decl.typeParameters.map((p) => p.getText()).join(', ')}>` : '';
      return [`interface ${name}${params} {`, ...membersOf(checker, checker.getDeclaredTypeOfSymbol(symbol), at), '}'].join('\n');
    }
    case 'class': {
      const instance = membersOf(checker, checker.getDeclaredTypeOfSymbol(symbol), at);
      const staticSide = membersOf(checker, checker.getTypeOfSymbolAtLocation(symbol, decl ?? at), at, { classStatic: true })
        .filter((l) => !l.trimStart().startsWith('prototype:'));
      const constructors = staticSide.filter((l) => l.trimStart().startsWith('constructor('));
      const statics = staticSide.filter((l) => !constructors.includes(l)).map((l) => l.replace(/^ {2}/, '  static '));
      return [`class ${name} {`, ...constructors, ...statics, ...instance, '}'].join('\n');
    }
    case 'enum': case 'const enum':
      return [`${kind} ${name} {`, ...(symbol.exports ? [...symbol.exports.values()] : []).map((m) => {
        const d = m.declarations?.[0];
        const value = d && ts.isEnumMember(d) ? checker.getConstantValue(d) : undefined;
        return `  ${m.name} = ${JSON.stringify(value)},`;
      }), '}'].join('\n');
    case 'namespace':
      return `namespace ${name} { ${[...checker.getExportsOfModule(symbol)].map((s) => s.name).sort().join(', ')} }`;
    default:
      return `${name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, decl ?? at), at, FORMAT)}`;
  }
}

function consumerTag(symbol, checker) {
  const tags = symbol.getJsDocTags(checker).filter((t) => t.name === 'consumer');
  if (tags.length === 0) return 'app (default)';
  return tags.map((t) => ts.displayPartsToString(t.text).trim()).join('; ');
}

function buildReport(pkg) {
  const program = loadProgram(pkg);
  const checker = program.getTypeChecker();
  const out = [
    `# API report: ${pkg.manifest.name}`,
    '',
    '<!-- Generated by scripts/api-report.mjs. Do not edit by hand: run `npm run api:report` and commit the result. -->',
    '',
    'Every name a consumer can import, with its kind, checker-printed signature, and `@consumer` tag',
    '(see `scripts/check-dogfood.mjs`). A diff here is a public API change.',
  ];
  for (const { specifier, file } of entryPoints(pkg)) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`${rel(file)} is not part of ${rel(join(pkg.dir, 'tsconfig.json'))}`);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    out.push('', `## \`${specifier}\``, '');
    if (exports.length === 0) {
      out.push('_No exports._');
      continue;
    }
    // Types reachable from this entry print by their public name; anything still
    // printed as import("...").Name is a non-exported type leaking into the API.
    const publicNames = new Map();
    for (const exported of exports) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (target.name === exported.name) publicNames.set(exported.name, target);
    }
    const unqualify = (text) => text.replace(/import\("[^"]+"\)\.([A-Za-z_$][\w$]*)/g, (match, name) => (publicNames.has(name) ? name : match));

    for (const exported of [...exports].sort((a, b) => a.name.localeCompare(b.name))) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const kind = kindOf(symbol);
      out.push(
        `### \`${exported.name}\``,
        '',
        `Kind: ${kind}. Consumer: ${consumerTag(symbol, checker)}.`,
        '',
        '```ts',
        unqualify(signatureOf(checker, symbol, kind, exported.name, sf)),
        '```',
        '',
      );
    }
    while (out[out.length - 1] === '') out.pop();
  }
  return out.join('\n') + '\n';
}

const stale = [];
for (const pkg of workspacePackages()) {
  const reportPath = join(pkg.dir, 'api-report.md');
  const next = buildReport(pkg);
  const current = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  if (current === next) {
    console.log(`api-report: ${rel(reportPath)} is up to date.`);
    continue;
  }
  if (check) {
    stale.push(rel(reportPath));
    const currentLines = (current ?? '').split('\n');
    const nextLines = next.split('\n');
    console.error(`api:check: ${rel(reportPath)} ${current === null ? 'is missing' : 'is stale'}. First differences:`);
    let shown = 0;
    for (let i = 0; i < Math.max(currentLines.length, nextLines.length) && shown < 20; i++) {
      if (currentLines[i] !== nextLines[i]) {
        if (currentLines[i] !== undefined) console.error(`  - ${currentLines[i]}`);
        if (nextLines[i] !== undefined) console.error(`  + ${nextLines[i]}`);
        shown++;
      }
    }
  } else {
    writeFileSync(reportPath, next);
    console.log(`api-report: wrote ${rel(reportPath)}.`);
  }
}
if (stale.length > 0) {
  console.error('Fix: npm run api:report, review the diff, and commit it.');
  process.exit(1);
}
