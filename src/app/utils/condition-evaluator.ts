/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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
import { evaluateActionCondition, extractConditionFieldNames as coreExtractConditionFieldNames } from '@civic-os/core';

/**
 * Evaluates a condition against record data (entity action visibility/enabled
 * conditions). Logic lives in @civic-os/core; this keeps the app signature and
 * the console.warn on an unknown operator.
 *
 * @param condition - The condition to evaluate (null/undefined = always true)
 * @param data - The record data to evaluate against
 * @returns true if condition is met or no condition specified
 */
export function evaluateCondition(
    condition: ActionCondition | null | undefined,
    data: Record<string, any> | null | undefined
): boolean {
    return evaluateActionCondition(condition, data, op => console.warn(`Unknown condition operator: ${op}`));
}

/**
 * Extracts all field names referenced in a condition (including nested or/and).
 * Dot-notation fields return only the base column. Delegates to @civic-os/core.
 */
export function extractConditionFieldNames(condition: ActionCondition | null | undefined): string[] {
    return coreExtractConditionFieldNames(condition);
}
