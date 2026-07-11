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

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Accessible loading spinner.
 *
 * Wraps DaisyUI's `loading loading-spinner` in a `role="status"` region with
 * translated screen-reader text, so page/section-level loading states are
 * announced to assistive technology instead of appearing as silent motion.
 *
 * The visual spinner is marked `aria-hidden`; the accessible name comes from the
 * `sr-only` text (default `a11y.loading`, overridable via the `label` input).
 *
 * Usage:
 *   <app-loading-indicator />                 <!-- md spinner, "Loading" -->
 *   <app-loading-indicator size="lg" />
 *   <app-loading-indicator [label]="'list.loading_records' | translate" />
 */
@Component({
  selector: 'app-loading-indicator',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span role="status" class="inline-flex items-center">
      <span class="loading loading-spinner" [class]="sizeClass()" aria-hidden="true"></span>
      <span class="sr-only">{{ label() || ('a11y.loading' | translate) }}</span>
    </span>
  `,
})
export class LoadingIndicatorComponent {
  /** Spinner size, mapped to DaisyUI `loading-*` classes. */
  size = input<'xs' | 'sm' | 'md' | 'lg'>('md');

  /** Optional pre-translated label overriding the default "Loading" sr-only text. */
  label = input<string>('');

  protected sizeClass = computed(() => `loading-${this.size()}`);
}
