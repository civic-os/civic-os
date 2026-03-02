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

import { ActionCondition, SimpleCondition } from '../interfaces/entity';

/**
 * Type guard: checks if a condition is a compound OR condition.
 */
function isOrCondition(c: ActionCondition): c is { or: ActionCondition[] } {
    return 'or' in c && Array.isArray((c as any).or);
}

/**
 * Type guard: checks if a condition is a compound AND condition.
 */
function isAndCondition(c: ActionCondition): c is { and: ActionCondition[] } {
    return 'and' in c && Array.isArray((c as any).and);
}

/**
 * Evaluates a condition against record data.
 *
 * Used for entity action visibility and enablement conditions.
 * Returns true when the condition is met.
 *
 * Supports simple conditions and compound or/and conditions:
 * - Simple: { field: 'status_id', operator: 'eq', value: 1 }
 * - OR: { or: [{ field: 'status_id', operator: 'eq', value: 1 }, { field: 'status_id', operator: 'eq', value: 2 }] }
 * - AND: { and: [{ field: 'amount', operator: 'gt', value: 0 }, { field: 'status_id', operator: 'eq', value: 1 }] }
 *
 * @param condition - The condition to evaluate (null/undefined = always true)
 * @param data - The record data to evaluate against
 * @returns true if condition is met or no condition specified
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

    // Handle compound OR condition
    if (isOrCondition(condition)) {
        return condition.or.some(sub => evaluateCondition(sub, data));
    }

    // Handle compound AND condition
    if (isAndCondition(condition)) {
        return condition.and.every(sub => evaluateCondition(sub, data));
    }

    // Simple condition - cast to SimpleCondition for field access
    const simple = condition as SimpleCondition;

    // Get field value, handling embedded FK objects (Status, ForeignKey types)
    // PostgREST embeds related data as objects like {id: 1, display_name: "..."}
    // For conditions, we want to compare against the ID
    let fieldValue = data[simple.field];
    if (fieldValue !== null && typeof fieldValue === 'object' && 'id' in fieldValue) {
        fieldValue = fieldValue.id;
    }

    switch (simple.operator) {
        case 'eq':
            return fieldValue === simple.value;

        case 'ne':
            return fieldValue !== simple.value;

        case 'gt':
            return typeof fieldValue === 'number' &&
                   typeof simple.value === 'number' &&
                   fieldValue > simple.value;

        case 'lt':
            return typeof fieldValue === 'number' &&
                   typeof simple.value === 'number' &&
                   fieldValue < simple.value;

        case 'gte':
            return typeof fieldValue === 'number' &&
                   typeof simple.value === 'number' &&
                   fieldValue >= simple.value;

        case 'lte':
            return typeof fieldValue === 'number' &&
                   typeof simple.value === 'number' &&
                   fieldValue <= simple.value;

        case 'in':
            return Array.isArray(simple.value) &&
                   simple.value.includes(fieldValue);

        case 'is_null':
            return fieldValue === null || fieldValue === undefined;

        case 'is_not_null':
            return fieldValue !== null && fieldValue !== undefined;

        default:
            // Unknown operator - return false for safety
            console.warn(`Unknown condition operator: ${(simple as any).operator}`);
            return false;
    }
}

/**
 * Extracts all field names referenced in a condition (including nested or/and).
 * Used to ensure condition fields are included in API select queries.
 */
export function extractConditionFieldNames(condition: ActionCondition | null | undefined): string[] {
    if (!condition) return [];

    if (isOrCondition(condition)) {
        return condition.or.flatMap(sub => extractConditionFieldNames(sub));
    }
    if (isAndCondition(condition)) {
        return condition.and.flatMap(sub => extractConditionFieldNames(sub));
    }

    return [(condition as SimpleCondition).field];
}
