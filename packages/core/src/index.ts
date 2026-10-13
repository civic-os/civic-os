/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolution canary for the workspace scaffolding (P1.0). Every consumer of
 * the core (the Angular app bundle, `ng test`, the import web worker, the MCP
 * server under tsc, vitest, Node, and Bun) imports this constant to prove it
 * resolves `@civic-os/core`. Removed when real exports land (P1.1a).
 *
 * @consumer app
 */
export const CORE_CANARY = 'civic-os-core-canary';
