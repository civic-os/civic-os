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
 * Resolves a field value from record data, supporting dot-notation for nested properties.
 *
 * PostgREST embeds FK data as objects: `status_id: {id: 1, status_key: "preparing", ...}`.
 * For dot-notation fields like "status_id.status_key", traverses the path.
 * For plain fields with embedded FK objects, extracts the .id for backward compatibility.
 */
function resolveFieldValue(data: Record<string, any>, field: string): any {
    if (field.includes('.')) {
        // Dot-notation: traverse nested object path
        const parts = field.split('.');
        let value: any = data;
        for (const part of parts) {
            if (value === null || value === undefined || typeof value !== 'object') {
                return undefined;
            }
            value = value[part];
        }
        return value;
    }

    // Plain field: extract .id from embedded FK objects for backward compatibility
    let value = data[field];
    if (value !== null && typeof value === 'object' && 'id' in value) {
        value = value.id;
    }
    return value;
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

    // Get field value, handling dot-notation for nested properties and
    // embedded FK objects (Status, ForeignKey types).
    // Dot-notation like "status_id.status_key" traverses into PostgREST embedded
    // objects: data.status_id = {id: 1, status_key: "preparing", ...}
    let fieldValue = resolveFieldValue(data, simple.field);

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
 *
 * For dot-notation fields like "status_id.status_key", returns only the base
 * column name ("status_id") since PostgREST already embeds the full FK object.
 */
export function extractConditionFieldNames(condition: ActionCondition | null | undefined): string[] {
    if (!condition) return [];

    if (isOrCondition(condition)) {
        return condition.or.flatMap(sub => extractConditionFieldNames(sub));
    }
    if (isAndCondition(condition)) {
        return condition.and.flatMap(sub => extractConditionFieldNames(sub));
    }

    const field = (condition as SimpleCondition).field;
    // Dot-notation: only the base column (before first dot) needs to be in the select.
    // The nested property (e.g. status_key) comes from the FK embed automatically.
    return [field.includes('.') ? field.split('.')[0] : field];
}
