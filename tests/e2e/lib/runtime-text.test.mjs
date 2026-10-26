/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeTextPairs, RUNTIME_TEXT_PLACEHOLDER } from './runtime-text.mjs';
import { swapChildren, restoreChildren } from './dom-swap.mjs';
import { El, t } from './fake-dom.mjs';

const blank = (els) => swapChildren(runtimeTextPairs(els, RUNTIME_TEXT_PLACEHOLDER));

test('masked run-time text becomes one fixed placeholder, so the same element has the same width in every run', () => {
  const runA = new El('span', t('13 hours ago'));
  const runB = new El('span', t('14 hours ago'));
  blank([runA]);
  blank([runB]);
  assert.equal(runA.textContent, RUNTIME_TEXT_PLACEHOLDER);
  assert.equal(runA.textContent, runB.textContent);
});

test('the original nodes are restored as the same objects (framework bindings keep working)', () => {
  const textNode = t('Oct 20, 2026, 9:31 AM');
  const icon = new El('i', t('schedule'));
  const cell = new El('td', icon, textNode);
  const row = new El('tr', cell, new El('td', t('Gymnasium')));
  const saved = blank([cell]);
  assert.equal(row.textContent, RUNTIME_TEXT_PLACEHOLDER + 'Gymnasium', 'only the matched element changes');
  assert.deepEqual(restoreChildren(saved), []);
  assert.equal(cell.childNodes[0], icon);
  assert.equal(cell.childNodes[1], textNode);
  assert.equal(textNode.parentNode, cell);
  assert.equal(row.textContent, 'scheduleOct 20, 2026, 9:31 AMGymnasium');
});

test('nested and repeated matches: only the outermost element is replaced, once, and restore is exact', () => {
  const inner = new El('time', t('3 minutes ago'));
  const outer = new El('span', t('Test Editor · '), inner);
  const other = new El('span', t('just now'));
  const root = new El('div', outer, other);
  const before = root.textContent;
  const saved = blank([inner, outer, other, outer]);
  assert.equal(saved.length, 2);
  assert.equal(root.textContent, RUNTIME_TEXT_PLACEHOLDER + RUNTIME_TEXT_PLACEHOLDER);
  assert.deepEqual(restoreChildren(saved), []);
  assert.equal(root.textContent, before);
  assert.equal(inner.parentNode, outer);
});

test('the in-page functions carry no closure, so they run when passed to the page as source', () => {
  const pairs = new Function(`return (${runtimeTextPairs.toString()})`)();
  const swap = new Function(`return (${swapChildren.toString()})`)();
  const restore = new Function(`return (${restoreChildren.toString()})`)();
  const el = new El('span', t('in 2 hours'));
  const saved = swap(pairs([el], 'X'));
  assert.equal(el.textContent, 'X');
  assert.deepEqual(restore(saved), []);
  assert.equal(el.textContent, 'in 2 hours');
});

test('verifier F4: a swap that throws part-way restores everything already swapped, then rethrows', () => {
  const a = new El('span', t('13 hours ago'));
  const b = new El('span', t('Oct 19, 2026'));
  const c = new El('span', t('just now'));
  b.failOnReplace = true;
  const root = new El('div', a, b, c);
  const before = root.textContent;
  assert.throws(() => blank([a, b, c]), /replaceChildren failed on SPAN/);
  b.failOnReplace = false;
  assert.equal(root.textContent, before, 'no placeholder left behind');
  assert.equal(a.childNodes[0].data, '13 hours ago');
});

test('verifier F4: nodes the page added while swapped are kept after the originals, and reported', () => {
  const text = t('5 minutes ago');
  const el = new El('span', text);
  const saved = blank([el]);
  // Angular re-renders during the screenshot and appends a node to the swapped element.
  const added = t(' (edited)');
  el.appendChild(added);
  const problems = restoreChildren(saved);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /<span> changed while swapped for the screenshot: 1 node\(s\) added, 0 temporary node\(s\) removed/);
  assert.deepEqual(el.childNodes, [text, added], 'original first, the added node kept');
  // The page removing the placeholder is reported too.
  const el2 = new El('span', t('just now'));
  const saved2 = blank([el2]);
  el2.replaceChildren();
  assert.match(restoreChildren(saved2)[0], /0 node\(s\) added, 1 temporary node\(s\) removed/);
  assert.equal(el2.textContent, 'just now');
});
