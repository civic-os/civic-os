#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * CI guard: no typographic dashes (en dash U+2013 / em dash U+2014) in
 * user-visible strings. Convention: plain hyphens only (see the accessibility
 * release ground rules in docs/notes/FOLLOWUP_TASKS_v0.67.md).
 *
 * Scanned surfaces:
 *   1. src/app template files (*.html), excluding HTML comments
 *   2. Inline `template:` strings in src/app *.ts components, excluding HTML
 *      comments within them
 *   3. String VALUES in src/app/i18n/en.translations.ts
 *
 * Deliberately NOT scanned (dashes are fine there): code comments, non-template
 * TypeScript, docs, SQL, tests.
 *
 * Usage: node scripts/check-typographic-dashes.js
 * Exits 1 with a per-occurrence report when a violation is found.
 */

const fs = require('fs');
const path = require('path');

const DASH_RE = /[–—]/;
const SRC_ROOT = path.join(__dirname, '..', 'src', 'app');
const TRANSLATIONS = path.join(SRC_ROOT, 'i18n', 'en.translations.ts');

/** Recursively collect files under dir with the given extension. */
function collect(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Replace a span of text with spaces, preserving newlines (keeps line numbers stable). */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/** Remove HTML comments while preserving line positions. */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, blank);
}

/** Report dash occurrences in text as {line, snippet} entries. */
function findDashes(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (DASH_RE.test(line)) {
      hits.push({ line: i + 1, snippet: line.trim().slice(0, 120) });
    }
  });
  return hits;
}

const violations = [];

function record(file, hits) {
  for (const hit of hits) {
    violations.push(`${path.relative(process.cwd(), file)}:${hit.line}  ${hit.snippet}`);
  }
}

// 1. Template files (HTML comments exempt)
for (const file of collect(SRC_ROOT, '.html')) {
  record(file, findDashes(stripHtmlComments(fs.readFileSync(file, 'utf8'))));
}

// 2. Inline templates in components (only the template string is scanned, so
//    TS comments and non-template code can never trip the guard)
for (const file of collect(SRC_ROOT, '.ts')) {
  const text = fs.readFileSync(file, 'utf8');
  const templateMatch = text.match(/template:\s*`/);
  if (!templateMatch) continue;
  const start = templateMatch.index + templateMatch[0].length;
  const end = text.indexOf('`', start);
  if (end === -1) continue;
  // Blank everything outside the template string, preserving line numbers
  const masked = blank(text.slice(0, start)) +
    stripHtmlComments(text.slice(start, end)) +
    blank(text.slice(end));
  record(file, findDashes(masked));
}

// 3. Translation string values only (keys and comments exempt; a dash in a
//    key would be caught wherever the key's value renders anyway)
{
  const text = fs.readFileSync(TRANSLATIONS, 'utf8');
  const masked = text
    .split('\n')
    .map(line => {
      // Match "  'key': 'value'," and keep only the value portion
      const m = line.match(/^(\s*'[^']*':\s*)('(?:[^'\\]|\\.)*')/);
      if (!m) return '';
      return ' '.repeat(m[1].length) + m[2];
    })
    .join('\n');
  record(TRANSLATIONS, findDashes(masked));
}

if (violations.length > 0) {
  console.error('Typographic dash (–/—) found in user-visible strings.');
  console.error('Convention: plain hyphens only in titles, placeholders, and translations');
  console.error('(code comments are exempt). Replace with "-" or rephrase.\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log('No typographic dashes in user-visible strings.');
