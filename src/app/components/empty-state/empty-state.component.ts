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

import { Component, inject, input, output } from '@angular/core';
import { AuthService } from '../../services/auth.service';

/**
 * EmptyStateComponent displays contextual messages when pages have no data.
 *
 * It provides different variants:
 * - Not logged in: Suggests logging in with a Login button
 * - No results (filtered): Suggests clearing filters
 * - No entries: Shows that data doesn't exist
 * - Record not found: For Detail/Edit pages when entity doesn't exist
 */
@Component({
  selector: 'app-empty-state',
  standalone: true,
  imports: [],
  template: `
    <div role="alert" class="alert justify-start" [class]="'alert-' + alertType()">
      <span class="material-symbols-outlined">{{ icon() }}</span>
      <div>
        <h3 class="font-bold">{{ title() }}</h3>
        <p class="text-sm">{{ message() }}</p>
      </div>
      @if (showLoginButton() && !auth.authenticated()) {
        <button class="btn btn-primary btn-sm" (click)="onLogin()">
          <span class="material-symbols-outlined text-lg">login</span>
          Log In
        </button>
      }
      @if (showClearFiltersButton()) {
        <button class="btn btn-outline btn-sm" (click)="clearFilters.emit()">
          Clear Filters
        </button>
      }
    </div>
  `
})
export class EmptyStateComponent {
  public auth = inject(AuthService);

  // Inputs
  icon = input<string>('info');
  title = input<string>('');
  message = input<string>('');
  alertType = input<'info' | 'warning' | 'error'>('info');
  showLoginButton = input<boolean>(false);
  showClearFiltersButton = input<boolean>(false);

  // Outputs
  clearFilters = output<void>();

  onLogin() {
    this.auth.login();
  }
}
