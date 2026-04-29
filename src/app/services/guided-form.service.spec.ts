/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { GuidedFormService } from './guided-form.service';
import { GuidedFormDefinition, GuidedFormStep, GuidedFormProgressEntry, GuidedFormCondition, GuidedFormContext } from '../interfaces/guided-form';

describe('GuidedFormService', () => {
  let service: GuidedFormService;
  let httpMock: HttpTestingController;
  const testPostgrestUrl = 'http://test-api.example.com/';

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

  beforeEach(() => {
    (window as any).civicOsConfig = { postgrestUrl: testPostgrestUrl };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        GuidedFormService
      ]
    });
    service = TestBed.inject(GuidedFormService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    delete (window as any).civicOsConfig;
  });

  describe('Service Setup', () => {
    it('should be created', () => {
      expect(service).toBeTruthy();
    });
  });

  describe('Context Loading', () => {
    it('should load context via RPC and cache result', (done) => {
      service.loadContext('test_guidedForm', 'test_parent', 42).subscribe(ctx => {
        expect(ctx.definition.guided_form_key).toBe('test_guidedForm');
        expect(ctx.parent_id).toBe(42);
        expect(ctx.parent_status_key).toBe('draft');

        // Verify cached
        const cached = service.getContext('test_guidedForm', 'test_parent', 42);
        expect(cached).toBeDefined();
        expect(cached!.parent_id).toBe(42);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_guided_form_context');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_guided_form_key: 'test_guidedForm',
        p_table_name: 'test_parent',
        p_record_id: 42
      });
      req.flush(mockContext);
    });

    it('should return cached context on second call', (done) => {
      // First call — triggers HTTP
      service.loadContext('test_guidedForm', 'test_parent', 42).subscribe(() => {
        // Second call — should return from cache, no HTTP
        service.loadContext('test_guidedForm', 'test_parent', 42).subscribe(ctx => {
          expect(ctx.parent_id).toBe(42);
          done();
        });
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_guided_form_context');
      req.flush(mockContext);
      // No second request expected — httpMock.verify() in afterEach confirms
    });

    it('should return undefined for uncached context', () => {
      expect(service.getContext('unknown', 'unknown', 1)).toBeUndefined();
    });

    it('should ensure steps have conditions arrays (defensive)', (done) => {
      const ctxWithoutConditions = {
        ...mockContext,
        steps: mockSteps.map(s => ({ ...s, conditions: undefined as any }))
      };

      service.loadContext('test_guidedForm', 'test_parent', 42).subscribe(ctx => {
        expect(ctx.steps[0].conditions).toEqual([]);
        expect(ctx.steps[1].conditions).toEqual([]);
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_guided_form_context');
      req.flush(ctxWithoutConditions);
    });

    it('should refresh context without clearing old data', (done) => {
      // Prime the cache
      service.loadContext('test_guidedForm', 'test_parent', 42).subscribe(() => {
        // Old data still visible
        expect(service.getContext('test_guidedForm', 'test_parent', 42)?.parent_status_key).toBe('draft');

        // Refresh — old data should remain visible during fetch
        const updatedContext = { ...mockContext, parent_status_key: 'submitted' as any };
        service.refreshContext('test_guidedForm', 'test_parent', 42).subscribe(ctx => {
          expect(ctx.parent_status_key).toBe('submitted');
          expect(service.getContext('test_guidedForm', 'test_parent', 42)?.parent_status_key).toBe('submitted');
          done();
        });

        const refreshReq = httpMock.expectOne(testPostgrestUrl + 'rpc/get_guided_form_context');
        refreshReq.flush(updatedContext);
      });

      const loadReq = httpMock.expectOne(testPostgrestUrl + 'rpc/get_guided_form_context');
      loadReq.flush(mockContext);
    });
  });

  describe('RPC Wrappers', () => {
    it('should call start_guided_form RPC', (done) => {
      service.startGuidedForm('test_guidedForm').subscribe(result => {
        expect(result).toEqual(jasmine.objectContaining({ parent_id: 42, parent_table: 'test_parent' }));
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/start_guided_form');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_guided_form_key: 'test_guidedForm' });
      req.flush({ parent_id: 42, parent_table: 'test_parent' });
    });

    it('should call complete_guided_form_step RPC', (done) => {
      service.completeStep('test_guidedForm', 42, 'step1').subscribe(result => {
        expect(result).toEqual({ all_data_steps_complete: false, next_step_key: 'step2', next_step_table: 'test_step2', next_record_id: 99 });
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/complete_guided_form_step');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_guided_form_key: 'test_guidedForm', p_parent_id: 42, p_step_key: 'step1' });
      req.flush({ all_data_steps_complete: false, next_step_key: 'step2', next_step_table: 'test_step2', next_record_id: 99 });
    });

    it('should call submit_guided_form RPC', (done) => {
      service.submitGuidedForm('test_guidedForm', 42).subscribe(result => {
        expect(result).toEqual(jasmine.objectContaining({ navigate_to: '/view/test_parent/42' }));
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/submit_guided_form');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_guided_form_key: 'test_guidedForm', p_parent_id: 42 });
      req.flush({ navigate_to: '/view/test_parent/42' });
    });

    it('should call cancel_guided_form RPC', (done) => {
      service.cancelGuidedForm('test_guidedForm', 42).subscribe(result => {
        expect(result).toEqual({ cancelled: true });
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/cancel_guided_form');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_guided_form_key: 'test_guidedForm', p_parent_id: 42 });
      req.flush({ cancelled: true });
    });

    it('should call ensure_guided_form_step_record RPC', (done) => {
      service.ensureStepRecord('test_guidedForm', 42, 'step1').subscribe(result => {
        expect(result).toEqual({ record_id: 99, created: true });
        done();
      });

      const req = httpMock.expectOne(testPostgrestUrl + 'rpc/ensure_guided_form_step_record');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_guided_form_key: 'test_guidedForm', p_parent_id: 42, p_step_key: 'step1' });
      req.flush({ record_id: 99, created: true });
    });
  });

  describe('getEffectiveSteps', () => {
    it('should mark completed steps from progress', () => {
      const steps = mockSteps;
      const progress = mockProgress;
      const effective = service.getEffectiveSteps(steps, {}, progress);

      expect(effective[0].isCompleted).toBe(true);
      expect(effective[1].isCompleted).toBe(false);
    });

    it('should mark required steps that cannot skip', () => {
      const steps = mockSteps;
      const effective = service.getEffectiveSteps(steps, {}, []);

      expect(effective[0].isRequired).toBe(true); // step1 can_skip=false
      expect(effective[1].isRequired).toBe(false); // step2 can_skip=true
    });

    it('should evaluate skip_if condition (eq)', () => {
      const condition: GuidedFormCondition = { id: 1, condition_type: 'skip_if', field: 'is_nonprofit', operator: 'eq', value: 'true' };
      const steps: GuidedFormStep[] = [{
        ...mockSteps[1],
        conditions: [condition]
      }];

      const skipped = service.getEffectiveSteps(steps, { is_nonprofit: true }, []);
      expect(skipped[0].isSkipped).toBe(true);

      const notSkipped = service.getEffectiveSteps(steps, { is_nonprofit: false }, []);
      expect(notSkipped[0].isSkipped).toBe(false);
    });

    it('should evaluate skip_if condition (neq)', () => {
      const condition: GuidedFormCondition = { id: 1, condition_type: 'skip_if', field: 'status', operator: 'neq', value: 'active' };
      const steps: GuidedFormStep[] = [{
        ...mockSteps[1],
        conditions: [condition]
      }];

      const skipped = service.getEffectiveSteps(steps, { status: 'pending' }, []);
      expect(skipped[0].isSkipped).toBe(true);

      const notSkipped = service.getEffectiveSteps(steps, { status: 'active' }, []);
      expect(notSkipped[0].isSkipped).toBe(false);
    });

    it('should evaluate skip_if condition (is_null)', () => {
      const condition: GuidedFormCondition = { id: 1, condition_type: 'skip_if', field: 'optional_field', operator: 'is_null', value: null };
      const steps: GuidedFormStep[] = [{
        ...mockSteps[1],
        conditions: [condition]
      }];

      const skipped = service.getEffectiveSteps(steps, { optional_field: null }, []);
      expect(skipped[0].isSkipped).toBe(true);

      const notSkipped = service.getEffectiveSteps(steps, { optional_field: 'value' }, []);
      expect(notSkipped[0].isSkipped).toBe(false);
    });

    it('should evaluate skip_if condition (is_not_null)', () => {
      const condition: GuidedFormCondition = { id: 1, condition_type: 'skip_if', field: 'flag', operator: 'is_not_null', value: null };
      const steps: GuidedFormStep[] = [{
        ...mockSteps[1],
        conditions: [condition]
      }];

      const skipped = service.getEffectiveSteps(steps, { flag: 'set' }, []);
      expect(skipped[0].isSkipped).toBe(true);

      const notSkipped = service.getEffectiveSteps(steps, { flag: null }, []);
      expect(notSkipped[0].isSkipped).toBe(false);
    });

    it('should evaluate require_if condition', () => {
      const condition: GuidedFormCondition = { id: 1, condition_type: 'require_if', field: 'is_urgent', operator: 'eq', value: 'true' };
      const steps: GuidedFormStep[] = [{
        ...mockSteps[1],
        conditions: [condition]
      }];

      const required = service.getEffectiveSteps(steps, { is_urgent: true }, []);
      expect(required[0].isRequired).toBe(true);

      const notRequired = service.getEffectiveSteps(steps, { is_urgent: false }, []);
      expect(notRequired[0].isRequired).toBe(false);
    });
  });

  describe('getLockedFields', () => {
    it('should return empty set for steps with no conditions', () => {
      const steps = mockSteps;
      expect(service.getLockedFields(steps)).toEqual(new Set());
    });

    it('should collect all condition fields', () => {
      const steps: GuidedFormStep[] = [
        { ...mockSteps[0], conditions: [{ id: 1, condition_type: 'skip_if', field: 'field_a', operator: 'eq', value: 'x' }] },
        { ...mockSteps[1], conditions: [{ id: 2, condition_type: 'require_if', field: 'field_b', operator: 'eq', value: 'y' }] }
      ];
      const locked = service.getLockedFields(steps);
      expect(locked).toEqual(new Set(['field_a', 'field_b']));
    });

    it('should deduplicate condition fields', () => {
      const steps: GuidedFormStep[] = [
        { ...mockSteps[0], conditions: [{ id: 1, condition_type: 'skip_if', field: 'same_field', operator: 'eq', value: 'x' }] },
        { ...mockSteps[1], conditions: [{ id: 2, condition_type: 'require_if', field: 'same_field', operator: 'eq', value: 'y' }] }
      ];
      const locked = service.getLockedFields(steps);
      expect(locked).toEqual(new Set(['same_field']));
    });
  });
});
