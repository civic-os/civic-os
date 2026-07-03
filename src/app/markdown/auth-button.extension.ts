/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { MarkedExtension, TokenizerAndRendererExtension } from 'marked';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const loginButtonExtension: TokenizerAndRendererExtension = {
  name: 'login-button',
  level: 'block',

  start(src: string): number | undefined {
    const idx = src.indexOf('@[login-button]');
    return idx !== -1 ? idx : undefined;
  },

  tokenizer(src: string) {
    const match = src.match(/^@\[login-button\]\(([^)]*)\)[ \t]*(?:\n|$)/);
    if (match) {
      return {
        type: 'login-button',
        raw: match[0],
        label: match[1].trim(),
      };
    }
    return undefined;
  },

  renderer(token) {
    const label = escapeHtml(token['label'] || 'Log In');
    return `<p><a href="/login" class="btn btn-primary not-prose">${label}</a></p>\n`;
  },
};

const logoutButtonExtension: TokenizerAndRendererExtension = {
  name: 'logout-button',
  level: 'block',

  start(src: string): number | undefined {
    const idx = src.indexOf('@[logout-button]');
    return idx !== -1 ? idx : undefined;
  },

  tokenizer(src: string) {
    const match = src.match(/^@\[logout-button\]\(([^)]*)\)[ \t]*(?:\n|$)/);
    if (match) {
      return {
        type: 'logout-button',
        raw: match[0],
        label: match[1].trim(),
      };
    }
    return undefined;
  },

  renderer(token) {
    const label = escapeHtml(token['label'] || 'Logout');
    return `<p><a href="/logout" class="btn btn-ghost not-prose">${label}</a></p>\n`;
  },
};

/** Marked extension that parses @[login-button](Label) and @[logout-button](Label) syntax. */
export const authButtonExtension: MarkedExtension = {
  extensions: [loginButtonExtension, logoutButtonExtension],
};
