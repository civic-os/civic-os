/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The edit editor behind `recordEditor(..., { mode: 'edit' })` (see `record-editor.ts` for the contract). Private
 * to the facades: not exported from any barrel.
 *
 * This holds the record load, the form, the plain and the coordinated save, the registered galleries, the series
 * membership and its scoped save (`saveWithScope`, `cancelScope`), `rebuild` and `dispose`. The guided-form and
 * autosave commands are later commits and throw until then.
 */

import { DataClientError } from '../client/errors.js';
import { createStore } from '../client/store.js';
import { createFormStore } from '../forms/form-store.js';
import type { FormStore } from '../forms/form-store.js';
import type { FormBackend } from '../forms/backend.js';
import type { EntityHandle } from '../handles/handles.js';
import { EntityPropertyType } from '../model/index.js';
import type { ApiError, EntityData, RenderableItem, SchemaEntityProperty, SeriesEditScope, SeriesMembership } from '../model/index.js';
import type { DataQuery } from '../model/index.js';
import { transformManyToManyData } from '../query/response.js';
import { propsForEdit } from '../schema/property-views.js';
import { propertyToSelectStringForEdit } from '../schema/select.js';
import { buildSplitSchedule } from '../transform/series-schedule.js';
import type { SeriesSchedule } from '../transform/series-schedule.js';
import { ValueTransformError, transformValueForControl, transformValuesForApi } from '../transform/values.js';
import type {
  EditorDeps,
  EditorEditStep,
  EditorEditStepResult,
  EditorGallery,
  EditorSaveResult,
  EditorScopedSaveResult,
  ManyToManyDiff,
  RecordEditorEdit,
  RecordEditorEditOptions,
  RecordEditorEditSnapshot,
  RichManyToManyDiff,
} from './record-editor.js';
import { buildPlan, editorInternals, isInlineManyToMany, publishWhenChanged, toApiError } from './record-editor-shared.js';

const notYet = (name: string): Error => new Error(`recordEditor edit mode: ${name} is not implemented yet`);

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

  const manyToMany = new Map<string, ManyToManyDiff>();
  const richManyToMany = new Map<string, RichManyToManyDiff>();
  const galleries = new Map<string, EditorGallery>();

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
    guidedForm: null,
    autoSave: 'idle',
    savingAndContinuing: false,
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

      // The record, with the fields legacy's `data$` sent: the edit select of every property, structural `status_id` included.
      let loaded: EntityData | undefined;
      if (row && nextProps.length > 0) {
        const entityColumns = all.filter(p => p.type !== EntityPropertyType.ManyToMany).map(p => p.column_name);
        const rows = await deps.data.getData({
          key: entity.name,
          entityId: String(options.recordId),
          fields: nextProps.map(propertyToSelectStringForEdit),
          ...(entityColumns.length > 0 && { entityColumns }),
        });
        if (disposed || id !== generation) return;
        loaded = rows[0];
      }

      let nextRecord: EntityData | null = null;
      let nextBackend: B | null = null;
      let nextStore: FormStore | null = null;
      let nextBaseline: Record<string, unknown> = {};
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
      }

      const previous = formStore;
      const previousStop = stopForm;
      properties = nextProps;
      inlineManyToMany = nextInline;
      renderables = nextRenderables;
      backend = nextBackend;
      formStore = nextStore;
      stopForm = nextStore ? nextStore.subscribe(publish) : null;
      record = nextRecord;
      notFound = row !== undefined && nextProps.length > 0 && !loaded;
      loadedApiValues = nextBaseline;
      // Only a form with a time slot can belong to a series (`edit.page.ts:640`); otherwise there is nothing to read.
      const hasTimeSlot = nextProps.some(p => p.type === EntityPropertyType.TimeSlot || p.type === EntityPropertyType.RecurringTimeSlot);
      if (nextRecord && hasTimeSlot) void loadSeries();
      else {
        seriesRead++;
        series = undefined;
      }
      guidedFormKey = row ? (entity.features?.guidedFormKey ?? null) : null;
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

  // ---- saving ---------------------------------------------------------------

  type Early = { status: 'ignored' } | { status: 'invalid' } | { status: 'transform_error'; column: string; message: string };

  /** Common start of a save: why it stops, or the transformed data of the enabled fields. */
  const begin = (): Early | { data: Record<string, unknown> } => {
    if (!formStore || saving) return { status: 'ignored' };
    if (!formStore.validate().valid) {
      for (const f of formStore.fields) formStore.markTouched(f.key);
      return { status: 'invalid' };
    }
    const values: Record<string, unknown> = {};
    for (const [key, f] of Object.entries(formStore.getSnapshot().fields)) if (f.enabled) values[key] = f.value;
    try {
      return { data: toApi(values) };
    } catch (e) {
      if (e instanceof ValueTransformError) return { status: 'transform_error', column: e.column, message: e.message };
      throw e;
    }
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
    const inline = (column: string) => inlineManyToMany.find(p => p.column_name === column && p.many_to_many_meta);
    for (const [column, diff] of manyToMany) {
      const property = inline(column);
      if (!property) continue;
      const meta = property.many_to_many_meta!;
      out.push({
        kind: 'many_to_many',
        column,
        property,
        addCount: diff.toAdd.length,
        removeCount: diff.toRemove.length,
        async execute() {
          const calls = [
            ...diff.toRemove.map(id => () => deps.data.removeManyToManyRelation(options.recordId, meta, id)),
            ...diff.toAdd.map(id => () => deps.data.addManyToManyRelation(options.recordId, meta, id)),
          ];
          if (calls.length === 0) return { success: true };
          return junctionResult(await Promise.allSettled(calls.map(call => call())));
        },
      });
    }
    for (const [column, diff] of richManyToMany) {
      const property = inline(column);
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
          const calls = [
            ...diff.toRemove.map(id => () => deps.data.removeManyToManyRelation(options.recordId, meta, id)),
            ...diff.toAdd.map(item => () => deps.data.addManyToManyRelation(options.recordId, meta, item.id, { ...item.extraData })),
            ...diff.toUpdate.map(item => () => deps.data.updateManyToManyRelation(options.recordId, meta, item.id, { ...item.extraData })),
          ];
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
    saving = false;
    publish();
    return 'error' in r ? { status: 'failed', error: r.error } : { status: 'saved', after: 'success' };
  };

  const runSave = async (beforeSend?: () => Promise<void>): Promise<EditorSaveResult> => {
    const started = begin();
    if (!('data' in started)) return started;
    // A series member's save waits for the page to ask which occurrences it applies to; nothing is sent yet.
    if (series?.is_member) {
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
    if (saving || held === null) return { status: 'ignored' };
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
      throw notYet('saveAndContinue');
    },
    skipStep() {
      throw notYet('skipStep');
    },
    goToStep() {
      throw notYet('goToStep');
    },
    enterEditMode() {
      throw notYet('enterEditMode');
    },
    cancelEditMode() {
      throw notYet('cancelEditMode');
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
      stopForm?.();
      formStore?.dispose();
    },
  };
  editorInternals.set(editor, { loadedApiValues: () => loadedApiValues });
  return editor;
}
