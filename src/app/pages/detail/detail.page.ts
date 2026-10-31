/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


import { Component, inject, ChangeDetectionStrategy, signal, computed, effect, untracked, QueryList, ViewChildren, DestroyRef, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormGroup, FormControl, Validators, ReactiveFormsModule } from '@angular/forms';
import {
  SchemaEntityProperty,
  SchemaEntityTable,
  InverseRelationshipData,
  RenderableItem,
  isStaticText,
  isProperty,
  EntityActionParam,
  FileReference,
  PhotoGalleryConfig,
} from '../../interfaces/entity';
import { ActionBarComponent, ActionButton } from '../../components/action-bar/action-bar.component';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryService } from '../../services/gallery.service';
import { PhotoGalleryEditorComponent } from '../../components/photo-gallery-editor/photo-gallery-editor.component';
import { ExceptionEditorComponent, ExceptionEditorResult } from '../../components/exception-editor/exception-editor.component';
import { GuidedFormNavComponent } from '../../components/guided-form-nav/guided-form-nav.component';
import { GuidedFormReviewSectionComponent } from '../../components/guided-form-review-section/guided-form-review-section.component';
import { GuidedFormService } from '../../services/guided-form.service';
import { TranslationService } from '../../services/translation.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { GuidedFormContext } from '../../interfaces/guided-form';
import { ContrastTextDirective } from '../../directives/contrast-text.directive';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, NavigationStart, Router, RouterModule } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import { AnalyticsService } from '../../services/analytics.service';
import { AuthService } from '../../services/auth.service';
import { MaintenanceService } from '../../services/maintenance.service';
import { NavigationService } from '../../services/navigation.service';
import { getAppTitle } from '../../config/runtime';

import { CommonModule } from '@angular/common';
import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { ManyToManyEditorComponent } from '../../components/many-to-many-editor/many-to-many-editor.component';
import { EmptyStateComponent } from '../../components/empty-state/empty-state.component';
import { PaymentCheckoutComponent } from '../../components/payment-checkout/payment-checkout.component';
import { EntityNotesComponent } from '../../components/entity-notes/entity-notes.component';
import { StaticTextComponent } from '../../components/static-text/static-text.component';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { RelatedRecordsComponent } from '../../components/related-records/related-records.component';
import {
  compareBySortOrder,
  recordViewer,
  type ActionParamSession,
  type EntityHandle,
  type RecordViewer,
  type RecordViewerSnapshot,
  type SeriesEditScope,
  type ViewerAction,
} from '@civic-os/core';
import { FACADE_DEPS } from '../../sdk/facade-deps';
import { switchingStore } from '../../sdk/switching-store';

@Component({
  selector: 'app-detail',
  templateUrl: './detail.page.html',
  styleUrl: './detail.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    RouterModule,
    ReactiveFormsModule,
    DisplayPropertyComponent,
    ManyToManyEditorComponent,
    EmptyStateComponent,
    PaymentCheckoutComponent,
    EntityNotesComponent,
    StaticTextComponent,
    ActionBarComponent,
    ExceptionEditorComponent,
    CosModalComponent,
    GuidedFormNavComponent,
    GuidedFormReviewSectionComponent,
    PhotoGalleryEditorComponent,
    RelatedRecordsComponent,
    TranslatePipe,
    ContrastTextDirective
  ]
})
export class DetailPage {
  /** The route entity's core handle, from `entityResolver` through route input binding. The `recordViewer` facade is made from it. */
  readonly entityHandle = input<EntityHandle | undefined>();

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private schema = inject(SchemaService);
  private analytics = inject(AnalyticsService);
  private fileUpload = inject(FileUploadService);
  private galleryService = inject(GalleryService);
  private guidedFormService = inject(GuidedFormService);
  private navigation = inject(NavigationService);
  private titleService = inject(Title);
  private facadeDeps = inject(FACADE_DEPS);
  public auth = inject(AuthService);
  public maintenance = inject(MaintenanceService);
  private translation = inject(TranslationService);

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  constructor() {
    // The post-action auto-close belongs to the record it ran on: drop it when the
    // user navigates elsewhere (including another record, which reuses this page)
    // or the page is destroyed, so it cannot pull them back or refresh the wrong record.
    this.router.events.pipe(takeUntilDestroyed()).subscribe(event => {
      if (event instanceof NavigationStart && this.actionAutoCloseTimer) {
        // Drop the pending navigate_to/refresh and the success modal with it, so it
        // does not stay open on the record the user moved to
        this.clearActionAutoClose();
        this.closeActionModal();
      }
    });
    this.route.params.pipe(takeUntilDestroyed()).subscribe(p => {
      this.entityKey = p['entityKey'];
      this.entityId = p['entityId'];
      this.routeKey.set(p['entityKey']);
      this.routeId.set(p['entityId']);
    });
    inject(DestroyRef).onDestroy(() => {
      this.clearActionAutoClose();
      this.releaseParamSession();
      this.viewer?.dispose();
      this.viewer = undefined;
    });
  }

  // Delete modal state
  showDeleteModal = signal(false);
  deleteLoading = signal(false);
  deleteError = signal<string | undefined>(undefined);

  // Payment initiation state
  paymentLoading = signal(false);
  paymentError = signal<string | undefined>(undefined);
  showCheckoutModal = signal(false);
  currentPaymentId = signal<string | undefined>(undefined);

  // Entity action state (v0.18.0)
  showActionModal = signal(false);
  currentAction = signal<ViewerAction | undefined>(undefined);
  actionLoading = signal(false);
  actionOverlayLoading = signal(false);  // For non-confirmation actions
  actionError = signal<string | undefined>(undefined);
  actionSuccess = signal<string | undefined>(undefined);
  /** Pending auto-close (then navigate/refresh) after a successful action */
  private actionAutoCloseTimer?: ReturnType<typeof setTimeout>;

  // Action parameter state (v0.32.0): the form is the page's; values and option lists come from the facade's parameter session
  actionParamForm = signal<FormGroup | undefined>(undefined);
  actionParamOptions = signal<Record<string, any[]>>({});
  actionFileUploading = signal(false);
  actionUploadedFile = signal<Record<string, FileReference>>({});
  actionUploadError = signal<string | undefined>(undefined);
  private paramSession?: ActionParamSession;
  private paramSessionUnsubscribe?: () => void;
  private paramControlSubs: { unsubscribe(): void }[] = [];

  // Photo gallery action param state (v0.55.0)
  @ViewChildren('actionGalleryEditor') actionGalleryEditors!: QueryList<PhotoGalleryEditorComponent>;
  actionGalleryConfig = signal<Record<string, PhotoGalleryConfig>>({});
  actionGalleryIds = signal<Record<string, string | null>>({});

  showDeleteScopeDialog = signal(false);

  // Cascading refresh trigger for child components (notes, M:M editors)
  // Increment this signal to trigger refresh in components that watch it
  refreshCounter = signal(0);

  // Guided form state (v0-48-0)
  guidedFormError = signal<string | undefined>(undefined);
  showGuidedFormSuccessModal = signal(false);
  guidedFormSubmitting = signal(false);
  /** Set before navigating away from a submitted guided form, so its header does not linger on the next page. */
  private guidedFormCleared = signal(false);

  public entityKey?: string;
  public entityId?: string;
  private routeKey = signal<string | undefined>(undefined);
  private routeId = signal<string | undefined>(undefined);

  /** The route's entity row, read from the resolved handle once it is the route's own (not the previous entity's). */
  currentEntity = computed<SchemaEntityTable | undefined>(() => {
    const handle = this.entityHandle();
    this.schema.entityRows(); // the handle's row is not a signal: re-read it when the rows reload
    return handle && handle.name === this.routeKey() ? handle.liveRow : undefined;
  });

  // Summary VIEWs (read-only, no id) don't have detail pages: redirect to the list
  private _summaryRedirect = effect(() => {
    const entity = this.currentEntity();
    if (entity?.is_view && !entity?.insert) {
      untracked(() => this.router.navigate(['/view', this.entityKey], { replaceUrl: true }));
    }
  });

  // The record: one `recordViewer` facade per (entity handle, route id), read as a signal. A change of either,
  // or a schema refresh (a locale change reloads the entity rows), disposes the previous facade and builds the
  // next; the handle must be the route's entity, so a switch between entities never loads the new id against
  // the old entity.
  private viewer?: RecordViewer;
  private viewerBinding = switchingStore<RecordViewerSnapshot>();
  readonly snapshot = this.viewerBinding.value;
  /** The loaded record, read by column name in the template (the facade's record type is the strict `EntityData`). */
  protected record = computed<any>(() => this.snapshot()?.record);

  private _bindViewer = effect(() => {
    const handle = this.entityHandle();
    const id = this.routeId();
    const key = this.routeKey();
    this.schema.entityRows();
    untracked(() => {
      this.releaseParamSession();
      this.viewer?.dispose();
      this.viewer = undefined;
      this.guidedFormCleared.set(false);
      if (!handle || id === undefined || handle.name !== key) {
        this.viewerBinding.bind(undefined);
        return;
      }
      const viewer = recordViewer(this.facadeDeps, handle, id);
      this.viewer = viewer;
      this.viewerBinding.bind(viewer);
    });
  });

  // Set the document title once entity + record data resolve
  // (e.g. "Issue: #42 – Civic OS"), mirroring the on-page heading.
  private _titleEffect = effect(() => {
    const entity = this.currentEntity();
    const data = this.snapshot()?.record;
    if (entity?.display_name && data) {
      const record = data['display_name'] || ('#' + data['id']);
      this.titleService.setTitle(`${entity.display_name}: ${record} - ${getAppTitle()}`);
    }
  });

  // The loaded sections, as the template reads them (type-only casts: the facade's lists are read-only)
  protected renderables = computed(() => this.snapshot()?.renderables as RenderableItem[] | undefined);
  protected manyToManyProps = computed(() => this.snapshot()?.manyToManyProperties as SchemaEntityProperty[] | undefined);
  protected inverseRelationships = computed(() => this.snapshot()?.inverse as InverseRelationshipData[] | undefined);
  seriesMembership = computed(() => this.snapshot()?.series);

  // Guided form: the facade's context with the step `conditions` arrays the nav and review components read
  guidedFormContext = computed<GuidedFormContext | null>(() => {
    const ctx = this.guidedFormCleared() ? null : this.snapshot()?.guidedForm?.context ?? null;
    return ctx ? { ...ctx, steps: ctx.steps.map(s => ({ ...s, conditions: s.conditions || [] })) } : null;
  });
  // Status key derived directly from context — no extra HTTP call needed
  guidedFormStatusKey = computed(() => this.guidedFormContext()?.parent_status_key ?? null);
  showReviewSection = computed(() => !this.guidedFormCleared() && (this.snapshot()?.guidedForm?.showReview ?? false));
  isGuidedFormSubmitted = computed(() => !this.guidedFormCleared() && (this.snapshot()?.guidedForm?.submitted ?? false));

  // Expose type guards to template
  protected readonly isStaticText = isStaticText;
  protected readonly isProperty = isProperty;

  /** v0.51.0: Format chip label for rich junctions (inline M:M on detail page) */
  formatRichJunctionLabel(displayName: string, junctionData: Record<string, unknown> | undefined, extraColumns: SchemaEntityProperty[]): string {
    if (!junctionData || extraColumns.length === 0) return displayName;
    const parts = [...extraColumns]
      .sort(compareBySortOrder)
      .map(col => junctionData[col.column_name])
      .filter(val => val !== null && val !== undefined && val !== '');
    if (parts.length === 0) return displayName;
    return `${displayName} / ${parts.join(' / ')}`;
  }

  /**
   * Actions the caller may execute whose visibility condition holds for the record.
   *
   * Actions are hidden (not just disabled) when the user lacks RPC permission or the
   * visibility_condition evaluates to false against the record data; the facade decides both.
   * Note: visibility_condition currently only supports entity field checks.
   * TODO: Future enhancement - support user context in conditions for scenarios like:
   *   - Role-based visibility: {"field": "$user.role", "operator": "in", "value": ["admin"]}
   *   - Ownership checks: {"field": "$user.id", "operator": "eq", "value": "$record.requested_by"}
   *   See: docs/ROADMAP.md (Entity Action Buttons section)
   */
  public visibleActions = computed(() => (this.snapshot()?.actions ?? []).filter(a => a.visible));

  /**
   * Combined action buttons for the action bar.
   * Includes: Edit, Delete, Payment, and Entity Actions.
   * All buttons flow through ActionBarComponent for responsive overflow handling.
   */
  public actionButtons = computed<ActionButton[]>(() => {
    const entity = this.currentEntity();
    const snap = this.snapshot();
    // Re-label when translations load or the locale changes
    this.translation.version();
    const buttons: ActionButton[] = [];

    if (!entity || !snap?.record) return buttons;

    const inMaintenance = untracked(() => this.maintenance.isActive() && !this.maintenance.isAdminBypassing());

    // Edit button (hidden for guided forms and during maintenance mode)
    if (entity.update && !entity.guided_form_key && !inMaintenance) {
      buttons.push({
        id: 'edit',
        label: this.translation.get('action.edit'),
        icon: 'edit',
        style: 'btn-accent',
        disabled: false
      });
    }

    // Delete button (hidden during maintenance mode)
    if (entity.delete && !inMaintenance) {
      buttons.push({
        id: 'delete',
        label: this.translation.get('action.delete'),
        icon: 'delete',
        style: 'btn-error',
        disabled: false
      });
    }

    // Payment button: "Complete Payment" while an unfinished payment exists, else "Pay Now"
    // (labeled here, not in a separate stream, so a locale change re-labels every button at once)
    if (snap.payment?.available) {
      buttons.push({
        id: 'payment',
        label: this.translation.get(snap.payment.resume ? 'payment.complete_payment' : 'action.pay_now'),
        icon: 'payment',
        style: 'btn-primary',
        // Never disabled: the legacy stream read paymentLoading only when it built the buttons, before any click
        disabled: false
      });
    }

    // Entity actions (sorted by sort_order from metadata)
    this.visibleActions().forEach(action => {
      buttons.push({
        id: `action:${action.key}`,
        label: action.displayName,
        icon: action.icon,
        style: `btn-${action.buttonStyle}`,
        disabled: !action.enabled,
        tooltip: action.tooltip
      });
    });

    return buttons;
  });

  // Inline M:M chip cap (show first N, then "+ x more" to expand)
  readonly INLINE_M2M_CHIP_LIMIT = 10;
  expandedInlineM2m = signal<Set<string>>(new Set());

  toggleInlineM2mExpand(columnName: string): void {
    const current = this.expandedInlineM2m();
    const next = new Set(current);
    if (next.has(columnName)) {
      next.delete(columnName);
    } else {
      next.add(columnName);
    }
    this.expandedInlineM2m.set(next);
  }

  isInlineM2mExpanded(columnName: string): boolean {
    return this.expandedInlineM2m().has(columnName);
  }

  // Refresh data after M:M changes
  refreshData() {
    this.viewer?.reload();

    // Cascade to child components (notes, M:M editors) via signal
    const newCount = this.refreshCounter() + 1;
    this.refreshCounter.set(newCount);
  }

  // Delete modal methods
  openDeleteModal() {
    this.deleteError.set(undefined);

    // Check if this is a series member - show scope dialog first
    const membership = this.seriesMembership();
    if (membership?.is_member) {
      this.showDeleteScopeDialog.set(true);
    } else {
      this.showDeleteModal.set(true);
    }
  }

  closeDeleteModal() {
    this.showDeleteModal.set(false);
  }

  async confirmDelete() {
    const viewer = this.viewer;
    if (!viewer || !this.entityKey || !this.entityId) return;

    this.deleteError.set(undefined);
    this.deleteLoading.set(true);

    const result = await viewer.deleteRecord();
    this.deleteLoading.set(false);
    switch (result.status) {
      case 'deleted':
        this.analytics.trackEvent('Entity', 'Delete', this.entityKey);
        // Navigate back to list view on success
        this.router.navigate(['/view', this.entityKey]);
        break;
      case 'failed':
        this.deleteError.set(result.message || 'Failed to delete record');
        break;
      case 'fallback':
        break;
    }
  }

  // =========================================================================
  // SERIES MEMBERSHIP METHODS
  // =========================================================================

  /**
   * Handle scope selection from ExceptionEditorComponent for delete.
   */
  onDeleteScopeConfirm(result: ExceptionEditorResult): void {
    this.showDeleteScopeDialog.set(false);

    if (!this.entityKey || !this.entityId) return;

    void this.deleteScoped(result.scope, result.reason);
  }

  /**
   * Cancel scope selection for delete.
   */
  onDeleteScopeCancel(): void {
    this.showDeleteScopeDialog.set(false);
  }

  /**
   * Delete one occurrence, this and the following ones, or the whole series group.
   * The facade sends the call (or reports it cannot apply); the page maps the outcome onto
   * the delete modal: navigate on success, the error and the plain modal otherwise.
   */
  private async deleteScoped(scope: SeriesEditScope, reason?: string): Promise<void> {
    const viewer = this.viewer;
    if (!viewer) return;

    this.deleteError.set(undefined);
    this.deleteLoading.set(true);

    const result = await viewer.deleteRecord(scope, reason);
    this.deleteLoading.set(false);
    switch (result.status) {
      case 'deleted':
        this.router.navigate(['/view', this.entityKey]);
        break;
      case 'failed':
        // A refused series RPC always carries a message, so the fallback is RecurringService's for a rejected request
        this.deleteError.set(result.message || (scope === 'all' ? 'Failed to delete series group' : 'Failed to cancel occurrence'));
        this.showDeleteModal.set(true);
        break;
      case 'fallback':
        // Fall back to regular delete
        this.showDeleteModal.set(true);
        break;
    }
  }

  /**
   * Initiate payment for entities with Payment property type.
   * Uses metadata-driven configuration (payment_initiation_rpc) to call domain-specific RPC.
   *
   * Pattern for adding payments to entities:
   * 1. Add payment_transaction_id column (UUID FK to payment_transactions)
   * 2. Create initiate_{entity}_payment(p_entity_id) RPC with domain logic
   * 3. Configure metadata: payment_initiation_rpc = 'initiate_{entity}_payment'
   * 4. Framework calls configured RPC when "Pay Now" clicked
   */
  async initiatePayment() {
    const viewer = this.viewer;
    if (!viewer || !this.entityKey || !this.entityId) return;

    this.paymentError.set(undefined);
    this.paymentLoading.set(true);

    const result = await viewer.initiatePayment();
    this.paymentLoading.set(false);
    if (result.status === 'checkout') {
      // Open PaymentCheckoutComponent modal
      this.currentPaymentId.set(result.paymentId);
      this.showCheckoutModal.set(true);
      return;
    }
    switch (result.reason) {
      case 'not_configured':
        console.error('[Payment] Payment initiation RPC not configured for entity:', this.entityKey);
        this.paymentError.set(this.translation.get('payment.error.not_configured'));
        break;
      case 'no_payment_id':
        this.paymentError.set(this.translation.get('payment.error.initiate_failed'));
        break;
      case 'rejected':
        this.paymentError.set(result.message || this.translation.get('payment.error.initiate_failed'));
        break;
    }
  }

  /**
   * Handle successful payment (or any status change)
   */
  handlePaymentSuccess(_paymentId: string) {
    this.showCheckoutModal.set(false);
    this.currentPaymentId.set(undefined);

    // Refresh data to show updated payment status
    // (PaymentCheckoutComponent already waits 500ms before emitting to ensure DB consistency)
    this.refreshData();
  }

  /**
   * Handle checkout modal close (user clicked X button)
   * Refresh data to show any payment status changes that occurred before close
   */
  handleCheckoutClose() {
    this.showCheckoutModal.set(false);
    this.currentPaymentId.set(undefined);

    // Refresh data in case payment status changed before user closed modal
    this.refreshData();
  }

  /**
   * Navigate to Create page for a related entity with pre-filled query params.
   *
   * Use Cases:
   * - "Add Appointment" from Resource detail page → pre-fills resource_id
   * - Calendar date selection → pre-fills time_slot + resource_id
   * - "Add Issue for User" → pre-fills assigned_user_id
   *
   * @param tableName - Target entity to create (e.g., 'appointments', 'issues')
   * @param fkColumn - Foreign key column name to pre-fill (e.g., 'resource_id', 'user_id')
   * @param additionalParams - Optional extra query params (e.g., { time_slot: '[start,end)', status: 'pending' })
   */
  navigateToCreateRelated(tableName: string, fkColumn: string, additionalParams?: Record<string, any>) {
    this.router.navigate(['/create', tableName], {
      queryParams: {
        [fkColumn]: this.entityId,
        ...additionalParams
      }
    });
  }

  // =========================================================================
  // ENTITY ACTION METHODS (v0.18.0)
  // =========================================================================

  goBack(): void {
    this.navigation.goBack('/view/' + this.entityKey);
  }

  /**
   * Handle clicks from the action bar.
   * Routes to appropriate handler based on button ID.
   */
  onActionButtonClick(buttonId: string): void {
    if (buttonId === 'edit') {
      const data = this.snapshot()?.record;
      if (data) {
        this.router.navigate(['/edit', this.entityKey, data['id']], { replaceUrl: true });
      }
    } else if (buttonId === 'delete') {
      this.openDeleteModal();
    } else if (buttonId === 'payment') {
      this.initiatePayment();
    } else if (buttonId.startsWith('action:')) {
      const actionName = buttonId.substring(7);
      const action = this.visibleActions().find(a => a.key === actionName);
      if (action) {
        this.onEntityActionClick(action);
      }
    }
  }

  /**
   * Resume the guided form by navigating to the first incomplete, non-skipped step.
   */
  continueGuidedForm(): void {
    const guided = this.snapshot()?.guidedForm;
    const pid = this.entityId;
    if (!guided?.context || !pid) return;

    // The first incomplete step that is required (skips over user-skippable optional steps)
    const nextStep = guided.steps.find(s => s.step_key === guided.nextStepKey);

    if (!nextStep) return;

    if (nextStep.step_key === '__parent__') {
      this.router.navigate(['/edit', nextStep.step_table, pid]);
    } else {
      this.onEditGuidedFormStep(nextStep.step_key);
    }
  }

  /**
   * Submit a completed guided form from the review section.
   */
  async onSubmitGuidedForm(): Promise<void> {
    const viewer = this.viewer;
    const key = this.currentEntity()?.guided_form_key;
    const pid = this.entityId;
    if (!viewer || !key || !pid) return;

    this.guidedFormError.set(undefined);
    this.guidedFormSubmitting.set(true);

    const result = await viewer.submitGuidedForm();
    this.guidedFormSubmitting.set(false);

    if (result.status === 'failed') {
      this.guidedFormError.set(result.message || 'An unexpected error occurred.');
      return;
    }

    // A submit changes the form's progress: the Edit and Create pages must not read the context they cached
    this.guidedFormService.invalidateContextForForm(key);

    // on_submit_rpc can return navigate_to to override the default success modal.
    // Guard against same-URL navigation (e.g., submit_tool_reservation returns
    // the current detail page URL) — Angular ignores navigateByUrl to the same
    // route, which would leave the page in a stale state with no refresh.
    const navigateTo = result.navigateTo;
    if (navigateTo && navigateTo !== this.router.url) {
      this.guidedFormCleared.set(true);
      this.router.navigateByUrl(navigateTo);
    } else {
      this.refreshData();
      this.showGuidedFormSuccessModal.set(true);
    }
  }

  onGuidedFormSuccessViewRecord(): void {
    this.showGuidedFormSuccessModal.set(false);
  }

  onGuidedFormSuccessCreateAnother(): void {
    this.showGuidedFormSuccessModal.set(false);
    const entity = this.currentEntity();
    if (!entity?.guided_form_key) return;

    this.guidedFormService.startGuidedForm(entity.guided_form_key).subscribe({
      next: (result) => {
        this.router.navigate(['/edit', entity.table_name, result.parent_id]);
      },
      error: (err) => {
        const message = err?.error?.message || err?.message || 'Could not start a new form.';
        this.guidedFormError.set(message);
      }
    });
  }

  onGuidedFormSuccessGoToList(): void {
    this.showGuidedFormSuccessModal.set(false);
    const entity = this.currentEntity();
    if (entity) {
      this.router.navigate(['/view', entity.table_name]);
    }
  }

  /**
   * Navigate to edit a specific guided form step from the review section.
   * Looks up the actual step record ID (not the parent ID).
   */
  onEditGuidedFormStep(stepKey: string): void {
    const ctx = this.guidedFormContext();
    const key = this.currentEntity()?.guided_form_key;
    const pid = this.entityId;
    if (!key || !pid || !ctx) return;

    const step = ctx.steps.find(s => s.step_key === stepKey);
    if (!step) return;

    if (stepKey === '__parent__') {
      this.router.navigate(['/edit', step.step_table, pid]);
      return;
    }

    if (step.parent_fk_column) {
      // Ensure draft record exists (idempotent), then navigate to edit
      this.guidedFormService.ensureStepRecord(key, pid, stepKey).subscribe({
        next: (result) => {
          if (result.record_id) {
            this.router.navigate(['/edit', step.step_table, result.record_id]);
          }
        },
        error: (err) => {
          const message = err?.error?.message || err?.message || 'Failed to load step record.';
          this.guidedFormError.set(message);
        }
      });
    }
  }

  /**
   * Handle guided form nav step click on detail page.
   */
  onGuidedFormStepClick(stepKey: string): void {
    if (stepKey === '__review__') {
      // Already on detail page — scroll to review section
      const reviewEl = document.querySelector('app-guided-form-review-section');
      if (reviewEl) {
        reviewEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    // For other steps, delegate to edit handler
    this.onEditGuidedFormStep(stepKey);
  }

  /**
   * Handle entity action button click.
   * Shows confirmation modal if:
   * - action has parameters (form needed), or
   * - action requires_confirmation
   * Otherwise executes immediately with loading overlay.
   */
  onEntityActionClick(action: ViewerAction): void {
    this.currentAction.set(action);
    this.actionError.set(undefined);
    this.actionSuccess.set(undefined);

    const hasParams = action.parameters && action.parameters.length > 0;

    if (hasParams || action.requiresConfirmation) {
      // Open the parameter session and build the param form from it if the action has parameters
      if (hasParams) {
        this.openParamSession(action);
        this.loadGalleryConfigs(action.parameters);
      }
      this.showActionModal.set(true);
    } else {
      // Show loading overlay and execute immediately
      this.actionOverlayLoading.set(true);
      this.executeEntityAction(action);
    }
  }

  /**
   * Confirm action from modal.
   * Validates param form if present, saves any gallery uploads, then collects values and executes.
   */
  async confirmEntityAction(): Promise<void> {
    const action = this.currentAction();
    if (!action) return;

    // Validate param form if present
    const form = this.actionParamForm();
    if (form) {
      if (form.invalid) {
        form.markAllAsTouched();
        return;
      }
    }

    this.actionLoading.set(true);

    // Save gallery uploads before executing RPC (v0.55.0)
    const gallerySaved = await this.saveActionGalleries();
    if (!gallerySaved) {
      this.actionLoading.set(false);
      this.actionError.set('Failed to save gallery photos. Please try again.');
      return;
    }

    // The facade collects the values by type and leaves out empty optional ones
    await this.executeEntityAction(action, form ? form.value : {});
  }

  private clearActionAutoClose(): void {
    clearTimeout(this.actionAutoCloseTimer);
    this.actionAutoCloseTimer = undefined;
  }

  /**
   * Close action modal and reset state (including param form).
   */
  closeActionModal(): void {
    this.showActionModal.set(false);
    this.currentAction.set(undefined);
    this.actionError.set(undefined);
    this.actionSuccess.set(undefined);
    this.actionParamForm.set(undefined);
    this.actionParamOptions.set({});
    this.releaseParamSession();
    this.actionFileUploading.set(false);
    this.actionUploadedFile.set({});
    this.actionUploadError.set(undefined);
    // Gallery cleanup (v0.55.0)
    this.actionGalleryConfig.set({});
    this.actionGalleryIds.set({});
  }

  /**
   * Run the entity action through the facade and map its outcome onto the modal:
   * the success message (then, after a brief delay, navigation or a refresh), the error text.
   *
   * @param action - The action to execute
   * @param values - Optional param values from the action param form (v0.32.0)
   */
  private async executeEntityAction(action: ViewerAction, values: Record<string, unknown> = {}): Promise<void> {
    const handle = this.viewer?.action(action.key);
    const result = handle ? await handle.run(values) : ({ status: 'failed' } as const);
    this.actionLoading.set(false);
    this.actionOverlayLoading.set(false);

    switch (result.status) {
      case 'succeeded': {
        // Determine message, navigation, and refresh behavior
        // RPC response can override metadata defaults
        const message = result.message || 'Action completed';
        const navigateTo = result.navigateTo;
        const shouldRefresh = result.refresh;

        this.actionSuccess.set(message);

        // Auto-close modal and handle navigation/refresh after brief delay
        this.clearActionAutoClose();
        this.actionAutoCloseTimer = setTimeout(() => {
          this.actionAutoCloseTimer = undefined;
          this.closeActionModal();

          if (navigateTo) {
            // Clear guided form state before navigation to prevent stale header
            this.guidedFormCleared.set(true);
            this.router.navigate([navigateTo]);
          } else if (shouldRefresh) {
            this.refreshData();
          }
        }, 1500);
        break;
      }
      case 'invalid':
        this.actionParamForm()?.markAllAsTouched();
        break;
      case 'failed':
        // RPC returned an error
        this.actionError.set(result.message || 'Action failed');
        break;
    }
  }

  // =========================================================================
  // ACTION PARAMETER HELPERS (v0.32.0)
  // =========================================================================

  /**
   * Open the action's parameter session and bridge the form to it. The session owns the values and the
   * dropdown options (and the debounced re-fetch of dependent ones); the form owns validation and the inputs.
   * - a control's value change goes to `session.setValue`;
   * - a session change refreshes the option lists and writes a value the session changed (a dependent cleared
   *   or invalidated) back into its control without emitting, so it does not re-enter `setValue`.
   */
  private openParamSession(action: ViewerAction): void {
    this.releaseParamSession();
    const session = this.viewer?.action(action.key)?.openParams();
    if (!session) return;

    this.paramSession = session;
    this.buildActionParamForm(action.parameters, session.getSnapshot().values);
    const form = this.actionParamForm()!;

    for (const param of action.parameters) {
      const control = form.get(param.param_name);
      if (control) {
        this.paramControlSubs.push(control.valueChanges.subscribe(value => session.setValue(param.param_name, value)));
      }
    }
    const sync = () => this.syncFromParamSession(session, form);
    this.paramSessionUnsubscribe = session.subscribe(sync);
    sync();
  }

  private syncFromParamSession(session: ActionParamSession, form: FormGroup): void {
    const { values, options } = session.getSnapshot();
    this.actionParamOptions.set(options as Record<string, any[]>);
    for (const [name, value] of Object.entries(values)) {
      const control = form.get(name);
      if (control && control.value !== value) {
        control.setValue(value, { emitEvent: false });
      }
    }
  }

  private releaseParamSession(): void {
    this.paramControlSubs.forEach(s => s.unsubscribe());
    this.paramControlSubs = [];
    this.paramSessionUnsubscribe?.();
    this.paramSessionUnsubscribe = undefined;
    this.paramSession?.dispose();
    this.paramSession = undefined;
  }

  /**
   * Build a FormGroup from action parameter definitions.
   * Creates a FormControl for each param with the required validator and the session's default value.
   */
  buildActionParamForm(params: readonly EntityActionParam[], values: Readonly<Record<string, unknown>> = {}): void {
    const controls: Record<string, FormControl> = {};

    for (const param of params) {
      const validators = param.required ? [Validators.required] : [];
      controls[param.param_name] = new FormControl(values[param.param_name] ?? null, validators);
    }

    this.actionParamForm.set(new FormGroup(controls));
  }

  /**
   * Load the gallery constraints (max_images, allowed_types) for photo_gallery params.
   */
  private loadGalleryConfigs(params: readonly EntityActionParam[]): void {
    for (const param of params) {
      if (param.param_type === 'photo_gallery' && param.target_column) {
        this.galleryService.getConfig(this.entityKey!, param.target_column).subscribe({
          next: (config) => {
            this.actionGalleryConfig.set({
              ...this.actionGalleryConfig(),
              [param.param_name]: config
            });
          },
          error: (err) => {
            console.error(`[DetailPage] Failed to load gallery config for ${param.target_column}`, err);
          }
        });
      }
    }
  }

  /**
   * Handle file selection for a file-type action parameter.
   * Validates the file, uploads via FileUploadService, and stores the
   * resulting file UUID in the param's form control for RPC submission.
   */
  onActionFileSelected(event: Event, paramName: string): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // Determine allowed types from param's file_type
    const param = this.currentAction()?.parameters?.find(p => p.param_name === paramName);
    const allowedTypes = this.getFileAcceptForParam(param);

    // Validate file (skip type check for '*/*')
    const typeFilter = allowedTypes !== '*/*' ? allowedTypes : undefined;
    const validationError = this.fileUpload.validateFile(file, typeFilter, 10 * 1024 * 1024);
    if (validationError) {
      this.actionUploadError.set(validationError);
      input.value = '';
      return;
    }

    this.actionFileUploading.set(true);
    this.actionUploadError.set(undefined);

    this.fileUpload.uploadFile(file, this.entityKey!, this.entityId!, false)
      .then(fileRef => {
        // Store UUID in form control for RPC submission
        this.actionParamForm()?.get(paramName)?.setValue(fileRef.id);
        // Track uploaded file info for display
        this.actionUploadedFile.set({
          ...this.actionUploadedFile(),
          [paramName]: fileRef
        });
      })
      .catch(err => {
        this.actionUploadError.set(err.message || 'File upload failed');
      })
      .finally(() => {
        this.actionFileUploading.set(false);
        input.value = '';
      });
  }

  // =========================================================================
  // PHOTO GALLERY ACTION PARAM HELPERS (v0.55.0)
  // =========================================================================

  /**
   * Handle draft gallery creation from a photo_gallery action param editor.
   * Stores the gallery ID and sets the form control value (enables required validation).
   */
  onActionGalleryDraftCreated(paramName: string, galleryId: string): void {
    this.actionGalleryIds.set({
      ...this.actionGalleryIds(),
      [paramName]: galleryId
    });
    // Set form control value so the gallery UUID is passed to the RPC
    this.actionParamForm()?.get(paramName)?.setValue(galleryId);
  }

  /**
   * Save all photo gallery editors in the action modal before executing the RPC.
   * Calls saveChanges() on each gallery editor to persist uploads.
   * @returns true if all saves succeeded (or no galleries to save)
   */
  async saveActionGalleries(): Promise<boolean> {
    if (!this.actionGalleryEditors?.length) return true;

    for (const editor of this.actionGalleryEditors) {
      if (editor.hasPendingChanges()) {
        const success = await editor.saveChanges();
        if (!success) return false;
      }
    }
    return true;
  }

  /**
   * Check if any gallery editor in the action modal is currently uploading.
   * Used to disable the Confirm button during uploads.
   */
  isAnyGalleryUploading(): boolean {
    if (!this.actionGalleryEditors?.length) return false;
    return this.actionGalleryEditors.some(editor => editor.uploading());
  }

  /**
   * Get the HTML accept attribute value for a file-type action parameter.
   */
  getFileAcceptForParam(param?: EntityActionParam): string {
    if (!param) return '*/*';
    switch (param.file_type) {
      case 'image': return 'image/*';
      case 'pdf': return 'application/pdf';
      default: return '*/*';
    }
  }

  /**
   * Get display column name for a foreign_key param's options.
   * Always uses display_name — join_column is the value column, not the label.
   */
  getParamDisplayColumn(_param: EntityActionParam): string {
    return 'display_name';
  }
}
