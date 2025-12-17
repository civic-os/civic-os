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

import { Component, Input, Output, EventEmitter, computed, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConflictInfo } from '../../interfaces/entity';

/**
 * Result of the conflict preview modal.
 */
export interface ConflictPreviewResult {
  action: 'create_all' | 'create_available' | 'cancel';
}

/**
 * Conflict Preview Component
 *
 * Modal dialog showing preview of recurring series conflicts before creation.
 * Displays color-coded list: green for available slots, red for conflicts.
 *
 * Usage:
 * ```html
 * <app-conflict-preview
 *   [isOpen]="showConflictPreview"
 *   [conflicts]="previewedConflicts"
 *   [loading]="loadingPreview"
 *   (confirm)="onConflictAction($event)"
 *   (cancel)="onCancelPreview()"
 * ></app-conflict-preview>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-conflict-preview',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen) {
      <div class="modal modal-open">
        <div class="modal-box max-w-2xl">
          <h3 class="font-bold text-lg mb-4">Schedule Preview</h3>

          @if (loading) {
            <div class="flex items-center justify-center py-8">
              <span class="loading loading-spinner loading-lg"></span>
              <span class="ml-3">Checking for conflicts...</span>
            </div>
          } @else {
            <!-- Summary -->
            <div class="flex gap-4 mb-4">
              <div class="stat bg-success/10 rounded-lg p-3 flex-1">
                <div class="stat-title text-sm">Available</div>
                <div class="stat-value text-success text-2xl">{{ availableCount() }}</div>
              </div>
              @if (conflictCount() > 0) {
                <div class="stat bg-error/10 rounded-lg p-3 flex-1">
                  <div class="stat-title text-sm">Conflicts</div>
                  <div class="stat-value text-error text-2xl">{{ conflictCount() }}</div>
                </div>
              }
            </div>

            @if (conflictCount() > 0) {
              <div class="alert alert-warning mb-4">
                <span class="material-symbols-outlined">warning</span>
                <span>{{ conflictCount() }} occurrence(s) conflict with existing schedules.</span>
              </div>
            }

            <!-- Occurrences List -->
            <div class="max-h-80 overflow-y-auto border rounded-lg">
              @for (item of conflicts; track item.occurrence_start) {
                <div class="flex items-center gap-3 p-3 border-b last:border-b-0"
                     [class.bg-success/5]="!item.has_conflict"
                     [class.bg-error/5]="item.has_conflict">
                  <!-- Status Icon -->
                  @if (item.has_conflict) {
                    <span class="material-symbols-outlined text-error">cancel</span>
                  } @else {
                    <span class="material-symbols-outlined text-success">check_circle</span>
                  }

                  <!-- Time Slot -->
                  <div class="flex-1">
                    <p class="font-medium">{{ formatTimeRange(item.occurrence_start, item.occurrence_end) }}</p>
                    @if (item.has_conflict && item.conflicting_display) {
                      <p class="text-sm text-base-content/70">
                        Conflicts with: {{ item.conflicting_display }}
                      </p>
                    }
                  </div>

                  <!-- Status Badge -->
                  @if (item.has_conflict) {
                    <span class="badge badge-error badge-sm">Conflict</span>
                  } @else {
                    <span class="badge badge-success badge-sm">Available</span>
                  }
                </div>
              } @empty {
                <div class="p-4 text-center text-base-content/70">
                  No occurrences to preview
                </div>
              }
            </div>
          }

          <div class="modal-action">
            <button class="btn btn-ghost" (click)="onCancel()">Cancel</button>

            @if (!loading && conflictCount() > 0) {
              <button
                class="btn btn-outline btn-primary"
                (click)="onAction('create_available')"
                [disabled]="availableCount() === 0"
              >
                Create {{ availableCount() }} Available
              </button>
            }

            @if (!loading) {
              <button
                class="btn btn-primary"
                (click)="onAction('create_all')"
                [disabled]="conflicts.length === 0"
              >
                @if (conflictCount() > 0) {
                  Create All (Skip Conflicts)
                } @else {
                  Create {{ availableCount() }} Occurrences
                }
              </button>
            }
          </div>
        </div>
        <div class="modal-backdrop" (click)="onCancel()"></div>
      </div>
    }
  `
})
export class ConflictPreviewComponent {
  @Input() isOpen = false;
  @Input() conflicts: ConflictInfo[] = [];
  @Input() loading = false;

  @Output() confirm = new EventEmitter<ConflictPreviewResult>();
  @Output() cancel = new EventEmitter<void>();

  // Computed counts
  availableCount = computed(() => {
    return this.conflicts.filter(c => !c.has_conflict).length;
  });

  conflictCount = computed(() => {
    return this.conflicts.filter(c => c.has_conflict).length;
  });

  /**
   * Format a time range for display.
   * Takes separate start and end ISO timestamps.
   */
  formatTimeRange(startStr: string, endStr: string): string {
    try {
      const start = new Date(startStr);
      const end = new Date(endStr);

      const dateOptions: Intl.DateTimeFormatOptions = {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      };
      const timeOptions: Intl.DateTimeFormatOptions = {
        hour: 'numeric',
        minute: '2-digit'
      };

      const startDate = start.toLocaleDateString(undefined, dateOptions);
      const startTime = start.toLocaleTimeString(undefined, timeOptions);
      const endTime = end.toLocaleTimeString(undefined, timeOptions);

      // Check if same day
      const endDate = end.toLocaleDateString(undefined, dateOptions);
      if (startDate === endDate) {
        return `${startDate}, ${startTime} - ${endTime}`;
      } else {
        return `${startDate} ${startTime} - ${endDate} ${endTime}`;
      }
    } catch {
      return `${startStr} - ${endStr}`;
    }
  }

  onAction(action: 'create_all' | 'create_available'): void {
    this.confirm.emit({ action });
  }

  onCancel(): void {
    this.cancel.emit();
  }
}
