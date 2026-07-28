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

import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { PwaService } from '../../services/pwa.service';
import { TranslatePipe } from '../../pipes/translate.pipe';

@Component({
  selector: 'app-offline-banner',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!pwa.isOnline()) {
      <div class="alert alert-warning gap-2 rounded-none" role="alert">
        <span class="material-symbols-outlined" aria-hidden="true">wifi_off</span>
        <span>{{ 'pwa.offline_message' | translate }}</span>
      </div>
    }
  `
})
export class OfflineBannerComponent {
  readonly pwa = inject(PwaService);
}
