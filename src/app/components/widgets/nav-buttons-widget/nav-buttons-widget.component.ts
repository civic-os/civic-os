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

import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DashboardWidget, NavButtonsWidgetConfig } from '../../../interfaces/dashboard';

/**
 * Navigation Buttons Widget Component
 *
 * Displays a flexible set of navigation buttons with optional header and description.
 * Supports configurable button styles (primary, secondary, outline, etc.) and icons.
 */
@Component({
  selector: 'app-nav-buttons-widget',
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './nav-buttons-widget.component.html',
  styleUrl: './nav-buttons-widget.component.css'
})
export class NavButtonsWidgetComponent {
  // Widget configuration from parent dashboard
  widget = input.required<DashboardWidget>();

  // Typed configuration (extract from JSONB config)
  config = computed<NavButtonsWidgetConfig>(() => {
    return this.widget().config as NavButtonsWidgetConfig;
  });

  /**
   * Get the DaisyUI button class based on the variant
   */
  getButtonClass(variant?: string): string {
    const baseClass = 'btn';

    switch (variant) {
      case 'primary':
        return `${baseClass} btn-primary`;
      case 'secondary':
        return `${baseClass} btn-secondary`;
      case 'accent':
        return `${baseClass} btn-accent`;
      case 'ghost':
        return `${baseClass} btn-ghost`;
      case 'link':
        return `${baseClass} btn-link`;
      case 'outline':
      default:
        return `${baseClass} btn-outline`;
    }
  }
}
