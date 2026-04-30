/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import DOMPurify from 'dompurify';
import { isAllowedEmbedDomain } from './video-embed.constants';

/**
 * Custom sanitize function for ngx-markdown that allows YouTube iframes
 * while stripping everything else DOMPurify would normally remove.
 *
 * Creates a fresh DOMPurify instance to avoid polluting global config
 * (the template-editor component uses the global DOMPurify separately).
 *
 * Defense-in-depth: even though the marked extension already validates
 * domains before emitting <iframe> tags, this sanitizer re-validates
 * every iframe src against the same allowlist.
 */
export function markdownSanitize(html: string): string {
  const purify = DOMPurify();

  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'iframe') {
      const el = node as Element;
      const src = el.getAttribute('src') || '';
      let allowed = false;
      try {
        const url = new URL(src);
        allowed = isAllowedEmbedDomain(url.hostname);
      } catch {
        // Invalid URL — not allowed
      }
      if (!allowed) {
        el.parentNode?.removeChild(el);
      }
    }
  });

  const clean = purify.sanitize(html, {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'sandbox', 'loading', 'target'],
  });

  purify.removeAllHooks();
  return clean;
}
