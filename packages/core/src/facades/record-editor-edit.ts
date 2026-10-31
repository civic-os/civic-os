/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The edit editor behind `recordEditor(..., { mode: 'edit' })` (see `record-editor.ts` for the contract). Private
 * to the facades: not exported from any barrel.
 *
 * This holds the record load, the form, the plain and the coordinated save, the registered galleries, the series
 * membership and its scoped save (`saveWithScope`, `cancelScope`), the guided form (context, field locks, display
 * record, autosave, `saveAndContinue`, `skipStep`, `goToStep`, `enterEditMode`, `cancelEditMode`), `rebuild` and `dispose`.
 */

import { DataClientError } from '../client/errors.js';
import { createStore } from '../client/store.js';
import { evaluateGuidedFormCondition } from '../conditions/index.js';
import { createFormStore } from '../forms/form-store.js';
import type { FormStore } from '../forms/form-store.js';
import type { FormBackend } from '../forms/backend.js';
import type { EntityHandle } from '../handles/handles.js';
import { EntityPropertyType } from '../model/index.js';
import type {
  ApiError,
  EffectiveGuidedFormStep,
  EntityData,
  GuidedFormContext,
  GuidedFormStep,
  RenderableItem,
  SchemaEntityProperty,
  SeriesEditScope,
  SeriesMembership,
} from '../model/index.js';
import type { DataQuery } from '../model/index.js';
import { transformManyToManyData } from '../query/response.js';
import { propsForEdit } from '../schema/property-views.js';
import { propertyToSelectString, propertyToSelectStringForEdit } from '../schema/select.js';
import { buildSplitSchedule } from '../transform/series-schedule.js';
import type { SeriesSchedule } from '../transform/series-schedule.js';
import { ValueTransformError, transformValueForControl, transformValuesForApi } from '../transform/values.js';
import type {
  EditorDeps,
  EditorEditContinueResult,
  EditorEditStep,
  EditorEditStepResult,
  EditorGallery,
  EditorGuidedForm,
  EditorNavigation,
  EditorStepNavigation,
  EditorSaveResult,
  EditorScopedSaveResult,
  ManyToManyDiff,
  RecordEditorEdit,
  RecordEditorEditOptions,
  RecordEditorEditSnapshot,
  RichManyToManyDiff,
} from './record-editor.js';
import { buildPlan, editorInternals, isInlineManyToMany, liveFields, publishWhenChanged, toApiError } from './record-editor-shared.js';

// Core compiles without DOM or Node types; timers are the platform's (the clock only reads `now()`).
declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** Legacy `getEffectiveSteps(steps, null, progress)`: the parent record is not read, so a condition sees no value. */
const effectiveSteps = (ctx: GuidedFormContext): EffectiveGuidedFormStep[] => {
  const done = new Set(ctx.progress.map(entry => entry.step_key));
  return ctx.steps.map(step => {
    const conditions = step.conditions ?? [];
    return {
      ...step,
      isCompleted: done.has(step.step_key),
      isSkipped: conditions.some(c => c.condition_type === 'skip_if' && evaluateGuidedFormCondition(c, null)),
      isRequired: !step.can_skip || conditions.some(c => c.condition_type === 'require_if' && evaluateGuidedFormCondition(c, null)),
    };
  });
};

/** Legacy `getLockedFields`: every field any step's condition reads. */
const lockedFields = (steps: readonly GuidedFormStep[]): Set<string> => {
  const fields = new Set<string>();
  for (const step of steps) for (const c of step.conditions ?? []) fields.add(c.field);
  return fields;
};

interface CompletionAnswer {
  auto_submitted?: boolean;
  navigate_to?: string | null;
  next_record_id?: number | string | null;
  next_step_table?: string | null;
  all_data_steps_complete?: boolean;
}

/** The server's own message of a rejected request (legacy `error?.error?.message`), absent for anything else. */
const serverMessage = (e: unknown): string | undefined => (e instanceof DataClientError ? e.shape.message || undefined : undefined);

/** A thrown value's message as legacy read it (`err?.error?.message || err?.message`); empty and absent are both absent. */
const causeMessage = (cause: unknown): string | undefined => {
  const c = cause as { error?: { message?: unknown }; message?: unknown } | null | undefined;
  const m = c?.error?.message || c?.message;
  return typeof m === 'string' && m !== '' ? m : undefined;
};

export function editEditor<B extends FormBackend>(
  deps: EditorDeps,
  entity: EntityHandle,
  options: RecordEditorEditOptions<B>,
): RecordEditorEdit<B> {
  let disposed = false;
  let generation = 0;
  let scheduled = false;

  const assertAlive = (): void => {
    if (disposed) throw new Error('recordEditor is disposed');
  };

  // ---- state ----------------------------------------------------------------

  let loading = true;
  let error: unknown;
  /** The edit properties minus non-inline many-to-many (legacy `currentProps`): what the payload transform reads. */
  let properties: readonly SchemaEntityProperty[] = [];
  let inlineManyToMany: readonly SchemaEntityProperty[] = [];
  let renderables: readonly RenderableItem[] = [];
  let backend: B | null = null;
  let formStore: FormStore | null = null;
  let stopForm: (() => void) | null = null;
  let record: EntityData | null = null;
  let notFound = false;
  let saving = false;
  let guidedFormKey: string | null = null;
  let loadedApiValues: Record<string, unknown> = {};
  let series: SeriesMembership | undefined;
  /** Latest-wins token of the membership reads. */
  let seriesRead = 0;
  /** The transformed data of a save that is waiting for a scope. */
  let held: Record<string, unknown> | null = null;

  /** What the form held when the record loaded, in control form (legacy's `patchValue` source for `cancelEditMode`). */
  let loadedControlValues: Record<string, unknown> = {};
  /** The entity's own columns, which `DataService.withEntityColumns` added to every legacy read of the record (id and default order). */
  let entityColumns: readonly string[] = [];

  // Guided form (legacy `:1016-1203`).
  let guidedContext: GuidedFormContext | null = null;
  let guidedParentId: string | null = null;
  let editingCompletedStep = false;
  let displayRecord: EntityData | null = null;
  /** Latest-wins tokens of the context read and of the display read. */
  let contextRead = 0;
  let displayRead = 0;
  let continuing = false;
  /** The entity has a guided form and the record loaded with an id: the snapshot serves a `guidedForm`, with no context until it arrives. */
  let guidedActive = false;

  // Autosave (legacy `setupAutoSave`, `performAutoSave`, `cancelAutoSave`).
  const debounceMs = options.autoSaveDebounceMs ?? 1500;
  const savedMs = options.autoSaveSavedMs ?? 2000;
  let autoSaveStatus: 'idle' | 'saving' | 'saved' = 'idle';
  let autoSaveEnabled = false;
  let autoSaveInFlight = false;
  /** Control-form values of the last successful save, or of the arming. */
  let lastSaved: Record<string, unknown> = {};
  /** JSON of the values the last debounce emitted (`distinctUntilChanged`); reset when armed. */
  let lastEmitted: string | undefined;
  /** JSON of the values at the last form notification that was looked at; a notification that leaves it alone arms nothing. */
  let seenJson: string | undefined;
  let autoSaveStop: (() => void) | null = null;
  let debounceTimer: unknown;
  const savedTimers = new Set<unknown>();
  let latestSavedTimer: unknown;
  /** Bumped when the form is replaced or the editor is disposed, so a late completion does not touch the new state. */
  let autoSaveEpoch = 0;
  /** `cancelEditMode` writes the loaded values back; that must never arm a save. */
  let quiet = false;
  let waitTimer: unknown;
  let waitWake: (() => void) | null = null;

  const manyToMany = new Map<string, ManyToManyDiff>();
  const richManyToMany = new Map<string, RichManyToManyDiff>();
  const galleries = new Map<string, EditorGallery>();

  let guidedMemo: {
    key: string;
    context: GuidedFormContext | null;
    parentId: string | null;
    editing: boolean;
    display: EntityData | null;
    canUpdate: boolean;
    value: EditorGuidedForm;
  } | null = null;

  /** The guided-form view; the same object while none of its inputs changed (`publishWhenChanged` compares by identity). */
  const guidedSnapshot = (): EditorGuidedForm | null => {
    if (!guidedActive || guidedFormKey === null) return null;
    const canUpdate = entity.can?.update === true;
    const m = guidedMemo;
    if (m && m.key === guidedFormKey && m.context === guidedContext && m.parentId === guidedParentId && m.editing === editingCompletedStep && m.display === displayRecord && m.canUpdate === canUpdate) {
      return m.value;
    }
    const ctx = guidedContext;
    const status = ctx?.parent_status_key ?? null;
    const draft = ctx !== null && status === 'draft';
    let skippable = false;
    if (ctx && draft) {
      const step = ctx.steps.find(s => s.step_table === entity.name);
      if (step && step.step_key !== '__parent__') {
        const eff = effectiveSteps(ctx).find(s => s.step_key === step.step_key);
        skippable = eff ? !eff.isRequired && !eff.isSkipped : false;
      }
    }
    const value: EditorGuidedForm = {
      key: guidedFormKey,
      context: ctx,
      parentId: guidedParentId,
      status,
      draft,
      locked: !ctx || canUpdate ? false : ctx.definition.lock_on_submit === true && status === 'submitted',
      skippable,
      editingCompletedStep,
      completedStepDisplay: status !== null && !draft && !editingCompletedStep,
      displayRecord,
    };
    guidedMemo = { key: guidedFormKey, context: ctx, parentId: guidedParentId, editing: editingCompletedStep, display: displayRecord, canUpdate, value };
    return value;
  };

  const buildSnapshot = (): RecordEditorEditSnapshot<B> => ({
    loading,
    error,
    properties,
    inlineManyToMany,
    renderables,
    backend,
    form: formStore ? formStore.getSnapshot() : null,
    saving,
    guidedFormKey,
    recordId: options.recordId,
    record,
    notFound,
    series,
    scopePending: held !== null,
    guidedForm: guidedSnapshot(),
    autoSave: autoSaveStatus,
    savingAndContinuing: continuing,
  });

  const store = createStore<RecordEditorEditSnapshot<B>>(buildSnapshot());
  const publish = (): void => {
    if (disposed) return;
    publishWhenChanged(store, buildSnapshot());
  };

  // ---- payload --------------------------------------------------------------

  const toApi = (values: Record<string, unknown>): Record<string, unknown> =>
    transformValuesForApi(values, properties, { mode: 'edit', timeZone: options.timeZone });

  /** The same transform for the load baseline: `{}` when a loaded value cannot be sent (legacy `tryTransformValuesForApi`). */
  const tryToApi = (values: Record<string, unknown>, props: readonly SchemaEntityProperty[]): Record<string, unknown> => {
    try {
      return transformValuesForApi(values, props, { mode: 'edit', timeZone: options.timeZone });
    } catch (e) {
      if (e instanceof ValueTransformError) return {};
      throw e;
    }
  };

  // ---- series membership ----------------------------------------------------

  /** Legacy `checkSeriesMembership`: a failed or empty read is `{ is_member: false }`, and the latest read wins. */
  const loadSeries = async (): Promise<void> => {
    const token = ++seriesRead;
    let membership: SeriesMembership;
    try {
      const body = await deps.data.callRpc('get_series_membership', { p_entity_table: entity.name, p_entity_id: options.recordId });
      membership = body ?? { is_member: false };
    } catch {
      membership = { is_member: false };
    }
    if (disposed || token !== seriesRead) return;
    series = membership;
    publish();
  };

  // ---- loading --------------------------------------------------------------

  const run = async (id: number): Promise<void> => {
    scheduled = false;
    if (disposed || id !== generation) return;
    const row = entity.liveRow;
    try {
      let nextProps: readonly SchemaEntityProperty[] = [];
      let nextRenderables: readonly RenderableItem[] = [];
      let all: readonly SchemaEntityProperty[] = [];
      if (row) {
        [all, nextRenderables] = await Promise.all([deps.schema.properties(row), deps.schema.formRenderables(entity, 'edit')]);
        if (disposed || id !== generation) return;
        nextProps = propsForEdit([...all]).filter(p => p.type !== EntityPropertyType.ManyToMany || isInlineManyToMany(p));
      }
      const nextInline = nextProps.filter(isInlineManyToMany);
      const nextColumns = all.filter(p => p.type !== EntityPropertyType.ManyToMany).map(p => p.column_name);

      // The record, with the fields legacy's `data$` sent: the edit select of every property, structural `status_id` included.
      let loaded: EntityData | undefined;
      if (row && nextProps.length > 0) {
        const rows = await deps.data.getData({
          key: entity.name,
          entityId: String(options.recordId),
          fields: nextProps.map(propertyToSelectStringForEdit),
          ...(nextColumns.length > 0 && { entityColumns: nextColumns }),
        });
        if (disposed || id !== generation) return;
        loaded = rows[0];
      }

      let nextRecord: EntityData | null = null;
      let nextBackend: B | null = null;
      let nextStore: FormStore | null = null;
      let nextBaseline: Record<string, unknown> = {};
      let nextControlValues: Record<string, unknown> = {};
      if (loaded) {
        // Legacy `currentData`: each inline many-to-many column flattened to its related rows.
        nextRecord = { ...loaded };
        for (const p of nextInline) {
          const meta = p.many_to_many_meta;
          if (!meta) continue;
          const extra = meta.extraColumns.map(c => c.column_name);
          nextRecord[p.column_name] = transformManyToManyData(
            (nextRecord[p.column_name] as unknown[] | undefined) || [],
            meta.relatedTable,
            extra.length > 0 ? extra : undefined,
            meta.parentHops,
            meta.parentHops?.length ? meta.targetTable : undefined,
          );
        }
        // The form holds the row's values from the start (pristine, untouched); a missing column is `null`, as a FormControl holds it.
        const formProps = nextProps.filter(p => p.show_on_edit !== false && p.type !== EntityPropertyType.ManyToMany);
        const controlValues: Record<string, unknown> = {};
        for (const p of formProps) {
          const v = transformValueForControl(p, (loaded as Record<string, unknown>)[p.column_name], { timeZone: options.timeZone });
          controlValues[p.column_name] = v === undefined ? null : v;
        }
        nextBackend = options.backend();
        nextStore = createFormStore(buildPlan(formProps, 'edit'), nextBackend, { initial: controlValues });
        nextBaseline = tryToApi(controlValues, nextProps);
        nextControlValues = controlValues;
      }

      const previous = formStore;
      const previousStop = stopForm;
      resetAutoSave();
      properties = nextProps;
      inlineManyToMany = nextInline;
      renderables = nextRenderables;
      backend = nextBackend;
      formStore = nextStore;
      stopForm = nextStore ? nextStore.subscribe(publish) : null;
      record = nextRecord;
      notFound = row !== undefined && nextProps.length > 0 && !loaded;
      loadedApiValues = nextBaseline;
      loadedControlValues = nextControlValues;
      entityColumns = nextColumns;
      // Only a form with a time slot can belong to a series (`edit.page.ts:640`); otherwise there is nothing to read.
      const hasTimeSlot = nextProps.some(p => p.type === EntityPropertyType.TimeSlot || p.type === EntityPropertyType.RecurringTimeSlot);
      if (nextRecord && hasTimeSlot) void loadSeries();
      else {
        seriesRead++;
        series = undefined;
      }
      guidedFormKey = row ? (entity.features?.guidedFormKey ?? null) : null;
      // The context is read again for every build; the previous one stays until the new one arrives.
      const loadedId = (loaded as Record<string, unknown> | undefined)?.['id'];
      guidedActive = Boolean(nextRecord && guidedFormKey && loadedId);
      if (guidedActive) void loadGuided(loadedId);
      else clearGuided();
      error = undefined;
      loading = false;
      previousStop?.();
      previous?.dispose();
    } catch (e) {
      if (disposed || id !== generation) return;
      error = e;
      loading = false;
    }
    publish();
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => run(generation));
  };
  schedule();

  // ---- autosave -------------------------------------------------------------

  /** Control-form values of the enabled fields, read live (an Angular form's `value` leaves disabled controls out). */
  const enabledValues = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    if (formStore && backend) for (const [key, f] of Object.entries(liveFields(formStore, backend))) if (f.enabled) values[key] = f.value;
    return values;
  };

  const isDraft = (): boolean => guidedContext !== null && guidedContext.parent_status_key === 'draft';

  /** Legacy `cancelAutoSave`: off until the next context load, the pending debounce and the latest badge timer cleared, the badge left alone. */
  const cancelAutoSave = (): void => {
    autoSaveEnabled = false;
    autoSaveStop?.();
    autoSaveStop = null;
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (latestSavedTimer !== undefined) {
      clearTimeout(latestSavedTimer);
      savedTimers.delete(latestSavedTimer);
      latestSavedTimer = undefined;
    }
  };

  /** The form was replaced or the editor is gone: every timer and every late completion is dropped. */
  const resetAutoSave = (): void => {
    cancelAutoSave();
    for (const timer of savedTimers) clearTimeout(timer);
    savedTimers.clear();
    latestSavedTimer = undefined;
    autoSaveEpoch++;
    autoSaveInFlight = false;
    autoSaveStatus = 'idle';
  };

  /** Legacy `performAutoSave`: only the changed fields, never `status_id`; nothing to send sends nothing. */
  const performAutoSave = async (): Promise<void> => {
    if (!formStore) return;
    const current = enabledValues();
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(current)) if (JSON.stringify(current[key]) !== JSON.stringify(lastSaved[key])) changed[key] = current[key];
    if (Object.keys(changed).length === 0) return;
    delete changed['status_id'];
    const payload = tryToApi(changed, properties);
    if (Object.keys(payload).length === 0) return;
    const epoch = autoSaveEpoch;
    autoSaveInFlight = true;
    autoSaveStatus = 'saving';
    publish();
    let ok: boolean;
    try {
      const { check } = await deps.data.editData(entity.name, options.recordId, payload);
      ok = check?.success === true;
    } catch {
      ok = false;
    }
    // A completion after a cancel still runs; one after the form was replaced or the editor disposed does not.
    if (disposed || epoch !== autoSaveEpoch) return;
    autoSaveInFlight = false;
    if (!ok) {
      autoSaveStatus = 'idle';
      publish();
      return;
    }
    lastSaved = current;
    autoSaveStatus = 'saved';
    publish();
    // Legacy overwrote its timer field without clearing the previous timer; so does this (dispose clears them all).
    const timer = setTimeout(() => {
      savedTimers.delete(timer);
      if (latestSavedTimer === timer) latestSavedTimer = undefined;
      if (autoSaveStatus === 'saved') {
        autoSaveStatus = 'idle';
        publish();
      }
    }, savedMs);
    savedTimers.add(timer);
    latestSavedTimer = timer;
  };

  const valuesJson = (): string => JSON.stringify(enabledValues());

  const fireAutoSave = (): void => {
    debounceTimer = undefined;
    if (disposed || !formStore) return;
    const json = valuesJson();
    if (json === lastEmitted) return;
    lastEmitted = json;
    if (!autoSaveEnabled || !isDraft()) return;
    void performAutoSave();
  };

  /** Debounce over the form's values: a notification that leaves the values as they were arms nothing. */
  const onFormChange = (): void => {
    if (!autoSaveEnabled) return;
    const json = valuesJson();
    if (quiet) {
      seenJson = json;
      return;
    }
    if (json === seenJson) return;
    seenJson = json;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fireAutoSave, debounceMs);
  };

  /** Legacy `setupAutoSave`. */
  const armAutoSave = (): void => {
    if (!formStore || !isDraft()) {
      autoSaveEnabled = false;
      return;
    }
    autoSaveEnabled = true;
    lastSaved = enabledValues();
    lastEmitted = undefined;
    seenJson = JSON.stringify(lastSaved);
    autoSaveStop?.();
    autoSaveStop = formStore.subscribe(onFormChange);
  };

  // ---- guided form ----------------------------------------------------------

  /** Legacy `lockFieldsEffect`: past draft, without `update`, every field a step condition reads is disabled. */
  const applyLocks = (): void => {
    const ctx = guidedContext;
    if (!ctx || !formStore || ctx.parent_status_key === 'draft' || entity.can?.update === true || ctx.steps.length === 0) return;
    for (const key of lockedFields(ctx.steps)) {
      const f = formStore.field(key);
      if (f && formStore.getSnapshot().fields[key]?.enabled) formStore.setEnabled(key, false);
    }
  };

  /** Legacy `fetchDisplayDataIfNeeded`: the record with every property's display select; a failed or empty read leaves the last one. */
  const readDisplay = async (): Promise<void> => {
    const token = ++displayRead;
    let rows: readonly EntityData[];
    try {
      rows = await deps.data.getData({
        key: entity.name,
        entityId: String(options.recordId),
        fields: properties.map(propertyToSelectString),
        ...(entityColumns.length > 0 && { entityColumns }),
      });
    } catch {
      return;
    }
    if (disposed || token !== displayRead || !rows[0]) return;
    displayRecord = rows[0];
    publish();
  };

  /** Legacy `initGuidedFormMode` (`:1091`): context, parent id, display record, then autosave. A failed or empty read changes nothing. */
  const loadGuided = async (rowId: unknown): Promise<void> => {
    const token = ++contextRead;
    displayRead++;
    const key = guidedFormKey;
    if (!key) return;
    let body: GuidedFormContext | null | undefined;
    try {
      body = (await deps.data.callRpc('get_guided_form_context', {
        p_guided_form_key: key,
        p_table_name: entity.name,
        p_record_id: Number(rowId),
      })) as GuidedFormContext | null | undefined;
    } catch {
      body = null;
    }
    if (disposed || token !== contextRead || !formStore || !body) return;
    guidedContext = { ...body, steps: (body.steps ?? []).map(step => ({ ...step, conditions: step.conditions ?? [] })) };
    guidedParentId = String(guidedContext.parent_id);
    editingCompletedStep = false;
    applyLocks();
    armAutoSave();
    publish();
    if (!isDraft()) await readDisplay();
  };

  /** No guided form to serve (no key, no id, no record): nothing of the previous one is kept. */
  const clearGuided = (): void => {
    contextRead++;
    displayRead++;
    guidedContext = null;
    guidedParentId = null;
    editingCompletedStep = false;
    displayRecord = null;
  };

  // ---- saving ---------------------------------------------------------------

  type Early = { status: 'ignored' } | { status: 'invalid' } | { status: 'transform_error'; column: string; message: string };

  /** The transformed data of the enabled fields, or the transform error (legacy `transformValuesForApi`). */
  const collect = (): { data: Record<string, unknown> } | { status: 'transform_error'; column: string; message: string } => {
    try {
      return { data: toApi(enabledValues()) };
    } catch (e) {
      if (e instanceof ValueTransformError) return { status: 'transform_error', column: e.column, message: e.message };
      throw e;
    }
  };

  /**
   * Common start of a save: why it stops, or the transformed data of the enabled fields. A guided-form draft skips
   * validation (legacy `submitForm` draft branch) and cancels autosave before it transforms; any other form cancels
   * only after it validated.
   */
  const begin = (): Early | { data: Record<string, unknown> } => {
    if (!formStore || saving || continuing) return { status: 'ignored' };
    if (!isDraft()) {
      if (!formStore.validate().valid) {
        for (const f of formStore.fields) formStore.markTouched(f.key);
        return { status: 'invalid' };
      }
    }
    cancelAutoSave();
    return collect();
  };

  /** One PATCH of the record, as `DataService.editData`: a verdict of the response check, or the parsed rejection. */
  const patchRecord = async (data: Record<string, unknown>): Promise<{ ok: true } | { error: ApiError }> => {
    try {
      const { check } = await deps.data.editData(entity.name, options.recordId, data);
      if (check?.success === true) return { ok: true };
      return { error: check.error as ApiError };
    } catch (e) {
      return { error: toApiError(e, deps.schema.constraintMessages()) };
    }
  };

  /** Failed operations of one step: counts, and success only when none failed. */
  const junctionResult = (settled: readonly PromiseSettledResult<unknown>[]): EditorEditStepResult => {
    const failedCount = settled.filter(r => r.status === 'rejected').length;
    const totalCount = settled.length;
    return failedCount === 0 ? { success: true, failedCount, totalCount } : { success: false, failedCount, totalCount, reason: 'changes_failed' };
  };

  /** Every registered gallery saved in parallel. A save that throws rejects the step, as legacy's `Promise.all` did (`:872`). */
  const saveGalleries = async (): Promise<boolean> => {
    const results = await Promise.all([...galleries.values()].map(g => g.save()));
    return results.every(Boolean);
  };

  const inlineProp = (column: string) => inlineManyToMany.find(p => p.column_name === column && p.many_to_many_meta);
  type Call = () => Promise<unknown>;
  type Meta = NonNullable<SchemaEntityProperty['many_to_many_meta']>;
  const pureCalls = (meta: Meta, diff: ManyToManyDiff): Call[] => [
    ...diff.toRemove.map(id => () => deps.data.removeManyToManyRelation(options.recordId, meta, id)),
    ...diff.toAdd.map(id => () => deps.data.addManyToManyRelation(options.recordId, meta, id)),
  ];
  const richCalls = (meta: Meta, diff: RichManyToManyDiff): Call[] => [
    ...diff.toRemove.map(id => () => deps.data.removeManyToManyRelation(options.recordId, meta, id)),
    ...diff.toAdd.map(item => () => deps.data.addManyToManyRelation(options.recordId, meta, item.id, { ...item.extraData })),
    ...diff.toUpdate.map(item => () => deps.data.updateManyToManyRelation(options.recordId, meta, item.id, { ...item.extraData })),
  ];

  const steps = (data: Record<string, unknown>, skipRecord = false): EditorEditStep[] => {
    const out: EditorEditStep[] = [];
    if (!skipRecord) {
      out.push({
        kind: 'record',
        async execute() {
          const r = await patchRecord(data);
          publish();
          if ('error' in r) return { success: false, errorMessage: r.error.humanMessage || r.error.message };
          return { success: true };
        },
      });
    }
    for (const [column, diff] of manyToMany) {
      const property = inlineProp(column);
      if (!property) continue;
      const meta = property.many_to_many_meta!;
      out.push({
        kind: 'many_to_many',
        column,
        property,
        addCount: diff.toAdd.length,
        removeCount: diff.toRemove.length,
        async execute() {
          const calls = pureCalls(meta, diff);
          if (calls.length === 0) return { success: true };
          return junctionResult(await Promise.allSettled(calls.map(call => call())));
        },
      });
    }
    for (const [column, diff] of richManyToMany) {
      const property = inlineProp(column);
      if (!property) continue;
      const meta = property.many_to_many_meta!;
      out.push({
        kind: 'rich_many_to_many',
        column,
        property,
        addCount: diff.toAdd.length,
        removeCount: diff.toRemove.length,
        updateCount: diff.toUpdate.length,
        async execute() {
          const calls = richCalls(meta, diff);
          if (calls.length === 0) return { success: true };
          return junctionResult(await Promise.allSettled(calls.map(call => call())));
        },
      });
    }
    if (galleries.size > 0) {
      out.push({
        kind: 'galleries',
        async execute() {
          return (await saveGalleries()) ? { success: true } : { success: false, reason: 'gallery_save_failed' };
        },
      });
    }
    return out;
  };

  /** Legacy's trigger: pending many-to-many diffs, or a registered gallery with buffered changes. */
  const hasPending = (): boolean =>
    manyToMany.size > 0 || richManyToMany.size > 0 || [...galleries.values()].some(g => g.hasPendingChanges() === true);

  /** The plain save from the transformed data on: `beforeSend`, then the coordinated steps or the one PATCH. */
  const commit = async (data: Record<string, unknown>, beforeSend?: () => Promise<void>): Promise<EditorSaveResult> => {
    saving = true;
    publish();
    if (beforeSend) {
      try {
        await beforeSend();
      } catch (cause) {
        saving = false;
        publish();
        return { status: 'aborted', cause };
      }
    }
    if (hasPending()) return { status: 'steps', steps: steps(data) };
    const r = await patchRecord(data);
    if ('error' in r) {
      saving = false;
      publish();
      return { status: 'failed', error: r.error };
    }
    // Legacy `performEdit` (`:422-447`): a draft leaves through the parent, a completed-step edit goes back to display mode.
    const ctx = guidedContext;
    if (ctx && isDraft()) {
      saving = false;
      publish();
      return {
        status: 'saved',
        after: 'guided_parent',
        navigation: { kind: 'view', table: ctx.definition.parent_table, id: guidedParentId ?? String(ctx.parent_id) },
      };
    }
    if (editingCompletedStep) {
      editingCompletedStep = false;
      saving = false;
      publish();
      await readDisplay();
      return { status: 'saved', after: 'completed_step' };
    }
    saving = false;
    publish();
    return { status: 'saved', after: 'success' };
  };

  const runSave = async (beforeSend?: () => Promise<void>): Promise<EditorSaveResult> => {
    const started = begin();
    if (!('data' in started)) return started;
    // A series member's save waits for the page to ask which occurrences it applies to; nothing is sent yet.
    // A guided-form draft is never held (legacy `submitForm` draft branch skips the series check).
    if (series?.is_member && !isDraft()) {
      held = started.data;
      publish();
      return { status: 'scope_required' };
    }
    return commit(started.data, beforeSend);
  };

  /** API-form values that differ from what the record held when loaded (legacy `changedApiValues`). */
  const changedValues = (data: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(data).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(loadedApiValues[key])));

  const splitFailed = (detail: string | undefined): EditorScopedSaveResult =>
    detail === undefined ? { status: 'series_split_failed' } : { status: 'series_split_failed', detail };

  /** "This and following" (legacy `performSeriesSplit`): split first, and the same RPC saves this occurrence. */
  const splitSeries = async (
    membership: SeriesMembership & { series_id: number; occurrence_date: string },
    data: Record<string, unknown>,
    beforeSend?: () => Promise<void>,
  ): Promise<EditorScopedSaveResult> => {
    saving = true;
    publish();
    const fail = (detail: string | undefined): EditorScopedSaveResult => {
      saving = false;
      publish();
      return splitFailed(detail);
    };
    try {
      if (beforeSend) await beforeSend();
    } catch (cause) {
      return fail(causeMessage(cause));
    }

    // The new version's dtstart is wall-clock time in the series' zone, so the schedule is read first; without it nothing is sent.
    // Only `rawQueryParams` is set, so the path is exactly legacy's `time_slot_series?id=eq.N&select=...` (hence the cast).
    let schedule: SeriesSchedule | undefined;
    try {
      const rows = await deps.data.getData({
        key: 'time_slot_series',
        rawQueryParams: [`id=eq.${membership.series_id}`, 'select=timezone,dtstart,time_slot_property'],
      } as unknown as DataQuery);
      schedule = (rows as unknown as SeriesSchedule[] | null)?.[0];
    } catch {
      schedule = undefined;
    }
    if (!schedule) return fail(undefined);

    const timeSlotColumn = schedule.time_slot_property || 'time_slot';
    const slot = buildSplitSchedule(data[timeSlotColumn] as string | null | undefined, membership.occurrence_date, schedule);
    // Only what the user changed. The template never carries the time slot (dtstart and duration do) or Status columns
    // (workflow is per occurrence); this occurrence gets every change, saved by the RPC in the same transaction.
    const changed = changedValues(data);
    const statusColumns = new Set(properties.filter(p => p.type === EntityPropertyType.Status).map(p => p.column_name));
    const newTemplate = Object.fromEntries(
      Object.entries(changed).filter(([key]) => key !== timeSlotColumn && key !== 'time_slot' && !statusColumns.has(key)),
    );

    let result: { success?: boolean; message?: string } | null | undefined;
    try {
      result = (await deps.data.callRpc('split_series_from_date', {
        p_series_id: membership.series_id,
        p_split_date: membership.occurrence_date,
        p_new_dtstart: slot.dtstart,
        p_new_duration: slot.duration || null,
        p_new_template: newTemplate,
        p_edited_entity_id: Number(options.recordId),
        p_edited_values: changed,
      })) as typeof result;
    } catch (e) {
      return fail(serverMessage(e) || 'Failed to split series');
    }
    if (!result?.success) return fail(result?.message || undefined);

    // The occurrence now belongs to the new version: never split the old one again.
    void loadSeries();
    loadedApiValues = { ...loadedApiValues, ...data };
    if (hasPending()) return { status: 'steps', steps: steps(data, true) };
    saving = false;
    publish();
    return { status: 'saved', after: 'success' };
  };

  /** "All occurrences" (legacy `performSeriesTemplateUpdate`): the full payload is the template. `saving` is never set, as legacy never set `isSaving`. */
  const updateTemplate = async (
    membership: SeriesMembership & { series_id: number },
    data: Record<string, unknown>,
    beforeSend?: () => Promise<void>,
  ): Promise<EditorScopedSaveResult> => {
    try {
      if (beforeSend) await beforeSend();
    } catch (cause) {
      return { status: 'aborted', cause };
    }
    const failed = (message: string | undefined): EditorScopedSaveResult =>
      message === undefined ? { status: 'series_update_failed' } : { status: 'series_update_failed', message };
    let result: { success?: boolean; message?: string } | null | undefined;
    try {
      result = (await deps.data.callRpc('update_series_template', {
        p_series_id: membership.series_id,
        p_new_template: data,
        p_skip_exceptions: true,
      })) as typeof result;
    } catch (e) {
      return failed(serverMessage(e) || 'Failed to update series template');
    }
    // Legacy: `result.success !== false`. An empty body threw there (and showed nothing); here it is a success.
    if (result?.success === false) return failed(result.message || undefined);
    return { status: 'saved', after: 'success' };
  };

  const saveWithScope = async (scope: SeriesEditScope, beforeSend?: () => Promise<void>): Promise<EditorScopedSaveResult> => {
    if (saving || continuing || held === null) return { status: 'ignored' };
    const data = held;
    held = null;
    publish();
    const membership = series;
    if (!membership) return { status: 'ignored' };
    if (scope === 'this_and_future' && membership.series_id !== undefined && membership.occurrence_date) {
      return splitSeries({ ...membership, series_id: membership.series_id, occurrence_date: membership.occurrence_date }, data, beforeSend);
    }
    if (scope === 'all' && membership.series_id !== undefined) {
      return updateTemplate({ ...membership, series_id: membership.series_id }, data, beforeSend);
    }
    // 'this_only', or a scope that lacks the series ids it needs, is the plain save.
    return commit(data, beforeSend) as Promise<EditorScopedSaveResult>;
  };

  // ---- guided-form commands -------------------------------------------------

  /** A wait that `dispose` ends early; the command then finds the editor disposed. */
  const wait = (ms: number): Promise<void> =>
    new Promise<void>(resolve => {
      waitWake = resolve;
      waitTimer = setTimeout(() => {
        waitTimer = undefined;
        waitWake = null;
        resolve();
      }, ms);
    });

  const errorText = (e: unknown): { message?: string; code?: string; hint?: string } => {
    const error: { message?: string; code?: string; hint?: string } = {};
    if (e instanceof DataClientError) {
      if (e.shape.message !== undefined) error.message = e.shape.message;
      if (e.shape.code !== undefined) error.code = e.shape.code;
      if (e.shape.hint !== undefined) error.hint = e.shape.hint;
    } else if (e instanceof Error) {
      error.message = e.message;
    }
    return error;
  };

  /** Legacy `executePendingM2mForGuidedForm` (`:1427`): every pending junction change at once; the first failures are counted, not thrown. */
  const relatedChanges = async (): Promise<{ failed: number; total: number }> => {
    const calls: Call[] = [];
    for (const [column, diff] of manyToMany) {
      const meta = inlineProp(column)?.many_to_many_meta;
      if (meta) calls.push(...pureCalls(meta, diff));
    }
    for (const [column, diff] of richManyToMany) {
      const meta = inlineProp(column)?.many_to_many_meta;
      if (meta) calls.push(...richCalls(meta, diff));
    }
    const settled = await Promise.allSettled(calls.map(call => call()));
    return { failed: settled.filter(r => r.status === 'rejected').length, total: settled.length };
  };

  /** Legacy `saveAndContinue` (`:1296`). */
  const runSaveAndContinue = async (): Promise<EditorEditContinueResult> => {
    if (!formStore || saving || continuing) return { status: 'ignored' };
    // An autosave in flight is waited for (200 ms, 15 times); the whole command, validation included, runs again after each wait.
    let retries = 0;
    for (;;) {
      if (!formStore) return { status: 'ignored' };
      if (!formStore.validate().valid) {
        for (const f of formStore.fields) formStore.markTouched(f.key);
        return { status: 'invalid' };
      }
      cancelAutoSave();
      if (autoSaveInFlight && retries++ < 15) {
        await wait(200);
        if (disposed) return { status: 'ignored' };
        continue;
      }
      break;
    }
    continuing = true;
    publish();
    const finish = <T extends EditorEditContinueResult>(result: T): T => {
      continuing = false;
      publish();
      return result;
    };
    const collected = collect();
    if (!('data' in collected)) return finish(collected);

    const ctx = guidedContext;
    const key = guidedFormKey;
    const recordId = String(options.recordId);
    const parentId = guidedParentId || recordId;
    if (!ctx || !key || !recordId || !parentId) return finish({ status: 'ignored' });
    const stepKey = ctx.steps.find(s => s.step_table === entity.name)?.step_key || '__parent__';

    const patched = await patchRecord(collected.data);
    if ('error' in patched) return finish({ status: 'failed', error: patched.error });

    const related = await relatedChanges();
    if (related.failed > 0) {
      return finish({
        status: 'related_failed',
        message: `${related.failed} of ${related.total} related item changes failed`,
        failedCount: related.failed,
        totalCount: related.total,
      });
    }

    let completion: CompletionAnswer;
    try {
      completion =
        ((await deps.data.callRpc('complete_guided_form_step', {
          p_guided_form_key: key,
          p_parent_id: Number(parentId),
          p_step_key: stepKey,
        })) as CompletionAnswer | null | undefined) ?? {};
    } catch (e) {
      return finish({ status: 'step_failed', guidedFormKey: key, stepKey, error: errorText(e) });
    }

    const parentTable = ctx.definition.parent_table;
    let navigation: EditorNavigation = { kind: 'none' };
    if (completion.auto_submitted) {
      navigation = completion.navigate_to ? { kind: 'url', url: completion.navigate_to } : { kind: 'view', table: parentTable, id: parentId };
    } else if (completion.next_record_id && completion.next_step_table) {
      navigation = { kind: 'edit', table: completion.next_step_table, id: completion.next_record_id };
    } else if (completion.all_data_steps_complete) {
      navigation = { kind: 'view', table: parentTable, id: parentId };
    }
    return finish({ status: 'continued', guidedFormKey: key, stepKey, navigation });
  };

  /** `ensure_guided_form_step_record` (legacy `guidedFormService.ensureStepRecord`): the step's record id, if the server answers one. */
  const ensureStepRecord = async (key: string, parentId: string | number, stepKey: string): Promise<number | string | undefined> => {
    const body = (await deps.data.callRpc('ensure_guided_form_step_record', {
      p_guided_form_key: key,
      p_parent_id: Number(parentId),
      p_step_key: stepKey,
    })) as { record_id?: number | string | null } | null | undefined;
    return body?.record_id ?? undefined;
  };

  /** Legacy `skipStep` (`:1468`). */
  const runSkipStep = async (): Promise<EditorNavigation | null> => {
    const ctx = guidedContext;
    const key = guidedFormKey;
    if (!ctx || !key || !ctx.parent_id) return null;
    cancelAutoSave();
    const current = ctx.steps.find(s => s.step_table === entity.name);
    if (!current) return null;
    const ordered = effectiveSteps(ctx)
      .filter(s => s.step_key !== '__parent__' && !s.isSkipped)
      .sort((a, b) => a.step_order - b.step_order);
    const next = ordered[ordered.findIndex(s => s.step_key === current.step_key) + 1];
    const parent: EditorNavigation = { kind: 'view', table: ctx.definition.parent_table, id: ctx.parent_id };
    if (!next) return parent;
    try {
      const recordId = await ensureStepRecord(key, ctx.parent_id, next.step_key);
      return recordId === undefined ? parent : { kind: 'edit', table: next.step_table, id: recordId };
    } catch {
      return parent;
    }
  };

  /** Legacy `onGuidedFormStepClick` (`:1247`). */
  const runGoToStep = async (stepKey: string): Promise<EditorStepNavigation> => {
    const ctx = guidedContext;
    const key = guidedFormKey;
    const pid = guidedParentId || String(options.recordId);
    if (!key || !pid || !ctx) return { status: 'ignored' };
    if (stepKey === '__parent__') {
      cancelAutoSave();
      return { status: 'navigate', navigation: { kind: 'edit', table: ctx.definition.parent_table, id: pid } };
    }
    if (stepKey === '__review__') {
      cancelAutoSave();
      return { status: 'navigate', navigation: { kind: 'view', table: ctx.definition.parent_table, id: pid } };
    }
    const step = ctx.steps.find(s => s.step_key === stepKey);
    if (!step || step.step_table === entity.name) return { status: 'none' };
    cancelAutoSave();
    if (!step.parent_fk_column) return { status: 'none' };
    try {
      const recordId = await ensureStepRecord(key, pid, stepKey);
      return recordId === undefined ? { status: 'none' } : { status: 'navigate', navigation: { kind: 'edit', table: step.step_table, id: recordId } };
    } catch (e) {
      const server = serverMessage(e);
      const message = server || (e instanceof Error ? e.message : undefined);
      return {
        status: 'failed',
        error: { humanMessage: server || 'Failed to load step record.', ...(message !== undefined && { message }) },
      };
    }
  };

  /** Legacy `cancelEditMode` (`:1226`): the loaded values go back without notifying dependents, and touched stays touched. */
  const resetToLoaded = (): void => {
    editingCompletedStep = false;
    if (formStore) {
      const store = formStore;
      const touched = store.fields.filter(f => store.getSnapshot().fields[f.key]?.touched).map(f => f.key);
      quiet = true;
      try {
        store.reset(loadedControlValues);
        for (const key of touched) store.markTouched(key);
      } finally {
        quiet = false;
      }
      if (autoSaveEnabled) seenJson = valuesJson();
    }
    publish();
  };

  // ---- commands -------------------------------------------------------------

  const editor: RecordEditorEdit<B> = {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    setManyToManyDiff(column, diff) {
      assertAlive();
      if (diff.toAdd.length === 0 && diff.toRemove.length === 0) manyToMany.delete(column);
      else manyToMany.set(column, diff);
    },
    setRichManyToManyDiff(column, diff) {
      assertAlive();
      if (diff.toAdd.length === 0 && diff.toRemove.length === 0 && diff.toUpdate.length === 0) richManyToMany.delete(column);
      else richManyToMany.set(column, diff);
    },
    registerGallery(column, gallery) {
      assertAlive();
      galleries.set(column, gallery);
      // A page tears its galleries down after the editor, so unregistering never throws; a stale function never removes a newer registration.
      return () => {
        if (galleries.get(column) === gallery) galleries.delete(column);
      };
    },
    clearPending() {
      assertAlive();
      manyToMany.clear();
      richManyToMany.clear();
      saving = false;
      publish();
    },
    save(beforeSend) {
      assertAlive();
      return runSave(beforeSend);
    },
    saveWithScope(scope, beforeSend) {
      assertAlive();
      return saveWithScope(scope, beforeSend);
    },
    cancelScope() {
      assertAlive();
      held = null;
      publish();
    },
    saveAndContinue() {
      assertAlive();
      return runSaveAndContinue();
    },
    skipStep() {
      assertAlive();
      return runSkipStep();
    },
    goToStep(stepKey) {
      assertAlive();
      return runGoToStep(stepKey);
    },
    enterEditMode() {
      assertAlive();
      editingCompletedStep = true;
      publish();
    },
    cancelEditMode() {
      assertAlive();
      resetToLoaded();
    },
    rebuild() {
      assertAlive();
      generation++;
      loading = true;
      publish();
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resetAutoSave();
      contextRead++;
      displayRead++;
      if (waitTimer !== undefined) clearTimeout(waitTimer);
      waitTimer = undefined;
      waitWake?.();
      waitWake = null;
      stopForm?.();
      formStore?.dispose();
    },
  };
  editorInternals.set(editor, { loadedApiValues: () => loadedApiValues });
  return editor;
}
