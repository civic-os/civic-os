/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for JWT cache key extraction.
 */

import { describe, it, expect } from 'vitest';
import { extractUserCacheKey, extractUserId } from '../jwt-utils.js';

// Helper to create a minimal JWT with a given payload
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = 'abcdefghijklmnop_rest_of_signature';
  return `${header}.${body}.${sig}`;
}

describe('extractUserCacheKey()', () => {
  it('returns sub:sigFingerprint for valid JWT with sub claim', () => {
    const token = makeJwt({ sub: 'user-123', role: 'authenticated' });
    const key = extractUserCacheKey(token);
    expect(key).toBe('user-123:abcdefghijklmnop');
  });

  it('returns undefined for JWT without sub claim', () => {
    const token = makeJwt({ role: 'web_anon' });
    expect(extractUserCacheKey(token)).toBeUndefined();
  });

  it('returns undefined for malformed token (not 3 parts)', () => {
    expect(extractUserCacheKey('not-a-jwt')).toBeUndefined();
    expect(extractUserCacheKey('a.b')).toBeUndefined();
    expect(extractUserCacheKey('')).toBeUndefined();
  });

  it('returns undefined for token with invalid base64 payload', () => {
    expect(extractUserCacheKey('header.!!!invalid!!!.sig')).toBeUndefined();
  });

  it('produces different keys for different signatures (same sub)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64url');

    const key1 = extractUserCacheKey(`${header}.${body}.AAAAAAAAAAAAAAAA_rest`);
    const key2 = extractUserCacheKey(`${header}.${body}.BBBBBBBBBBBBBBBB_rest`);

    expect(key1).not.toBe(key2);
    expect(key1).toContain('user-123:');
    expect(key2).toContain('user-123:');
  });

  it('handles UUID sub claims', () => {
    const token = makeJwt({ sub: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const key = extractUserCacheKey(token);
    expect(key).toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890:');
  });
});

describe('extractUserId()', () => {
  it('returns sub claim for valid JWT', () => {
    const token = makeJwt({ sub: 'user-123', role: 'authenticated' });
    expect(extractUserId(token)).toBe('user-123');
  });

  it('returns UUID sub claim', () => {
    const token = makeJwt({ sub: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    expect(extractUserId(token)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('returns undefined for JWT without sub', () => {
    const token = makeJwt({ role: 'web_anon' });
    expect(extractUserId(token)).toBeUndefined();
  });

  it('returns undefined for malformed token', () => {
    expect(extractUserId('not-a-jwt')).toBeUndefined();
    expect(extractUserId('a.b')).toBeUndefined();
    expect(extractUserId('')).toBeUndefined();
  });

  it('returns undefined for invalid base64 payload', () => {
    expect(extractUserId('header.!!!invalid!!!.sig')).toBeUndefined();
  });

  it('returns same sub regardless of signature', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64url');
    expect(extractUserId(`${header}.${body}.sig_AAA`)).toBe('user-123');
    expect(extractUserId(`${header}.${body}.sig_BBB`)).toBe('user-123');
  });
});
