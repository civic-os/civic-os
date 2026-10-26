/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** I/O seam: the Transport contract and a fetch implementation (P1.2). */
export { TransportError } from './errors.js';
export type { TransportErrorKind } from './errors.js';
export { fetchTransport } from './fetch-transport.js';
export type { FetchLike, FetchLikeHeaders, FetchLikeResponse, FetchTransportOptions } from './fetch-transport.js';
export type { AbortSignalLike, Transport, TransportRequest, TransportResponse } from './types.js';
