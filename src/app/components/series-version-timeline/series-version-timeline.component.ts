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

import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SeriesVersionSummary } from '../../interfaces/entity';

/**
 * Series Version Timeline Component
 *
 * Displays a visual timeline of series versions within a group.
 * Shows effective date ranges, highlights current version, and allows selection.
 *
 * Usage:
 * ```html
 * <app-series-version-timeline
 *   [versions]="group.versions"
 *   [currentVersionId]="selectedVersionId"
 *   (versionSelect)="onVersionSelect($event)"
 * ></app-series-version-timeline>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-series-version-timeline',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="series-timeline">
      @if (versions.length === 0) {
        <p class="text-base-content/70 text-sm">No versions available</p>
      } @else if (versions.length === 1) {
        <!-- Single version - simplified display -->
        <div class="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
          <span class="material-symbols-outlined text-primary">schedule</span>
          <div>
            <p class="font-medium">{{ versions[0].rrule_description || 'Recurring Schedule' }}</p>
            <p class="text-sm text-base-content/70">
              Started {{ formatDate(versions[0].dtstart) }}
              @if (versions[0].expanded_until) {
                · Scheduled through {{ formatDate(versions[0].expanded_until) }}
              }
            </p>
          </div>
        </div>
      } @else {
        <!-- Multiple versions - timeline display -->
        <div class="relative">
          <!-- Timeline line -->
          <div class="absolute left-4 top-0 bottom-0 w-0.5 bg-base-300"></div>

          @for (version of versions; track version.series_id; let i = $index; let last = $last) {
            <div
              class="relative flex items-start gap-4 pb-4 cursor-pointer hover:bg-base-200/50 rounded-lg p-2 -ml-2 transition-colors"
              [class.bg-primary/10]="version.series_id === currentVersionId"
              (click)="selectVersion(version)"
            >
              <!-- Timeline dot -->
              <div class="relative z-10 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                   [class.bg-primary]="version.series_id === currentVersionId || isCurrentVersion(version)"
                   [class.bg-base-300]="version.series_id !== currentVersionId && !isCurrentVersion(version)">
                @if (isCurrentVersion(version)) {
                  <span class="material-symbols-outlined text-primary-content text-sm">radio_button_checked</span>
                } @else if (version.terminated_at) {
                  <span class="material-symbols-outlined text-base-content/50 text-sm">history</span>
                } @else {
                  <span class="material-symbols-outlined text-base-content/70 text-sm">schedule</span>
                }
              </div>

              <!-- Version info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium">Version {{ versions.length - i }}</span>
                  @if (isCurrentVersion(version)) {
                    <span class="badge badge-primary badge-sm">Current</span>
                  }
                  @if (version.terminated_at) {
                    <span class="badge badge-ghost badge-sm">Ended</span>
                  }
                </div>

                <p class="text-sm text-base-content/70 mt-1">
                  {{ version.rrule_description || describeRRule(version.rrule) }}
                </p>

                <p class="text-xs text-base-content/50 mt-1">
                  {{ formatDate(version.dtstart) }}
                  @if (version.terminated_at) {
                    – {{ formatDate(version.terminated_at) }}
                  } @else if (version.expanded_until) {
                    – present (through {{ formatDate(version.expanded_until) }})
                  } @else {
                    – present
                  }
                </p>

                @if (version.instance_count !== undefined) {
                  <p class="text-xs text-base-content/50">
                    {{ version.instance_count }} occurrence(s)
                  </p>
                }
              </div>

              <!-- Selection indicator -->
              @if (version.series_id === currentVersionId) {
                <span class="material-symbols-outlined text-primary">chevron_right</span>
              }
            </div>
          }
        </div>
      }
    </div>
  `
})
export class SeriesVersionTimelineComponent {
  @Input() versions: SeriesVersionSummary[] = [];
  @Input() currentVersionId?: number;

  @Output() versionSelect = new EventEmitter<SeriesVersionSummary>();

  /**
   * Check if this version is the current active version (not terminated).
   */
  isCurrentVersion(version: SeriesVersionSummary): boolean {
    return !version.terminated_at;
  }

  selectVersion(version: SeriesVersionSummary): void {
    this.versionSelect.emit(version);
  }

  formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  /**
   * Basic RRULE description for fallback display.
   */
  describeRRule(rrule: string): string {
    if (!rrule) return 'Recurring';

    const parts = rrule.split(';');
    const freq = parts.find(p => p.startsWith('FREQ='))?.split('=')[1];

    switch (freq) {
      case 'DAILY': return 'Daily';
      case 'WEEKLY': return 'Weekly';
      case 'MONTHLY': return 'Monthly';
      case 'YEARLY': return 'Yearly';
      default: return 'Recurring';
    }
  }
}
