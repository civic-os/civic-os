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
 * and right after the screenshot the original nodes are put back. Two runs then lay the
 * page out identically whatever the run-time text said.
 *
 * Both functions run inside the page (passed as source to evaluate) and touch only the
 * standard DOM members used below, so the unit tests drive them with small fake nodes.
 * The original child nodes are re-attached, not re-created, so Angular keeps the text
 * nodes it binds to.
 */

export const RUNTIME_TEXT_PLACEHOLDER = '<runtime-text>';

/**
 * Replaces the children of each element with one placeholder text node. Only the
 * outermost of nested matches is replaced (its descendants go with it). Returns what
 * restoreRuntimeText() needs.
 */
export function blankRuntimeText(elements, placeholder) {
  const outermost = elements.filter((el, i) => elements.indexOf(el) === i && !elements.some((o) => o !== el && o.contains(el)));
  const saved = outermost.map((el) => [el, Array.from(el.childNodes)]);
  for (const [el] of saved) el.replaceChildren(el.ownerDocument.createTextNode(placeholder));
  return saved;
}

/** Puts the saved children back, in reverse order of blanking. */
export function restoreRuntimeText(saved) {
  for (const [el, nodes] of [...saved].reverse()) el.replaceChildren(...nodes);
}
