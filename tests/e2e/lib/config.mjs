/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pinned environment for the request-equivalence harness. Everything that can
 * change what the app sends (time, timezone, locale, viewport, page size) is
 * fixed here so two runs of the same code produce the same traffic.
 *
 * Bump HARNESS_VERSION whenever a change here, in the normalizer or in a flow
 * changes the shape of recorded baselines; compare mode warns on a mismatch.
 */
export const HARNESS_VERSION = '5';

export const APP_ORIGIN = 'http://localhost:4200';
export const POSTGREST_ORIGIN = 'http://localhost:3000';
export const KEYCLOAK_ORIGIN = 'http://localhost:8082';
export const MINIO_ORIGIN = 'http://localhost:9000';
export const KEYCLOAK_REALM = 'civic-os-dev';
export const KEYCLOAK_CLIENT_ID = 'civic-os-dev-client';

/** Origins the browser may reach. Everything else (Matomo, map tiles, Google Fonts, Stripe, YouTube) is aborted. */
export const ALLOWED_ORIGINS = [APP_ORIGIN, POSTGREST_ORIGIN, KEYCLOAK_ORIGIN, MINIO_ORIGIN];

/**
 * Fake client clock start (a Tuesday morning in America/New_York, EDT).
 * The clock is installed with page.clock.install(), so it starts here on every
 * context and then advances in real time; see README "Clock" for why not
 * setFixedTime(). Typed date values in flows are chosen far from this instant
 * so the runtime-timestamp mask never touches them.
 */
export const CLOCK_T0 = '2026-10-20T09:30:00-04:00';
export const TIMEZONE = 'America/New_York';
export const LOCALE = 'en-US';
export const VIEWPORT = { width: 1280, height: 900 };

/** Seeded localStorage for the app origin (see README "Pinned state"). */
export const LIST_PAGE_SIZE = '10';
export const SEEDED_LOCAL_STORAGE = [
  { name: 'civic-os-locale', value: 'en' },
  { name: 'civic_os_list_page_size', value: LIST_PAGE_SIZE },
  { name: 'civic-os-theme', value: 'corporate' },
];

/** Headers kept in recordings (lower-case). Authorization is reduced to presence. */
export const RECORDED_HEADERS = [
  'accept',
  'accept-language',
  'accept-profile',
  'content-profile',
  'content-type',
  'prefer',
  'range',
  'range-unit',
  'x-impersonate-roles',
];

/** Idle window that ends a step once nothing is in flight. Longer than the 1 s thumbnail poll, debounceTime(300) chains and the 1.5 s post-action refresh timer. */
export const QUIET_IDLE_MS = 2000;
export const QUIET_TIMEOUT_MS = 45_000;
