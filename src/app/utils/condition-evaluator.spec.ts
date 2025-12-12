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

import { evaluateCondition } from './condition-evaluator';
import { ActionCondition } from '../interfaces/entity';

describe('evaluateCondition', () => {
    const testData = {
        id: 123,
        status_id: 1,
        amount: 100,
        name: 'Test Record',
        is_active: true,
        deleted_at: null,
        created_at: '2024-01-15T10:00:00Z'
    };

    describe('null/undefined handling', () => {
        it('should return true when condition is null', () => {
            expect(evaluateCondition(null, testData)).toBe(true);
        });

        it('should return true when condition is undefined', () => {
            expect(evaluateCondition(undefined, testData)).toBe(true);
        });

        it('should return false when data is null', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'eq', value: 1 };
            expect(evaluateCondition(condition, null)).toBe(false);
        });

        it('should return false when data is undefined', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'eq', value: 1 };
            expect(evaluateCondition(condition, undefined)).toBe(false);
        });
    });

    describe('eq operator', () => {
        it('should return true when values are equal (number)', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'eq', value: 1 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when values are not equal (number)', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'eq', value: 2 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should return true when values are equal (string)', () => {
            const condition: ActionCondition = { field: 'name', operator: 'eq', value: 'Test Record' };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when values are not equal (string)', () => {
            const condition: ActionCondition = { field: 'name', operator: 'eq', value: 'Other' };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should return true when values are equal (boolean)', () => {
            const condition: ActionCondition = { field: 'is_active', operator: 'eq', value: true };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should handle strict equality (no type coercion)', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'eq', value: '1' };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('ne operator', () => {
        it('should return true when values are not equal', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'ne', value: 2 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when values are equal', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'ne', value: 1 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('gt operator', () => {
        it('should return true when field value is greater', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'gt', value: 50 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when field value is equal', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'gt', value: 100 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should return false when field value is less', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'gt', value: 150 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should return false for non-numeric values', () => {
            const condition: ActionCondition = { field: 'name', operator: 'gt', value: 50 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('lt operator', () => {
        it('should return true when field value is less', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'lt', value: 150 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when field value is equal', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'lt', value: 100 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should return false when field value is greater', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'lt', value: 50 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('gte operator', () => {
        it('should return true when field value is greater', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'gte', value: 50 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return true when field value is equal', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'gte', value: 100 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when field value is less', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'gte', value: 150 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('lte operator', () => {
        it('should return true when field value is less', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'lte', value: 150 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return true when field value is equal', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'lte', value: 100 };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when field value is greater', () => {
            const condition: ActionCondition = { field: 'amount', operator: 'lte', value: 50 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('in operator', () => {
        it('should return true when value is in array', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'in', value: [1, 2, 3] };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when value is not in array', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'in', value: [2, 3, 4] };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should return false when value is not an array', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'in', value: 1 };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should work with string arrays', () => {
            const condition: ActionCondition = { field: 'name', operator: 'in', value: ['Test Record', 'Other'] };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });
    });

    describe('is_null operator', () => {
        it('should return true when field is null', () => {
            const condition: ActionCondition = { field: 'deleted_at', operator: 'is_null' };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return true when field is undefined', () => {
            const condition: ActionCondition = { field: 'nonexistent_field', operator: 'is_null' };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when field has a value', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'is_null' };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('is_not_null operator', () => {
        it('should return true when field has a value', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'is_not_null' };
            expect(evaluateCondition(condition, testData)).toBe(true);
        });

        it('should return false when field is null', () => {
            const condition: ActionCondition = { field: 'deleted_at', operator: 'is_not_null' };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });

        it('should return false when field is undefined', () => {
            const condition: ActionCondition = { field: 'nonexistent_field', operator: 'is_not_null' };
            expect(evaluateCondition(condition, testData)).toBe(false);
        });
    });

    describe('unknown operator', () => {
        it('should return false for unknown operator', () => {
            const condition = { field: 'status_id', operator: 'unknown' as any, value: 1 };
            spyOn(console, 'warn');
            expect(evaluateCondition(condition, testData)).toBe(false);
            expect(console.warn).toHaveBeenCalled();
        });
    });

    describe('embedded FK objects (PostgREST embedded resources)', () => {
        // When FK columns like status_id are Status/ForeignKey types, PostgREST
        // embeds the related object: {id: 1, display_name: "Pending", color: "#..."}
        // instead of just the raw ID. Conditions should extract the .id for comparison.

        it('should extract id from embedded object for eq operator', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'eq', value: 1 };
            const dataWithEmbeddedStatus = {
                id: 123,
                status_id: { id: 1, display_name: 'Pending', color: '#22C55E' }
            };
            expect(evaluateCondition(condition, dataWithEmbeddedStatus)).toBe(true);
        });

        it('should extract id from embedded object for ne operator', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'ne', value: 2 };
            const dataWithEmbeddedStatus = {
                id: 123,
                status_id: { id: 1, display_name: 'Pending', color: '#22C55E' }
            };
            expect(evaluateCondition(condition, dataWithEmbeddedStatus)).toBe(true);
        });

        it('should extract id from embedded object for in operator', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'in', value: [1, 2] };
            const dataWithEmbeddedStatus = {
                id: 123,
                status_id: { id: 1, display_name: 'Pending', color: '#22C55E' }
            };
            expect(evaluateCondition(condition, dataWithEmbeddedStatus)).toBe(true);
        });

        it('should handle null embedded object', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'is_null' };
            const dataWithNullStatus = { id: 123, status_id: null };
            expect(evaluateCondition(condition, dataWithNullStatus)).toBe(true);
        });

        it('should still work with primitive values', () => {
            const condition: ActionCondition = { field: 'status_id', operator: 'eq', value: 1 };
            const dataWithPrimitiveStatus = { id: 123, status_id: 1 };
            expect(evaluateCondition(condition, dataWithPrimitiveStatus)).toBe(true);
        });
    });

    describe('real-world scenarios', () => {
        it('should evaluate pending status condition', () => {
            const pendingCondition: ActionCondition = { field: 'status_id', operator: 'eq', value: 1 };
            const pendingData = { status_id: 1, display_name: 'Pending Request' };
            const approvedData = { status_id: 2, display_name: 'Approved Request' };

            expect(evaluateCondition(pendingCondition, pendingData)).toBe(true);
            expect(evaluateCondition(pendingCondition, approvedData)).toBe(false);
        });

        it('should evaluate can-cancel condition (pending or approved)', () => {
            const canCancelCondition: ActionCondition = { field: 'status_id', operator: 'in', value: [1, 2] };
            const pendingData = { status_id: 1 };
            const approvedData = { status_id: 2 };
            const cancelledData = { status_id: 4 };

            expect(evaluateCondition(canCancelCondition, pendingData)).toBe(true);
            expect(evaluateCondition(canCancelCondition, approvedData)).toBe(true);
            expect(evaluateCondition(canCancelCondition, cancelledData)).toBe(false);
        });

        it('should evaluate not-cancelled visibility condition', () => {
            const notCancelledCondition: ActionCondition = { field: 'status_id', operator: 'ne', value: 4 };
            const pendingData = { status_id: 1 };
            const cancelledData = { status_id: 4 };

            expect(evaluateCondition(notCancelledCondition, pendingData)).toBe(true);
            expect(evaluateCondition(notCancelledCondition, cancelledData)).toBe(false);
        });
    });
});
