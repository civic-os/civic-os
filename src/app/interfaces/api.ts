/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

export interface ApiResponse {
    success: boolean;
    error?: ApiError;
    body?: any;
    progress?: number;  // For upload progress tracking (0-100)
}
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
 */
export interface ConstraintMessage {
    constraint_name: string;
    table_name: string;
    column_name: string | null;
    error_message: string;
}