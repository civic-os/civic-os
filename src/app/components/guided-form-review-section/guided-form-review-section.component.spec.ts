/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { GuidedFormReviewSectionComponent } from './guided-form-review-section.component';
import { GuidedFormService } from '../../services/guided-form.service';
import { SchemaService } from '../../services/schema.service';
import { GuidedFormDefinition, GuidedFormStep, GuidedFormProgressEntry, GuidedFormContext } from '../../interfaces/guided-form';

describe('GuidedFormReviewSectionComponent', () => {
  let component: GuidedFormReviewSectionComponent;
  let fixture: ComponentFixture<GuidedFormReviewSectionComponent>;
  let mockGuidedFormService: jasmine.SpyObj<GuidedFormService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;

  const mockDefinition: GuidedFormDefinition = {
    guided_form_key: 'test_guidedForm',
    description: null,
    parent_table: 'test_parent',
    ownership_column: 'created_by',
    lock_on_submit: false,
    on_submit_rpc: null,
    review_intro_text: 'Please review before submitting.',
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
    mockGuidedFormService = jasmine.createSpyObj('GuidedFormService', [
      'getEffectiveSteps', 'getStepRecord'
    ]);

    mockGuidedFormService.getEffectiveSteps.and.callFake((steps: GuidedFormStep[], parent: any, progress: GuidedFormProgressEntry[]) => {
      const progressSet = new Set(progress.map(p => p.step_key));
      return steps.map(step => ({
        ...step,
        isSkipped: false,
        isCompleted: progressSet.has(step.step_key),
        isRequired: !step.can_skip
      }));
    });
    mockGuidedFormService.getStepRecord.and.returnValue(of([{ id: 1, notes: 'Test notes' }]));

    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntity', 'getPropsForDetail'
    ]);
    mockSchemaService.getEntity.and.callFake((tableName: string) =>
      of({ table_name: tableName, display_name: tableName } as any)
    );
    mockSchemaService.getPropsForDetail.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [GuidedFormReviewSectionComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: GuidedFormService, useValue: mockGuidedFormService },
        { provide: SchemaService, useValue: mockSchemaService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GuidedFormReviewSectionComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('context', mockContext);
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('effectiveSteps', () => {
    it('should filter out skipped steps and parent step from dataSteps', () => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.componentRef.setInput('parentRecord', { id: 42 });
      fixture.detectChanges();

      const dataSteps = component.dataSteps();
      expect(dataSteps.every(s => s.step_key !== '__parent__')).toBe(true);
      expect(dataSteps.every(s => !s.isSkipped)).toBe(true);
    });
  });

  describe('step records', () => {
    it('should load step records for non-skipped data steps', (done) => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.componentRef.setInput('parentRecord', { id: 42 });
      fixture.detectChanges();

      setTimeout(() => {
        expect(mockGuidedFormService.getStepRecord).toHaveBeenCalled();
        expect(component.stepRecords().has('step1')).toBe(true);
        done();
      }, 50);
    });

    it('should return step record from cache', (done) => {
      fixture.componentRef.setInput('context', mockContext);
      fixture.componentRef.setInput('parentRecord', { id: 42 });
      fixture.detectChanges();

      setTimeout(() => {
        const record = component.getStepRecord('step1');
        expect(record).toEqual({ id: 1, notes: 'Test notes' });
        done();
      }, 50);
    });
  });

  describe('onEditStep', () => {
    it('should emit editStep with step key', () => {
      spyOn(component.editStep, 'emit');
      component.onEditStep('step1');
      expect(component.editStep.emit).toHaveBeenCalledWith('step1');
    });
  });

  describe('onSubmit', () => {
    it('should emit submit event', () => {
      spyOn(component.submit, 'emit');
      component.onSubmit();
      expect(component.submit.emit).toHaveBeenCalled();
    });
  });
});
