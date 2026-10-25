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

import { inject, Injectable } from '@angular/core';
import { classifyPostgrestError, humanizeError } from '@civic-os/core';
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
   * Checks cached constraint_messages for user-friendly error text; for CHECK (23514)
   * and exclusion (23P01) violations without a configured message the fallback names
   * the raw constraint (E-03). Wording and classification live in @civic-os/core.
   */
  public parseToHumanWithLookup(err: ApiError): string {
    return ErrorService.humanize(err, this.schemaService.constraintMessages);
  }

  /**
   * Parse API error to human-readable message (static version, no tracking, no lookup).
   * Kept for backwards compatibility. Does NOT perform constraint message lookups.
   * Use parseToHumanWithLookup() instance method for full functionality.
   *
   * Note: Error string i18n deferred to Phase 2 to avoid circular dependency
   * (ErrorService → TranslationService → LocaleService → AuthService → DataService → ErrorService).
   */
  public static parseToHuman(err: ApiError): string {
    return ErrorService.humanize(err, undefined);
  }

  private static humanize(err: ApiError, constraintMessages: { constraint_name: string; error_message: string }[] | undefined): string {
    const message = humanizeError(err, { constraintMessages });
    // E-04: the UI shows only "System Error" for an unrecognized failure, so keep the full error in the console.
    if (classifyPostgrestError(err).kind === 'system') {
      console.error('[ErrorService] Unrecognized API error:', err);
    }
    return message;
  }
}
