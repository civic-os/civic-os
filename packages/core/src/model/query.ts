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
    limit?: number;
    isSummaryView?: boolean;
}

/** @consumer app */
export interface PaginatedResponse<T> {
    data: T[];
    totalCount: number;
}
