/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from src/app/interfaces; PostgREST payloads are untyped JSON and tightening `any` would change the public types (SDK P1.4+). */

/** @consumer app */
export interface FilterCriteria {
    column: string;
    operator: string;
    value: any;
}

/** @consumer app */
export interface PaginationParams {
    page: number;
    pageSize: number;
}

/** @consumer app */
export interface DataQuery {
    key: string;
    fields: string[];
    entityId?: string;
    orderField?: string;
    orderDirection?: string;
    searchQuery?: string;
    filters?: FilterCriteria[];
    rawQueryParams?: string[];
    pagination?: PaginationParams;
    /** Maximum rows; an integer >= 1 (Q-10). Sent as `limit=` or as a Range window, per the compile options. */
    limit?: number;
    /** Rows to skip; an integer >= 0 (Q-10). Sent as `offset=` or as a Range window, per the compile options. */
    offset?: number;
    /** Ask PostgREST for the total (`Prefer: count=exact`). Paginated reads always do (Q-02). */
    count?: boolean;
    isSummaryView?: boolean;
    /**
     * The entity's real column names (no virtual many-to-many properties).
     * When present it is authoritative for `id` inclusion in the select (Q-11)
     * and for the default order (Q-01: `display_name`, `id` tie-breaker), even
     * for columns the query does not select. When absent the legacy fallback
     * applies: `id` is added unless `isSummaryView`, and the default order
     * considers only the selected fields.
     */
    entityColumns?: readonly string[];
    /**
     * Text search configuration for `searchQuery` (Q-05). Absent renders bare
     * `wfts.` (database default); present renders `wfts(<config>).`. Lowercase
     * identifier only, else the query is rejected.
     */
    textSearchConfig?: string;
}

/** @consumer app */
export interface PaginatedResponse<T> {
    data: T[];
    totalCount: number;
}

/**
 * A page together with the total PostgREST reported. `totalCount` is null when
 * the response carries no numeric total (missing header, `*`, unparseable);
 * the consumer decides the fallback (Q-16).
 *
 * @consumer app
 */
export interface CountedResponse<T> {
    data: T[];
    totalCount: number | null;
}
