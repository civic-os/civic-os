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
import { MaintenanceService } from '../../services/maintenance.service';

@Component({
  selector: 'app-maintenance-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (maintenance.isAdminBypassing()) {
      <div class="alert alert-info gap-2 rounded-none" role="alert">
        <span class="material-symbols-outlined" aria-hidden="true">admin_panel_settings</span>
        <span>{{ maintenance.adminBypassMessage() }} ({{ maintenance.mode() }})</span>
      </div>
    } @else if (maintenance.isReadOnly()) {
      <div class="alert alert-warning gap-2 rounded-none" role="alert">
        <span class="material-symbols-outlined" aria-hidden="true">construction</span>
        <span>{{ maintenance.readonlyMessage() }}</span>
      </div>
    } @else if (maintenance.isFullMaintenance()) {
      <div class="alert alert-error gap-2 rounded-none" role="alert">
        <span class="material-symbols-outlined" aria-hidden="true">error</span>
        <span>{{ maintenance.fullMessage() }}</span>
      </div>
    }
  `
})
export class MaintenanceBannerComponent {
  readonly maintenance = inject(MaintenanceService);
}
