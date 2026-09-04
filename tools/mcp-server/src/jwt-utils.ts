/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * JWT utilities for per-user permission caching.
 * Extracts a cache key from JWT tokens without verifying them
 * (verification is PostgREST's responsibility).
 */

/**
 * Extract a cache key from a JWT for per-user permission caching.
 *
 * Combines the `sub` claim (user ID) with the first 16 characters of the
 * JWT signature as a fingerprint. This prevents a forged JWT matching a real
 * user's `sub` from reading that user's cached permission flags.
 *
 * Returns `undefined` for anonymous/malformed tokens — the caller should
 * fall back to the shared anonymous cache.
 */
export function extractUserCacheKey(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = payload.sub;
    if (!sub) return undefined;
    // Include first 16 chars of JWT signature as fingerprint.
    // Different tokens for the same user get separate cache entries.
    // Prevents forged JWTs from reading a real user's cached permissions.
    const sigFingerprint = parts[2].slice(0, 16);
    return `${sub}:${sigFingerprint}`;
  } catch {
    return undefined;
  }
}

/**
 * Extract just the user ID (sub claim) from a JWT for logging.
 * Unlike extractUserCacheKey, omits the signature fingerprint
 * since logs don't need cache isolation.
 */
export function extractUserId(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.sub ?? undefined;
  } catch {
    return undefined;
  }
}
