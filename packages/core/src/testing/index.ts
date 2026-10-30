/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@civic-os/core/testing`: test fixtures and fakes for consumers of the core
 * (a fake clock, and a fake transport with a client over it).
 */
export { createFakeClock } from './fake-clock.js';
export type { FakeClock } from './fake-clock.js';
export { FAKE_API_URL, fakeTransport, reply } from './fake-transport.js';
export type { FakeTransport, FakeTransportOptions, RecordedRequest } from './fake-transport.js';
