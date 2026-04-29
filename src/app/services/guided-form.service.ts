/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { EMPTY, Observable, of, tap } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';
import {
  GuidedFormDefinition,
  GuidedFormStep,
  GuidedFormCondition,
  GuidedFormProgressEntry,
  GuidedFormContext,
  EffectiveGuidedFormStep
} from '../interfaces/guided-form';

/** Response from start_guided_form RPC */
export interface StartGuidedFormResult {
  parent_id: number;
}

/** Response from complete_guided_form_step RPC */
export interface CompleteStepResult {
  all_data_steps_complete: boolean;
  auto_submitted?: boolean;
  navigate_to?: string;
  next_step_key?: string;
  next_step_table?: string;
  next_record_id?: number;
}

/** Response from submit_guided_form RPC */
export interface SubmitGuidedFormResult {
  navigate_to?: string;
}

/** Response from ensure_guided_form_step_record RPC */
export interface EnsureStepRecordResult {
  record_id: number;
  created: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class GuidedFormService {
  private http = inject(HttpClient);

  // ==========================================================================
  // Context: Single-call context loading (v0.48.0 refactor)
  // ==========================================================================

  /** Context cache keyed by "guidedFormKey:tableName:recordId" */
  private contextMap = signal<Map<string, GuidedFormContext>>(new Map());

  /** In-flight request tracking to prevent duplicate HTTP calls */
  private inFlightContextKeys = new Set<string>();

  private contextKey(guidedFormKey: string, tableName: string, recordId: number | string): string {
    return `${guidedFormKey}:${tableName}:${recordId}`;
  }

  /**
   * Load full guided form context in a single RPC call.
   * Returns Observable that emits the context when available.
   * Deduplicates in-flight requests and caches results.
   */
  public loadContext(
    guidedFormKey: string,
    tableName: string,
    recordId: number | string
  ): Observable<GuidedFormContext> {
    const key = this.contextKey(guidedFormKey, tableName, recordId);

    // Return cached context if available
    const cached = this.contextMap().get(key);
    if (cached) return of(cached);

    // Prevent duplicate in-flight requests — EMPTY completes without emitting
    if (this.inFlightContextKeys.has(key)) return EMPTY;
    this.inFlightContextKeys.add(key);

    return this.http.post<GuidedFormContext>(
      `${getPostgrestUrl()}rpc/get_guided_form_context`,
      {
        p_guided_form_key: guidedFormKey,
        p_table_name: tableName,
        p_record_id: Number(recordId)
      }
    ).pipe(
      tap({
        next: ctx => {
          if (ctx) {
            // Ensure steps have conditions arrays (defensive)
            if (ctx.steps) {
              ctx.steps = ctx.steps.map(s => ({ ...s, conditions: s.conditions || [] }));
            }
            this.contextMap.update(m => {
              const newMap = new Map(m);
              newMap.set(key, ctx);
              return newMap;
            });
          }
          this.inFlightContextKeys.delete(key);
        },
        error: () => {
          this.inFlightContextKeys.delete(key);
        }
      })
    );
  }

  /**
   * Synchronous read from cache. Returns undefined if not yet loaded.
   */
  public getContext(
    guidedFormKey: string,
    tableName: string,
    recordId: number | string
  ): GuidedFormContext | undefined {
    return this.contextMap().get(this.contextKey(guidedFormKey, tableName, recordId));
  }

  /**
   * Re-fetch context without clearing the cache first.
   * Old data remains visible until the HTTP response arrives,
   * preventing the UI from briefly showing zero progress.
   */
  public refreshContext(
    guidedFormKey: string,
    tableName: string,
    recordId: number | string
  ): Observable<GuidedFormContext> {
    const key = this.contextKey(guidedFormKey, tableName, recordId);
    // Remove from in-flight tracking to allow re-fetch
    this.inFlightContextKeys.delete(key);

    return this.http.post<GuidedFormContext>(
      `${getPostgrestUrl()}rpc/get_guided_form_context`,
      {
        p_guided_form_key: guidedFormKey,
        p_table_name: tableName,
        p_record_id: Number(recordId)
      }
    ).pipe(
      tap(ctx => {
        if (ctx) {
          if (ctx.steps) {
            ctx.steps = ctx.steps.map(s => ({ ...s, conditions: s.conditions || [] }));
          }
          this.contextMap.update(m => {
            const newMap = new Map(m);
            newMap.set(key, ctx);
            return newMap;
          });
        }
      })
    );
  }

  /**
   * Clear all cached contexts for a given guided form key.
   * Called after mutations (completeStep, submitGuidedForm) so the next
   * loadContext() call hits the server instead of returning stale data.
   */
  private invalidateContextForForm(guidedFormKey: string): void {
    this.contextMap.update(m => {
      const newMap = new Map(m);
      for (const key of newMap.keys()) {
        if (key.startsWith(guidedFormKey + ':')) {
          newMap.delete(key);
        }
      }
      return newMap;
    });
  }

  // ==========================================================================
  // Runtime Actions (HTTP -> caller handles result)
  // ==========================================================================

  public startGuidedForm(key: string) {
    return this.http.post<StartGuidedFormResult>(
      `${getPostgrestUrl()}rpc/start_guided_form`,
      { p_guided_form_key: key }
    );
  }

  public completeStep(key: string, parentId: number | string, stepKey: string) {
    return this.http.post<CompleteStepResult>(
      `${getPostgrestUrl()}rpc/complete_guided_form_step`,
      { p_guided_form_key: key, p_parent_id: Number(parentId), p_step_key: stepKey }
    ).pipe(tap(() => this.invalidateContextForForm(key)));
  }

  public submitGuidedForm(key: string, parentId: number | string) {
    return this.http.post<SubmitGuidedFormResult>(
      `${getPostgrestUrl()}rpc/submit_guided_form`,
      { p_guided_form_key: key, p_parent_id: Number(parentId) }
    ).pipe(tap(() => this.invalidateContextForForm(key)));
  }

  public cancelGuidedForm(key: string, parentId: number | string) {
    return this.http.post<any>(
      `${getPostgrestUrl()}rpc/cancel_guided_form`,
      { p_guided_form_key: key, p_parent_id: Number(parentId) }
    );
  }

  // ==========================================================================
  // Step Record Management
  // ==========================================================================

  public getStepRecord(stepTable: string, parentFkColumn: string, parentId: number | string, select?: string) {
    let url = `${getPostgrestUrl()}${stepTable}?${parentFkColumn}=eq.${parentId}&limit=1`;
    if (select) url += `&select=${select}`;
    return this.http.get<any[]>(url);
  }

  public ensureStepRecord(guidedFormKey: string, parentId: number | string, stepKey: string) {
    return this.http.post<EnsureStepRecordResult>(
      `${getPostgrestUrl()}rpc/ensure_guided_form_step_record`,
      { p_guided_form_key: guidedFormKey, p_parent_id: Number(parentId), p_step_key: stepKey }
    );
  }

  // ==========================================================================
  // Pure Computations (no side effects, no HTTP)
  // ==========================================================================

  public getEffectiveSteps(
    steps: GuidedFormStep[],
    parentRecord: any,
    progress: GuidedFormProgressEntry[]
  ): EffectiveGuidedFormStep[] {
    const progressSet = new Set(progress.map(p => p.step_key));

    return steps.map(step => {
      const isCompleted = progressSet.has(step.step_key);
      let isSkipped = false;
      let isRequired = !step.can_skip;

      for (const condition of step.conditions.filter(c => c.condition_type === 'skip_if')) {
        if (this.evaluateCondition(condition, parentRecord)) {
          isSkipped = true;
          break;
        }
      }

      for (const condition of step.conditions.filter(c => c.condition_type === 'require_if')) {
        if (this.evaluateCondition(condition, parentRecord)) {
          isRequired = true;
          break;
        }
      }

      return { ...step, isSkipped, isCompleted, isRequired };
    });
  }

  public evaluateCondition(condition: GuidedFormCondition, parentRecord: any): boolean {
    let value = parentRecord?.[condition.field];
    // Handle embedded FK/category/status objects (e.g., {id: 7, display_name: '...'})
    if (value && typeof value === 'object' && 'id' in value) {
      value = value.id;
    }
    switch (condition.operator) {
      case 'eq':
        if (value == null) return false;
        return String(value) === condition.value;
      case 'neq':
        if (value == null) return true;
        return String(value) !== condition.value;
      case 'is_null': return value === null || value === undefined;
      case 'is_not_null': return value !== null && value !== undefined;
      default: return false;
    }
  }

  public getLockedFields(steps: GuidedFormStep[]): Set<string> {
    const fields = new Set<string>();
    for (const step of steps) {
      for (const condition of step.conditions) {
        fields.add(condition.field);
      }
    }
    return fields;
  }
}
