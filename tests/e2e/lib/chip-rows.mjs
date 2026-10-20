/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * M:M chip rows in screenshots.
 *
 * The detail, review and edit pages render M:M chips in junction-row order, and the
 * app saves several new junction rows with parallel POSTs, so the chip order depends
 * on which insert commits first. A flow declares the chips such a row must hold
 * (harness.chipRows). Before every screenshot, each visible row holding any of those
 * chips is checked: its chips, as a multiset of labels, must equal the declared set.
 * A dropped, duplicated or mislabelled chip fails the step, in every capture. Rows
 * that pass have their chips put in label order for the screenshot (swapChildren in
 * dom-swap.mjs) and their original order back afterwards. Only the order is
 * neutralized; nothing is masked.
 *
 * chipRowPairs() runs inside the page (its source is passed to evaluate), so it must
 * not reference anything outside itself.
 */

/**
 * @param {Element[]} elements   every element of the page (document order)
 * @param {string[]} expected    the chip labels the row must hold (a multiset)
 * @param {(el: Element) => boolean} isVisible
 * @returns {{ rows: number, pairs: Array<[Element, Element[]]>, problems: string[] }}
 *          pairs: each matching row with its chips in label order, for swapChildren()
 */
export function chipRowPairs(elements, expected, isVisible) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const byLabel = (a, b) => (norm(a.textContent) < norm(b.textContent) ? -1 : norm(a.textContent) > norm(b.textContent) ? 1 : 0);
  const labels = new Set(expected);
  // A chip is the outermost visible element whose whole text is one of the labels.
  const hits = elements.filter((el) => isVisible(el) && labels.has(norm(el.textContent)));
  const chips = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
  const rows = [];
  for (const chip of chips) if (chip.parentElement && !rows.includes(chip.parentElement)) rows.push(chip.parentElement);
  const want = [...expected].sort();
  const pairs = [];
  const problems = [];
  for (const row of rows) {
    const items = Array.from(row.children).filter(isVisible);
    const got = items.map((el) => norm(el.textContent)).sort();
    if (got.length !== want.length || got.some((t, i) => t !== want[i])) {
      problems.push(`M:M chip row differs from the declared chips: expected [${want.join(' | ')}], found [${got.join(' | ')}]`);
      continue;
    }
    pairs.push([row, [...items].sort(byLabel)]);
  }
  return { rows: rows.length, pairs, problems };
}
