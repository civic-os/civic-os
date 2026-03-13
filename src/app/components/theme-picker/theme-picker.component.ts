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

import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { ThemeService } from '../../services/theme.service';
import { RECOMMENDED_THEMES, detectAvailableThemes, themeNameToLabel } from '../../constants/themes';

interface ThemeItem {
  name: string;
  label: string;
}

@Component({
  selector: 'app-theme-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Current selection -->
    <div class="mb-4">
      <h4 class="text-sm font-semibold opacity-70 mb-2">Current</h4>
      <div class="rounded-lg ring-2 ring-primary p-1" [attr.data-theme]="themeService.theme()">
        <div class="flex items-center gap-2 p-2 rounded-md bg-base-100">
          <div class="flex gap-1">
            <span class="badge badge-sm bg-primary border-0 text-primary-content">A</span>
            <span class="badge badge-sm bg-secondary border-0 text-secondary-content">A</span>
            <span class="badge badge-sm bg-accent border-0 text-accent-content">A</span>
            <span class="badge badge-sm bg-neutral border-0 text-neutral-content">A</span>
          </div>
          <span class="text-sm font-medium text-base-content flex-1">{{ themeLabel(themeService.theme()) }}</span>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-success" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
          </svg>
        </div>
      </div>
    </div>

    <!-- Recommended themes -->
    <div class="mb-4">
      <h4 class="text-sm font-semibold opacity-70 mb-2">Recommended</h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        @for (theme of recommendedItems(); track theme.name) {
          <button
            class="rounded-lg p-1 cursor-pointer transition-all hover:scale-[1.02]"
            [class.ring-2]="themeService.theme() === theme.name"
            [class.ring-primary]="themeService.theme() === theme.name"
            (click)="selectTheme(theme.name)"
          >
            <div class="rounded-md p-2 bg-base-100 flex items-center gap-2" [attr.data-theme]="theme.name">
              <div class="flex gap-1">
                <span class="badge badge-xs bg-primary border-0"></span>
                <span class="badge badge-xs bg-secondary border-0"></span>
                <span class="badge badge-xs bg-accent border-0"></span>
                <span class="badge badge-xs bg-neutral border-0"></span>
              </div>
              <span class="text-xs text-base-content truncate">{{ theme.label }}</span>
            </div>
          </button>
        }
      </div>
    </div>

    <!-- All themes -->
    @if (otherItems().length > 0) {
      <div>
        <h4 class="text-sm font-semibold opacity-70 mb-2">All Colors</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          @for (theme of otherItems(); track theme.name) {
            <button
              class="rounded-lg p-1 cursor-pointer transition-all hover:scale-[1.02]"
              [class.ring-2]="themeService.theme() === theme.name"
              [class.ring-primary]="themeService.theme() === theme.name"
              (click)="selectTheme(theme.name)"
            >
              <div class="rounded-md p-2 bg-base-100 flex items-center gap-2" [attr.data-theme]="theme.name">
                <div class="flex gap-1">
                  <span class="badge badge-xs bg-primary border-0"></span>
                  <span class="badge badge-xs bg-secondary border-0"></span>
                  <span class="badge badge-xs bg-accent border-0"></span>
                  <span class="badge badge-xs bg-neutral border-0"></span>
                </div>
                <span class="text-xs text-base-content truncate">{{ theme.label }}</span>
              </div>
            </button>
          }
        </div>
      </div>
    }
  `
})
export class ThemePickerComponent {
  readonly themeService = inject(ThemeService);

  private readonly allThemes = signal<string[]>([]);

  /** Recommended themes filtered to those actually available in compiled CSS */
  readonly recommendedItems = computed<ThemeItem[]>(() => {
    const available = new Set(this.allThemes());
    return RECOMMENDED_THEMES
      .filter(name => available.has(name))
      .map(name => ({ name, label: themeNameToLabel(name) }));
  });

  /** All themes except recommended ones and the currently selected theme, sorted alphabetically */
  readonly otherItems = computed<ThemeItem[]>(() => {
    const recommendedSet = new Set(RECOMMENDED_THEMES);
    return this.allThemes()
      .filter(name => !recommendedSet.has(name))
      .map(name => ({ name, label: themeNameToLabel(name) }));
  });

  constructor() {
    this.allThemes.set(detectAvailableThemes());
  }

  selectTheme(name: string): void {
    this.themeService.setTheme(name);
  }

  themeLabel(name: string): string {
    return themeNameToLabel(name);
  }
}
