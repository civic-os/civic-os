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

import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslationService } from '../services/translation.service';

/**
 * Pipe that translates a key into the current locale's string.
 *
 * Usage:
 *   {{ 'nav.home' | translate }}
 *   {{ 'pagination.showing' | translate:{ start: 1, end: 10, total: 50 } }}
 *
 * This is an impure pipe — it re-evaluates when the translation version
 * signal changes (i.e., when locale switches or translations are loaded).
 * Despite being impure, it's lightweight: just a Map lookup + optional
 * string interpolation.
 */
@Pipe({
  name: 'translate',
  pure: false
})
export class TranslatePipe implements PipeTransform {
  private readonly translationService = inject(TranslationService);

  transform(key: string, params?: Record<string, string | number>): string {
    // Reading version() triggers re-evaluation when translations change
    this.translationService.version();
    return this.translationService.get(key, params);
  }
}
