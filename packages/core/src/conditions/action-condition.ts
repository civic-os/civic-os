/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from src/app; record payloads and conditions are untyped JSON (SDK P1.4+). */

import type { ActionCondition, SimpleCondition } from '../model/index.js';

/**
 * Type guard: checks if a condition is a compound OR condition.
 */
function isOrCondition(c: object): c is { or: unknown[] } {
    return 'or' in c && Array.isArray((c as any).or);
}

/**
 * Type guard: checks if a condition is a compound AND condition.
 */
function isAndCondition(c: object): c is { and: unknown[] } {
    return 'and' in c && Array.isArray((c as any).and);
}

/** A non-null object: the only shape a condition (or a compound entry) can have. */
function isConditionObject(c: unknown): c is object {
    return typeof c === 'object' && c !== null;
}

/**
 * Resolves a field value from record data, supporting dot-notation for nested properties.
 *
 * PostgREST embeds FK data as objects: `status_id: {id: 1, status_key: "preparing", ...}`.
 * For dot-notation fields like "status_id.status_key", traverses the path.
 * For plain fields with embedded FK objects, extracts the .id for backward compatibility.
 */
export function resolveFieldValue(data: Record<string, any>, field: string): any {
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
 * How `eq`, `ne` (`neq`) and `in` compare the record value with the condition value.
 * - `strict` (entity actions): `===`, so `5` does not equal `'5'`.
 * - `string` (guided forms): both sides are compared as strings, because guided-form
 *   condition values are stored as text (`'7'` matches a record value of `7`);
 *   a missing or null record value compares as null.
 * Ordering operators (`gt`, `lt`, `gte`, `lte`) are always number-only.
 *
 * @consumer app
 */
export type ConditionCoercion = 'strict' | 'string';

/**
 * @consumer app
 */
export interface EvaluateConditionOptions {
    /** Defaults to `strict`. */
    coercion?: ConditionCoercion;
    /** Called with the operator when it is not recognized (core has no console). */
    onUnknownOperator?: (operator: unknown) => void;
}

/** Comparison form of a value under the `string` coercion: null for missing/null, else its text. */
function asText(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
}

/**
 * The one condition evaluator (F-16), shared by entity actions (strict) and guided
 * forms (string coercion). It is total: it never throws, and anything it cannot
 * evaluate fails closed (C-06).
 *
 * - No condition (null, undefined or any falsy value) is true; a condition with no
 *   data is false.
 * - A scalar condition, a non-object entry inside `or` / `and`, a condition whose
 *   `field` is not a string, a non-array `or` / `and` and an unknown operator are
 *   false, so `{or: [null]}` cannot enable anything.
 * - `neq` is an alias of `ne`. `ne` / `neq` against null follows the strict rule:
 *   a null record value is not unequal to null.
 *
 * Supports simple conditions and compound or/and conditions:
 * - Simple: { field: 'status_id', operator: 'eq', value: 1 }
 * - OR: { or: [{ field: 'status_id', operator: 'eq', value: 1 }, { field: 'status_id', operator: 'eq', value: 2 }] }
 * - AND: { and: [{ field: 'amount', operator: 'gt', value: 0 }, { field: 'status_id', operator: 'eq', value: 1 }] }
 *
 * @consumer app
 * @param condition - The condition to evaluate (null/undefined = always true)
 * @param data - The record data to evaluate against
 * @returns true if condition is met or no condition specified
 */
export function evaluateCondition(
    condition: unknown,
    data: Record<string, any> | null | undefined,
    options: EvaluateConditionOptions = {}
): boolean {
    // No condition means always true
    if (!condition) {
        return true;
    }

    // No data means condition cannot be evaluated - return false for safety
    if (!data) {
        return false;
    }

    return evaluateEntry(condition, data, options);
}

function evaluateEntry(condition: unknown, data: Record<string, any>, options: EvaluateConditionOptions): boolean {
    // Only an absent top-level condition means "always"; a scalar or null entry is malformed
    if (!isConditionObject(condition)) {
        return false;
    }

    // Handle compound OR condition
    if (isOrCondition(condition)) {
        return condition.or.some(sub => evaluateEntry(sub, data, options));
    }

    // Handle compound AND condition
    if (isAndCondition(condition)) {
        return condition.and.every(sub => evaluateEntry(sub, data, options));
    }

    const simple = condition as { field?: unknown; operator?: unknown; value?: any };
    if (typeof simple.field !== 'string') {
        return false;
    }

    // Get field value, handling dot-notation for nested properties and
    // embedded FK objects (Status, ForeignKey types).
    // Dot-notation like "status_id.status_key" traverses into PostgREST embedded
    // objects: data.status_id = {id: 1, status_key: "preparing", ...}
    const fieldValue = resolveFieldValue(data, simple.field);
    const text = options.coercion === 'string';

    switch (simple.operator) {
        case 'eq':
            return text ? asText(fieldValue) === asText(simple.value) : fieldValue === simple.value;
        case 'ne':
        case 'neq':
            return text ? asText(fieldValue) !== asText(simple.value) : fieldValue !== simple.value;
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
                   (text
                       ? simple.value.some(v => asText(v) === asText(fieldValue))
                       : simple.value.includes(fieldValue));
        case 'is_null':
            return fieldValue === null || fieldValue === undefined;
        case 'is_not_null':
            return fieldValue !== null && fieldValue !== undefined;
        default:
            // Unknown operator - return false for safety
            options.onUnknownOperator?.(simple.operator);
            return false;
    }
}

/**
 * Evaluates an entity-action condition against record data (strict equality).
 * See {@link evaluateCondition} for the rules.
 *
 * Core has no console, so an unknown operator is reported through the optional
 * `onUnknownOperator` callback (the app passes one that calls console.warn).
 *
 * @consumer app
 */
export function evaluateActionCondition(
    condition: ActionCondition | null | undefined,
    data: Record<string, any> | null | undefined,
    onUnknownOperator?: (operator: unknown) => void
): boolean {
    return evaluateCondition(condition, data, { coercion: 'strict', onUnknownOperator });
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
    if (!isConditionObject(condition)) return [];

    if (isOrCondition(condition)) {
        return condition.or.flatMap(sub => extractConditionFieldNames(sub as ActionCondition));
    }
    if (isAndCondition(condition)) {
        return condition.and.flatMap(sub => extractConditionFieldNames(sub as ActionCondition));
    }

    const field = (condition as SimpleCondition).field;
    // A malformed entry (no string field) references nothing; the evaluator fails it closed.
    if (typeof field !== 'string') return [];
    // Dot-notation: only the base column (before first dot) needs to be in the select.
    // The nested property (e.g. status_key) comes from the FK embed automatically.
    return [field.includes('.') ? field.split('.')[0] : field];
}
