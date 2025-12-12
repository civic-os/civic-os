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

import { ActionCondition } from '../interfaces/entity';

/**
 * Evaluates a condition against record data.
 *
 * Used for entity action visibility and enablement conditions.
 * Returns true when the condition is met.
 *
 * @param condition - The condition to evaluate (null/undefined = always true)
 * @param data - The record data to evaluate against
 * @returns true if condition is met or no condition specified
 *
 * @example
 * ```typescript
 * // Check if status_id equals 1
 * evaluateCondition({ field: 'status_id', operator: 'eq', value: 1 }, record);
 *
 * // Check if amount is greater than 100
 * evaluateCondition({ field: 'amount', operator: 'gt', value: 100 }, record);
 *
 * // Check if field is null
 * evaluateCondition({ field: 'deleted_at', operator: 'is_null' }, record);
 * ```
 */
export function evaluateCondition(
    condition: ActionCondition | null | undefined,
    data: Record<string, any> | null | undefined
): boolean {
    // No condition means always true
    if (!condition) {
        return true;
    }

    // No data means condition cannot be evaluated - return false for safety
    if (!data) {
        return false;
    }

    // Get field value, handling embedded FK objects (Status, ForeignKey types)
    // PostgREST embeds related data as objects like {id: 1, display_name: "..."}
    // For conditions, we want to compare against the ID
    let fieldValue = data[condition.field];
    if (fieldValue !== null && typeof fieldValue === 'object' && 'id' in fieldValue) {
        fieldValue = fieldValue.id;
    }

    switch (condition.operator) {
        case 'eq':
            return fieldValue === condition.value;

        case 'ne':
            return fieldValue !== condition.value;

        case 'gt':
            return typeof fieldValue === 'number' &&
                   typeof condition.value === 'number' &&
                   fieldValue > condition.value;

        case 'lt':
            return typeof fieldValue === 'number' &&
                   typeof condition.value === 'number' &&
                   fieldValue < condition.value;

        case 'gte':
            return typeof fieldValue === 'number' &&
                   typeof condition.value === 'number' &&
                   fieldValue >= condition.value;

        case 'lte':
            return typeof fieldValue === 'number' &&
                   typeof condition.value === 'number' &&
                   fieldValue <= condition.value;

        case 'in':
            return Array.isArray(condition.value) &&
                   condition.value.includes(fieldValue);

        case 'is_null':
            return fieldValue === null || fieldValue === undefined;

        case 'is_not_null':
            return fieldValue !== null && fieldValue !== undefined;

        default:
            // Unknown operator - return false for safety
            console.warn(`Unknown condition operator: ${(condition as any).operator}`);
            return false;
    }
}
