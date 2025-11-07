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

import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { APP_VERSION } from '../../config/version';
import { getApiDocsUrl } from '../../config/runtime';

/**
 * About modal component displaying application version and information.
 *
 * Displays:
 * - App name and version
 * - License and copyright
 * - GitHub repository link
 * - API documentation link (PostgREST OpenAPI)
 */
@Component({
  selector: 'app-about-modal',
  imports: [],
  templateUrl: './about-modal.component.html',
  styleUrl: './about-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AboutModalComponent {
  // Input: Control visibility of modal
  showModal = input.required<boolean>();

  // Output: Notify parent to close modal
  closeModal = output<void>();

  // App version from version.ts
  readonly appVersion = APP_VERSION;

  // License information
  readonly license = 'AGPL-3.0-or-later';
  readonly copyright = '© 2023-2025 Civic OS, L3C';

  // External links
  readonly githubUrl = 'https://github.com/civic-os/civic-os';
  readonly apiDocsUrl = getApiDocsUrl(); // Swagger UI for interactive API documentation

  /**
   * Close the modal.
   * Emits closeModal event to parent component.
   */
  close(): void {
    this.closeModal.emit();
  }
}
