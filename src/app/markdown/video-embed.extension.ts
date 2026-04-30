/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { MarkedExtension, TokenizerAndRendererExtension } from 'marked';
import { resolveEmbedUrl } from './video-embed.constants';

const videoExtension: TokenizerAndRendererExtension = {
  name: 'video',
  level: 'block',

  start(src: string): number | undefined {
    const idx = src.indexOf('@[');
    return idx !== -1 ? idx : undefined;
  },

  tokenizer(src: string) {
    const match = src.match(/^@\[video\]\(([^)]+)\)[ \t]*(?:\n|$)/);
    if (match) {
      return {
        type: 'video',
        raw: match[0],
        url: match[1].trim(),
      };
    }
    return undefined;
  },

  renderer(token) {
    const embedUrl = resolveEmbedUrl(token['url']);

    if (embedUrl) {
      return `<div class="video-embed not-prose">`
        + `<iframe src="${embedUrl}" `
        + `sandbox="allow-scripts allow-same-origin allow-presentation" `
        + `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" `
        + `allowfullscreen `
        + `loading="lazy">`
        + `</iframe>`
        + `</div>\n`;
    }

    // Fallback: render as a plain link for non-allowlisted domains
    const safeUrl = escapeHtml(token['url']);
    return `<p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a></p>\n`;
  },
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Marked extension that parses @[video](url) syntax into embedded iframes. */
export const videoEmbedExtension: MarkedExtension = {
  extensions: [videoExtension],
};
