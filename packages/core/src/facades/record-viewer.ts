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
 * inverse-relationship previews, calendar sections, series membership and the
 * guided-form context. It runs the commands the page offers: an entity action
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
 * calendars, series, guided-form context) load after it, each settling
 * on its own. {@link RecordViewer.reload} runs the whole sequence again, with
 * the stale values kept until the new ones arrive. A new load aborts the
 * previous one (latest wins).
 */

import type { EntityHandle } from '../handles/handles.js';
import type { EntityFeatures, EntityPermissions } from '../handles/handles.js';
import type {
  EffectiveGuidedFormStep,
  EntityAction,
  EntityActionParam,
  EntityActionResult,
  EntityData,
  GuidedFormContext,
  InverseRelationshipData,
  InverseRelationshipMeta,
  PaymentValue,
  RenderableItem,
  SchemaEntityProperty,
  SchemaEntityTable,
  SeriesEditScope,
  SeriesMembership,
} from '../model/index.js';
import type { FacadeDeps, FacadeSchema } from './deps.js';
import type { ListCalendarEvent } from './record-list.js';

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
  /** All entities of the schema, for the inverse previews' `sort_order` and the calendar sections' configuration. */
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
 * One calendar the record owns: events of a related entity that has a
 * calendar configured and points at this record.
 *
 * @consumer typed recordViewer
 */
export interface ViewerCalendarSection {
  readonly sourceTable: string;
  readonly sourceEntityDisplayName: string;
  /** The FK column on the source table that holds this record's id. */
  readonly sourceColumn: string;
  readonly calendarPropertyName: string;
  readonly calendarColorProperty: string | null;
  /** In calendar-property order; never empty (sections without events are left out). */
  readonly events: readonly ListCalendarEvent[];
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
  readonly calendars: readonly ViewerCalendarSection[];
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
 * The record request: `GET <entity>?select=<fields>&id=eq.<id>` with `fields`
 * from `propertyToSelectString` of each detail property, then, for each
 * column named by an action's `visibility_condition` or `enabled_condition`
 * (`extractConditionFieldNames`) that is not a property column, the bare
 * column name.
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
   *   no more than cancel the occurrence); `fallback` without a `series_id` and
   *   an `occurrence_date`;
   * - `all`: `delete_series_group` with `{ p_group_id }`; `fallback` without a `group_id`.
   * A scope on a record that is not a series member is `fallback`.
   * An RPC body with `success: false` is `failed` with its `message`.
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
  void deps;
  void entity;
  void recordId;
  void options;
  throw new Error('recordViewer is not implemented yet');
}
