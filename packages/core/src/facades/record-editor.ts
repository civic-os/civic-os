/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `recordEditor`: the Create page's form and save commands, without layout
 * (`docs/notes/FRONTEND_SDK_DESIGN.md` §11). Edit mode joins the options union
 * and the snapshot in later commits; this file builds create only.
 *
 * The editor loads the entity's create properties and renderables, builds a
 * {@link FormBackend}, a form store and the form together, applies the route's
 * prefill, and republishes one snapshot per change of the form. `save` validates,
 * transforms and sends the one create request, or hands the page the steps of a
 * coordinated create (inline many-to-many additions and gallery links, which need
 * the new record's id). `saveAndContinue` creates and then completes a guided
 * form's step.
 *
 * What stays on the page: navigation, toasts and modals, translation (results carry
 * keys and raw messages, never UI text), the token refresh (passed as `beforeSend`),
 * the many-to-many pickers and gallery uploads that produce the diffs and drafts,
 * and the progress UI that runs the steps.
 */

import { createStore } from '../client/store.js';
import { DataClientError } from '../client/errors.js';
import { humanizeError } from '../errors/index.js';
import type { PostgrestErrorShape } from '../errors/classify.js';
import { createFormStore } from '../forms/form-store.js';
import type { FormStore } from '../forms/form-store.js';
import type { PlanItem, RenderPlan } from '../plan/types.js';
import { EntityPropertyType } from '../model/index.js';
import type { PropertyItem } from '../model/index.js';
import { getColumnSpan, getDefaultValueForProperty, propsForCreate } from '../schema/property-views.js';
import { ValueTransformError, transformValuesForApi } from '../transform/values.js';
import { TransportError } from '../transport/errors.js';
import type { ApiError, ConstraintMessage } from '../model/index.js';
import type { EntityHandle } from '../handles/handles.js';
import type { FormBackend } from '../forms/backend.js';
import type { FormSnapshot } from '../forms/form-store.js';
import type { RenderableItem, SchemaEntityProperty } from '../model/index.js';
import type { FacadeDeps, FacadeSchema } from './deps.js';

/**
 * The schema as the editor reads it, beyond {@link FacadeSchema.properties}.
 * The generic app implements each over `SchemaService`.
 *
 * @consumer typed recordEditor
 */
export interface EditorSchema extends FacadeSchema {
  /** `getCreateRenderables` / `getEditRenderables`: the form's properties merged with static text blocks, in `sort_order`. */
  formRenderables(entity: EntityHandle, mode: 'create' | 'edit'): Promise<readonly RenderableItem[]>;
  /** What `SchemaService.constraintMessages` holds at call time, for the wording of a rejected write. */
  constraintMessages(): readonly ConstraintMessage[] | undefined;
}

/**
 * {@link FacadeDeps} with the schema reads the editor needs.
 *
 * @consumer typed recordEditor
 */
export interface EditorDeps extends FacadeDeps {
  readonly schema: EditorSchema;
}

/**
 * Pending inline many-to-many changes of one column. On create only `toAdd` is sent.
 *
 * @consumer typed recordEditor
 */
export interface ManyToManyDiff {
  readonly toAdd: readonly (number | string)[];
  readonly toRemove: readonly (number | string)[];
}

/**
 * Pending changes of one rich-junction column (the junction row carries extra columns).
 *
 * @consumer typed recordEditor
 */
export interface RichManyToManyDiff {
  readonly toAdd: readonly { readonly id: number | string; readonly extraData: Readonly<Record<string, unknown>> }[];
  readonly toRemove: readonly (number | string)[];
  readonly toUpdate: readonly { readonly id: number | string; readonly extraData: Readonly<Record<string, unknown>> }[];
  readonly addedItems?: readonly { readonly id: number | string; readonly display_name: string; readonly color?: string }[];
}

/**
 * Options of a create editor. Edit mode will join as `mode: 'edit'`.
 *
 * @consumer typed recordEditor
 */
export interface RecordEditorCreateOptions<B extends FormBackend> {
  readonly mode: 'create';
  /** Called once per built form: the first load and every {@link RecordEditor.rebuild}. */
  readonly backend: () => B;
  /** IANA zone a `DateTimeLocal` control value is read in (core never reads the ambient zone). */
  readonly timeZone: string;
  /**
   * The route's query params. After a form builds, each key that names a field whose value is falsy is
   * set (through the store) and marked touched; other keys are ignored.
   */
  readonly prefill?: Readonly<Record<string, unknown>>;
  /** Persists the page's buffered gallery rows; resolves whether all were saved. Run by the `gallery_images` step. */
  readonly galleryImages?: () => Promise<boolean>;
}

/**
 * @consumer typed recordEditor
 */
export type RecordEditorOptions<B extends FormBackend> = RecordEditorCreateOptions<B>;

/**
 * Everything the editor knows at one moment. Stable between changes (the `useSyncExternalStore` contract).
 * One keystroke yields one snapshot: the editor republishes only when the form store's snapshot changes.
 *
 * @consumer typed recordEditor
 */
export interface RecordEditorSnapshot<B extends FormBackend> {
  /** True from creation until the first load settles, and while a rebuild runs. */
  readonly loading: boolean;
  /** The schema load's failure, or `undefined`. */
  readonly error: unknown;
  /** The create properties: `propsForCreate` minus non-inline many-to-many and file properties. */
  readonly properties: readonly SchemaEntityProperty[];
  /** The inline many-to-many properties (`show_inline`), which the form does not hold as fields. */
  readonly inlineManyToMany: readonly SchemaEntityProperty[];
  readonly renderables: readonly RenderableItem[];
  /** The backend of the current form; `null` before the first build and for an entity that is not in the schema. */
  readonly backend: B | null;
  /** The form store's snapshot; `null` as `backend`. */
  readonly form: FormSnapshot | null;
  /** {@link RecordEditor.save} or {@link RecordEditor.saveAndContinue} is in flight. */
  readonly saving: boolean;
  /** The entity's `guided_form_key`, read when the form was built. */
  readonly guidedFormKey: string | null;
  /** The id of the record the last successful create returned. */
  readonly createdId: number | string | null;
}

/**
 * Why a step could not complete, for the page to word: `record_id_missing` (the record step returned
 * no id), `additions_failed` (see `failedCount` / `totalCount`), `gallery_link_failed`,
 * `gallery_images_failed`. Server text, when there is some, is in `errorMessage` instead.
 *
 * @consumer typed recordEditor
 */
export type EditorStepReason = 'record_id_missing' | 'additions_failed' | 'gallery_link_failed' | 'gallery_images_failed';

/**
 * @consumer typed recordEditor
 */
export interface EditorStepResult {
  readonly success: boolean;
  readonly failedCount?: number;
  readonly totalCount?: number;
  readonly errorMessage?: string;
  readonly reason?: EditorStepReason;
}

/**
 * One step of a coordinated create. The page runs the steps in order and stops at the first that fails
 * (`SaveProgressComponent`). `kind` and its data are what the page words the label from.
 *
 * @consumer typed recordEditor
 */
export type EditorStep = (
  | { readonly kind: 'record' }
  | { readonly kind: 'many_to_many'; readonly column: string; readonly property: SchemaEntityProperty; readonly addCount: number }
  | { readonly kind: 'gallery_link'; readonly column: string }
  | { readonly kind: 'gallery_images' }
) & { execute(): Promise<EditorStepResult> };

/**
 * Outcome of {@link RecordEditor.save}.
 * - `ignored`: there is no form, or a save is in flight; nothing was sent.
 * - `invalid`: every field was marked touched; nothing was sent.
 * - `transform_error`: a value cannot be sent as written (`column`, English `message`); nothing was sent.
 * - `created`: the one request ran; `id` is the first returned row's `id`.
 * - `failed`: the request was rejected; `error` has the legacy `ApiError` shape.
 * - `steps`: pending many-to-many or gallery changes exist; nothing was sent. The page runs the steps.
 *
 * @consumer typed recordEditor
 */
export type EditorCreateResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'invalid' }
  | { readonly status: 'transform_error'; readonly column: string; readonly message: string }
  | { readonly status: 'created'; readonly id: number | string | null }
  | { readonly status: 'failed'; readonly error: ApiError }
  | { readonly status: 'steps'; readonly steps: readonly EditorStep[] };

/**
 * Where the page goes after a guided-form step completes.
 *
 * @consumer typed recordEditor
 */
export type EditorNavigation =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'view'; readonly table: string; readonly id: number | string }
  | { readonly kind: 'edit'; readonly table: string; readonly id: number | string }
  | { readonly kind: 'none' };

/**
 * Outcome of {@link RecordEditor.saveAndContinue}. Beyond the {@link EditorCreateResult} cases it shares:
 * - `aborted`: `beforeSend` rejected (`cause`); nothing was sent.
 * - `created`: also the fallback when the entity has no guided form, the response has no id, or the guided-form
 *   context cannot be loaded; the page shows its normal success.
 * - `continued`: the step completed; the page tracks the step, invalidates its cached context for
 *   `guidedFormKey` and performs `navigation`.
 * - `step_failed`: the record exists (`id`) but completing the step failed; `error` carries the server's text.
 *
 * @consumer typed recordEditor
 */
export type EditorContinueResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'invalid' }
  | { readonly status: 'transform_error'; readonly column: string; readonly message: string }
  | { readonly status: 'aborted'; readonly cause: unknown }
  | { readonly status: 'failed'; readonly error: ApiError }
  | { readonly status: 'created'; readonly id: number | string | null }
  | {
      readonly status: 'continued';
      readonly id: number | string;
      readonly guidedFormKey: string;
      readonly stepKey: string;
      readonly navigation: EditorNavigation;
    }
  | {
      readonly status: 'step_failed';
      readonly id: number | string;
      readonly guidedFormKey: string;
      readonly stepKey: string;
      readonly error: { readonly message?: string; readonly code?: string; readonly hint?: string };
    };

/**
 * An editor over one entity's Create form.
 *
 * @consumer app
 */
export interface RecordEditor<B extends FormBackend> {
  getSnapshot(): RecordEditorSnapshot<B>;
  /** Returns an idempotent unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Records the pending inline many-to-many change of `column`; an empty diff removes the entry. */
  setManyToManyDiff(column: string, diff: ManyToManyDiff): void;
  /** Records the pending rich-junction change of `column`; an empty diff removes the entry. */
  setRichManyToManyDiff(column: string, diff: RichManyToManyDiff): void;
  /** Records the draft gallery created for `column`; it is linked after the record exists. */
  setGalleryDraft(column: string, galleryId: string): void;
  /** Forgets every pending diff and draft (the page calls it when the steps have all run). */
  clearPending(): void;
  save(): Promise<EditorCreateResult>;
  /**
   * Create, then complete the guided form's step. `beforeSend` (the page's token refresh) runs after the
   * values are transformed and before the request, as the legacy page ordered them.
   */
  saveAndContinue(beforeSend?: () => Promise<void>): Promise<EditorContinueResult>;
  /** Clears the pending diffs and drafts, `createdId` and `saving`, and resets the form to its defaults. */
  resetForAnother(): void;
  /** Reads the schema again and builds a new backend, store and form together; the old ones are dropped. */
  rebuild(): void;
  /** Stops notifying and drops the form. Further commands throw. */
  dispose(): void;
}


const FILE_TYPES: ReadonlySet<EntityPropertyType> = new Set([
  EntityPropertyType.File,
  EntityPropertyType.FileImage,
  EntityPropertyType.FilePDF,
]);

/** The legacy `DataService.parseApiError` result for a failed write. */
function toApiError(err: unknown, constraintMessages: readonly ConstraintMessage[] | undefined): ApiError {
  if (err instanceof DataClientError) {
    const s = err.shape;
    const shape: PostgrestErrorShape = { httpCode: s.httpCode };
    if (s.code !== undefined) shape.code = s.code;
    if (s.details !== undefined) shape.details = s.details;
    if (s.message !== undefined) shape.message = s.message;
    const out: ApiError = {
      httpCode: s.httpCode,
      message: s.message || err.statusText || 'Unknown error',
      humanMessage: humanizeError(shape, { constraintMessages }),
    };
    if (s.code !== undefined) out.code = s.code;
    if (s.details !== undefined) out.details = s.details;
    if (s.hint !== undefined) out.hint = s.hint;
    return out;
  }
  if (err instanceof TransportError) {
    return { httpCode: 0, message: 'Unknown error', humanMessage: humanizeError({ httpCode: 0 }, { constraintMessages }) };
  }
  return { httpCode: 500, message: 'An unexpected error occurred', humanMessage: 'System Error' };
}

const rowId = (body: unknown): number | string | null => {
  const first = Array.isArray(body) ? (body[0] as { id?: number | string } | undefined) : undefined;
  return first?.id ? first.id : null;
};

/**
 * Creates a {@link RecordEditor} for `entity` and schedules its first load.
 *
 * @consumer app
 */
export function recordEditor<B extends FormBackend>(
  deps: EditorDeps,
  entity: EntityHandle,
  options: RecordEditorOptions<B>,
): RecordEditor<B> {
  let disposed = false;
  let generation = 0;
  let scheduled = false;

  const assertAlive = (): void => {
    if (disposed) throw new Error('recordEditor is disposed');
  };

  // ---- state ----------------------------------------------------------------

  let loading = true;
  let error: unknown;
  let properties: readonly SchemaEntityProperty[] = [];
  let formProps: readonly SchemaEntityProperty[] = [];
  let inlineManyToMany: readonly SchemaEntityProperty[] = [];
  let renderables: readonly RenderableItem[] = [];
  let backend: B | null = null;
  let formStore: FormStore | null = null;
  let stopForm: (() => void) | null = null;
  let saving = false;
  let guidedFormKey: string | null = null;
  let createdId: number | string | null = null;

  const manyToMany = new Map<string, ManyToManyDiff>();
  const richManyToMany = new Map<string, RichManyToManyDiff>();
  const galleryDrafts = new Map<string, string>();

  const buildSnapshot = (): RecordEditorSnapshot<B> => ({
    loading,
    error,
    properties,
    inlineManyToMany,
    renderables,
    backend,
    form: formStore ? formStore.getSnapshot() : null,
    saving,
    guidedFormKey,
    createdId,
  });

  const store = createStore<RecordEditorSnapshot<B>>(buildSnapshot());
  /** One keystroke can notify the backend several times; only a snapshot that differs is published. */
  const publish = (): void => {
    if (disposed) return;
    const next = buildSnapshot();
    const cur = store.getSnapshot();
    const same = (Object.keys(next) as (keyof RecordEditorSnapshot<B>)[]).every(k => Object.is(next[k], cur[k]));
    if (!same) store.set(next);
  };

  // ---- loading --------------------------------------------------------------

  const planOf = (props: readonly SchemaEntityProperty[]): RenderPlan => {
    const items: PlanItem[] = props.map(p => ({
      kind: 'property',
      key: p.column_name,
      property: { ...p, itemType: 'property' } as PropertyItem,
      label: { text: p.display_name },
      span: getColumnSpan(p),
    }));
    return { mode: 'create', items, sections: [{ title: undefined, items }] };
  };

  const run = async (id: number): Promise<void> => {
    scheduled = false;
    if (disposed || id !== generation) return;
    const row = entity.liveRow;
    try {
      let nextProps: readonly SchemaEntityProperty[] = [];
      let nextRenderables: readonly RenderableItem[] = [];
      let all: readonly SchemaEntityProperty[] = [];
      if (row) {
        [all, nextRenderables] = await Promise.all([deps.schema.properties(row), deps.schema.formRenderables(entity, 'create')]);
        if (disposed || id !== generation) return;
        nextProps = propsForCreate(all);
      }
      const isInline = (p: SchemaEntityProperty) => p.type === EntityPropertyType.ManyToMany && p.show_inline === true;
      const nextForm = nextProps.filter(p => p.type !== EntityPropertyType.ManyToMany && !FILE_TYPES.has(p.type));
      let nextBackend: B | null = null;
      let nextStore: FormStore | null = null;
      if (row) {
        nextBackend = options.backend();
        nextStore = createFormStore(planOf(nextForm), nextBackend);
        for (const [key, v] of Object.entries(options.prefill ?? {})) {
          if (nextStore.field(key) && !nextBackend.getValue(key)) {
            nextStore.setValue(key, v);
            nextStore.markTouched(key);
          }
        }
      }
      const previous = formStore;
      const previousStop = stopForm;
      properties = nextProps.filter(p => p.type !== EntityPropertyType.ManyToMany || isInline(p)).filter(p => !FILE_TYPES.has(p.type));
      formProps = nextForm;
      inlineManyToMany = nextProps.filter(isInline);
      renderables = nextRenderables;
      backend = nextBackend;
      formStore = nextStore;
      stopForm = nextStore ? nextStore.subscribe(publish) : null;
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

  /** The enabled fields' values, transformed for the API; or why they cannot be sent. */
  type Prepared = { ok: true; data: Record<string, unknown> } | { ok: false; result: { status: 'transform_error'; column: string; message: string } };

  const prepare = (snapshotFields: Record<string, { value: unknown; enabled: boolean }>): Prepared => {
    const data: Record<string, unknown> = {};
    for (const [key, f] of Object.entries(snapshotFields)) if (f.enabled) data[key] = f.value;
    try {
      return { ok: true, data: transformValuesForApi(data, formProps, { mode: 'create', timeZone: options.timeZone }) };
    } catch (e) {
      if (e instanceof ValueTransformError) return { ok: false, result: { status: 'transform_error', column: e.column, message: e.message } };
      throw e;
    }
  };

  /** Common start of both save commands: null when the save may go on, else its early result. */
  const begin = (): { status: 'ignored' } | { status: 'invalid' } | { status: 'transform_error'; column: string; message: string } | { data: Record<string, unknown> } => {
    if (!formStore || saving) return { status: 'ignored' };
    if (!formStore.validate().valid) {
      for (const f of formStore.fields) formStore.markTouched(f.key);
      return { status: 'invalid' };
    }
    const prepared = prepare(formStore.getSnapshot().fields as Record<string, { value: unknown; enabled: boolean }>);
    if (!prepared.ok) return prepared.result;
    return { data: prepared.data };
  };

  const createRecord = async (data: Record<string, unknown>): Promise<{ id: number | string | null } | { error: ApiError }> => {
    try {
      const body = await deps.data.createData(entity.name, data);
      const id = rowId(body);
      if (id !== null) createdId = id;
      return { id };
    } catch (e) {
      return { error: toApiError(e, deps.schema.constraintMessages()) };
    }
  };

  const steps = (data: Record<string, unknown>): EditorStep[] => {
    const out: EditorStep[] = [
      {
        kind: 'record',
        async execute() {
          const r = await createRecord(data);
          publish();
          if ('error' in r) return { success: false, errorMessage: r.error.humanMessage || r.error.message };
          return { success: true };
        },
      },
    ];
    const additions = (property: SchemaEntityProperty, items: readonly { id: number | string; extra?: Record<string, unknown> }[]): EditorStep => ({
      kind: 'many_to_many',
      column: property.column_name,
      property,
      addCount: items.length,
      async execute() {
        if (createdId === null) return { success: false, reason: 'record_id_missing' };
        if (items.length === 0) return { success: true };
        const meta = property.many_to_many_meta!;
        const results = await Promise.allSettled(items.map(i => deps.data.addManyToManyRelation(createdId!, meta, i.id, i.extra)));
        const failedCount = results.filter(r => r.status === 'rejected').length;
        const totalCount = items.length;
        return failedCount === 0 ? { success: true, failedCount, totalCount } : { success: false, failedCount, totalCount, reason: 'additions_failed' };
      },
    });
    const inline = (column: string) => inlineManyToMany.find(p => p.column_name === column && p.many_to_many_meta);
    for (const [column, diff] of manyToMany) {
      const property = inline(column);
      if (property) out.push(additions(property, diff.toAdd.map(id => ({ id }))));
    }
    for (const [column, diff] of richManyToMany) {
      const property = inline(column);
      if (property) out.push(additions(property, diff.toAdd.map(a => ({ id: a.id, extra: { ...a.extraData } }))));
    }
    for (const [column, galleryId] of galleryDrafts) {
      out.push({
        kind: 'gallery_link',
        column,
        async execute() {
          if (createdId === null) return { success: false, reason: 'record_id_missing' };
          try {
            await deps.data.callRpc('link_gallery_to_entity', {
              p_gallery_id: galleryId,
              p_entity_type: entity.name,
              p_entity_id: String(createdId),
              p_column_name: column,
            });
            return { success: true };
          } catch (e) {
            const message = e instanceof DataClientError ? e.shape.message : undefined;
            return message ? { success: false, errorMessage: message } : { success: false, reason: 'gallery_link_failed' };
          }
        },
      });
    }
    if (galleryDrafts.size > 0) {
      out.push({
        kind: 'gallery_images',
        async execute() {
          if (!options.galleryImages) return { success: true };
          try {
            return (await options.galleryImages()) ? { success: true } : { success: false, reason: 'gallery_images_failed' };
          } catch {
            return { success: false, reason: 'gallery_images_failed' };
          }
        },
      });
    }
    return out;
  };

  const hasPending = (): boolean => manyToMany.size > 0 || richManyToMany.size > 0 || galleryDrafts.size > 0;

  const runSave = async (): Promise<EditorCreateResult> => {
    const started = begin();
    if (!('data' in started)) return started;
    saving = true;
    if (hasPending()) {
      publish();
      return { status: 'steps', steps: steps(started.data) };
    }
    publish();
    const r = await createRecord(started.data);
    saving = false;
    publish();
    return 'error' in r ? { status: 'failed', error: r.error } : { status: 'created', id: r.id };
  };

  const runSaveAndContinue = async (beforeSend?: () => Promise<void>): Promise<EditorContinueResult> => {
    const started = begin();
    if (!('data' in started)) return started;
    saving = true;
    publish();
    const finish = <T extends EditorContinueResult>(result: T): T => {
      saving = false;
      publish();
      return result;
    };
    if (beforeSend) {
      try {
        await beforeSend();
      } catch (cause) {
        return finish({ status: 'aborted', cause });
      }
    }
    const created = await createRecord(started.data);
    if ('error' in created) return finish({ status: 'failed', error: created.error });
    const id = created.id;
    if (!guidedFormKey || id === null) return finish({ status: 'created', id });

    const ctx: { step_key?: string | null; parent_id?: number | string; definition?: { parent_table?: string } } | null = await deps.data
      .callRpc('get_guided_form_context', {
        p_guided_form_key: guidedFormKey,
        p_table_name: entity.name,
        p_record_id: Number(id),
      })
      .catch(() => null);
    if (!ctx) return finish({ status: 'created', id });

    const stepKey = ctx.step_key || '__parent__';
    const parentId = String(ctx.parent_id);
    const parentTable = ctx.definition?.parent_table ?? '';
    let completion: {
      auto_submitted?: boolean;
      navigate_to?: string | null;
      next_record_id?: number | string | null;
      next_step_table?: string | null;
      all_data_steps_complete?: boolean;
    };
    try {
      completion =
        (await deps.data.callRpc('complete_guided_form_step', {
          p_guided_form_key: guidedFormKey,
          p_parent_id: Number(parentId),
          p_step_key: stepKey,
        })) ?? {};
    } catch (e) {
      const error: { message?: string; code?: string; hint?: string } = {};
      if (e instanceof DataClientError) {
        if (e.shape.message !== undefined) error.message = e.shape.message;
        if (e.shape.code !== undefined) error.code = e.shape.code;
        if (e.shape.hint !== undefined) error.hint = e.shape.hint;
      } else if (e instanceof Error) {
        error.message = e.message;
      }
      return finish({ status: 'step_failed', id, guidedFormKey, stepKey, error });
    }

    let navigation: EditorNavigation = { kind: 'none' };
    if (completion.auto_submitted) {
      navigation = completion.navigate_to ? { kind: 'url', url: completion.navigate_to } : { kind: 'view', table: parentTable, id: parentId };
    } else if (completion.next_record_id && completion.next_step_table) {
      navigation = { kind: 'edit', table: completion.next_step_table, id: completion.next_record_id };
    } else if (completion.all_data_steps_complete) {
      navigation = { kind: 'view', table: parentTable, id: parentId };
    }
    return finish({ status: 'continued', id, guidedFormKey, stepKey, navigation });
  };

  // ---- commands -------------------------------------------------------------

  return {
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
    setGalleryDraft(column, galleryId) {
      assertAlive();
      galleryDrafts.set(column, galleryId);
    },
    clearPending() {
      assertAlive();
      manyToMany.clear();
      richManyToMany.clear();
      galleryDrafts.clear();
      saving = false;
      publish();
    },
    save() {
      assertAlive();
      return runSave();
    },
    saveAndContinue(beforeSend) {
      assertAlive();
      return runSaveAndContinue(beforeSend);
    },
    resetForAnother() {
      assertAlive();
      manyToMany.clear();
      richManyToMany.clear();
      galleryDrafts.clear();
      createdId = null;
      saving = false;
      if (formStore) {
        const defaults: Record<string, unknown> = {};
        for (const p of formProps) defaults[p.column_name] = getDefaultValueForProperty(p);
        formStore.reset(defaults);
      }
      publish();
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
}
