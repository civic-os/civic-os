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

export interface FilterCriteria {
    column: string;
    operator: string;
    value: any;
}

export interface PaginationParams {
    page: number;
    pageSize: number;
}

export interface DataQuery {
    key: string;
    fields: string[];
    entityId?: string;
    orderField?: string;
    orderDirection?: string;
    searchQuery?: string;
    filters?: FilterCriteria[];
    pagination?: PaginationParams;
    limit?: number;
    isSummaryView?: boolean;
}

export interface PaginatedResponse<T> {
    data: T[];
    totalCount: number;
}