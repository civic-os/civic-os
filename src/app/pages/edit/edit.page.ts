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


import { Component, inject, signal, computed, effect, ChangeDetectionStrategy, ViewChildren, QueryList, untracked, input, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { SchemaService } from '../../services/schema.service';
import { Observable, from, map, mergeMap, of, tap } from 'rxjs';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import {
  SchemaEntityTable,
  RenderableItem,
  isStaticText,
  isProperty,
  SeriesEditScope
} from '../../interfaces/entity';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { GuidedFormNavComponent } from '../../components/guided-form-nav/guided-form-nav.component';
import { ApiError } from '../../interfaces/api';
import Keycloak from 'keycloak-js';
import { GuidedFormService } from '../../services/guided-form.service';
import { ProfileService } from '../../services/profile.service';

import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { EditPropertyComponent } from '../../components/edit-property/edit-property.component';
import { EmptyStateComponent } from '../../components/empty-state/empty-state.component';
import { StaticTextComponent } from '../../components/static-text/static-text.component';
import { ExceptionEditorComponent, ExceptionEditorResult } from '../../components/exception-editor/exception-editor.component';
import { InlineM2mEditorComponent } from '../../components/inline-m2m-editor/inline-m2m-editor.component';
import { RichM2mDiff } from '../../components/fk-search-modal/fk-search-modal.component';
import { SaveProgressComponent, SaveStep, SaveStepResult } from '../../components/save-progress/save-progress.component';
import { AnalyticsService } from '../../services/analytics.service';
import { MaintenanceService } from '../../services/maintenance.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslationService } from '../../services/translation.service';
import { getAppTitle } from '../../config/runtime';
import { CommonModule } from '@angular/common';
import {
  recordEditor,
  type EditorEditContinueResult,
  type EditorEditStep,
  type EditorEditStepResult,
  type EditorNavigation,
  type EditorSaveResult,
  type EditorScopedSaveResult,
  type EntityHandle,
  type RecordEditorEdit,
  type RecordEditorEditSnapshot,
} from '@civic-os/core';
import { ContrastTextDirective } from '../../directives/contrast-text.directive';
import { FACADE_DEPS } from '../../sdk/facade-deps';
import { formGroupBackend, type FormGroupBackend } from '../../sdk/form-group-backend';
import { switchingStore } from '../../sdk/switching-store';

/** The zone the browser resolved; core transforms take it explicitly. */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

@Component({
    selector: 'app-edit',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
    DisplayPropertyComponent,
    EditPropertyComponent,
    EmptyStateComponent,
    StaticTextComponent,
    ExceptionEditorComponent,
    InlineM2mEditorComponent,
    SaveProgressComponent,
    GuidedFormNavComponent,
    CommonModule,
    ReactiveFormsModule,
    CosModalComponent,
    RouterModule,
    TranslatePipe,
    ContrastTextDirective
],
    templateUrl: './edit.page.html',
    styleUrl: './edit.page.css'
})
export class EditPage {
  /** The route entity's core handle, from `entityResolver` through route input binding. The `recordEditor` facade is made from it (`docs/notes/FRONTEND_SDK_DESIGN.md` §11). */
  readonly entityHandle = input<EntityHandle | undefined>();

  private route = inject(ActivatedRoute);
  private schema = inject(SchemaService);
  private router = inject(Router);
  private keycloak = inject(Keycloak);
  private analytics = inject(AnalyticsService);
  private navigation = inject(NavigationService);
  private profileService = inject(ProfileService);
  private guidedForm = inject(GuidedFormService);
  private titleService = inject(Title);
  private translation = inject(TranslationService);
  private facadeDeps = inject(FACADE_DEPS);
  public auth = inject(AuthService);
  private maintenanceService = inject(MaintenanceService);

  // Redirect away from edit page during maintenance mode
  private _maintenanceGuard = effect(() => {
    if (this.maintenanceService.isActive() && !this.maintenanceService.isAdminBypassing()) {
      const entityKey = untracked(() => this.entityKey);
      const entityId = untracked(() => this.entityId);
      const target = entityKey && entityId ? ['/view', entityKey, entityId] : ['/'];
      this.router.navigate(target);
    }
  });

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  public entityKey?: string;
  public entityId?: string;
  private routeKey = signal<string | undefined>(undefined);
  private routeId = signal<string | undefined>(undefined);

  constructor() {
    this.route.params.pipe(takeUntilDestroyed()).subscribe(p => {
      this.routeKey.set(p['entityKey']);
      this.routeId.set(p['entityId']);
    });
    inject(DestroyRef).onDestroy(() => {
      this.disposeEditor();
    });
  }

  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(mergeMap(p => {
    this.entityKey = p['entityKey'];
    this.entityId = p['entityId'];
    if(p['entityKey'] && p['entityId']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined);
    }
  }), tap(entity => {
    // Set the document title once entity metadata resolves (e.g. "Edit Issue – Civic OS").
    if (entity?.display_name) {
      const name = this.translation.get('form.edit_title', { entity: entity.display_name });
      this.titleService.setTitle(`${name} - ${getAppTitle()}`);
    }
  }));

  // The form: one `recordEditor` facade per (entity handle, route key, route id). A change of any, or a schema
  // refresh (a locale change reloads the entity rows), disposes the previous facade and builds the next; the
  // handle must be the route's entity, so a switch between entities never builds the new key's form from the
  // old entity. The facade reads the schema and the record itself.
  private editor?: RecordEditorEdit<FormGroupBackend>;
  private editorBinding = switchingStore<RecordEditorEditSnapshot<FormGroupBackend>>();
  readonly snapshot = this.editorBinding.value;
  private galleryUnregisters: (() => void)[] = [];

  private _bindEditor = effect(() => {
    const handle = this.entityHandle();
    const key = this.routeKey();
    const id = this.routeId();
    this.schema.entityRows();
    untracked(() => {
      this.disposeEditor();
      if (!handle || handle.name !== key || !id) {
        this.editorBinding.bind(undefined);
        return;
      }
      const editor = recordEditor(this.facadeDeps, handle, {
        mode: 'edit',
        recordId: id,
        backend: formGroupBackend,
        timeZone: browserTimeZone(),
      });
      this.editor = editor;
      this.editorBinding.bind(editor);
    });
  });

  private disposeEditor(): void {
    this.editor?.dispose();
    this.editor = undefined;
    this.galleryUnregisters = [];
  }

  // The template's view of the snapshot. Each is the legacy observable or signal it replaces.

  /** The form group the controls bind to; undefined until the record has loaded. */
  public editForm = computed(() => this.snapshot()?.backend?.form);
  /** The loaded row (inline many-to-many columns flattened), or null while loading and when not found. */
  public record = computed<any>(() => this.snapshot()?.record ?? null);
  /** Properties merged with static text blocks, for the template. */
  public editRenderables = computed(() => this.snapshot()?.renderables as RenderableItem[] | undefined);
  /** A reload with a record on show (the editor loads again). */
  public loading = computed(() => {
    const snap = this.snapshot();
    return !!snap && snap.loading && snap.record !== null;
  });
  /** The first read is in flight and there is no record to show yet. */
  public dataLoading = computed(() => this.snapshot()?.loading ?? false);

  // Expose type guards to template
  protected readonly isStaticText = isStaticText;
  protected readonly isProperty = isProperty;

  public showValidationError = signal(false);

  // Reactively hide the error banner when the form becomes valid
  private _hideValidationError = effect(() => {
    if (this.snapshot()?.form?.valid && untracked(() => this.showValidationError())) {
      this.showValidationError.set(false);
    }
  });

  // v0.47.0: Gallery editors for deferred reorder save
  @ViewChildren(EditPropertyComponent) editProperties!: QueryList<EditPropertyComponent>;

  public saveSteps = signal<SaveStep[] | null>(null);
  public saveComplete = signal(false);

  // v0.65.0: returnTo support — auto-navigate on success instead of showing modal. Read when a record has
  // loaded (legacy read it in the load of `data$`), so each loaded record takes the route's value at that moment.
  private returnTo: string | null = null;
  private recordLoaded = computed(() => this.snapshot()?.record != null);
  private _readReturnTo = effect(() => {
    if (this.recordLoaded()) {
      untracked(() => {
        this.returnTo = this.route.snapshot?.queryParamMap?.get('returnTo') ?? null;
      });
    }
  });

  // Signal-based modal state (replaces ViewChild DialogComponent)
  showSuccessModal = signal(false);
  showErrorModal = signal(false);
  currentError = signal<ApiError | undefined>(undefined);

  // Which save is in flight. Legacy `isSaving` was set by a plain save, a "this and following" split and the
  // coordinated steps that follow either (until `onSaveComplete`), never by Save and Continue nor by an "all
  // occurrences" update; `snapshot.saving` is true for every save command but the last, so the page gates it
  // by the command.
  private inFlight = signal<'save' | null>(null);
  /** v0.60.1: Double-submit guard (Save). */
  public isSaving = computed(() => this.inFlight() === 'save' && (this.snapshot()?.saving ?? false));
  public savingAndContinuing = computed(() => this.snapshot()?.savingAndContinuing ?? false);

  // v0.48.0: Guided form mode
  public isGuidedFormMode = computed(() => !!this.snapshot()?.guidedFormKey);
  public guidedFormContext = computed(() => this.snapshot()?.guidedForm?.context ?? null);
  public isGuidedFormDraft = computed(() => this.snapshot()?.guidedForm?.draft ?? false);
  public isGuidedFormLocked = computed(() => this.snapshot()?.guidedForm?.locked ?? false);
  public isCurrentStepSkippable = computed(() => this.snapshot()?.guidedForm?.skippable ?? false);
  public isEditingCompletedStep = computed(() => this.snapshot()?.guidedForm?.editingCompletedStep ?? false);
  public showCompletedStepDisplayMode = computed(() => this.snapshot()?.guidedForm?.completedStepDisplay ?? false);
  /** Rich display data for completed step display mode. */
  public displayData = computed<any>(() => this.snapshot()?.guidedForm?.displayRecord ?? null);
  public autoSaveStatus = computed(() => this.snapshot()?.autoSave ?? 'idle');

  // Series membership (for recurring time slots)
  public seriesMembership = computed(() => this.snapshot()?.series);
  public showScopeDialog = computed(() => this.snapshot()?.scopePending ?? false);

  async submitForm(event: any): Promise<void> {
    event?.preventDefault?.();

    const editor = this.editor;
    if (!editor || !this.editForm() || this.isSaving()) return;

    this.syncGalleries();
    this.inFlight.set('save');
    // The token is refreshed after the values are transformed and before anything is sent
    const result = await editor.save(() => this.refreshToken());

    // Coordinated steps keep Save disabled until they have all run (`onSaveComplete`)
    this.inFlight.set(result.status === 'steps' ? 'save' : null);
    if (result.status === 'invalid') {
      this.showValidationError.set(true);
    } else if (result.status !== 'ignored') {
      this.showValidationError.set(false);
    }
    this.handleSaveResult(result);
  }

  /** What each outcome of a plain save does (legacy `submitForm` and `performEdit`). */
  private handleSaveResult(result: EditorSaveResult | EditorScopedSaveResult): void {
    switch (result.status) {
      case 'ignored':
      case 'scope_required':
        // `scope_required` opens the scope dialog through the snapshot (`scopePending`)
        return;
      case 'invalid':
        // Scroll to first invalid field
        this.scrollToFirstError();
        return;
      case 'transform_error':
        this.showTransformError(result);
        return;
      case 'aborted':
        this.showSessionExpired();
        return;
      case 'saved':
        // Track successful record edit
        this.trackEdit();
        if (result.after === 'guided_parent') {
          // Guided form draft: navigate to detail page instead of success modal
          this.performNavigation(result.navigation);
        } else if (result.after === 'success') {
          this.handleSaveSuccess();
        }
        // 'completed_step': the editor is back in display mode with fresh display data
        return;
      case 'steps':
        this.runSteps(result.steps);
        return;
      case 'failed':
        console.error('[EDIT SUBMIT] API returned error:', result.error);
        console.error('[EDIT SUBMIT] Error details:', {
          httpCode: result.error?.httpCode,
          message: result.error?.message,
          details: result.error?.details,
          hint: result.error?.hint,
          humanMessage: result.error?.humanMessage
        });
        this.currentError.set(result.error);
        this.showErrorModal.set(true);
        return;
      case 'series_split_failed':
      case 'series_update_failed':
        // Only `saveWithScope` gives these; `onScopeConfirm` words them
        return;
    }
  }

  /**
   * Handle scope selection from ExceptionEditorComponent.
   * Called when user selects scope for series member edit.
   */
  async onScopeConfirm(choice: ExceptionEditorResult): Promise<void> {
    const editor = this.editor;
    if (!editor) return;

    // The scope's own tracking and success apply only when the series ids it needs were there; without them
    // the editor fell back to the plain save, which legacy tracked as an ordinary edit.
    const membership = this.snapshot()?.series;
    const viaSeries = choice.scope === 'all'
      ? !!membership?.series_id
      : choice.scope === 'this_and_future'
        ? !!membership?.series_id && !!membership?.occurrence_date
        : false;

    this.syncGalleries();
    this.inFlight.set('save');
    const result = await editor.saveWithScope(choice.scope, () => this.refreshToken());
    this.inFlight.set(result.status === 'steps' ? 'save' : null);
    this.handleScopedResult(viaSeries ? choice.scope : 'this_only', result);
  }

  private handleScopedResult(scope: SeriesEditScope, result: EditorScopedSaveResult): void {
    switch (result.status) {
      case 'series_split_failed':
        this.showSeriesSplitError(result.detail);
        return;
      case 'series_update_failed':
        console.error('[SERIES UPDATE] API returned error:', result.message);
        this.currentError.set({
          httpCode: 400,
          message: result.message || 'Failed to update series',
          humanMessage: 'Series Update Failed'
        });
        this.showErrorModal.set(true);
        return;
      case 'saved':
        if (scope === 'this_and_future') {
          this.trackEdit('EditSeriesFuture');
          this.handleSaveSuccess();
          return;
        }
        if (scope === 'all') {
          this.trackEdit('EditSeriesAll');
          this.handleSaveSuccess();
          return;
        }
        break;
      case 'steps':
        // The split is tracked once it has succeeded, before the related saves
        if (scope === 'this_and_future') {
          this.trackEdit('EditSeriesFuture');
        }
        break;
    }
    this.handleSaveResult(result);
  }

  /**
   * Cancel scope selection.
   */
  onScopeCancel(): void {
    this.editor?.cancelScope();
  }

  private showSeriesSplitError(detail?: string): void {
    this.currentError.set({
      httpCode: 400,
      message: detail || this.translation.get('error.series_split_failed'),
      humanMessage: this.translation.get('error.series_split_failed')
    });
    this.showErrorModal.set(true);
  }

  // --- v0.46.0: Inline M:M methods ---

  onM2mDiffChanged(columnName: string, diff: { toAdd: (number | string)[], toRemove: (number | string)[] }) {
    this.editor?.setManyToManyDiff(columnName, diff);
  }

  // v0.51.0: Handle rich junction diff from inline editor
  onRichM2mDiffChanged(columnName: string, diff: RichM2mDiff) {
    this.editor?.setRichManyToManyDiff(columnName, diff);
  }

  onSaveComplete() {
    this.saveComplete.set(true);
    this.inFlight.set(null);
    this.editor?.clearPending();
    this.trackEdit();

    // v0.65.0: If returnTo is set, auto-navigate instead of showing success buttons
    if (this.returnTo) {
      this.profileService.invalidateCache();
      this.showSuccessModal.set(false);
      this.router.navigateByUrl(this.returnTo, { replaceUrl: true });
    }
  }

  /** The coordinated save: the editor's steps, worded and run by the progress component. */
  private runSteps(steps: readonly EditorEditStep[]): void {
    this.saveSteps.set(steps.map(step => this.toSaveStep(step)));
    this.showSuccessModal.set(true);  // SaveProgressComponent auto-starts execution
  }

  private toSaveStep(step: EditorEditStep): SaveStep {
    return {
      label: this.stepLabel(step),
      execute: () => from(step.execute()).pipe(map(result => this.toSaveStepResult(result)))
    };
  }

  private stepLabel(step: EditorEditStep): string {
    switch (step.kind) {
      case 'record': return 'Saving record';
      case 'many_to_many': return `Updating ${step.property.display_name} (${step.addCount} to add, ${step.removeCount} to remove)`;
      case 'rich_many_to_many': return `Updating ${step.property.display_name} (${step.addCount + step.removeCount + step.updateCount} changes)`;
      case 'galleries': return 'Saving gallery changes';
    }
  }

  private toSaveStepResult(result: EditorEditStepResult): SaveStepResult {
    const out: SaveStepResult = { success: result.success };
    if (result.failedCount !== undefined) out.failedCount = result.failedCount;
    if (result.totalCount !== undefined) out.totalCount = result.totalCount;
    const message = result.errorMessage ?? this.stepReasonMessage(result);
    if (message !== undefined) out.errorMessage = message;
    return out;
  }

  private stepReasonMessage(result: EditorEditStepResult): string | undefined {
    switch (result.reason) {
      case 'changes_failed': return `${result.failedCount} of ${result.totalCount} changes failed`;
      case 'gallery_save_failed': return 'Failed to save gallery changes';
      default: return undefined;
    }
  }

  /**
   * v0.47.0: Registers the gallery editors that are mounted right now with the editor (replacing any earlier
   * registration), just before a save command reads them: the set is `editProperties` with a gallery editor, as
   * legacy filtered it when it saved.
   */
  private syncGalleries(): void {
    const editor = this.editor;
    if (!editor) return;
    for (const unregister of this.galleryUnregisters) unregister();
    this.galleryUnregisters = [];
    for (const ep of this.editProperties?.filter(p => p.galleryEditor) ?? []) {
      this.galleryUnregisters.push(editor.registerGallery(ep.prop().column_name, {
        hasPendingChanges: () => ep.galleryEditor?.hasPendingChanges() === true,
        save: () => ep.saveGalleryChanges(),
      }));
    }
  }

  private scrollToFirstError(): void {
    // Wait for Angular to update the DOM with error classes
    setTimeout(() => {
      const firstInvalidControl = document.querySelector('.ng-invalid:not(form)');
      if (firstInvalidControl) {
        firstInvalidControl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Try to focus if it's a focusable element
        if (firstInvalidControl instanceof HTMLElement) {
          firstInvalidControl.focus();
        }
      }
    }, 100);
  }

  goBack(): void {
    this.navigation.goBack('/view/' + this.entityKey + '/' + this.entityId);
  }

  navToList(key?: string) {
    if(key) {
      this.router.navigate(['view', key], { replaceUrl: true });
    } else {
      this.router.navigate(['view', this.entityKey], { replaceUrl: true });
    }
  }
  navToRecord(key: string, id?: string) {
    this.router.navigate(['view', key, id], { replaceUrl: true });
  }

  /**
   * Handle successful save. If returnTo is set, auto-navigate back
   * instead of showing the success modal.
   */
  private handleSaveSuccess(): void {
    if (this.returnTo) {
      this.profileService.invalidateCache();
      this.router.navigateByUrl(this.returnTo, { replaceUrl: true });
    } else {
      this.showSuccessModal.set(true);
    }
  }

  /** Close success modal */
  closeSuccessModal(): void {
    this.showSuccessModal.set(false);
  }

  /** Close error modal and reset error state */
  closeErrorModal(): void {
    this.showErrorModal.set(false);
    this.currentError.set(undefined);
  }

  private trackEdit(action: 'Edit' | 'EditSeriesFuture' | 'EditSeriesAll' = 'Edit'): void {
    if (this.entityKey) {
      this.analytics.trackEvent('Entity', action, this.entityKey);
    }
  }

  /** Token refresh before a save; a failure aborts it (the session expired). */
  private refreshToken(): Promise<void> {
    return this.keycloak.updateToken(60).then(() => undefined);
  }

  private showSessionExpired(): void {
    this.currentError.set({
      httpCode: 401,
      message: 'Session expired',
      humanMessage: 'Session Expired',
      hint: 'Your login session has expired. Please refresh the page to log in again.'
    });
    this.showErrorModal.set(true);
  }

  /** F-09: an invalid local date or time stops the save and says which field. */
  private showTransformError(e: { column: string; message: string }): void {
    const label = this.snapshot()?.properties.find(p => p.column_name === e.column)?.display_name ?? e.column;
    this.currentError.set({
      httpCode: 400,
      message: e.message,
      humanMessage: `${label}: ${this.translation.get('form.pattern_mismatch')}`
    });
    this.showErrorModal.set(true);
  }

  /** Performs where the editor says to go (a completed step, a skipped step, a step opened from the navigation). */
  private performNavigation(nav: EditorNavigation): void {
    if (nav.kind === 'url') {
      this.router.navigateByUrl(nav.url);
    } else if (nav.kind === 'view') {
      this.router.navigate(['/view', nav.table, nav.id]);
    } else if (nav.kind === 'edit') {
      this.router.navigate(['/edit', nav.table, nav.id]);
    }
  }

  // ==========================================================================
  // GUIDED FORM MODE (v0.48.0)
  // ==========================================================================

  /** Enter edit mode for a completed guided form step. */
  public enterEditMode(): void {
    this.editor?.enterEditMode();
  }

  /** Cancel editing a completed guided form step and revert form values. */
  public cancelEditMode(): void {
    this.editor?.cancelEditMode();
  }

  /** Navigate to a different guided form step from the nav overlay. */
  public async onGuidedFormStepClick(stepKey: string): Promise<void> {
    const result = await this.editor?.goToStep(stepKey);
    if (result?.status === 'navigate') {
      this.performNavigation(result.navigation);
    } else if (result?.status === 'failed') {
      this.currentError.set({
        humanMessage: result.error.humanMessage,
        message: result.error.message ?? ''
      });
      this.showErrorModal.set(true);
    }
  }

  /** Save current step and advance to next step in guided form. */
  public async saveAndContinue(event?: Event): Promise<void> {
    event?.preventDefault?.();

    const editor = this.editor;
    if (!editor || !this.editForm()) return;

    this.syncGalleries();
    const result = await editor.saveAndContinue();

    if (result.status === 'invalid') {
      this.showValidationError.set(true);
    } else if (result.status !== 'ignored') {
      this.showValidationError.set(false);
    }
    this.handleContinueResult(result);
  }

  private handleContinueResult(result: EditorEditContinueResult): void {
    switch (result.status) {
      case 'ignored':
        return;
      case 'invalid':
        this.scrollToFirstError();
        return;
      case 'transform_error':
        this.showTransformError(result);
        return;
      case 'failed':
        this.currentError.set(result.error);
        this.showErrorModal.set(true);
        return;
      case 'related_failed':
        this.currentError.set({
          humanMessage: result.message || 'Failed to save related items.',
          message: result.message || ''
        });
        this.showErrorModal.set(true);
        return;
      case 'step_failed':
        this.currentError.set({
          humanMessage: result.error.message || 'Failed to complete step.',
          message: result.error.message || 'Failed to complete step.',
          code: result.error.code,
          hint: result.error.hint
        });
        this.showErrorModal.set(true);
        return;
      case 'continued':
        this.analytics.trackEvent('GuidedForm', 'StepComplete', `${result.guidedFormKey}:${result.stepKey}`);
        // Completing the step makes the cached guided-form context stale
        this.guidedForm.invalidateContextForForm(result.guidedFormKey);
        this.performNavigation(result.navigation);
        return;
    }
  }

  /**
   * Skip the current optional step without saving or validating.
   * Navigates to the next data step, or to the detail/review page if this is the last step.
   */
  public async skipStep(): Promise<void> {
    const nav = await this.editor?.skipStep();
    if (nav) this.performNavigation(nav);
  }
}
