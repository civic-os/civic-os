/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Record facades: the page orchestration of design §11, without layout.
 * Kept off the package barrel until a facade has an app call site (the
 * dogfood check).
 */

export type { FacadeDeps, FacadeSchema } from './deps.js';
export { recordList } from './record-list.js';
export type {
  ListCalendar,
  ListCalendarEvent,
  ListFilterChip,
  ListMapFeature,
  ListSort,
  ListState,
  ListStateInput,
  ListViews,
  RecordList,
  RecordListOptions,
  RecordListSnapshot,
} from './record-list.js';
