/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankRuntimeText, restoreRuntimeText, RUNTIME_TEXT_PLACEHOLDER } from './runtime-text.mjs';

/** Minimal DOM: just the members blankRuntimeText/restoreRuntimeText use. */
const doc = { createTextNode: (data) => new Text(data) };
class Text {
  constructor(data) { this.data = data; this.parent = null; this.childNodes = []; this.ownerDocument = doc; }
  get textContent() { return this.data; }
  contains(n) { return n === this; }
}
class El {
  constructor(name, ...children) {
    this.name = name; this.childNodes = []; this.parent = null; this.ownerDocument = doc;
    this.replaceChildren(...children);
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parent = null;
    this.childNodes = nodes;
    for (const c of nodes) c.parent = this;
  }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
}
const t = (s) => new Text(s);

test('masked run-time text becomes one fixed placeholder, so the same element has the same width in every run', () => {
  const runA = new El('span', t('13 hours ago'));
  const runB = new El('span', t('14 hours ago'));
  blankRuntimeText([runA], RUNTIME_TEXT_PLACEHOLDER);
  blankRuntimeText([runB], RUNTIME_TEXT_PLACEHOLDER);
  assert.equal(runA.textContent, RUNTIME_TEXT_PLACEHOLDER);
  assert.equal(runA.textContent, runB.textContent);
});

test('the original nodes are restored as the same objects (framework bindings keep working)', () => {
  const textNode = t('Oct 20, 2026, 9:31 AM');
  const icon = new El('i', t('schedule'));
  const cell = new El('td', icon, textNode);
  const row = new El('tr', cell, new El('td', t('Gymnasium')));
  const saved = blankRuntimeText([cell], RUNTIME_TEXT_PLACEHOLDER);
  assert.equal(row.textContent, RUNTIME_TEXT_PLACEHOLDER + 'Gymnasium', 'only the matched element changes');
  restoreRuntimeText(saved);
  assert.equal(cell.childNodes[0], icon);
  assert.equal(cell.childNodes[1], textNode);
  assert.equal(textNode.parent, cell);
  assert.equal(row.textContent, 'scheduleOct 20, 2026, 9:31 AMGymnasium');
});

test('nested and repeated matches: only the outermost element is replaced, once, and restore is exact', () => {
  const inner = new El('time', t('3 minutes ago'));
  const outer = new El('span', t('Test Editor · '), inner);
  const other = new El('span', t('just now'));
  const root = new El('div', outer, other);
  const before = root.textContent;
  const saved = blankRuntimeText([inner, outer, other, outer], RUNTIME_TEXT_PLACEHOLDER);
  assert.equal(saved.length, 2);
  assert.equal(root.textContent, RUNTIME_TEXT_PLACEHOLDER + RUNTIME_TEXT_PLACEHOLDER);
  restoreRuntimeText(saved);
  assert.equal(root.textContent, before);
  assert.equal(inner.parent, outer);
});

test('the functions carry no closure, so they run when passed to the page as source', () => {
  const blank = new Function(`return (${blankRuntimeText.toString()})`)();
  const restore = new Function(`return (${restoreRuntimeText.toString()})`)();
  const el = new El('span', t('in 2 hours'));
  const saved = blank([el], 'X');
  assert.equal(el.textContent, 'X');
  restore(saved);
  assert.equal(el.textContent, 'in 2 hours');
});
