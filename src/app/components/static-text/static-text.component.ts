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

import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { MarkdownModule } from 'ngx-markdown';
import { StaticText } from '../../interfaces/entity';

/**
 * Static Text Component
 *
 * Renders markdown content blocks on Detail/Edit/Create pages.
 * Used for policies, headers, instructional text, and other static content
 * that needs to be interspersed with entity properties.
 *
 * Features:
 * - Full markdown support via ngx-markdown
 * - Automatic DOMPurify sanitization
 * - Prose styling for typography
 * - Works with RenderableItem union type
 *
 * @example
 * ```html
 * <app-static-text [staticText]="item"></app-static-text>
 * ```
 *
 * @since v0.17.0
 */
@Component({
  selector: 'app-static-text',
  standalone: true,
  imports: [MarkdownModule],
  template: `
    <div class="prose max-w-none">
      <markdown [data]="staticText().content"></markdown>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StaticTextComponent {
  /**
   * The static text item to render.
   * Contains markdown content and display configuration.
   */
  staticText = input.required<StaticText>();
}
