/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Framework-neutral state primitives: the snapshot store and the clock port. */
export { createStore } from '../client/store.js';
export type { Store } from '../client/store.js';
export { systemClock } from './clock.js';
export type { Clock } from './clock.js';
