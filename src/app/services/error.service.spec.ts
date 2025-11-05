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

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ErrorService } from './error.service';
import { AnalyticsService } from './analytics.service';
import { SchemaService } from './schema.service';
import { ApiError, ConstraintMessage } from '../interfaces/api';

describe('ErrorService', () => {
  let service: ErrorService;
  let mockAnalyticsService: jasmine.SpyObj<AnalyticsService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;

  beforeEach(() => {
    mockAnalyticsService = jasmine.createSpyObj('AnalyticsService', ['trackError']);
    mockSchemaService = jasmine.createSpyObj('SchemaService', ['getConstraintMessages']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AnalyticsService, useValue: mockAnalyticsService },
        { provide: SchemaService, useValue: mockSchemaService }
      ]
    });
    service = TestBed.inject(ErrorService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('parseToHuman()', () => {
    it('should return permissions error for code 42501', () => {
      const error: ApiError = {
        code: '42501',
        httpCode: 403,
        message: 'insufficient_privilege',
        details: '',
        humanMessage: 'Permissions error'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('Permissions error');
    });

    it('should return unique constraint error for code 23505', () => {
      const error: ApiError = {
        code: '23505',
        httpCode: 409,
        message: 'duplicate key value',
        details: '',
        humanMessage: 'Could not update'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('Record must be unique');
    });

    it('should return validation error for code 23514', () => {
      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'check constraint violated',
        details: '',
        humanMessage: 'Could not update'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('Validation failed');
    });

    it('should return generic validation message for CHECK violations (no extraction)', () => {
      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'new row violates check constraint "price_positive"',
        details: 'Failing row contains (1, "Product", -10.00)',
        humanMessage: 'Could not update'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('Validation failed');
    });

    it('should return not found error for HTTP 404', () => {
      const error: ApiError = {
        httpCode: 404,
        message: 'Resource not found',
        details: '',
        humanMessage: 'Not found'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('Resource not found');
    });

    it('should return session expired error for HTTP 401', () => {
      const error: ApiError = {
        httpCode: 401,
        message: 'Session expired',
        details: '',
        humanMessage: 'Session Expired'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('Your session has expired. Please refresh the page to log in again.');
    });

    it('should return generic error for unknown error codes', () => {
      const error: ApiError = {
        httpCode: 500,
        message: 'Internal server error',
        details: '',
        humanMessage: 'System Error'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('System Error');
    });

    it('should return conflict error for exclusion constraint 23P01', () => {
      const error: ApiError = {
        code: '23P01',
        httpCode: 409,
        message: 'conflicting key value violates exclusion constraint',
        details: '',
        humanMessage: 'Conflict'
      };

      const result = ErrorService.parseToHuman(error);
      expect(result).toBe('This conflicts with an existing record.');
    });
  });

  describe('parseToHumanWithLookup()', () => {
    it('should lookup and return user-friendly message for CHECK constraint violation', () => {
      const constraintMessages: ConstraintMessage[] = [
        {
          constraint_name: 'price_positive',
          table_name: 'products',
          column_name: 'price',
          error_message: 'Price must be greater than zero'
        }
      ];
      mockSchemaService.constraintMessages = constraintMessages;

      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'new row for relation "products" violates check constraint "price_positive"',
        details: 'Failing row contains (1, "Product", -10.00)',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('Price must be greater than zero');
    });

    it('should lookup and return user-friendly message for exclusion constraint violation', () => {
      const constraintMessages: ConstraintMessage[] = [
        {
          constraint_name: 'no_overlapping_reservations',
          table_name: 'reservations',
          column_name: 'time_slot',
          error_message: 'This time slot is already booked. Please select a different time.'
        }
      ];
      mockSchemaService.constraintMessages = constraintMessages;

      const error: ApiError = {
        code: '23P01',
        httpCode: 409,
        message: 'conflicting key value violates exclusion constraint "no_overlapping_reservations"',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('This time slot is already booked. Please select a different time.');
    });

    it('should return fallback message when constraint message is not found in cache', () => {
      mockSchemaService.constraintMessages = [
        {
          constraint_name: 'other_constraint',
          table_name: 'other_table',
          column_name: 'other_column',
          error_message: 'Other message'
        }
      ];

      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'new row violates check constraint "unknown_constraint"',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('Validation failed: unknown_constraint');
    });

    it('should return generic fallback when constraint messages cache is undefined', () => {
      mockSchemaService.constraintMessages = undefined;

      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'new row violates check constraint "price_positive"',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('Validation failed: price_positive');
    });

    it('should return exclusion-specific fallback when constraint not found and code is 23P01', () => {
      mockSchemaService.constraintMessages = [];

      const error: ApiError = {
        code: '23P01',
        httpCode: 409,
        message: 'conflicting key value violates exclusion constraint "unknown_exclusion"',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('This conflicts with an existing record. Please check your input and try again.');
    });

    it('should return generic error when constraint name cannot be extracted', () => {
      mockSchemaService.constraintMessages = [];

      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'check constraint violated', // No constraint name in quotes
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('Validation failed');
    });

    it('should delegate to static parseToHuman for non-constraint errors', () => {
      const error: ApiError = {
        code: '42501',
        httpCode: 403,
        message: 'insufficient_privilege',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('Permissions error');
    });

    it('should extract constraint name from details field if not in message', () => {
      const constraintMessages: ConstraintMessage[] = [
        {
          constraint_name: 'email_format',
          table_name: 'users',
          column_name: 'email',
          error_message: 'Email must be in valid format'
        }
      ];
      mockSchemaService.constraintMessages = constraintMessages;

      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'new row violates constraint',
        details: 'Failing constraint "email_format"',
        humanMessage: ''
      };

      const result = service.parseToHumanWithLookup(error);
      expect(result).toBe('Email must be in valid format');
    });
  });

  describe('parseToHumanWithTracking()', () => {
    it('should call parseToHumanWithLookup and track error with HTTP code', () => {
      mockSchemaService.constraintMessages = [];

      const error: ApiError = {
        httpCode: 404,
        message: 'Not found',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithTracking(error);
      expect(result).toBe('Resource not found');
      expect(mockAnalyticsService.trackError).toHaveBeenCalledWith('HTTP 404', 404);
    });

    it('should call parseToHumanWithLookup and prioritize HTTP code in tracking', () => {
      mockSchemaService.constraintMessages = [];

      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'check constraint violated',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithTracking(error);
      expect(result).toBe('Validation failed');
      // When both httpCode and code are present, httpCode takes precedence in tracking
      expect(mockAnalyticsService.trackError).toHaveBeenCalledWith('HTTP 400', 400);
    });

    it('should use constraint message lookup when available', () => {
      const constraintMessages: ConstraintMessage[] = [
        {
          constraint_name: 'price_min',
          table_name: 'products',
          column_name: 'price',
          error_message: 'Price cannot be negative'
        }
      ];
      mockSchemaService.constraintMessages = constraintMessages;

      const error: ApiError = {
        code: '23514',
        httpCode: 400,
        message: 'violates check constraint "price_min"',
        details: '',
        humanMessage: ''
      };

      const result = service.parseToHumanWithTracking(error);
      expect(result).toBe('Price cannot be negative');
      // HTTP code takes precedence in tracking when both are present
      expect(mockAnalyticsService.trackError).toHaveBeenCalledWith('HTTP 400', 400);
    });
  });
});
