/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Make everything OUTSIDE the given element inert while a modal dialog is open.
 *
 * `aria-modal="true"` alone is unevenly honored: VoiceOver's virtual cursor can
 * recover to background elements after in-dialog content re-renders, stranding
 * screen-reader users behind the dialog. Angular Material solves this by
 * rendering dialogs in a body-level overlay and hiding its siblings; our
 * dialogs render inline, so we walk from the dialog to <body> and set `inert`
 * on every sibling at each level. `inert` removes the subtree from the
 * accessibility tree AND blocks focus (Chrome's recommended replacement for
 * aria-hidden in this situation).
 *
 * Nesting-safe: elements that are already inert (e.g. from an outer modal) are
 * skipped and left untouched on restore, so stacked modals unwind correctly.
 *
 * @returns a restore function that removes only the inert attributes this call added.
 */
export function inertSiblingsOutside(element: HTMLElement): () => void {
  const inerted: Element[] = [];
  let el: HTMLElement | null = element;

  while (el && el !== document.body && el.parentElement) {
    for (const sibling of Array.from(el.parentElement.children)) {
      if (sibling === el) continue;
      const tag = sibling.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
      if (sibling.hasAttribute('inert')) continue; // outer modal or app-owned
      sibling.setAttribute('inert', '');
      inerted.push(sibling);
    }
    el = el.parentElement;
  }

  return () => {
    for (const sibling of inerted) {
      sibling.removeAttribute('inert');
    }
    inerted.length = 0;
  };
}
