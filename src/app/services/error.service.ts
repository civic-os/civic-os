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

import { inject, Injectable } from '@angular/core';
import { ApiError } from '../interfaces/api';
import { AnalyticsService } from './analytics.service';
import { SchemaService } from './schema.service';

@Injectable({
  providedIn: 'root'
})
export class ErrorService {
  private analytics = inject(AnalyticsService);
  private schemaService = inject(SchemaService);

  /**
   * Parse API error to human-readable message with constraint message lookup and analytics tracking.
   * Looks up constraint violations in cached constraint_messages for user-friendly error display.
   * Use this instance method when possible for analytics support.
   */
  public parseToHumanWithTracking(err: ApiError): string {
    const message = this.parseToHumanWithLookup(err);

    // Track error with status code or PostgreSQL error code
    if (err.httpCode) {
      this.analytics.trackError(`HTTP ${err.httpCode}`, err.httpCode);
    } else if (err.code) {
      // Track PostgreSQL error codes as numeric if possible
      const numericCode = parseInt(err.code);
      if (!isNaN(numericCode)) {
        this.analytics.trackError(`PostgreSQL ${err.code}`, numericCode);
      } else {
        this.analytics.trackError(`PostgreSQL ${err.code}`);
      }
    } else {
      this.analytics.trackError(message);
    }

    return message;
  }

  /**
   * Parse API error to human-readable message with constraint message lookup.
   * Checks cached constraint_messages for user-friendly error text.
   * Handles both CHECK constraints (23514) and exclusion constraints (23P01).
   */
  public parseToHumanWithLookup(err: ApiError): string {
    // Handle constraint violations with lookup
    if (err.code === '23514' || err.code === '23P01') {
      // Extract constraint name from error details or message
      // PostgreSQL format examples:
      // CHECK: 'new row for relation "table_name" violates check constraint "constraint_name"'
      // Exclusion: 'conflicting key value violates exclusion constraint "constraint_name"'
      const constraintMatch = err.details?.match(/constraint "([^"]+)"/) || err.message?.match(/constraint "([^"]+)"/);

      if (constraintMatch && constraintMatch[1]) {
        const constraintName = constraintMatch[1];

        // Look up constraint message in cached data
        const constraintMessages = this.schemaService.constraintMessages;
        if (constraintMessages) {
          const messageEntry = constraintMessages.find(cm => cm.constraint_name === constraintName);
          if (messageEntry) {
            return messageEntry.error_message;
          }
        }

        // Fallback if no cached message found
        if (err.code === '23P01') {
          return `This conflicts with an existing record. Please check your input and try again.`;
        } else {
          return `Validation failed: ${constraintName}`;
        }
      }

      // Generic fallback if we can't extract constraint name
      return err.code === '23P01' ? 'This conflicts with an existing record.' : 'Validation failed';
    }

    // For all other errors, use the static method
    return ErrorService.parseToHuman(err);
  }

  /**
   * Parse API error to human-readable message (static version, no tracking, no lookup).
   * Kept for backwards compatibility. Does NOT perform constraint message lookups.
   * Use parseToHumanWithLookup() instance method for full functionality.
   */
  public static parseToHuman(err: ApiError): string {
    //https://postgrest.org/en/stable/references/errors.html
    if(err.code == '42501') {
      return "Permissions error";
    } else if(err.code == '23505') {
      return "Record must be unique";
    } else if(err.code == '23514') {
      return "Validation failed";
    } else if(err.code == '23P01') {
      return "This conflicts with an existing record.";
    } else if(err.httpCode == 404) {
      return "Resource not found";
    } else if(err.httpCode == 401) {
      return "Your session has expired. Please refresh the page to log in again.";
    }
    return "System Error";
  }
}
