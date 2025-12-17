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

import { Component, Input, Output, EventEmitter, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SeriesEditScope, SeriesMembership } from '../../interfaces/entity';

/**
 * Result of the exception editor modal.
 */
export interface ExceptionEditorResult {
  scope: SeriesEditScope;
  reason?: string;
}

/**
 * Exception Editor Component
 *
 * Modal dialog for selecting scope when editing/deleting a series occurrence.
 * Options: "This only", "This and future", "All occurrences"
 *
 * Usage:
 * ```html
 * <app-exception-editor
 *   [isOpen]="showScopeDialog"
 *   [membership]="seriesMembership"
 *   [operation]="'edit'"
 *   (confirm)="onScopeConfirm($event)"
 *   (cancel)="onScopeCancel()"
 * ></app-exception-editor>
 * ```
 *
 * Added in v0.19.0.
 */
@Component({
  selector: 'app-exception-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen) {
      <div class="modal modal-open">
        <div class="modal-box max-w-md">
          <h3 class="font-bold text-lg mb-4">
            @if (operation === 'edit') {
              Edit Recurring Event
            } @else if (operation === 'delete') {
              Delete Recurring Event
            } @else {
              Recurring Event
            }
          </h3>

          @if (membership) {
            <div class="mb-4 p-3 bg-base-200 rounded-lg">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-info">repeat</span>
                <span class="font-medium">{{ membership.group_name }}</span>
              </div>
              @if (membership.occurrence_date) {
                <p class="text-sm text-base-content/70 mt-1">
                  Occurrence: {{ formatDate(membership.occurrence_date) }}
                </p>
              }
            </div>
          }

          <p class="mb-4">
            @if (operation === 'edit') {
              How do you want to apply this change?
            } @else if (operation === 'delete') {
              What do you want to delete?
            }
          </p>

          <div class="space-y-3">
            <!-- This Only -->
            <label class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-base-200 transition-colors"
                   [class.border-primary]="selectedScope() === 'this_only'"
                   [class.bg-primary/5]="selectedScope() === 'this_only'">
              <input
                type="radio"
                class="radio radio-primary mt-1"
                name="scope"
                value="this_only"
                [checked]="selectedScope() === 'this_only'"
                (change)="selectScope('this_only')"
              />
              <div>
                <span class="font-medium block">This occurrence only</span>
                <span class="text-sm text-base-content/70">
                  @if (operation === 'edit') {
                    Changes will only affect this single event
                  } @else {
                    Only this occurrence will be deleted
                  }
                </span>
              </div>
            </label>

            <!-- This and Future -->
            <label class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-base-200 transition-colors"
                   [class.border-primary]="selectedScope() === 'this_and_future'"
                   [class.bg-primary/5]="selectedScope() === 'this_and_future'">
              <input
                type="radio"
                class="radio radio-primary mt-1"
                name="scope"
                value="this_and_future"
                [checked]="selectedScope() === 'this_and_future'"
                (change)="selectScope('this_and_future')"
              />
              <div>
                <span class="font-medium block">This and future occurrences</span>
                <span class="text-sm text-base-content/70">
                  @if (operation === 'edit') {
                    Changes will apply to this and all future events
                  } @else {
                    This and all future occurrences will be deleted
                  }
                </span>
              </div>
            </label>

            <!-- All -->
            <label class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-base-200 transition-colors"
                   [class.border-primary]="selectedScope() === 'all'"
                   [class.bg-primary/5]="selectedScope() === 'all'">
              <input
                type="radio"
                class="radio radio-primary mt-1"
                name="scope"
                value="all"
                [checked]="selectedScope() === 'all'"
                (change)="selectScope('all')"
              />
              <div>
                <span class="font-medium block">All occurrences</span>
                <span class="text-sm text-base-content/70">
                  @if (operation === 'edit') {
                    Changes will apply to all events in this series
                  } @else {
                    The entire recurring series will be deleted
                  }
                </span>
              </div>
            </label>
          </div>

          <!-- Reason (for delete) -->
          @if (operation === 'delete' && selectedScope() === 'this_only') {
            <div class="form-control mt-4">
              <label class="label">
                <span class="label-text">Reason (optional)</span>
              </label>
              <textarea
                class="textarea textarea-bordered"
                rows="2"
                placeholder="Why is this occurrence being cancelled?"
                [ngModel]="reason()"
                (ngModelChange)="reason.set($event)"
              ></textarea>
            </div>
          }

          <div class="modal-action">
            <button class="btn btn-ghost" (click)="onCancel()">Cancel</button>
            <button
              class="btn"
              [class.btn-error]="operation === 'delete'"
              [class.btn-primary]="operation !== 'delete'"
              (click)="onConfirm()"
            >
              @if (operation === 'delete') {
                Delete
              } @else {
                Apply Changes
              }
            </button>
          </div>
        </div>
        <div class="modal-backdrop" (click)="onCancel()"></div>
      </div>
    }
  `
})
export class ExceptionEditorComponent {
  @Input() isOpen = false;
  @Input() membership?: SeriesMembership;
  @Input() operation: 'edit' | 'delete' = 'edit';

  @Output() confirm = new EventEmitter<ExceptionEditorResult>();
  @Output() cancel = new EventEmitter<void>();

  selectedScope = signal<SeriesEditScope>('this_only');
  reason = signal('');

  selectScope(scope: SeriesEditScope): void {
    this.selectedScope.set(scope);
  }

  onConfirm(): void {
    this.confirm.emit({
      scope: this.selectedScope(),
      reason: this.reason() || undefined
    });
    this.reset();
  }

  onCancel(): void {
    this.cancel.emit();
    this.reset();
  }

  formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  private reset(): void {
    this.selectedScope.set('this_only');
    this.reason.set('');
  }
}
