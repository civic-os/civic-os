/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `recordViewer`: the Detail page's data and commands, without layout
 * (`docs/notes/FRONTEND_SDK_DESIGN.md` §11).
 *
 * The viewer loads one record of one entity and everything the page shows
 * around it: the detail properties and renderables, the entity's actions with
 * their visibility and enablement against the record, payment availability,
 * inverse-relationship previews, series membership and the guided-form
 * context. It runs the commands the page offers: an entity action
 * (with its parameter options), delete (with series scopes), payment
 * initiation and guided-form submit.
 *
 * What stays on the page: navigation, modals, toasts, the document title,
 * translation (results carry keys and raw messages, never UI text),
 * analytics, maintenance-mode gating of the Edit and Delete buttons, the
 * `FormGroup` of an action's parameters, file and gallery uploads for
 * parameters, the 1.5 s auto-close after an action, and the Edit button.
 *
 * Loading: creation schedules one load in a microtask. The record, the
 * entity's actions (whose condition columns join the record's select) and the
 * properties load first; the sections around the record (inverse previews,
 * series, guided-form context) load after it, each settling
 * on its own. {@link RecordViewer.reload} runs the whole sequence again, with
 * the stale values kept until the new ones arrive. A new load aborts the
 * previous one (latest wins).
 */

import { createStore } from '../client/store.js';
import { DataClientError } from '../client/errors.js';
import { evaluateActionCondition, evaluateGuidedFormCondition, extractConditionFieldNames } from '../conditions/index.js';
import { humanizeError } from '../errors/index.js';
import type { EntityHandle } from '../handles/handles.js';
import type { EntityFeatures, EntityPermissions } from '../handles/handles.js';
import { EntityPropertyType } from '../model/index.js';
import type {
  DataQuery,
  EffectiveGuidedFormStep,
  EntityAction,
  EntityActionParam,
  EntityActionResult,
  EntityData,
  GuidedFormContext,
  GuidedFormStep,
  InverseRelationshipData,
  InverseRelationshipMeta,
  PaymentValue,
  RenderableItem,
  SchemaEntityProperty,
  SchemaEntityTable,
  SeriesEditScope,
  SeriesMembership,
} from '../model/index.js';
import { transformManyToManyData } from '../query/response.js';
import { propsForDetail } from '../schema/property-views.js';
import { propertyToSelectString } from '../schema/select.js';
import { TransportError } from '../transport/errors.js';
import type { AbortSignalLike } from '../transport/types.js';
import type { FacadeDeps, FacadeSchema } from './deps.js';

/**
 * The schema as the viewer reads it, beyond {@link FacadeSchema.properties}.
 * The generic app implements each over `SchemaService`.
 *
 * @consumer typed recordViewer
 */
export interface ViewerSchema extends FacadeSchema {
  /** `getDetailRenderables`: the detail properties merged with static text blocks, in `sort_order`. */
  renderables(entity: EntityHandle): Promise<readonly RenderableItem[]>;
  /** `getEntityActions`: the actions the caller may see, by `sort_order`. Never cached (`can_execute` follows the JWT). Resolves `[]` on failure. */
  actions(entity: EntityHandle): Promise<readonly EntityAction[]>;
  /** `getInverseRelationships`: every FK that points at the entity, minus `excludeTables`, each with its preview limit and mode. */
  inverseRelationships(
    entity: EntityHandle,
    excludeTables?: ReadonlySet<string>,
  ): Promise<readonly InverseRelationshipMeta[]>;
  /** All entities of the schema, for the inverse previews' `sort_order`. */
  entities(): Promise<readonly SchemaEntityTable[]>;
}

/**
 * {@link FacadeDeps} with the schema reads the viewer needs.
 *
 * @consumer typed recordViewer
 */
export interface ViewerDeps extends FacadeDeps {
  readonly schema: ViewerSchema;
}

/**
 * One entity action as it stands for the loaded record. Only actions the
 * caller may execute (`can_execute`) are listed; `visible` is the
 * `visibility_condition` against the record, so the page shows
 * `actions.filter(a => a.visible)`.
 *
 * @consumer typed recordViewer
 */
export interface ViewerAction {
  /** The action's `action_name`. */
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: string;
  /** The DaisyUI color modifier: `primary`, `error`, ... */
  readonly buttonStyle: string;
  readonly sortOrder: number;
  readonly requiresConfirmation: boolean;
  readonly confirmationMessage?: string;
  readonly defaultSuccessMessage?: string;
  /** Parameters in `sort_order`. Empty when the action takes none. */
  readonly parameters: readonly EntityActionParam[];
  /** `can_execute` and the visibility condition against the record. */
  readonly visible: boolean;
  /** The enabled condition against the record (none means enabled). */
  readonly enabled: boolean;
  /** `disabledTooltip` while disabled, otherwise the description. */
  readonly tooltip?: string;
}

/**
 * Payment state for an entity with a Payment property.
 *
 * @consumer typed recordViewer
 */
export interface ViewerPayment {
  /**
   * The entity has `payment_initiation_rpc` and a Payment property, and the
   * record's payment is not `succeeded`. Pending, failed and canceled
   * payments can be started (again).
   */
  readonly available: boolean;
  /** An unfinished payment exists: the page labels the button "Complete Payment", otherwise "Pay Now". */
  readonly resume: boolean;
  /** The record's embedded payment value, when the record has one. */
  readonly payment: PaymentValue | undefined;
  /** {@link RecordViewer.initiatePayment} is in flight. */
  readonly loading: boolean;
}

/**
 * The guided-form view of the record, for an entity with a `guided_form_key`.
 *
 * @consumer typed recordViewer
 */
export interface ViewerGuidedForm {
  /** `null` until `get_guided_form_context` returns, and when it fails. */
  readonly context: GuidedFormContext | null;
  /** `parent_status_key === 'submitted'`. */
  readonly submitted: boolean;
  /** Status `complete`, or `draft` with every required step done, or submitted. */
  readonly showReview: boolean;
  /** The context's steps with completion and skip state; `[]` without a context. */
  readonly steps: readonly EffectiveGuidedFormStep[];
  /** The first required, incomplete, non-skipped step (`__parent__` for the record itself); `null` when none. */
  readonly nextStepKey: string | null;
  /** {@link RecordViewer.submitGuidedForm} is in flight. */
  readonly submitting: boolean;
}

/**
 * Everything the viewer knows at one moment. Stable between changes (the
 * `useSyncExternalStore` contract).
 *
 * @consumer typed recordViewer
 */
export interface RecordViewerSnapshot {
  /** True from creation until the first load settles, and while a reload runs. */
  readonly loading: boolean;
  /** The load's failure, or `undefined`. */
  readonly error: unknown;
  /** The read succeeded and returned no row. */
  readonly notFound: boolean;
  /**
   * The record, with the M:M properties flattened to arrays of related rows
   * (`_junction` holds a rich junction's extra columns). Condition-only
   * columns are present on it and not in `properties`. `undefined` before the
   * first load settles, when it fails, and when no row matches; kept (stale)
   * while a reload runs.
   */
  readonly record: EntityData | undefined;
  /** `propsForDetail`: every property the page may show, M:M included. */
  readonly properties: readonly SchemaEntityProperty[];
  /** The detail renderables: `properties` that show on detail, with static text blocks in `sort_order`. */
  readonly renderables: readonly RenderableItem[];
  /** Properties for the main grid: not M:M (or inline M:M) and not `show_on_detail === false`. */
  readonly inlineProperties: readonly SchemaEntityProperty[];
  /** M:M properties that are not inline: the cards below the grid. */
  readonly manyToManyProperties: readonly SchemaEntityProperty[];
  /** `undefined` when the entity is not in the live schema. */
  readonly features: EntityFeatures | undefined;
  readonly can: EntityPermissions | undefined;
  /** The caller's executable actions for this record, in `sort_order`. */
  readonly actions: readonly ViewerAction[];
  /** `null` when the entity has no Payment property or no `payment_initiation_rpc`. */
  readonly payment: ViewerPayment | null;
  /**
   * Inverse relationships with at least one row, ordered by the source
   * entity's `sort_order`. For a guided form, the form's step tables are left
   * out; the section loads after the guided-form context settles.
   */
  readonly inverse: readonly InverseRelationshipData[];
  /** `undefined` until checked, and for an entity without recurring support; `{ is_member: false }` when the check fails. */
  readonly series: SeriesMembership | undefined;
  /** `null` for an entity without a guided form, or before the record loads. */
  readonly guidedForm: ViewerGuidedForm | null;
  /** {@link RecordViewer.deleteRecord} is in flight. */
  readonly deleting: boolean;
}

/**
 * Why a command could not run to completion. `message` is the server's
 * human-readable text when there is one (an RPC's `message`, or the humanized
 * PostgREST error); the page picks its translated fallback otherwise.
 *
 * @consumer typed recordViewer
 */
export interface ViewerFailure {
  readonly status: 'failed';
  readonly message?: string;
}

/**
 * Outcome of {@link RecordViewer.deleteRecord}. `fallback`: the scope cannot be
 * applied (the record is not a series member, or the series ids it needs are
 * missing) and nothing was sent; the page falls back to the plain delete
 * confirmation.
 *
 * @consumer typed recordViewer
 */
export type ViewerDeleteResult = { readonly status: 'deleted' } | { readonly status: 'fallback' } | ViewerFailure;

/**
 * Outcome of {@link RecordViewer.initiatePayment}. `checkout`: open the
 * checkout for `paymentId` (an existing pending payment is reused without an
 * RPC; a failed or canceled one calls the RPC for a new intent).
 * `failed.reason`: `not_configured` (no `payment_initiation_rpc`),
 * `no_payment_id` (the RPC returned none) or `rejected` (the request failed;
 * `message` is the server's).
 *
 * @consumer typed recordViewer
 */
export type ViewerPaymentResult =
  | { readonly status: 'checkout'; readonly paymentId: string }
  | { readonly status: 'failed'; readonly reason: 'not_configured' | 'no_payment_id' | 'rejected'; readonly message?: string };

/**
 * Outcome of {@link RecordViewer.submitGuidedForm}. The viewer does not
 * reload on success: the page navigates to `navigateTo` (the `on_submit_rpc`
 * may return one), or calls {@link RecordViewer.reload}.
 *
 * @consumer typed recordViewer
 */
export type ViewerGuidedFormResult = { readonly status: 'submitted'; readonly navigateTo?: string } | ViewerFailure;

/**
 * Outcome of {@link ViewerActionHandle.run}.
 * - `succeeded`: `message` is the RPC's, else the action's default success
 *   message, else `undefined` (the page supplies "Action completed");
 *   `navigateTo` is the RPC's, else `default_navigate_to`; `refresh` is the
 *   RPC's, else `refresh_after_action`. The viewer does neither; the page
 *   waits as long as it likes, then navigates or calls `reload()`.
 * - `invalid`: a required parameter has no value; nothing was sent.
 * - `failed`: the RPC returned `success: false` (its `message`), or the
 *   request failed.
 *
 * @consumer typed recordViewer
 */
export type ViewerActionResult =
  | {
      readonly status: 'succeeded';
      readonly message?: string;
      readonly navigateTo?: string;
      readonly refresh: boolean;
      readonly result: EntityActionResult | undefined;
    }
  | { readonly status: 'invalid'; readonly missing: readonly string[] }
  | ViewerFailure;

/**
 * One option of a parameter dropdown: `id` and `display_name`, plus any other
 * columns the source returned.
 *
 * @consumer typed recordViewer
 */
export interface ViewerParamOption {
  readonly id: string | number;
  readonly display_name: string;
  readonly [column: string]: unknown;
}

/**
 * The state of an action's parameter form, without the form control.
 *
 * @consumer typed recordViewer
 */
export interface ActionParamsSnapshot {
  /**
   * Current values by `param_name`. Starts from `default_value` cast by type
   * (`number`/`money` to a number or `null`, `boolean` to `true` for
   * `'true'`/`'1'` and otherwise `false`).
   */
  readonly values: Readonly<Record<string, unknown>>;
  /** Dropdown options by `param_name`, for `status`, `category`, `foreign_key` and `user` parameters. */
  readonly options: Readonly<Record<string, readonly ViewerParamOption[]>>;
  /** `param_name`s whose options are loading. */
  readonly loading: readonly string[];
}

/**
 * A parameter session: the values and options of one opening of an action's
 * form. Option sources, by parameter:
 * - `status`: `statuses` filtered by `status_entity_type`, by `sort_order`;
 * - `category`: `categories` likewise;
 * - `foreign_key` with `options_source_rpc`: that RPC with
 *   `{ p_id: <record id>, p_depends_on: { <dep>: <value or null> } }`; a
 *   failure gives `[]`. With `depends_on_params` all `null`, the first load
 *   waits for a dependency to get a value;
 * - `foreign_key` with `join_table` and `join_column`: the table by
 *   `display_name`;
 * - `user`: `civic_os_users` by `display_name`.
 *
 * Changing a value that another parameter lists in `depends_on_params`
 * re-fetches that parameter's RPC options after the debounce (all
 * dependencies `null`: its options become `[]` and its value `null` at once);
 * a selection that is no longer among the new options becomes `null`.
 *
 * @consumer typed recordViewer
 */
export interface ActionParamSession {
  getSnapshot(): ActionParamsSnapshot;
  subscribe(listener: () => void): () => void;
  /** Sets one value. Unknown names are ignored. */
  setValue(paramName: string, value: unknown): void;
  /** Cancels pending re-fetches and stops notifying. */
  dispose(): void;
}

/**
 * An entity action of the record. {@link ViewerAction} is the live state;
 * the handle runs it.
 *
 * @consumer typed recordViewer
 */
export interface ViewerActionHandle {
  readonly key: string;
  /** The action as it stands now, or `undefined` once it has left the list (a reload dropped it). */
  state(): ViewerAction | undefined;
  /** Opens a parameter session; `undefined` when the action has no parameters. Dispose it when the form closes. */
  openParams(): ActionParamSession | undefined;
  /**
   * Calls the action's RPC with `{ p_entity_id: <record id>, ...values }`.
   * `values` is keyed by `param_name`; empty values of optional parameters
   * are left out, and the rest are collected by type (`number` and `money`
   * to numbers, `boolean` to booleans, `datetime_local` to a UTC ISO string).
   * A required parameter without a value resolves `invalid`. The record is
   * not reloaded.
   */
  run(values?: Readonly<Record<string, unknown>>): Promise<ViewerActionResult>;
}

/**
 * Policy a caller may set; the defaults are the generic app's.
 *
 * @consumer typed recordViewer
 */
export interface RecordViewerOptions {
  /** Debounce of the dependent-parameter re-fetch, in ms. Default 300. */
  readonly paramDebounceMs?: number;
}

/**
 * A viewer over one record.
 *
 * The record request: `GET <entity>?select=<fields>&order=<default>&id=eq.<id>`
 * with `fields` from `propertyToSelectString` of each detail property, then,
 * for each column named by an action's `visibility_condition` or
 * `enabled_condition` (`extractConditionFieldNames`) that is not a property
 * column, the bare column name. The `order` is the entity's default order
 * (`display_name`, then `id`), which the entity's column list decides.
 *
 * @consumer app
 */
export interface RecordViewer {
  getSnapshot(): RecordViewerSnapshot;
  /** Returns an idempotent unsubscribe. */
  subscribe(listener: () => void): () => void;

  /**
   * Loads the record, the sections, the series membership and the guided-form
   * context again, keeping the stale values until the new ones arrive.
   */
  reload(): void;
  /** The action `key` among the snapshot's `actions`, or `undefined`. */
  action(key: string): ViewerActionHandle | undefined;
  /**
   * Deletes the record. Without `scope`: `DELETE <entity>?id=eq.<id>`.
   * With a `scope`, for a series member:
   * - `this_only`: `cancel_series_occurrence` with `{ p_entity_table, p_entity_id, p_reason }`
   *   (`reason` or `null`); a rejected request is `failed`;
   * - `this_and_future`: the same call with a `null` reason (the legacy page does
   *   no more than cancel the occurrence, and leaves whatever it returns); it
   *   is `deleted` once sent, and `fallback` without a `series_id` and an
   *   `occurrence_date`;
   * - `all`: `delete_series_group` with `{ p_group_id }`; `fallback` without a `group_id`.
   * A scope on a record that is not a series member is `fallback`.
   * For the other scopes, an RPC body with `success: false` is `failed` with its `message`.
   */
  deleteRecord(scope?: SeriesEditScope, reason?: string): Promise<ViewerDeleteResult>;
  /** Starts or resumes the record's payment; see {@link ViewerPaymentResult}. */
  initiatePayment(): Promise<ViewerPaymentResult>;
  /** `submit_guided_form` with `{ p_guided_form_key, p_parent_id }`; see {@link ViewerGuidedFormResult}. */
  submitGuidedForm(): Promise<ViewerGuidedFormResult>;
  /** Aborts the load in flight, closes open parameter sessions and stops notifying. Further commands throw. */
  dispose(): void;
}

/**
 * Creates a {@link RecordViewer} for record `recordId` of `entity` and
 * schedules its first load.
 *
 * @consumer app
 */
export function recordViewer(
  deps: ViewerDeps,
  entity: EntityHandle,
  recordId: string | number,
  options: RecordViewerOptions = {},
): RecordViewer {
  const debounceMs = options.paramDebounceMs ?? 300;
  const sessions = new Set<ActionParamSession>();

  let disposed = false;
  let loading = true;
  let error: unknown;
  let notFound = false;
  let record: EntityData | undefined;
  let rawProps: readonly SchemaEntityProperty[] = [];
  let renderItems: readonly RenderableItem[] = [];
  let rawActions: readonly EntityAction[] = [];
  let inverse: readonly InverseRelationshipData[] = [];
  let series: SeriesMembership | undefined;
  let guidedCtx: GuidedFormContext | null = null;
  let deleting = false;
  let paymentLoading = false;
  let submitting = false;

  let generation = 0;
  let controller: AbortControllerLike | undefined;
  let scheduled = false;

  const assertAlive = (): void => {
    if (disposed) throw new Error('recordViewer is disposed');
  };

  // ---- derivation -----------------------------------------------------------

  const paymentProperty = (): SchemaEntityProperty | undefined =>
    propsForDetail(rawProps).find(p => p.type === EntityPropertyType.Payment);

  const paymentValue = (): PaymentValue | undefined => {
    const column = paymentProperty()?.column_name;
    const value = record && column ? record[column] : undefined;
    return isPaymentValue(value) ? value : undefined;
  };

  const toViewerAction = (a: EntityAction): ViewerAction => {
    const enabled = evaluateActionCondition(a.enabled_condition, record);
    const tooltip = enabled ? a.description : a.disabled_tooltip;
    return {
      key: a.action_name,
      displayName: a.display_name,
      ...(a.description !== undefined && { description: a.description }),
      ...(a.icon !== undefined && { icon: a.icon }),
      buttonStyle: a.button_style,
      sortOrder: a.sort_order,
      requiresConfirmation: a.requires_confirmation,
      ...(a.confirmation_message !== undefined && { confirmationMessage: a.confirmation_message }),
      ...(a.default_success_message !== undefined && { defaultSuccessMessage: a.default_success_message }),
      parameters: [...(a.parameters ?? [])].sort(bySortOrder),
      visible: evaluateActionCondition(a.visibility_condition, record),
      enabled,
      ...(tooltip !== undefined && { tooltip }),
    };
  };

  const viewerActions = (): ViewerAction[] =>
    record ? rawActions.filter(a => a.can_execute).sort(bySortOrder).map(toViewerAction) : [];

  const buildPayment = (): ViewerPayment | null => {
    const features = entity.features;
    if (!paymentProperty() || !features?.paymentInitiationRpc) return null;
    const payment = paymentValue();
    return {
      available: record !== undefined && payment?.status !== 'succeeded',
      resume: payment !== undefined && payment.status !== 'succeeded',
      payment,
      loading: paymentLoading,
    };
  };

  const buildGuidedForm = (): ViewerGuidedForm | null => {
    if (!entity.features?.guidedFormKey || !record?.['id']) return null;
    if (!guidedCtx) {
      return { context: null, submitted: false, showReview: false, steps: [], nextStepKey: null, submitting };
    }
    const steps = effectiveSteps(guidedCtx);
    const submitted = guidedCtx.parent_status_key === 'submitted';
    const allRequiredDone = steps.filter(st => st.isRequired && !st.isSkipped).every(st => st.isCompleted);
    const status = guidedCtx.parent_status_key;
    return {
      context: guidedCtx,
      submitted,
      showReview: status === 'complete' || (status === 'draft' && allRequiredDone) || submitted,
      steps,
      nextStepKey: steps.find(st => !st.isCompleted && !st.isSkipped && st.isRequired)?.step_key ?? null,
      submitting,
    };
  };

  const buildSnapshot = (): RecordViewerSnapshot => {
    const properties = propsForDetail(rawProps);
    return {
      loading,
      error,
      notFound,
      record,
      properties,
      renderables: renderItems,
      inlineProperties: properties.filter(
        p => (p.type !== EntityPropertyType.ManyToMany || p.show_inline === true) && p.show_on_detail !== false,
      ),
      manyToManyProperties: properties.filter(p => p.type === EntityPropertyType.ManyToMany && p.show_inline !== true),
      features: entity.features,
      can: entity.can,
      actions: viewerActions(),
      payment: buildPayment(),
      inverse,
      series,
      guidedForm: buildGuidedForm(),
      deleting,
    };
  };

  const store = createStore<RecordViewerSnapshot>(buildSnapshot());
  const publish = (): void => {
    if (!disposed) store.set(buildSnapshot());
  };

  // ---- loading --------------------------------------------------------------

  const conditionFields = (): string[] => {
    const fields = new Set<string>();
    for (const a of rawActions) {
      extractConditionFieldNames(a.visibility_condition).forEach(f => fields.add(f));
      extractConditionFieldNames(a.enabled_condition).forEach(f => fields.add(f));
    }
    return [...fields];
  };

  const loadRecord = async (signal: AbortSignalLike): Promise<EntityData | undefined> => {
    const detail = propsForDetail(rawProps);
    const columns = detail.map(propertyToSelectString);
    const existing = new Set(detail.map(p => p.column_name));
    for (const field of conditionFields()) {
      if (!existing.has(field)) columns.push(field);
    }
    const entityColumns = rawProps.filter(p => p.type !== EntityPropertyType.ManyToMany).map(p => p.column_name);
    const query: DataQuery = {
      key: entity.name,
      fields: columns,
      entityId: String(recordId),
      ...(entityColumns.length > 0 && { entityColumns }),
    };
    const rows = await deps.data.getData(query, { signal });
    const row = rows[0];
    if (!row) return undefined;
    const data: EntityData = { ...row };
    for (const p of detail) {
      const meta = p.many_to_many_meta;
      if (p.type === EntityPropertyType.ManyToMany && meta) {
        const extra = meta.extraColumns.map(c => c.column_name);
        data[p.column_name] = transformManyToManyData(
          (data[p.column_name] as unknown[] | undefined) || [],
          meta.relatedTable,
          extra.length > 0 ? extra : undefined,
          meta.parentHops,
          meta.parentHops?.length ? meta.targetTable : undefined,
        );
      }
    }
    return data;
  };

  const loadSeries = async (id: number, signal: AbortSignalLike): Promise<void> => {
    let membership: SeriesMembership;
    try {
      const body = await deps.data.callRpc('get_series_membership', { p_entity_table: entity.name, p_entity_id: recordId }, { signal });
      membership = body ?? { is_member: false };
    } catch {
      membership = { is_member: false };
    }
    if (disposed || id !== generation) return;
    series = membership;
    publish();
  };

  const loadGuidedContext = async (id: number, signal: AbortSignalLike, rec: EntityData, key: string): Promise<void> => {
    try {
      const ctx = await deps.data.callRpc(
        'get_guided_form_context',
        { p_guided_form_key: key, p_table_name: entity.name, p_record_id: Number(rec['id']) },
        { signal },
      );
      if (disposed || id !== generation) return;
      // A null body leaves the previous context, as the legacy page did.
      if (ctx) guidedCtx = ctx as GuidedFormContext;
    } catch {
      if (disposed || id !== generation) return;
    }
    publish();
  };

  const loadInverse = async (id: number, signal: AbortSignalLike, rec: EntityData): Promise<void> => {
    let sections: InverseRelationshipData[];
    try {
      const exclude = guidedCtx ? new Set(guidedCtx.steps.map(st => st.step_table)) : undefined;
      const [metas, entities] = await Promise.all([deps.schema.inverseRelationships(entity, exclude), deps.schema.entities()]);
      const loaded = await Promise.all(
        metas.map(async (meta): Promise<InverseRelationshipData> => {
          try {
            const { records, totalCount } = await deps.data.getInverseRelationshipPreview(
              meta.sourceTable,
              meta.sourceColumn,
              rec['id'],
              meta.previewLimit,
              meta.previewMode,
              { signal },
            );
            return { meta, totalCount: totalCount ?? records.length, previewRecords: records, targetId: rec['id'] as number };
          } catch {
            return { meta, totalCount: 0, previewRecords: [], targetId: rec['id'] as number };
          }
        }),
      );
      const order = (table: string): number => entities.find(e => e.table_name === table)?.sort_order || 0;
      sections = loaded.filter(d => d.totalCount > 0).sort((a, b) => order(a.meta.sourceTable) - order(b.meta.sourceTable));
    } catch {
      sections = [];
    }
    if (disposed || id !== generation) return;
    inverse = sections;
    publish();
  };

  const run = async (id: number, signal: AbortSignalLike): Promise<void> => {
    scheduled = false;
    if (disposed || id !== generation) return;

    const row = entity.liveRow;
    if (!row) {
      rawProps = [];
      renderItems = [];
      rawActions = [];
      record = undefined;
      notFound = false;
      error = undefined;
      loading = false;
      publish();
      return;
    }

    try {
      const [props, renderables, actions] = await Promise.all([
        deps.schema.properties(row),
        deps.schema.renderables(entity),
        deps.schema.actions(entity),
      ]);
      if (disposed || id !== generation) return;
      rawProps = props;
      renderItems = renderables;
      rawActions = actions;
    } catch (err) {
      if (disposed || id !== generation) return;
      error = err;
      loading = false;
      publish();
      return;
    }

    let loaded: EntityData | undefined;
    let failure: unknown;
    if (propsForDetail(rawProps).length > 0) {
      try {
        loaded = await loadRecord(signal);
      } catch (err) {
        failure = err;
      }
      if (disposed || id !== generation) return;
    }

    record = loaded;
    error = failure;
    notFound = failure === undefined && propsForDetail(rawProps).length > 0 && loaded === undefined;
    loading = false;
    publish();

    const guidedKey = entity.features?.guidedFormKey ?? null;
    if (loaded) {
      const context = guidedKey && loaded['id'] ? loadGuidedContext(id, signal, loaded, guidedKey) : Promise.resolve();
      void context.then(() => (disposed || id !== generation ? undefined : loadInverse(id, signal, loaded)));
    }
    if (entity.features?.recurring && String(recordId) !== '') {
      void loadSeries(id, signal);
    }
  };

  const requestLoad = (): void => {
    generation++;
    controller?.abort();
    controller = newController();
    loading = true;
    if (!scheduled) {
      scheduled = true;
      void Promise.resolve().then(() => run(generation, (controller as AbortControllerLike).signal));
    }
  };

  // ---- commands -------------------------------------------------------------

  const humanMessage = (err: unknown): string | undefined => {
    if (err instanceof DataClientError) return humanizeError(err.shape);
    if (err instanceof TransportError && err.kind === 'network') return humanizeError({ httpCode: 0 });
    return undefined;
  };
  const serverMessage = (err: unknown): string | undefined => (err instanceof DataClientError ? err.shape.message : undefined);
  const failed = (message: string | undefined): ViewerFailure => (message !== undefined ? { status: 'failed', message } : { status: 'failed' });

  const runAction = async (key: string, values: Readonly<Record<string, unknown>>): Promise<ViewerActionResult> => {
    const act = rawActions.find(a => a.action_name === key && a.can_execute);
    if (!act || !record) return { status: 'failed' };
    const params = [...(act.parameters ?? [])].sort(bySortOrder);
    const missing = params.filter(p => p.required && isEmpty(values[p.param_name])).map(p => p.param_name);
    if (missing.length > 0) return { status: 'invalid', missing };
    try {
      const result = (await deps.data.executeRpc(act.rpc_function, {
        p_entity_id: recordId,
        ...collectParamValues(params, values),
      })) as EntityActionResult | null | undefined;
      if (result?.success === false) return failed(result.message);
      const message = result?.message || act.default_success_message;
      const navigateTo = result?.navigate_to || act.default_navigate_to;
      return {
        status: 'succeeded',
        ...(message && { message }),
        ...(navigateTo && { navigateTo }),
        refresh: result?.refresh ?? act.refresh_after_action,
        result: result ?? undefined,
      };
    } catch (err) {
      return failed(humanMessage(err));
    }
  };

  const deleteScoped = async (scope: SeriesEditScope, reason: string | undefined): Promise<ViewerDeleteResult> => {
    const membership = series;
    if (!membership?.is_member) return { status: 'fallback' };
    let fn: string;
    let params: Record<string, unknown>;
    switch (scope) {
      case 'this_only':
        fn = 'cancel_series_occurrence';
        params = { p_entity_table: entity.name, p_entity_id: parseInt(String(recordId), 10), p_reason: reason || null };
        break;
      case 'this_and_future':
        if (!membership.series_id || !membership.occurrence_date) return { status: 'fallback' };
        // Parity with the legacy page (detail.page.ts, deleteThisAndFuture): it only cancels this occurrence
        // and does not end the series. That is a known bug, fixed separately on main; port the fix here when it lands.
        fn = 'cancel_series_occurrence';
        params = { p_entity_table: entity.name, p_entity_id: parseInt(String(recordId), 10), p_reason: null };
        break;
      case 'all':
        if (!membership.group_id) return { status: 'fallback' };
        fn = 'delete_series_group';
        params = { p_group_id: membership.group_id };
        break;
    }
    try {
      const result = (await deps.data.callRpc(fn, params)) as { success?: boolean; message?: string } | null;
      // Legacy deleteThisAndFuture navigates away whatever the cancel returns (RecurringService turns a
      // rejection into a success:false body, which it ignores), so this scope never fails.
      if (scope === 'this_and_future') return { status: 'deleted' };
      if (result?.success === false) return failed(result.message);
      return { status: 'deleted' };
    } catch (err) {
      if (scope === 'this_and_future') return { status: 'deleted' };
      return failed(serverMessage(err));
    }
  };

  const deleteRecordCommand = async (scope: SeriesEditScope | undefined, reason: string | undefined): Promise<ViewerDeleteResult> => {
    if (scope !== undefined && !(entity.features?.recurring && series?.is_member)) return { status: 'fallback' };
    deleting = true;
    publish();
    try {
      if (scope === undefined) {
        try {
          await deps.data.deleteData(entity.name, recordId);
          return { status: 'deleted' };
        } catch (err) {
          return failed(humanMessage(err));
        }
      }
      return await deleteScoped(scope, reason);
    } finally {
      deleting = false;
      publish();
    }
  };

  const initiatePaymentCommand = async (): Promise<ViewerPaymentResult> => {
    const rpc = entity.features?.paymentInitiationRpc;
    if (!rpc) return { status: 'failed', reason: 'not_configured' };
    const existing = paymentValue();
    if (existing && (existing.status === 'pending_intent' || existing.status === 'pending')) {
      return { status: 'checkout', paymentId: existing.id };
    }
    paymentLoading = true;
    publish();
    try {
      const response = await deps.data.callRpc(rpc, { p_entity_id: recordId });
      const paymentId = typeof response === 'string' ? response : response?.[0];
      return paymentId ? { status: 'checkout', paymentId } : { status: 'failed', reason: 'no_payment_id' };
    } catch (err) {
      const message = serverMessage(err);
      return message !== undefined ? { status: 'failed', reason: 'rejected', message } : { status: 'failed', reason: 'rejected' };
    } finally {
      paymentLoading = false;
      publish();
    }
  };

  const submitGuidedFormCommand = async (): Promise<ViewerGuidedFormResult> => {
    const key = entity.features?.guidedFormKey;
    if (!key) return { status: 'failed' };
    submitting = true;
    publish();
    try {
      const response = await deps.data.callRpc('submit_guided_form', { p_guided_form_key: key, p_parent_id: Number(recordId) });
      const navigateTo = response?.navigate_to;
      return navigateTo ? { status: 'submitted', navigateTo } : { status: 'submitted' };
    } catch (err) {
      return failed(serverMessage(err) || (err instanceof Error ? err.message : undefined) || undefined);
    } finally {
      submitting = false;
      publish();
    }
  };

  // ---- parameter sessions ---------------------------------------------------

  const openSession = (act: EntityAction): ActionParamSession | undefined => {
    const params = [...(act.parameters ?? [])].sort(bySortOrder);
    if (params.length === 0) return undefined;

    const sessionController = newController();
    const timers = new Map<string, unknown>();
    const loadingNames = new Set<string>();
    const optionsByName: Record<string, readonly ViewerParamOption[]> = {};
    let values: Record<string, unknown> = {};
    let closed = false;
    for (const p of params) values[p.param_name] = defaultValue(p);

    const initial: ActionParamsSnapshot = { values, options: optionsByName, loading: [] };
    const sessionStore = createStore<ActionParamsSnapshot>(initial);
    const publishSession = (): void => {
      if (!closed) sessionStore.set({ values: { ...values }, options: { ...optionsByName }, loading: [...loadingNames] });
    };

    const pId = (): number | string | null => (recordId ? Number(recordId) || recordId : null);
    const dependsOn = (p: EntityActionParam): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const dep of p.depends_on_params ?? []) out[dep] = values[dep] ?? null;
      return out;
    };
    const allDepsNull = (p: EntityActionParam): boolean => (p.depends_on_params ?? []).every(dep => values[dep] == null);

    const fromRpc = async (p: EntityActionParam): Promise<ViewerParamOption[]> => {
      try {
        const res = await deps.data.callRpc(
          p.options_source_rpc!,
          { p_id: pId(), p_depends_on: dependsOn(p) },
          { signal: sessionController.signal },
        );
        return Array.isArray(res) ? res : [];
      } catch {
        return [];
      }
    };

    const optionsRequest = (p: EntityActionParam): Promise<ViewerParamOption[]> | undefined => {
      const signal = { signal: sessionController.signal };
      if (p.param_type === 'status' && p.status_entity_type) {
        return deps.data.getData(
          { key: 'statuses', fields: ['id', 'display_name'], filters: [{ column: 'entity_type', operator: 'eq', value: p.status_entity_type }], orderField: 'sort_order', orderDirection: 'asc' },
          signal,
        ) as Promise<ViewerParamOption[]>;
      }
      if (p.param_type === 'category' && p.category_entity_type) {
        return deps.data.getData(
          { key: 'categories', fields: ['id', 'display_name'], filters: [{ column: 'entity_type', operator: 'eq', value: p.category_entity_type }], orderField: 'sort_order', orderDirection: 'asc' },
          signal,
        ) as Promise<ViewerParamOption[]>;
      }
      if (p.param_type === 'foreign_key' && p.options_source_rpc) {
        if (p.depends_on_params?.length && allDepsNull(p)) return undefined;
        return fromRpc(p);
      }
      if (p.param_type === 'foreign_key' && p.join_table && p.join_column) {
        return deps.data.getData(
          { key: p.join_table, fields: [...new Set(['id', 'display_name', p.join_column])], orderField: 'display_name', orderDirection: 'asc' },
          signal,
        ) as Promise<ViewerParamOption[]>;
      }
      if (p.param_type === 'user') {
        return deps.data.getData({ key: 'civic_os_users', fields: ['id', 'display_name'], orderField: 'display_name', orderDirection: 'asc' }, signal) as Promise<ViewerParamOption[]>;
      }
      return undefined;
    };

    // One batch, as the legacy page's forkJoin (detail.page.ts, loadActionParamOptions): the options arrive
    // together, and one failed table request leaves every parameter in the batch without options.
    const batch: [string, Promise<ViewerParamOption[]>][] = [];
    for (const p of params) {
      const request = optionsRequest(p);
      if (!request) continue;
      loadingNames.add(p.param_name);
      batch.push([p.param_name, request]);
    }
    if (batch.length > 0) {
      publishSession();
      Promise.all(batch.map(([, request]) => request)).then(
        results => {
          for (const [name] of batch) loadingNames.delete(name);
          if (closed) return;
          batch.forEach(([name], i) => (optionsByName[name] = results[i]));
          publishSession();
        },
        () => {
          for (const [name] of batch) loadingNames.delete(name);
          publishSession();
        },
      );
    }

    const setValue = (name: string, value: unknown): void => {
      if (closed || !params.some(p => p.param_name === name)) return;
      values = { ...values, [name]: value };
      publishSession();
      // One debounce per dependent parameter, shared by all its dependencies.
      for (const dependent of params) {
        if (!dependent.options_source_rpc || !dependent.depends_on_params?.includes(name)) continue;
        const pending = timers.get(dependent.param_name);
        if (pending !== undefined) clearTimeout(pending);
        timers.set(
          dependent.param_name,
          setTimeout(() => {
            timers.delete(dependent.param_name);
            if (closed) return;
            if (allDepsNull(dependent)) {
              optionsByName[dependent.param_name] = [];
              setValue(dependent.param_name, null);
              return;
            }
            void fromRpc(dependent).then(options => {
              if (closed) return;
              optionsByName[dependent.param_name] = options;
              const current = values[dependent.param_name];
              if (current != null && !options.some(o => String(o.id) === String(current))) {
                setValue(dependent.param_name, null);
              } else {
                publishSession();
              }
            });
          }, debounceMs),
        );
      }
    };

    const session: ActionParamSession = {
      getSnapshot: () => sessionStore.getSnapshot(),
      subscribe: listener => sessionStore.subscribe(listener),
      setValue,
      dispose() {
        if (closed) return;
        closed = true;
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        sessionController.abort();
        sessions.delete(session);
      },
    };
    sessions.add(session);
    return session;
  };

  const findAction = (key: string): EntityAction | undefined =>
    record ? rawActions.find(a => a.action_name === key && a.can_execute) : undefined;

  const handleFor = (key: string): ViewerActionHandle => ({
    key,
    state: () => viewerActions().find(a => a.key === key),
    openParams() {
      const act = findAction(key);
      return disposed || !act ? undefined : openSession(act);
    },
    run(values = {}) {
      assertAlive();
      return runAction(key, values);
    },
  });

  requestLoad();

  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    reload() {
      assertAlive();
      requestLoad();
      publish();
    },
    action: key => (findAction(key) ? handleFor(key) : undefined),
    deleteRecord(scope, reason) {
      assertAlive();
      return deleteRecordCommand(scope, reason);
    },
    initiatePayment() {
      assertAlive();
      return initiatePaymentCommand();
    },
    submitGuidedForm() {
      assertAlive();
      return submitGuidedFormCommand();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      controller?.abort();
      for (const session of [...sessions]) session.dispose();
    },
  };
}

// ---- helpers ----------------------------------------------------------------

// Core compiles without DOM or Node types.
declare const setTimeout: (callback: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}
const newController = (): AbortControllerLike =>
  new (globalThis as unknown as { AbortController: new () => AbortControllerLike }).AbortController();


const bySortOrder = (a: { sort_order: number }, b: { sort_order: number }): number => a.sort_order - b.sort_order;

/** A payment value embedded in a record: an object with an `id` and a `status`. */
const isPaymentValue = (value: unknown): value is PaymentValue =>
  value != null && typeof value === 'object' && 'id' in value && 'status' in value;

/** What a required control counts as empty. */
const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

/** `default_value` cast by the parameter's type. */
function defaultValue(p: EntityActionParam): unknown {
  const raw = p.default_value;
  switch (p.param_type) {
    case 'number':
    case 'money': {
      if (raw === undefined || raw === null) return null;
      const n = parseFloat(raw);
      return Number.isNaN(n) ? null : n;
    }
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'photo_gallery':
      return null;
    default:
      return raw ?? null;
  }
}

/** The parameters' values as the RPC takes them: empty optionals left out, the rest cast by type. */
function collectParamValues(params: readonly EntityActionParam[], values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    let value = values[p.param_name];
    if ((value === null || value === undefined || value === '') && !p.required) continue;
    switch (p.param_type) {
      case 'number':
      case 'money':
        value = value !== null && value !== '' ? Number(value) : null;
        break;
      case 'boolean':
        value = !!value;
        break;
      case 'datetime_local':
        if (value) value = new Date(value as string).toISOString();
        break;
    }
    out[p.param_name] = value;
  }
  return out;
}

/** The guided form's steps with completion, skip and requirement; the parent record is not read (legacy `getEffectiveSteps(steps, null, progress)`). */
function effectiveSteps(ctx: GuidedFormContext): EffectiveGuidedFormStep[] {
  const done = new Set(ctx.progress.map(entry => entry.step_key));
  return ctx.steps.map((st: GuidedFormStep) => {
    const conditions = st.conditions ?? [];
    return {
      ...st,
      isCompleted: done.has(st.step_key),
      isSkipped: conditions.some(c => c.condition_type === 'skip_if' && evaluateGuidedFormCondition(c, null)),
      isRequired: !st.can_skip || conditions.some(c => c.condition_type === 'require_if' && evaluateGuidedFormCondition(c, null)),
    };
  });
}
