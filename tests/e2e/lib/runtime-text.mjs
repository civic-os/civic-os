/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Fixed-width stand-ins for run-dependent text in screenshots.
 *
 * A screenshot mask paints over an element but keeps its box, and the box's width
 * follows the text: "13 hours ago" and "14 hours ago" (or 9:31 and 9:32) differ by a
 * few pixels, and inside a table or a flex row that moves the neighbours too. So right
 * before a screenshot, every element matched by a runtime-text mask (runtimeTextMasks()
 * in harness.ts) gets its content swapped for one text node, RUNTIME_TEXT_PLACEHOLDER,
 * and right after the screenshot the original nodes are put back (dom-swap.mjs). Two
 * runs then lay the page out identically whatever the run-time text said.
 *
 * runtimeTextPairs() runs inside the page (its source is passed to evaluate), so it
 * must not reference anything outside itself.
 */

export const RUNTIME_TEXT_PLACEHOLDER = '<runtime-text>';

/**
 * The swap for swapChildren(): each element's children become one placeholder text
 * node. Only the outermost of nested or repeated matches is listed (its descendants
 * go with it).
 *
 * @returns {Array<[Element, Node[]]>}
 */
export function runtimeTextPairs(elements, placeholder) {
  const outermost = elements.filter((el, i) => elements.indexOf(el) === i && !elements.some((o) => o !== el && o.contains(el)));
  return outermost.map((el) => [el, [el.ownerDocument.createTextNode(placeholder)]]);
}
