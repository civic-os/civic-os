/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A minimal DOM for the unit tests of the in-page helpers (dom-swap, runtime-text,
 * chip-rows): only the members those helpers use. Not used at run time.
 */

export const doc = { createTextNode: (data) => new Text(data) };

export class Text {
  constructor(data) {
    this.data = data;
    this.parentNode = null;
    this.childNodes = [];
    this.ownerDocument = doc;
    this.nodeName = '#text';
  }
  get textContent() {
    return this.data;
  }
  get parentElement() {
    return this.parentNode;
  }
  contains(n) {
    return n === this;
  }
}

export class El {
  constructor(name, ...children) {
    this.nodeName = name.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = doc;
    this.hidden = false;
    this.replaceChildren(...children);
  }
  replaceChildren(...nodes) {
    if (this.failOnReplace) throw new Error(`replaceChildren failed on ${this.nodeName}`);
    for (const c of this.childNodes) c.parentNode = null;
    for (const c of nodes) {
      if (c.parentNode && c.parentNode !== this) c.parentNode.childNodes = c.parentNode.childNodes.filter((x) => x !== c);
      c.parentNode = this;
    }
    this.childNodes = [...nodes];
  }
  appendChild(n) {
    this.replaceChildren(...this.childNodes, n);
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof El);
  }
  get parentElement() {
    return this.parentNode;
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  /** Every descendant element in document order (like querySelectorAll('*')). */
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

export const t = (s) => new Text(s);
export const isVisible = (el) => !el.hidden;
