/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from src/app; record payloads and conditions are untyped JSON (SDK P1.4+). */

import type { ActionCondition, SimpleCondition } from '../model/index.js';

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
 * Evaluates an entity-action condition against record data.
 *
 * Used for entity action visibility and enablement conditions.
 * Returns true when the condition is met.
 *
 * Supports simple conditions and compound or/and conditions:
 * - Simple: { field: 'status_id', operator: 'eq', value: 1 }
 * - OR: { or: [{ field: 'status_id', operator: 'eq', value: 1 }, { field: 'status_id', operator: 'eq', value: 2 }] }
 * - AND: { and: [{ field: 'amount', operator: 'gt', value: 0 }, { field: 'status_id', operator: 'eq', value: 1 }] }
 *
 * Core has no console, so an unknown operator is reported through the optional
 * `onUnknownOperator` callback (the app passes one that calls console.warn).
 *
 * @consumer app
 * @param condition - The condition to evaluate (null/undefined = always true)
 * @param data - The record data to evaluate against
 * @param onUnknownOperator - Called with the operator when it is not recognized
 * @returns true if condition is met or no condition specified
 */
export function evaluateActionCondition(
    condition: ActionCondition | null | undefined,
    data: Record<string, any> | null | undefined,
    onUnknownOperator?: (operator: unknown) => void
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
        return condition.or.some(sub => evaluateActionCondition(sub, data, onUnknownOperator));
    }

    // Handle compound AND condition
    if (isAndCondition(condition)) {
        return condition.and.every(sub => evaluateActionCondition(sub, data, onUnknownOperator));
    }

    // Simple condition - cast to SimpleCondition for field access
    const simple = condition as SimpleCondition;

    // Get field value, handling dot-notation for nested properties and
    // embedded FK objects (Status, ForeignKey types).
    // Dot-notation like "status_id.status_key" traverses into PostgREST embedded
    // objects: data.status_id = {id: 1, status_key: "preparing", ...}
    const fieldValue = resolveFieldValue(data, simple.field);

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
            onUnknownOperator?.((simple as any).operator);
            return false;
    }
}

/**
 * Extracts all field names referenced in a condition (including nested or/and).
 * Used to ensure condition fields are included in API select queries.
 *
 * For dot-notation fields like "status_id.status_key", returns only the base
 * column name ("status_id") since PostgREST already embeds the full FK object.
 *
 * @consumer app
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
