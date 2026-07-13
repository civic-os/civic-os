/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { GuidedFormNavComponent } from './guided-form-nav.component';
import { GuidedFormService } from '../../services/guided-form.service';
import { GuidedFormDefinition, GuidedFormStep, GuidedFormProgressEntry, GuidedFormContext } from '../../interfaces/guided-form';

describe('GuidedFormNavComponent', () => {
  let component: GuidedFormNavComponent;
  let fixture: ComponentFixture<GuidedFormNavComponent>;
  let mockGuidedFormService: jasmine.SpyObj<GuidedFormService>;

  const mockDefinition: GuidedFormDefinition = {
    guided_form_key: 'test_guidedForm',
    description: null,
    parent_table: 'test_parent',
    ownership_column: 'created_by',
    lock_on_submit: false,
    on_submit_rpc: null,
    review_intro_text: null,
    precondition_rpc: null,
    auto_submit_on_all_skipped: false,
    is_enabled: true,
    status_options: []
  };

  const mockSteps: GuidedFormStep[] = [
    { id: 1, guided_form_key: 'test_guidedForm', step_key: 'step1', display_name: 'Step 1', description: null, step_table: 'test_step1', parent_fk_column: 'parent_id', step_order: 1, can_skip: false, track_key: null, conditions: [] },
    { id: 2, guided_form_key: 'test_guidedForm', step_key: 'step2', display_name: 'Step 2', description: null, step_table: 'test_step2', parent_fk_column: 'parent_id', step_order: 2, can_skip: true, track_key: null, conditions: [] }
  ];

  const mockProgress: GuidedFormProgressEntry[] = [
    { id: 1, guided_form_key: 'test_guidedForm', parent_id: 42, step_key: '__parent__', completed_at: '2026-01-01T00:00:00Z', completed_by: null, submitted_at: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 2, guided_form_key: 'test_guidedForm', parent_id: 42, step_key: 'step1', completed_at: '2026-01-01T00:00:00Z', completed_by: null, submitted_at: null, created_at: '2026-01-01T00:00:00Z' }
  ];

  const mockContext: GuidedFormContext = {
    definition: mockDefinition,
    steps: mockSteps,
    progress: mockProgress,
    status_options: [],
    parent_status_id: 1,
    parent_status_key: 'draft',
    parent_id: 42,
    record_id: 42,
    is_child_step: false,
    step_key: null,
    step_record_ids: { '__parent__': 42, 'step1': 10 }
  };

  beforeEach(async () => {
    mockGuidedFormService = jasmine.createSpyObj('GuidedFormService', ['getEffectiveSteps']);

    mockGuidedFormService.getEffectiveSteps.and.callFake((steps: GuidedFormStep[], parent: any, progress: GuidedFormProgressEntry[]) => {
      const progressSet = new Set(progress.map(p => p.step_key));
      return steps.map(step => ({
        ...step,
        isSkipped: false,
        isCompleted: progressSet.has(step.step_key),
        isRequired: !step.can_skip
      }));
    });

    await TestBed.configureTestingModule({
      imports: [GuidedFormNavComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: GuidedFormService, useValue: mockGuidedFormService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GuidedFormNavComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('context', mockContext);
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('effectiveSteps', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.detectChanges();
    });

    it('should prepend parent step, include non-skipped data steps, and always append review', () => {
      const effective = component.effectiveSteps();
      expect(effective.length).toBe(4); // parent + 2 steps + review (always shown)
      expect(effective[0].step_key).toBe('__parent__');
      expect(effective[1].step_key).toBe('step1');
      expect(effective[2].step_key).toBe('step2');
      expect(effective[3].step_key).toBe('__review__');
    });

    it('should use getEffectiveSteps with parentRecord for condition evaluation', () => {
      fixture.componentRef.setInput('parentRecord', { is_nonprofit: true });
      fixture.detectChanges();

      component.effectiveSteps();
      expect(mockGuidedFormService.getEffectiveSteps).toHaveBeenCalledWith(
        mockSteps,
        { is_nonprofit: true },
        mockProgress
      );
    });

    it('should mark parent step as completed when __parent__ is in progress', () => {
      const effective = component.effectiveSteps();
      const parentStep = effective.find(s => s.step_key === '__parent__');
      expect(parentStep?.isCompleted).toBe(true);
    });

    it('should mark data steps as completed from progress', () => {
      const effective = component.effectiveSteps();
      const step1 = effective.find(s => s.step_key === 'step1');
      const step2 = effective.find(s => s.step_key === 'step2');
      expect(step1?.isCompleted).toBe(true); // step1 in progress
      expect(step2?.isCompleted).toBe(false); // step2 not in progress
    });
  });

  describe('isStepClickable', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.detectChanges();
    });

    it('should allow clicking non-skipped steps in edit mode', () => {
      fixture.componentRef.setInput('mode', 'edit');
      fixture.detectChanges();
      const step = component.effectiveSteps().find(s => s.step_key === 'step1');
      expect(step).toBeTruthy();
      expect(component.isStepClickable(step!)).toBe(true);
    });

    it('should allow clicking completed non-skipped steps in view mode', () => {
      fixture.componentRef.setInput('mode', 'view');
      fixture.detectChanges();
      const step = component.effectiveSteps().find(s => s.step_key === 'step1');
      expect(step).toBeTruthy();
      expect(component.isStepClickable(step!)).toBe(true);
    });

    it('should allow clicking incomplete steps in view mode when parent_status_key is draft', () => {
      // mockContext already has parent_status_key: 'draft'
      fixture.componentRef.setInput('mode', 'view');
      fixture.detectChanges();
      const step = component.effectiveSteps().find(s => s.step_key === 'step2');
      expect(step).toBeTruthy();
      expect(component.isStepClickable(step!)).toBe(true);
    });

    it('should not allow clicking incomplete steps in view mode when parent_status_key is not draft', () => {
      const completedContext = { ...mockContext, parent_status_key: 'complete' as any };
      fixture.componentRef.setInput('context', completedContext);
      fixture.componentRef.setInput('mode', 'view');
      fixture.detectChanges();
      const step = component.effectiveSteps().find(s => s.step_key === 'step2');
      expect(step).toBeTruthy();
      expect(component.isStepClickable(step!)).toBe(false);
    });

    it('should not allow clicking skipped steps in edit mode', () => {
      fixture.componentRef.setInput('mode', 'edit');
      fixture.detectChanges();

      const skippedStep = { ...mockSteps[1], isSkipped: true, isCompleted: false, isRequired: false } as any;
      expect(component.isStepClickable(skippedStep)).toBe(false);
    });

    it('should not allow clicking review when data steps are incomplete', () => {
      // mockContext has step1 complete but step2 incomplete
      fixture.componentRef.setInput('mode', 'view');
      fixture.detectChanges();
      const review = component.effectiveSteps().find(s => s.step_key === '__review__');
      expect(review).toBeTruthy();
      expect(component.isStepClickable(review!)).toBe(false);
    });

    it('should allow clicking review when all data steps are complete', () => {
      const allCompleteProgress = [
        ...mockContext.progress,
        { id: 3, guided_form_key: 'test_guidedForm', parent_id: 42, step_key: 'step2', completed_at: '2026-01-01T00:00:00Z', completed_by: null, submitted_at: null, created_at: '2026-01-01T00:00:00Z' }
      ];
      const allCompleteContext = { ...mockContext, progress: allCompleteProgress };
      fixture.componentRef.setInput('context', allCompleteContext);
      fixture.componentRef.setInput('mode', 'view');
      fixture.detectChanges();
      const review = component.effectiveSteps().find(s => s.step_key === '__review__');
      expect(review).toBeTruthy();
      expect(component.isStepClickable(review!)).toBe(true);
    });
  });

  describe('stepContent', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.detectChanges();
    });

    it('should return checkmark for completed steps', () => {
      const step = component.effectiveSteps().find(s => s.step_key === '__parent__');
      expect(step?.isCompleted).toBe(true);
      expect(component.stepContent(step!)).toBe('✓');
    });

    it('should return dash for skipped steps', () => {
      expect(component.stepContent({ isCompleted: false, isSkipped: true, step_key: 'x' } as any)).toBe('-');
    });

    it('should return step number for pending steps', () => {
      const step2 = component.effectiveSteps().find(s => s.step_key === 'step2');
      expect(step2?.isCompleted).toBe(false);
      // step2 is the 3rd visible step: parent=1, step1=2, step2=3, review=4
      expect(component.stepContent(step2!)).toBe('3');
    });

    it('should return step number for pending review step', () => {
      const review = component.effectiveSteps().find(s => s.step_key === '__review__');
      expect(review).toBeTruthy();
      expect(review?.isCompleted).toBe(false); // not yet submitted
      // review is the 4th visible step: parent=1, step1=2, step2=3, review=4
      expect(component.stepContent(review!)).toBe('4');
    });

    it('should return checkmark for completed review step', () => {
      const reviewStep = { isCompleted: true, isSkipped: false, step_key: '__review__' } as any;
      expect(component.stepContent(reviewStep)).toBe('✓');
    });
  });

  describe('onStepClick', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.detectChanges();
    });

    it('should emit stepClick for steps', () => {
      spyOn(component.stepClick, 'emit');
      const step = component.effectiveSteps().find(s => s.step_key === 'step1');
      expect(step).toBeTruthy();
      component.onStepClick(step!);
      expect(component.stepClick.emit).toHaveBeenCalledWith('step1');
    });
  });

  describe('isCurrent (active step for AT)', () => {
    it('should mark the parent step current when context.step_key is null', () => {
      // mockContext.step_key is null → editing the parent record
      fixture.componentRef.setInput('context', mockContext);
      fixture.detectChanges();
      const parentStep = component.effectiveSteps().find(s => s.step_key === '__parent__');
      const step1 = component.effectiveSteps().find(s => s.step_key === 'step1');
      expect(component.isCurrent(parentStep!)).toBe(true);
      expect(component.isCurrent(step1!)).toBe(false);
    });

    it('should mark the matching data step current when context.step_key is set', () => {
      const childContext = { ...mockContext, step_key: 'step1', is_child_step: true };
      fixture.componentRef.setInput('context', childContext);
      fixture.detectChanges();
      const step1 = component.effectiveSteps().find(s => s.step_key === 'step1');
      const parentStep = component.effectiveSteps().find(s => s.step_key === '__parent__');
      expect(component.isCurrent(step1!)).toBe(true);
      expect(component.isCurrent(parentStep!)).toBe(false);
    });

    it('should never mark the synthetic review step current', () => {
      const reviewContext = { ...mockContext, step_key: '__review__' };
      fixture.componentRef.setInput('context', reviewContext);
      fixture.detectChanges();
      const review = component.effectiveSteps().find(s => s.step_key === '__review__');
      expect(component.isCurrent(review!)).toBe(false);
    });

    it('should render aria-current="step" on exactly the current step in the DOM', () => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.detectChanges();
      const items: HTMLElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('li.step')
      );
      const currentItems = items.filter(li => li.getAttribute('aria-current') === 'step');
      expect(currentItems.length).toBe(1);
      // First step in the nav is the parent step, which is current here
      expect(items[0].getAttribute('aria-current')).toBe('step');
    });
  });
});
