/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `recordEditor`: the Create and Edit pages' form and save commands, without layout
 * (`docs/notes/FRONTEND_SDK_DESIGN.md` §11). One entry point with overloads on
 * `options.mode`. Create is built. Edit is declared (`RecordEditorEditOptions`,
 * `RecordEditorEditSnapshot`, `RecordEditorEdit` and their result types) and built in pieces:
 * load, form, plain and coordinated save, galleries, `rebuild` and `dispose` (`record-editor-edit.ts`);
 * the series, guided-form and autosave commands throw `not implemented yet` until their commits.
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
import { createFormStore } from '../forms/form-store.js';
import type { FormStore } from '../forms/form-store.js';
import { EntityPropertyType } from '../model/index.js';
import { getDefaultValueForProperty, propsForCreate } from '../schema/property-views.js';
import { ValueTransformError, transformValuesForApi } from '../transform/values.js';
import type { ApiError, ConstraintMessage } from '../model/index.js';
import type { EntityHandle } from '../handles/handles.js';
import type { FormBackend } from '../forms/backend.js';
import type { FormSnapshot } from '../forms/form-store.js';
import type {
  EntityData,
  GuidedFormContext,
  RenderableItem,
  SchemaEntityProperty,
  SeriesEditScope,
  SeriesMembership,
} from '../model/index.js';
import type { FacadeDeps, FacadeSchema } from './deps.js';
import { editEditor } from './record-editor-edit.js';
import { FILE_TYPES, buildPlan, isInlineManyToMany, publishWhenChanged, toApiError } from './record-editor-shared.js';

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
 * Options of a create editor (`mode: 'create'`).
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
 * Options of an edit editor (`mode: 'edit'`). Edit mode reads the record, builds the form from its values and
 * saves through one PATCH, or hands back the steps of a coordinated save.
 *
 * @consumer typed recordEditor
 */
export interface RecordEditorEditOptions<B extends FormBackend> {
  readonly mode: 'edit';
  /** Called once per built form: the first load and every {@link RecordEditorEdit.rebuild}. */
  readonly backend: () => B;
  /** IANA zone a `DateTimeLocal` control value is read in (core never reads the ambient zone). */
  readonly timeZone: string;
  /**
   * The record's id as the route gave it. Legacy sends it unchanged to the record read, the PATCH, every
   * many-to-many request and `get_series_membership` (`p_entity_id`). Only `split_series_from_date`
   * (`p_edited_entity_id`) gets `Number(recordId)`; the guided-form RPCs take `Number` of the loaded row's `id`
   * (`p_record_id`) and of the parent id (`p_parent_id`). The editor does the same, so a string id is never
   * coerced anywhere else.
   */
  readonly recordId: number | string;
  /**
   * Quiet time after the last change of the form before an autosave runs, in milliseconds. Default 1500 (legacy
   * `debounceTime(1500)`). Timers are `setTimeout`, not the clock, which only reads `now()`.
   */
  readonly autoSaveDebounceMs?: number;
  /** How long `autoSave` stays `'saved'` before it returns to `'idle'`, in milliseconds. Default 2000. */
  readonly autoSaveSavedMs?: number;
}

/**
 * The options of {@link recordEditor}: `mode` picks the editor.
 *
 * @consumer typed recordEditor
 */
export type RecordEditorOptions<B extends FormBackend> = RecordEditorCreateOptions<B> | RecordEditorEditOptions<B>;

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
 * - `aborted`: `beforeSend` rejected (`cause`); nothing was sent.
 * - `steps`: pending many-to-many or gallery changes exist; nothing was sent. The page runs the steps.
 *
 * @consumer typed recordEditor
 */
export type EditorCreateResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'invalid' }
  | { readonly status: 'transform_error'; readonly column: string; readonly message: string }
  | { readonly status: 'aborted'; readonly cause: unknown }
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
  /**
   * Validate, transform and send the one create request, or hand back the steps of a coordinated create.
   * `beforeSend` (the page's token refresh) runs after the values are transformed and before anything is
   * sent, including before the steps are returned; if it rejects the result is `aborted`.
   */
  save(beforeSend?: () => Promise<void>): Promise<EditorCreateResult>;
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

// ---- edit contract (declared; implemented by later commits) --------------------

/**
 * A gallery editor the page mounts for a PhotoGallery column. It replaces legacy's `@ViewChildren(EditPropertyComponent)`
 * query (`edit.page.ts:264`): the page registers each gallery with {@link RecordEditorEdit.registerGallery}.
 *
 * @consumer typed recordEditor
 */
export interface EditorGallery {
  /** Buffered reorders, captions or removals that a save has not persisted. */
  hasPendingChanges(): boolean;
  /** Persists the buffered changes; resolves whether all were saved. */
  save(): Promise<boolean>;
}

/**
 * The guided-form view of the record being edited, for an entity with a `guided_form_key`. Each field mirrors a
 * legacy signal of the edit page (`edit.page.ts:1016-1085`), whose definition is quoted.
 *
 * @consumer typed recordEditor
 */
export interface EditorGuidedForm {
  /** `guidedFormKey`: the entity's `guided_form_key`. */
  readonly key: string;
  /**
   * `guidedFormContext`: `get_guided_form_context(key, entity name, Number(row id))`, with every step's
   * `conditions` defaulted to `[]`. `null` until it returns, and when it fails (legacy logs and goes on without).
   */
  readonly context: GuidedFormContext | null;
  /** `guidedFormParentId`: `String(context.parent_id)`; `null` without a context. On a child step this differs from `recordId`. */
  readonly parentId: string | null;
  /** `guidedFormStatus`: `context?.parent_status_key ?? null`. */
  readonly status: string | null;
  /** `isGuidedFormDraft`: `status === 'draft'`. Drafts autosave, skip required validation on save, and leave through the parent's detail page. */
  readonly draft: boolean;
  /**
   * `isGuidedFormLocked`: `false` without a context and when the entity grants `update` (RBAC bypasses the lock, as
   * the backend does); otherwise `definition.lock_on_submit === true && parent_status_key === 'submitted'`.
   */
  readonly locked: boolean;
  /**
   * `isCurrentStepSkippable`: `false` unless a context exists and the form is a draft. The step is the context step
   * whose `step_table` is the entity's table; `false` when none or when it is `__parent__`. Otherwise
   * the step's effective entry (`getEffectiveSteps(steps, undefined, progress)`) gives `!isRequired && !isSkipped`,
   * and `false` when the entry is missing.
   */
  readonly skippable: boolean;
  /** `isEditingCompletedStep`: the user left display mode with {@link RecordEditorEdit.enterEditMode}. Reset to `false` whenever the context loads. */
  readonly editingCompletedStep: boolean;
  /**
   * `showCompletedStepDisplayMode`: `status !== null && !draft && !editingCompletedStep`. The page shows
   * `displayRecord` read-only instead of the form.
   */
  readonly completedStepDisplay: boolean;
  /**
   * `displayData`: the record read again with every property's `propertyToSelectString` (embedded FK, Status and
   * Category objects) for display mode. Read when the context arrives and the form is not a draft, and again after
   * a completed-step edit saves (`saved` with `after: 'completed_step'`). `null` until read.
   */
  readonly displayRecord: EntityData | null;
}

/**
 * Everything an edit editor knows at one moment. Stable between changes (the `useSyncExternalStore` contract).
 * It carries the create snapshot's fields, except `createdId`, plus the record, series, guided-form and autosave state.
 *
 * @consumer typed recordEditor
 */
export interface RecordEditorEditSnapshot<B extends FormBackend> {
  /** True from creation until the first load (schema, then the record) settles, and while a rebuild runs. */
  readonly loading: boolean;
  /** The schema load's or the record read's failure, or `undefined`. */
  readonly error: unknown;
  /**
   * The edit properties: `propsForEdit` (structural `status_id` and the like included) minus non-inline many-to-many,
   * as legacy's `properties$` (`:144`). File properties stay: edit carries them in the form. `propsForEdit` drops
   * every `show_on_edit === false` property except the structural ones (`display_name`, `status_id`, `submitted_at`),
   * which are here but are not form fields.
   */
  readonly properties: readonly SchemaEntityProperty[];
  /** The inline many-to-many properties (`show_inline`), which the form does not hold as fields. */
  readonly inlineManyToMany: readonly SchemaEntityProperty[];
  readonly renderables: readonly RenderableItem[];
  /** The backend of the current form; `null` before the first build, while the record is missing, and for an entity that is not in the schema. */
  readonly backend: B | null;
  /** The form store's snapshot; `null` as `backend`. */
  readonly form: FormSnapshot | null;
  /** A save command is in flight. Held after `steps` until {@link RecordEditorEdit.clearPending}. */
  readonly saving: boolean;
  /** The entity's `guided_form_key`, read when the form was built. */
  readonly guidedFormKey: string | null;
  /** The route's id, as {@link RecordEditorEditOptions.recordId} gave it. */
  readonly recordId: number | string;
  /**
   * The loaded row with each inline many-to-many column flattened to its related rows (legacy `currentData`, `:186`),
   * for the inline editors. `null` until loaded and when the record is not found.
   */
  readonly record: EntityData | null;
  /** The record read returned no row. `record`, `backend` and `form` are `null`. */
  readonly notFound: boolean;
  /**
   * Series membership, read after the record loads and only when a `TimeSlot` or `RecurringTimeSlot` property is in
   * the form (`:640`). `undefined` before the read, without such a property, and when the read fails (legacy's silent fail).
   * Re-read after a "this and following" split.
   */
  readonly series: SeriesMembership | undefined;
  /** A series member's save is waiting for {@link RecordEditorEdit.saveWithScope} or {@link RecordEditorEdit.cancelScope}. */
  readonly scopePending: boolean;
  /** `null` without a `guided_form_key` and before the record loads. */
  readonly guidedForm: EditorGuidedForm | null;
  /**
   * Autosave of a draft guided-form step: `'saving'` while its PATCH is in flight, `'saved'` after it succeeds until
   * `autoSaveSavedMs` passes, else `'idle'`. Legacy turns autosave off for good on the first save command that reaches
   * `cancelAutoSave` (a successful or failed save, Save and Continue, a step jump) and only a context load turns it
   * back on; the editor keeps that rule.
   */
  readonly autoSave: 'idle' | 'saving' | 'saved';
  /** {@link RecordEditorEdit.saveAndContinue} is in flight (legacy `savingAndContinuing`). */
  readonly savingAndContinuing: boolean;
}

/**
 * Why an edit step could not complete, for the page to word: `changes_failed` (see `failedCount` / `totalCount`;
 * legacy's English was `${failed} of ${total} changes failed`) or `gallery_save_failed` (legacy: `Failed to save
 * gallery changes`). Server text, when there is some, is in `errorMessage` instead.
 *
 * @consumer typed recordEditor
 */
export type EditorEditStepReason = 'changes_failed' | 'gallery_save_failed';

/**
 * @consumer typed recordEditor
 */
export interface EditorEditStepResult {
  readonly success: boolean;
  readonly failedCount?: number;
  readonly totalCount?: number;
  readonly errorMessage?: string;
  readonly reason?: EditorEditStepReason;
}

/**
 * One step of a coordinated save. The page runs the steps in order and stops at the first that fails; operations
 * inside a step run in parallel. The order is the record, each pure junction (removals, then additions), each rich
 * junction (removals, additions, updates), then the galleries. `kind` and its counts are what the page words the
 * label from (legacy: `Saving record`, `Updating <name> (<add> to add, <remove> to remove)`,
 * `Updating <name> (<n> changes)`, `Saving gallery changes`).
 *
 * @consumer typed recordEditor
 */
export type EditorEditStep = (
  | { readonly kind: 'record' }
  | {
      readonly kind: 'many_to_many';
      readonly column: string;
      readonly property: SchemaEntityProperty;
      readonly addCount: number;
      readonly removeCount: number;
    }
  | {
      readonly kind: 'rich_many_to_many';
      readonly column: string;
      readonly property: SchemaEntityProperty;
      readonly addCount: number;
      readonly removeCount: number;
      readonly updateCount: number;
    }
  | { readonly kind: 'galleries' }
) & { execute(): Promise<EditorEditStepResult> };

/**
 * Outcome of {@link RecordEditorEdit.save} (legacy `submitForm` and `performEdit`).
 * - `ignored`: there is no form, or a save is in flight; nothing was sent.
 * - `invalid`: every field was marked touched; nothing was sent. A guided-form draft skips this check (`:309`).
 * - `transform_error`: a value cannot be sent as written (`column`, English `message`); nothing was sent.
 * - `aborted`: `beforeSend` rejected (`cause`); nothing was sent. The page words legacy's 401 "Session expired".
 * - `scope_required`: the record belongs to a series (`series.is_member`) and the form is not a guided-form draft.
 *   The transformed data is held, `scopePending` is true, nothing was sent, and `beforeSend` has not run. The page
 *   asks for a scope and calls {@link RecordEditorEdit.saveWithScope} or {@link RecordEditorEdit.cancelScope}.
 * - `saved`: the PATCH succeeded. `after` says what the page does next: `success` (the success modal, or the `returnTo`
 *   redirect, which stays page state), `guided_parent` (a guided-form draft: leave through `navigation`, the parent's
 *   detail page; legacy falls back to `success` without a context), or `completed_step` (an edit of a completed
 *   step: the editor has left edit mode and read `guidedForm.displayRecord` again).
 * - `steps`: pending many-to-many or gallery changes exist; nothing was sent. The page runs the steps (the record
 *   step first, absent after a series split) and calls {@link RecordEditorEdit.clearPending} when they have all run.
 * - `failed`: the PATCH was rejected: `error` is legacy's `ApiError`, or the `httpCode: 500` "System Error" shape
 *   when the request threw.
 *
 * @consumer typed recordEditor
 */
export type EditorSaveResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'invalid' }
  | { readonly status: 'transform_error'; readonly column: string; readonly message: string }
  | { readonly status: 'aborted'; readonly cause: unknown }
  | { readonly status: 'scope_required' }
  | { readonly status: 'saved'; readonly after: 'success' }
  | { readonly status: 'saved'; readonly after: 'guided_parent'; readonly navigation: EditorNavigation }
  | { readonly status: 'saved'; readonly after: 'completed_step' }
  | { readonly status: 'steps'; readonly steps: readonly EditorEditStep[] }
  | { readonly status: 'failed'; readonly error: ApiError };

/**
 * Outcome of {@link RecordEditorEdit.saveWithScope}: every {@link EditorSaveResult} case but `scope_required`,
 * plus the two series failures, which carry no UI text (the page owns the wording: `error.series_split_failed`
 * for the split; legacy's English for the update was `Series Update Failed`).
 * - `series_split_failed`: the split could not run or failed, so nothing was saved (`this_and_future`).
 *   `detail` is the server's message when there is one (legacy's `result.message`, or the thrown error's
 *   `error.message`); it is absent when the series schedule could not be read.
 * - `series_update_failed`: `update_series_template` reported failure (`all`). `message` is the server's, if any.
 *
 * @consumer typed recordEditor
 */
export type EditorScopedSaveResult =
  | Exclude<EditorSaveResult, { readonly status: 'scope_required' }>
  | { readonly status: 'series_split_failed'; readonly detail?: string }
  | { readonly status: 'series_update_failed'; readonly message?: string };

/**
 * Outcome of {@link RecordEditorEdit.saveAndContinue} (legacy `:1296`).
 * - `ignored`: no form, no guided-form context, or a save command in flight; nothing was sent.
 * - `invalid`: every field was marked touched; nothing was sent.
 * - `transform_error`: as {@link EditorSaveResult}.
 * - `failed`: the PATCH was rejected; `error` as in {@link EditorSaveResult}, except that a thrown request's
 *   `humanMessage` is legacy's `An unexpected error occurred.` here.
 * - `related_failed`: the record is saved but pending many-to-many changes failed; `message` is legacy's
 *   `${failed} of ${n} related item changes failed` (counts when known).
 * - `step_failed`: the record and related items are saved but completing the step failed; `error` carries the RPC error's text.
 * - `continued`: the step completed; the page tracks `GuidedForm / StepComplete` for `guidedFormKey:stepKey`,
 *   invalidates its cached context and performs `navigation`.
 *
 * @consumer typed recordEditor
 */
export type EditorEditContinueResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'invalid' }
  | { readonly status: 'transform_error'; readonly column: string; readonly message: string }
  | { readonly status: 'failed'; readonly error: ApiError }
  | { readonly status: 'related_failed'; readonly message: string; readonly failedCount?: number; readonly totalCount?: number }
  | {
      readonly status: 'step_failed';
      readonly guidedFormKey: string;
      readonly stepKey: string;
      readonly error: { readonly message?: string; readonly code?: string; readonly hint?: string };
    }
  | {
      readonly status: 'continued';
      readonly guidedFormKey: string;
      readonly stepKey: string;
      readonly navigation: EditorNavigation;
    };

/**
 * Outcome of {@link RecordEditorEdit.goToStep} (legacy `onGuidedFormStepClick`, `:1247`).
 * - `ignored`: no guided-form context; nothing happened and autosave is untouched.
 * - `none`: nothing to open. An unknown step or the current step leaves autosave untouched; a step without
 *   `parent_fk_column`, or an ensure that returns no record id, comes after autosave was cancelled.
 * - `navigate`: autosave is cancelled; the page performs `navigation`.
 * - `failed`: `ensure_guided_form_step_record` failed. `error.humanMessage` is the server's message or legacy's
 *   English `Failed to load step record.`; `error.message` is the server's message or the error's text.
 *
 * @consumer typed recordEditor
 */
export type EditorStepNavigation =
  | { readonly status: 'ignored' }
  | { readonly status: 'none' }
  | { readonly status: 'navigate'; readonly navigation: EditorNavigation }
  | { readonly status: 'failed'; readonly error: { readonly humanMessage: string; readonly message?: string } };

/**
 * An editor over one record's Edit form. Every command that sends or navigates resolves `ignored` while another
 * save command is in flight, as the create editor does.
 *
 * Field locks (legacy `lockFieldsEffect`, `:1035`): once the guided-form context loads, if the form is not a draft
 * and the entity grants no `update`, the editor disables every field named by a step condition
 * (`getLockedFields`) through `store.setEnabled(key, false)`. There is no command; disabled fields are left out of a save.
 *
 * There is no unsaved-changes guard: legacy's edit route has no `canDeactivate`, and the editor adds none.
 * What stays on the page: navigation, toasts and modals, translation, the `returnTo` redirect and profile-cache
 * invalidation, analytics, the token refresh (passed as `beforeSend`), the many-to-many pickers and gallery
 * editors that produce the diffs, and the progress UI that runs the steps.
 *
 * @consumer typed recordEditor
 */
export interface RecordEditorEdit<B extends FormBackend> {
  getSnapshot(): RecordEditorEditSnapshot<B>;
  /** Returns an idempotent unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Records the pending inline many-to-many change of `column`; an empty diff removes the entry. */
  setManyToManyDiff(column: string, diff: ManyToManyDiff): void;
  /** Records the pending rich-junction change of `column`; an empty diff removes the entry. */
  setRichManyToManyDiff(column: string, diff: RichManyToManyDiff): void;
  /**
   * Registers the gallery editor of `column` and returns its unregister function. Legacy's rule: a save takes the
   * coordinated path when there are many-to-many diffs or a registered gallery `hasPendingChanges()`, and then
   * the `galleries` step is added whenever any gallery is registered, pending or not (`edit.page.ts:852`).
   */
  registerGallery(column: string, gallery: EditorGallery): () => void;
  /** Forgets every pending diff and releases `saving` (the page calls it when the steps have all run). */
  clearPending(): void;
  /**
   * Validate, transform and send the one PATCH (legacy `submitForm` and `performEdit`), or hand back the steps of a
   * coordinated save, or ask for a series scope. The order: a guided-form draft skips validation and the scope check;
   * otherwise an invalid form is `invalid` and a series member is `scope_required`. Autosave is cancelled on every path
   * that passes validation (and for a draft before transforming). `beforeSend` (the page's token refresh) runs after the
   * values are transformed and before anything is sent, including before the steps are returned.
   */
  save(beforeSend?: () => Promise<void>): Promise<EditorSaveResult>;
  /**
   * Continue a held save (`scope_required`) with the chosen scope (legacy `onScopeConfirm`). Resolves `ignored`
   * when no save is held.
   * - `this_only`: the plain save path.
   * - `this_and_future`: split first, then the occurrence is saved by the same RPC. A failed split resolves
   *   `series_split_failed` and saves nothing. Only the changed values are sent, the template never carries the time slot
   *   or Status columns, and the membership is re-read afterwards; pending related changes then run as `steps`
   *   without the record step.
   * - `all`: `update_series_template` with the form data. Legacy sends no coordinated many-to-many here and never
   *   sets `saving`; commit 11 decides parity.
   * Without the series ids legacy needs (`series_id`, and `occurrence_date` for the split), both fall back to the plain save.
   * `beforeSend` runs first on every path, before any request.
   */
  saveWithScope(scope: SeriesEditScope, beforeSend?: () => Promise<void>): Promise<EditorScopedSaveResult>;
  /** Drops the held save and clears `scopePending` (legacy `onScopeCancel`). */
  cancelScope(): void;
  /**
   * Save the step, flush pending many-to-many diffs, complete the guided-form step and say where to go. Unlike the
   * create editor's it does no token refresh. It cancels autosave, and if an autosave PATCH is in flight it waits
   * for it, checking every 200 ms for at most 15 checks (3 seconds), then goes on regardless. The PATCH
   * runs first, then the diffs in parallel, then `complete_guided_form_step`. The navigation: `auto_submitted`
   * goes to `navigate_to` or the parent's detail page; `next_record_id` with `next_step_table` goes to that edit page;
   * `all_data_steps_complete` goes to the parent's detail page; otherwise `none`.
   */
  saveAndContinue(): Promise<EditorEditContinueResult>;
  /**
   * Leave a draft step without saving or validating (legacy `skipStep`, `:1468`): cancels autosave, then resolves the
   * next effective, non-skipped data step in `step_order` after the current one, ensures its record
   * (`ensure_guided_form_step_record`) and navigates to its edit page; with no next step, or when ensuring fails,
   * to the parent's detail page. `null` when there is no context, parent, or current step.
   */
  skipStep(): Promise<EditorNavigation | null>;
  /** Open another step from the guided-form navigation (`__parent__` edits the parent, `__review__` views it); see {@link EditorStepNavigation}. */
  goToStep(stepKey: string): Promise<EditorStepNavigation>;
  /** Leave display mode of a completed guided-form step (`guidedForm.editingCompletedStep` becomes true). */
  enterEditMode(): void;
  /**
   * Leave edit mode of a completed step and put the form back to the loaded record: the control values of `record`
   * and pristine, written through one `store.reset(loadedControlValues)`. Legacy wrote each control with
   * `emitEvent: false` (no dependent re-query, no autosave) and called only `markAsPristine`, so touched state
   * survived; `reset` also clears it, which commit 12 pins or records as a departure.
   */
  cancelEditMode(): void;
  /** Reads the schema and the record again and builds a new backend, store and form together; the old ones are dropped. */
  rebuild(): void;
  /** Stops notifying, cancels autosave and drops the form. Further commands throw. */
  dispose(): void;
}

const rowId = (body: unknown): number | string | null => {
  const first = Array.isArray(body) ? (body[0] as { id?: number | string } | undefined) : undefined;
  return first?.id ? first.id : null;
};

/**
 * Creates a {@link RecordEditor} (`mode: 'create'`) or a {@link RecordEditorEdit} (`mode: 'edit'`) for `entity` and
 * schedules its first load. The edit editor's series, guided-form and autosave commands are not built yet and
 * throw `recordEditor edit mode: <name> is not implemented yet`.
 *
 * @consumer app
 */
export function recordEditor<B extends FormBackend>(deps: EditorDeps, entity: EntityHandle, options: RecordEditorCreateOptions<B>): RecordEditor<B>;
export function recordEditor<B extends FormBackend>(deps: EditorDeps, entity: EntityHandle, options: RecordEditorEditOptions<B>): RecordEditorEdit<B>;
export function recordEditor<B extends FormBackend>(
  deps: EditorDeps,
  entity: EntityHandle,
  options: RecordEditorOptions<B>,
): RecordEditor<B> | RecordEditorEdit<B> {
  if (options.mode === 'edit') return editEditor(deps, entity, options);
  return createEditor(deps, entity, options);
}

/** The create editor: the whole of `recordEditor` before edit mode was declared. */
function createEditor<B extends FormBackend>(
  deps: EditorDeps,
  entity: EntityHandle,
  options: RecordEditorCreateOptions<B>,
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
    publishWhenChanged(store, buildSnapshot());
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
        [all, nextRenderables] = await Promise.all([deps.schema.properties(row), deps.schema.formRenderables(entity, 'create')]);
        if (disposed || id !== generation) return;
        nextProps = propsForCreate(all);
      }
      const isInline = isInlineManyToMany;
      const nextForm = nextProps.filter(p => p.type !== EntityPropertyType.ManyToMany && !FILE_TYPES.has(p.type));
      let nextBackend: B | null = null;
      let nextStore: FormStore | null = null;
      if (row) {
        nextBackend = options.backend();
        nextStore = createFormStore(buildPlan(nextForm, 'create'), nextBackend);
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

  const runSave = async (beforeSend?: () => Promise<void>): Promise<EditorCreateResult> => {
    const started = begin();
    if (!('data' in started)) return started;
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
    if (hasPending()) return { status: 'steps', steps: steps(started.data) };
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
    save(beforeSend) {
      assertAlive();
      return runSave(beforeSend);
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
        // The reset writes without events, but the legacy page's `reset(defaults)` emitted on every control, and
        // dependent options (a select filtered by another field) re-query on that emission. Setting each field to
        // its default through the store lets the backend tell its dependents; nothing turns dirty or touched.
        for (const key of Object.keys(defaults)) formStore.setValue(key, defaults[key]);
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
