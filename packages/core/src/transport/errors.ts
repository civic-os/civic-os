/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Why an exchange did not complete.
 *
 * @consumer typed TransportError
 */
export type TransportErrorKind = 'network' | 'aborted';

/**
 * Rejection of `Transport.request` when no HTTP response was obtained.
 * An HTTP error status is not a `TransportError`: it resolves.
 *
 * - `kind: 'aborted'`: the request's `signal` was aborted, before or during the
 *   exchange.
 * - `kind: 'network'`: DNS failure, connection refused or reset, CORS or TLS
 *   failure, or any other error thrown by the underlying `fetch` (the original
 *   error is kept as `cause`).
 *
 * @consumer app
 */
export class TransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message?: string, options?: { cause?: unknown }) {
    super(message ?? (kind === 'aborted' ? 'Request aborted' : 'Network request failed'), options);
    this.name = 'TransportError';
    this.kind = kind;
  }
}
