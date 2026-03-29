// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { createHmac } from 'node:crypto';

/**
 * Generate a JWT signed with the eval PostgREST symmetric secret.
 * No external dependencies — uses Node's built-in crypto.
 */

const EVAL_JWT_SECRET = 'civic-os-eval-jwt-secret-at-least-32-characters-long';

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

export function generateEvalJWT(opts: {
  sub?: string;
  roles?: string[];
  expiresInSeconds?: number;
} = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSeconds ?? 3600);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: opts.sub ?? '00000000-0000-0000-0000-000000000000',
    iat: now,
    exp,
    realm_access: {
      roles: opts.roles ?? ['admin', 'user', 'editor', 'manager'],
    },
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const sigInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', EVAL_JWT_SECRET).update(sigInput).digest();
  const sigB64 = base64url(signature);

  return `${headerB64}.${payloadB64}.${sigB64}`;
}
