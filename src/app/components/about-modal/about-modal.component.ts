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

import { Component, ChangeDetectionStrategy, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { DomainVersionInfo } from '@civic-os/core';
import { APP_VERSION } from '../../config/version';
import { getApiDocsUrl } from '../../config/runtime';
import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { SchemaService } from '../../services/schema.service';

/**
 * About modal component displaying application version and information.
 *
 * Displays:
 * - App name and version, plus the instance's domain and framework versions (loaded when the modal opens;
 *   hidden on instances older than v0.77.0, which have no version record)
 * - License and copyright
 * - GitHub repository link
 * - API documentation link (PostgREST OpenAPI)
 */
@Component({
  selector: 'app-about-modal',
  imports: [CosModalComponent, TranslatePipe],
  templateUrl: './about-modal.component.html',
  styleUrl: './about-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AboutModalComponent {
  // Input: Control visibility of modal
  showModal = input.required<boolean>();

  // Output: Notify parent to close modal
  closeModal = output<void>();

  private readonly schema = inject(SchemaService);
  private versionRequest?: Subscription;

  // Instance versions; undefined until loaded and on instances without the version record
  readonly instanceVersions = signal<DomainVersionInfo | undefined>(undefined);

  // App version from version.ts
  readonly appVersion = APP_VERSION;

  // License information
  readonly license = 'AGPL-3.0-or-later';
  readonly copyright = '© 2023-2025 Civic OS, L3C';

  // External links
  readonly githubUrl = 'https://github.com/civic-os/civic-os';
  readonly apiDocsUrl = getApiDocsUrl(); // Swagger UI for interactive API documentation

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.versionRequest?.unsubscribe());
    // Refresh the instance versions each time the modal opens
    effect(() => {
      if (this.showModal()) {
        untracked(() => this.loadInstanceVersions());
      }
    });
  }

  private loadInstanceVersions(): void {
    this.versionRequest?.unsubscribe();
    this.versionRequest = this.schema.getDomainVersion().subscribe(info => this.instanceVersions.set(info));
  }

  /**
   * Close the modal.
   * Emits closeModal event to parent component.
   */
  close(): void {
    this.closeModal.emit();
  }
}
