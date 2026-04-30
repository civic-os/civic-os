/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/** Domains allowed to render as embedded iframes in markdown content. */
export const ALLOWED_EMBED_DOMAINS: string[] = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
];

/**
 * Checks whether a hostname is in the embed allowlist.
 * Uses suffix matching so `www.youtube.com` matches `youtube.com`,
 * but `youtube.com.evil.com` does not.
 */
export function isAllowedEmbedDomain(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return ALLOWED_EMBED_DOMAINS.some(
    domain => lower === domain || lower.endsWith('.' + domain)
  );
}

/**
 * Resolves a raw YouTube URL into a privacy-enhanced embed URL.
 *
 * Supported patterns:
 * - youtube.com/watch?v=ID       -> youtube-nocookie.com/embed/ID
 * - youtu.be/ID                  -> youtube-nocookie.com/embed/ID
 * - youtube.com/embed/ID         -> youtube-nocookie.com/embed/ID
 * - youtube.com/playlist?list=ID -> youtube-nocookie.com/embed/videoseries?list=ID
 *
 * Timestamps (t=, start=) are preserved as ?start= on the embed URL.
 * Returns null for unrecognized or disallowed URLs.
 */
export function resolveEmbedUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  // Only allow https (and http for local dev convenience, resolved to nocookie anyway)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  if (!isAllowedEmbedDomain(parsed.hostname)) {
    return null;
  }

  const params = parsed.searchParams;

  // youtube.com/playlist?list=ID
  const listId = params.get('list');
  if (parsed.pathname === '/playlist' && listId) {
    return `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(listId)}`;
  }

  // Extract video ID from various patterns
  let videoId: string | null = null;

  // youtu.be/ID
  if (parsed.hostname === 'youtu.be' || parsed.hostname === 'www.youtu.be') {
    videoId = parsed.pathname.slice(1).split('/')[0] || null;
  }

  // youtube.com/watch?v=ID
  if (!videoId) {
    videoId = params.get('v');
  }

  // youtube.com/embed/ID
  if (!videoId) {
    const embedMatch = parsed.pathname.match(/^\/embed\/([^/?]+)/);
    if (embedMatch) {
      videoId = embedMatch[1];
    }
  }

  if (!videoId || !/^[\w-]+$/.test(videoId)) {
    return null;
  }

  // Preserve start time
  const startTime = params.get('start') || params.get('t');
  const startParam = startTime ? `?start=${encodeURIComponent(startTime.replace(/s$/, ''))}` : '';

  return `https://www.youtube-nocookie.com/embed/${videoId}${startParam}`;
}
