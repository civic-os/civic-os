/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from src/app/interfaces; PostgREST payloads are untyped JSON and tightening `any` would change the public types (SDK P1.4+). */

/** @consumer app */
export interface ApiResponse {
    success: boolean;
    error?: ApiError;
    body?: any;
    progress?: number;  // For upload progress tracking (0-100)
}
/** @consumer app */
export interface ApiError {
    httpCode?: number;
    code?: string;
    details?: string;
    hint?: string;
    humanMessage: string;
    message: string;
}

/**
 * Database constraint error messages for user-friendly error display
 * Maps PostgreSQL constraint names to friendly error messages
 *
 * @consumer app
 */
export interface ConstraintMessage {
    constraint_name: string;
    table_name: string;
    column_name: string | null;
    error_message: string;
}
