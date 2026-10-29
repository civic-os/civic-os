/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Entry point of @civic-os/core, the sole interpreter of the Civic OS metadata
 * contract (docs/notes/FRONTEND_SDK_DESIGN.md). Each module owns its barrel;
 * this file only re-exports them, so lanes never edit it.
 */
export * from './model/index.js';
export * from './schema/index.js';
export * from './query/index.js';
export * from './transform/index.js';
export * from './conditions/index.js';
export * from './errors/index.js';
export * from './transport/index.js';
export * from './client/index.js';
export * from './names/index.js';
export * from './handles/index.js';
export * from './version/index.js';
export * from './typed-client/index.js';
export * from './state/index.js';
