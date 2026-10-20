/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipRowPairs } from './chip-rows.mjs';
import { swapChildren, restoreChildren } from './dom-swap.mjs';
import { El, t, isVisible } from './fake-dom.mjs';

const EXPECTED = ['Urgent', 'Road Surface'];

/** A detail-page M:M section: label, chip row (links with a label span and a colour dot), edit button. */
function section(...labels) {
  const chips = labels.map((l) => new El('a', new El('span', t(l)), new El('span')));
  const row = new El('div', ...chips);
  const root = new El('div', new El('div', t('Tags')), row, new El('button', t('Edit Tags')));
  return { root, row, chips };
}

test('a row holding exactly the declared chips passes and is sorted for the screenshot, then restored', () => {
  const { root, row, chips } = section('Urgent', 'Road Surface');
  const r = chipRowPairs(root.all(), EXPECTED, isVisible);
  assert.equal(r.rows, 1);
  assert.deepEqual(r.problems, []);
  const saved = swapChildren(r.pairs);
  assert.deepEqual(row.children.map((c) => c.textContent), ['Road Surface', 'Urgent']);
  assert.deepEqual(restoreChildren(saved), []);
  assert.deepEqual(row.children, chips, 'original order and nodes back');
  // The other insertion order gives the same screenshot order.
  const other = section('Road Surface', 'Urgent');
  swapChildren(chipRowPairs(other.root.all(), EXPECTED, isVisible).pairs);
  assert.deepEqual(other.row.children.map((c) => c.textContent), ['Road Surface', 'Urgent']);
});

test('verifier F2: a missing non-anchor chip fails, even though the anchor chip is still there', () => {
  const { root } = section('Urgent');
  const r = chipRowPairs(root.all(), EXPECTED, isVisible);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /expected \[Road Surface \| Urgent\], found \[/);
});

test('verifier F2: a duplicated or mislabelled chip fails', () => {
  const dup = chipRowPairs(section('Urgent', 'Road Surface', 'Urgent').root.all(), EXPECTED, isVisible);
  assert.match(dup.problems[0], /found \[Road Surface \| Urgent \| Urgent\]/);
  const wrong = chipRowPairs(section('Urgent', 'Drainage').root.all(), EXPECTED, isVisible);
  assert.match(wrong.problems[0], /found \[Drainage \| Urgent\]/);
});

test('hidden elements (a closed dialog listing the same labels) are ignored; a page without the row has nothing to check', () => {
  const dialogList = new El('ul', new El('label', t('Urgent')), new El('label', t('Road Surface')), new El('label', t('Drainage')));
  dialogList.hidden = true;
  for (const c of dialogList.children) c.hidden = true;
  const { root } = section('Road Surface', 'Urgent');
  const page = new El('body', root, dialogList);
  const r = chipRowPairs(page.all(), EXPECTED, isVisible);
  assert.equal(r.rows, 1);
  assert.deepEqual(r.problems, []);
  const none = chipRowPairs(new El('body', new El('h1', t('Issues'))).all(), EXPECTED, isVisible);
  assert.deepEqual(none, { rows: 0, pairs: [], problems: [] });
});

test('the in-page function carries no closure, so it runs when passed to the page as source', () => {
  const fn = new Function(`return (${chipRowPairs.toString()})`)();
  const { root } = section('Urgent');
  assert.equal(fn(root.all(), EXPECTED, isVisible).problems.length, 1);
});
