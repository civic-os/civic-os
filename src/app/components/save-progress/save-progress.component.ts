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

import { Component, ChangeDetectionStrategy, input, output, signal, effect, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';

/**
 * Result from executing a save step.
 */
export interface SaveStepResult {
  success: boolean;
  failedCount?: number;
  totalCount?: number;
  errorMessage?: string;
}

/**
 * Definition for a single step in the save pipeline.
 * Provided by the parent — SaveProgressComponent clones these into
 * internal signal-backed state for OnPush-safe rendering.
 *
 * @since v0.46.0
 */
export interface SaveStep {
  label: string;
  execute: () => Observable<SaveStepResult>;
  retryFailed?: () => Observable<SaveStepResult>;
}

/**
 * Internal step state tracked by SaveProgressComponent.
 * Separate from SaveStep to avoid mutating parent-owned objects.
 */
interface StepState {
  label: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  errorMessage?: string;
  failedCount?: number;
  totalCount?: number;
  execute: () => Observable<SaveStepResult>;
  retryFailed?: () => Observable<SaveStepResult>;
}

/**
 * Step-list UI showing live progress for a multi-step save pipeline.
 *
 * Owns the entire execution lifecycle:
 * - Auto-starts when `steps` input is set
 * - Drives steps sequentially (step N+1 starts only after step N succeeds)
 * - Handles errors with Retry/Skip controls
 * - Emits `completed` when all steps are done (success or skipped)
 *
 * Uses internal signal-backed state for OnPush-safe rendering.
 *
 * @since v0.46.0
 */
@Component({
  selector: 'app-save-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './save-progress.component.html',
})
export class SaveProgressComponent {
  private destroyRef = inject(DestroyRef);

  steps = input.required<SaveStep[]>();
  completed = output<void>();

  // Internal signal-backed step state (not mutating parent objects)
  stepStates = signal<StepState[]>([]);
  private started = false;

  allComplete = () => {
    const states = this.stepStates();
    return states.length > 0 && states.every(s => s.status === 'success' || s.status === 'skipped');
  };

  constructor() {
    // Auto-start when steps input is provided
    effect(() => {
      const steps = this.steps();
      if (steps.length > 0 && !this.started) {
        this.started = true;
        // Clone step definitions into internal state
        this.stepStates.set(steps.map(s => ({
          label: s.label,
          status: 'pending' as const,
          execute: s.execute,
          retryFailed: s.retryFailed
        })));
        this.runStep(0);
      }
    });
  }

  getIcon(status: string): string {
    switch (status) {
      case 'pending': return 'radio_button_unchecked';
      case 'running': return 'progress_activity';
      case 'success': return 'check_circle';
      case 'error': return 'error';
      case 'skipped': return 'skip_next';
      default: return 'radio_button_unchecked';
    }
  }

  getIconClass(status: string): string {
    switch (status) {
      case 'success': return 'text-success';
      case 'error': return 'text-error';
      case 'running': return 'text-primary animate-spin';
      case 'skipped': return 'text-warning';
      default: return 'text-base-content/30';
    }
  }

  onRetry(index: number) {
    const states = this.stepStates();
    const step = states[index];
    if (!step?.retryFailed) return;

    this.updateStep(index, { status: 'running', errorMessage: undefined });

    step.retryFailed().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        if (result.success) {
          this.updateStep(index, { status: 'success' });
          this.runStep(index + 1);
        } else {
          this.updateStep(index, {
            status: 'error',
            errorMessage: result.errorMessage,
            failedCount: result.failedCount,
            totalCount: result.totalCount
          });
        }
      },
      error: () => {
        this.updateStep(index, { status: 'error', errorMessage: 'An unexpected error occurred' });
      }
    });
  }

  onSkip(index: number) {
    this.updateStep(index, { status: 'skipped' });
    this.runStep(index + 1);
  }

  private runStep(index: number) {
    const states = this.stepStates();
    if (index >= states.length) {
      this.completed.emit();
      return;
    }

    const step = states[index];
    this.updateStep(index, { status: 'running' });

    step.execute().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        if (result.success) {
          this.updateStep(index, { status: 'success' });
          this.runStep(index + 1);
        } else {
          this.updateStep(index, {
            status: 'error',
            errorMessage: result.errorMessage,
            failedCount: result.failedCount,
            totalCount: result.totalCount
          });
        }
      },
      error: () => {
        this.updateStep(index, { status: 'error', errorMessage: 'An unexpected error occurred' });
      }
    });
  }

  /** Update a step's state immutably to trigger signal change detection */
  private updateStep(index: number, patch: Partial<StepState>) {
    this.stepStates.update(states => {
      const next = [...states];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }
}
