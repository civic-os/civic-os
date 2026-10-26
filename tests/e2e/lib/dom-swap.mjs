/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Temporary, reversible changes to the page's DOM around a screenshot: swap the
 * children of some elements, take the screenshot, put the original children back.
 * Used for run-time text placeholders (runtime-text.mjs) and for putting M:M chips
 * in a fixed order (chip-rows.mjs).
 *
 * The original child nodes are re-attached, not re-created, so Angular keeps the
 * nodes it binds to. Both functions run inside the page (their source is passed to
 * evaluate, so they must not reference anything outside themselves) and use only
 * standard DOM members, so the unit tests drive them with small fake nodes.
 */

/**
 * Replaces the children of each element with the given nodes. Transactional: if any
 * replacement throws, every element already swapped gets its own children back
 * before the error is rethrown. Returns the record restoreChildren() needs.
 *
 * @param {Array<[Element, Node[]]>} pairs  element and its temporary children
 */
export function swapChildren(pairs) {
  const saved = [];
  try {
    for (const [el, nodes] of pairs) {
      const original = Array.from(el.childNodes);
      el.replaceChildren(...nodes);
      saved.push([el, original, nodes]);
    }
  } catch (err) {
    for (const [el, original] of saved.reverse()) el.replaceChildren(...original);
    throw err;
  }
  return saved;
}

/**
 * Puts the original children back, in reverse order of swapping. If the page changed
 * a swapped element in the meantime (Angular added or removed a child while the
 * screenshot was taken), the original children are restored, any node the page added
 * is kept after them, and the change is reported: the caller fails the step with it.
 *
 * @returns {string[]} one message per element the page changed while swapped; empty when none
 */
export function restoreChildren(saved) {
  const problems = [];
  for (const [el, original, temporary] of [...saved].reverse()) {
    const current = Array.from(el.childNodes);
    const added = current.filter((n) => !temporary.includes(n));
    const removed = temporary.filter((n) => !current.includes(n));
    el.replaceChildren(...original, ...added);
    if (added.length || removed.length) {
      problems.push(`<${String(el.nodeName || el.tagName || 'element').toLowerCase()}> changed while swapped for the screenshot: ${added.length} node(s) added, ${removed.length} temporary node(s) removed`);
    }
  }
  return problems;
}
