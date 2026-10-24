/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Core I/O clients over the Transport seam (P1.2). */
export { DataClient } from './data-client.js';
export type {
  BulkInsertOptions,
  DataClientOptions,
  DataRequestOptions,
  EditDataResult,
  InversePreviewResult,
  JunctionRef,
} from './data-client.js';
export { DataClientError } from './errors.js';
export type { DataClientErrorShape } from './errors.js';
