#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Extract the sorted, unique set of class selectors from the built CSS.
 *
 * Run after `npm run build`. A later gate diffs the class set between two
 * builds (for example before and after the SDK extraction) to prove no
 * Tailwind/DaisyUI class was lost or newly emitted by accident.
 *
 * Usage:
 *   node scripts/css-classset.mjs [--dir dist/frontend/browser] [--out classes.json]
 *
 * Without --out the JSON is printed to stdout. Output shape:
 *   { "dir": "...", "files": ["styles-ABC.css", ...], "count": N, "classes": ["..."] }
 *
 * Only selector preludes are scanned (never declaration values, strings,
 * url(...) payloads, @keyframes or @font-face bodies), and CSS escapes are
 * decoded, so `.md\:flex` is reported as `md:flex`.
 *
 * Scope: the emitted .css files (global Tailwind/DaisyUI output). Angular
 * component-scoped styles are inlined into the JS chunks and are not covered.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const dir = resolve(arg('--dir', 'dist/frontend/browser'));
const out = arg('--out', null);

// At-rules whose block contains ordinary rules; every other at-rule block
// (keyframes, font-face, property, page, counter-style, ...) is skipped.
const TRANSPARENT_AT_RULES = new Set([
  'media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'document',
]);

function cssFiles(root) {
  const found = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) continue;
    if (name.endsWith('.css')) found.push(name);
  }
  return found.sort();
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Pull class names out of one selector prelude. */
function classesFromSelector(prelude, into) {
  let i = 0;
  const n = prelude.length;
  while (i < n) {
    const ch = prelude[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"' || ch === "'") {
      // attribute values: skip the quoted string
      i++;
      while (i < n && prelude[i] !== ch) i += prelude[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '.') {
      let j = i + 1;
      let name = '';
      while (j < n) {
        const c = prelude[j];
        if (c === '\\') {
          // hex escape: up to 6 hex digits + optional single whitespace
          const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(prelude.slice(j + 1));
          if (hex) {
            name += String.fromCodePoint(parseInt(hex[0].trim(), 16));
            j += 1 + hex[0].length;
          } else {
            name += prelude[j + 1] ?? '';
            j += 2;
          }
          continue;
        }
        if (/[A-Za-z0-9_\-]/.test(c) || c.charCodeAt(0) > 127) { name += c; j++; continue; }
        break;
      }
      // A leading digit means this was a decimal point (e.g. inside :nth-child(.5n)), not a class.
      if (name && !/^[0-9]/.test(name)) into.add(name);
      i = j;
      continue;
    }
    i++;
  }
}

/** Walk a stylesheet and collect class selectors into `into`. */
function collect(css, into) {
  const text = stripComments(css);
  const n = text.length;
  let i = 0;
  let buf = '';
  let parenDepth = 0;

  function skipBlock(start) {
    // `start` is the index just after an opening brace; return index after its match.
    let depth = 1;
    let k = start;
    while (k < n && depth > 0) {
      const c = text[k];
      if (c === '"' || c === "'") {
        k++;
        while (k < n && text[k] !== c) k += text[k] === '\\' ? 2 : 1;
      } else if (c === '\\') {
        k++;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
      k++;
    }
    return k;
  }

  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && text[k] !== c) k += text[k] === '\\' ? 2 : 1;
      buf += text.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    if (c === '\\') { buf += text.slice(i, i + 2); i += 2; continue; }
    if (c === '(') parenDepth++;
    else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);

    if (parenDepth === 0 && c === '{') {
      const prelude = buf.trim();
      buf = '';
      if (prelude.startsWith('@')) {
        const name = /^@([A-Za-z-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
        if (!TRANSPARENT_AT_RULES.has(name)) {
          i = skipBlock(i + 1);
          continue;
        }
        // transparent at-rule: keep scanning its contents as ordinary rules
        i++;
        continue;
      }
      classesFromSelector(prelude, into);
      i++; // descend: nested rules and declarations are handled by the same loop
      continue;
    }
    if (parenDepth === 0 && (c === ';' || c === '}')) {
      buf = ''; // end of a declaration or block
      i++;
      continue;
    }
    buf += c;
    i++;
  }
}

const files = cssFiles(dir);
if (files.length === 0) {
  console.error(`No .css files found in ${dir}. Run "npm run build" first.`);
  process.exit(1);
}

const classes = new Set();
for (const f of files) collect(readFileSync(join(dir, f), 'utf8'), classes);

const sorted = [...classes].sort();
const json = JSON.stringify({ dir, files, count: sorted.length, classes: sorted }, null, 2) + '\n';

if (out) {
  writeFileSync(out, json);
  console.error(`${sorted.length} classes from ${files.length} file(s) written to ${out}`);
} else {
  process.stdout.write(json);
}
