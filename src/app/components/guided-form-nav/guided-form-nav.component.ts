/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { Component, input, output, computed, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GuidedFormService } from '../../services/guided-form.service';
import { GuidedFormContext, EffectiveGuidedFormStep } from '../../interfaces/guided-form';

/** Synthetic review step uses negative ID to avoid collision with real database IDs */
const REVIEW_STEP_ID = -1;
const REVIEW_STEP_ORDER = Number.MAX_SAFE_INTEGER;

@Component({
  selector: 'app-guided-form-nav',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './guided-form-nav.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GuidedFormNavComponent {
  private guidedFormService = inject(GuidedFormService);

  // Inputs — context provides all data; parentRecord for condition evaluation
  context = input.required<GuidedFormContext>();
  parentRecord = input<any>();
  entityDisplayName = input<string>();
  mode = input<'edit' | 'view'>('view');

  stepClick = output<string>();

  effectiveSteps = computed(() => {
    const ctx = this.context();
    if (!ctx) return [];

    const parent = this.parentRecord();

    // Evaluate conditions using service (skip_if / require_if)
    let effective = this.guidedFormService.getEffectiveSteps(ctx.steps, parent, ctx.progress);

    // If steps don't already include a parent step, prepend synthetic one
    const hasParentStep = effective.some(s => s.step_key === '__parent__');
    if (!hasParentStep) {
      const parentStep: EffectiveGuidedFormStep = {
        id: 0,
        guided_form_key: ctx.definition.guided_form_key,
        step_key: '__parent__',
        display_name: this.entityDisplayName() || ctx.definition.guided_form_key,
        description: null,
        step_table: ctx.definition.parent_table,
        parent_fk_column: null,
        step_order: 0,
        can_skip: false,
        track_key: null,
        conditions: [],
        isSkipped: false,
        isCompleted: ctx.progress.some(p => p.step_key === '__parent__'),
        isRequired: true
      };
      effective.unshift(parentStep);
    }

    // Hide skipped steps from nav (except parent which is never skipped)
    effective = effective.filter(s => s.step_key === '__parent__' || !s.isSkipped);

    // Always append synthetic review step so users see the full journey
    if (!effective.some(s => s.step_key === '__review__')) {
      effective.push({
        id: REVIEW_STEP_ID,
        guided_form_key: ctx.definition.guided_form_key,
        step_key: '__review__',
        display_name: 'Review & Submit',
        description: null,
        step_table: ctx.definition.parent_table,
        parent_fk_column: null,
        step_order: REVIEW_STEP_ORDER,
        can_skip: false,
        track_key: null,
        conditions: [],
        isSkipped: false,
        isCompleted: ctx.parent_status_key === 'submitted',
        isRequired: true
      });
    }

    return effective;
  });

  onStepClick(step: EffectiveGuidedFormStep): void {
    if (!this.isStepClickable(step)) return;
    this.stepClick.emit(step.step_key);
  }

  isStepClickable(step: EffectiveGuidedFormStep): boolean {
    if (step.step_key === '__review__') {
      // Review is clickable only when all non-skipped data steps are complete
      const dataSteps = this.effectiveSteps().filter(
        s => s.step_key !== '__parent__' && s.step_key !== '__review__' && !s.isSkipped
      );
      return dataSteps.length === 0 || dataSteps.every(s => s.isCompleted);
    }
    if (this.mode() === 'edit') return !step.isSkipped;
    // View mode: completed steps always clickable
    if (step.isCompleted && !step.isSkipped) return true;
    // View mode + draft form: uncompleted non-skipped steps also clickable (resume)
    if (this.context().parent_status_key === 'draft' && !step.isSkipped) return true;
    return false;
  }

  /** Map of step_key → visible step number (skipped steps don't consume a number). */
  private stepNumbers = computed(() => {
    const map = new Map<string, number>();
    let n = 1;
    for (const step of this.effectiveSteps()) {
      if (!step.isSkipped) {
        map.set(step.step_key, n++);
      }
    }
    return map;
  });

  /** Content shown inside the DaisyUI step circle via data-content. */
  stepContent(step: EffectiveGuidedFormStep): string {
    if (step.isCompleted) return '✓';
    if (step.isSkipped) return '-';
    return String(this.stepNumbers().get(step.step_key) ?? '');
  }
}
