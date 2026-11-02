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

import { KeyFilterError } from '@civic-os/core';
import { TranslationService } from '../services/translation.service';

/**
 * The translated message for a widget's key filter failure, or undefined when `error` is
 * something else, so the widget keeps its own message for other failures.
 */
export function keyFilterMessage(error: unknown, translation: TranslationService): string | undefined {
  if (!(error instanceof KeyFilterError)) return undefined;
  switch (error.reason) {
    case 'unknown_key':
      return translation.get('dashboard.filter_unknown_key', { key: error.key ?? '', column: error.column });
    case 'unavailable':
      return translation.get('dashboard.filter_unavailable', { column: error.column });
    default:
      return translation.get('dashboard.filter_invalid', { column: error.column });
  }
}
