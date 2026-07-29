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
  selector: 'app-pwa-update-toast',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pwa.showUpdateToast()) {
      <div class="fixed bottom-4 end-4 z-50 alert alert-info shadow-lg w-auto" role="status">
        <span class="material-symbols-outlined" aria-hidden="true">system_update</span>
        <span>{{ 'pwa.update_available' | translate }}</span>
        <button type="button" class="btn btn-primary btn-sm" (click)="pwa.reloadForUpdate()">
          {{ 'pwa.update_reload' | translate }}
        </button>
      </div>
    }
  `
})
export class PwaUpdateToastComponent {
  readonly pwa = inject(PwaService);
}
