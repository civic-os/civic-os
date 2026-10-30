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


import { Component, inject, ChangeDetectionStrategy, signal, computed, ViewChildren, QueryList, effect, untracked, DestroyRef, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { Observable, from, mergeMap, of, tap, map } from 'rxjs';
import {
  SchemaEntityTable,
  RenderableItem,
  isStaticText,
  isProperty
} from '../../interfaces/entity';
import { ActivatedRoute, Router, RouterModule, Params } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import Keycloak from 'keycloak-js';

import { EditPropertyComponent } from "../../components/edit-property/edit-property.component";
import { EmptyStateComponent } from '../../components/empty-state/empty-state.component';
import { StaticTextComponent } from '../../components/static-text/static-text.component';
import { InlineM2mEditorComponent } from '../../components/inline-m2m-editor/inline-m2m-editor.component';
import { RichM2mDiff } from '../../components/fk-search-modal/fk-search-modal.component';
import { SaveProgressComponent, SaveStep, SaveStepResult } from '../../components/save-progress/save-progress.component';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { AnalyticsService } from '../../services/analytics.service';
import { GuidedFormService } from '../../services/guided-form.service';
import { MaintenanceService } from '../../services/maintenance.service';
import { ProfileService } from '../../services/profile.service';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslationService } from '../../services/translation.service';
import { getAppTitle } from '../../config/runtime';
import { ApiError } from '../../interfaces/api';
import {
  recordEditor,
  type EditorContinueResult,
  type EditorStep,
  type EditorStepResult,
  type EntityHandle,
  type RecordEditor,
  type RecordEditorSnapshot,
} from '@civic-os/core';
import { FACADE_DEPS } from '../../sdk/facade-deps';
import { formGroupBackend, type FormGroupBackend } from '../../sdk/form-group-backend';
import { switchingStore } from '../../sdk/switching-store';

@Component({
    selector: 'app-create',
    templateUrl: './create.page.html',
    styleUrl: './create.page.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
    EditPropertyComponent,
    EmptyStateComponent,
    StaticTextComponent,
    InlineM2mEditorComponent,
    SaveProgressComponent,
    CommonModule,
    ReactiveFormsModule,
    CosModalComponent,
    RouterModule,
    TranslatePipe
]
})
export class CreatePage {
  /** The route entity's core handle, from `entityResolver` through route input binding. The `recordEditor` facade is made from it (`docs/notes/FRONTEND_SDK_DESIGN.md` §11). */
  readonly entityHandle = input<EntityHandle | undefined>();

  private route = inject(ActivatedRoute);
  private schema = inject(SchemaService);
  private router = inject(Router);
  private keycloak = inject(Keycloak);
  private analytics = inject(AnalyticsService);
  private navigation = inject(NavigationService);
  private guidedForm = inject(GuidedFormService);
  private profileService = inject(ProfileService);
  private titleService = inject(Title);
  private translation = inject(TranslationService);
  private facadeDeps = inject(FACADE_DEPS);
  public auth = inject(AuthService);
  private maintenanceService = inject(MaintenanceService);

  // Redirect away from create page during maintenance mode
  private _maintenanceGuard = effect(() => {
    if (this.maintenanceService.isActive() && !this.maintenanceService.isAdminBypassing()) {
      const target = this.entityKey ? ['/view', this.entityKey] : ['/'];
      this.router.navigate(target);
    }
  });

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  public entityKey?: string;
  private routeKey = signal<string | undefined>(undefined);
  /** The route's latest query params, read when an editor is built (a prefill, `returnTo`). */
  private queryParams: Params = {};

  constructor() {
    this.route.params.pipe(takeUntilDestroyed()).subscribe(p => this.routeKey.set(p['entityKey']));
    this.route.queryParams.pipe(takeUntilDestroyed()).subscribe(params => (this.queryParams = params));
    inject(DestroyRef).onDestroy(() => {
      this.editor?.dispose();
      this.editor = undefined;
    });
  }

  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(mergeMap(p => {
    this.entityKey = p['entityKey'];
    if(p['entityKey']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined);
    }
  }), tap(entity => {
    // Set the document title once entity metadata resolves (e.g. "Create Issue – Civic OS").
    if (entity?.display_name) {
      const name = this.translation.get('form.create_title', { entity: entity.display_name });
      this.titleService.setTitle(`${name} - ${getAppTitle()}`);
    }
  }));

  // The form: one `recordEditor` facade per (entity handle, route key). A change of either, or a schema refresh
  // (a locale change reloads the entity rows), disposes the previous facade and builds the next, with the
  // route's query params at that moment as the prefill; the handle must be the route's entity, so a switch
  // between entities never builds the new key's form from the old entity.
  private editor?: RecordEditor<FormGroupBackend>;
  private editorBinding = switchingStore<RecordEditorSnapshot<FormGroupBackend>>();
  readonly snapshot = this.editorBinding.value;

  private _bindEditor = effect(() => {
    const handle = this.entityHandle();
    const key = this.routeKey();
    this.schema.entityRows();
    untracked(() => {
      this.editor?.dispose();
      this.editor = undefined;
      if (!handle || handle.name !== key) {
        this.editorBinding.bind(undefined);
        return;
      }
      const params = this.queryParams;
      this.returnTo = params['returnTo'] || null;
      const editor = recordEditor(this.facadeDeps, handle, {
        mode: 'create',
        backend: formGroupBackend,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        prefill: params,
        galleryImages: () => this.saveGalleryChanges(),
      });
      this.editor = editor;
      this.editorBinding.bind(editor);
    });
  });

  /** The header and form show once the editor's load has settled (legacy: once the properties had emitted, even none). */
  public loaded = computed(() => {
    const snap = this.snapshot();
    return snap !== undefined && !snap.loading;
  });
  /** The form group the controls bind to; undefined until built. */
  public createForm = computed(() => this.snapshot()?.backend?.form);
  /** Properties merged with static text blocks, for the template. */
  public createRenderables = computed(() => this.snapshot()?.renderables as RenderableItem[] | undefined);

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

  // Signal-based modal state (replaces ViewChild DialogComponent)
  showSuccessModal = signal(false);
  showErrorModal = signal(false);
  currentError = signal<ApiError | undefined>(undefined);

  public saveSteps = signal<SaveStep[] | null>(null);
  public saveComplete = signal(false);

  @ViewChildren(EditPropertyComponent) editProperties!: QueryList<EditPropertyComponent>;

  // v0.65.0: returnTo support — auto-navigate on success instead of showing modal
  private returnTo: string | null = null;

  // Which command is in flight; its button is disabled while the editor is saving (legacy: `isSaving`,
  // `savingAndContinuing`).
  private inFlight = signal<'save' | 'continue' | null>(null);
  /** Save stays disabled after a single create succeeded, until Create another (legacy never cleared `isSaving` there). */
  private saveLocked = signal(false);
  /** v0.60.1: Double-submit guard (Save). */
  public isSaving = computed(() => this.saveLocked() || (this.inFlight() === 'save' && (this.snapshot()?.saving ?? false)));
  public savingAndContinuing = computed(() => this.inFlight() === 'continue' && (this.snapshot()?.saving ?? false));

  // v0-48-0: Guided form mode
  public isGuidedFormMode = computed(() => !!this.snapshot()?.guidedFormKey);

  async submitForm(event: any): Promise<void> {
    event?.preventDefault?.();

    const editor = this.editor;
    if (!editor || !this.createForm() || this.isSaving() || this.snapshot()?.saving) return;

    this.inFlight.set('save');
    // Refresh token before submission (if expires in < 60 seconds)
    const result = await editor.save(() => this.refreshToken());

    // A coordinated create keeps Save disabled until its steps have all run (`onSaveComplete`)
    this.inFlight.set(result.status === 'steps' ? 'save' : null);
    if (result.status === 'invalid') {
      this.showValidationError.set(true);
    } else if (result.status !== 'ignored') {
      this.showValidationError.set(false);
    }

    switch (result.status) {
      case 'ignored':
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
      case 'failed':
        console.error('[CREATE SUBMIT] API returned error:', result.error);
        console.error('[CREATE SUBMIT] Error details:', {
          httpCode: result.error?.httpCode,
          message: result.error?.message,
          details: result.error?.details,
          hint: result.error?.hint,
          humanMessage: result.error?.humanMessage
        });
        this.currentError.set(result.error);
        this.showErrorModal.set(true);
        return;
      case 'created':
        // Track successful record creation
        if (this.entityKey) {
          this.analytics.trackEvent('Entity', 'Create', this.entityKey);
        }
        this.saveLocked.set(true);
        this.handleSaveSuccess();
        return;
      case 'steps':
        this.runSteps(result.steps);
        return;
    }
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
    this.saveLocked.set(false);
    this.inFlight.set(null);
    this.editor?.clearPending();
    if (this.entityKey) {
      this.analytics.trackEvent('Entity', 'Create', this.entityKey);
    }

    // v0.65.0: If returnTo is set, auto-navigate instead of showing success buttons
    if (this.returnTo) {
      this.profileService.invalidateCache();
      this.showSuccessModal.set(false);
      this.router.navigateByUrl(this.returnTo, { replaceUrl: true });
    }
  }

  // v0.47.0: Track draft galleries created during form interaction
  onDraftGalleryCreated(event: { columnName: string; galleryId: string }) {
    this.editor?.setGalleryDraft(event.columnName, event.galleryId);
  }

  /** The coordinated create: the editor's steps, worded and run by the progress component. */
  private runSteps(steps: readonly EditorStep[]): void {
    this.saveSteps.set(steps.map(step => this.toSaveStep(step)));
    this.showSuccessModal.set(true);  // SaveProgressComponent auto-starts execution
  }

  private toSaveStep(step: EditorStep): SaveStep {
    return {
      label: this.stepLabel(step),
      execute: () => from(step.execute()).pipe(
        map(result => {
          // The record step tracks the create once the new record's id is known
          if (step.kind === 'record' && result.success && this.entityKey && this.editor?.getSnapshot().createdId != null) {
            this.analytics.trackEvent('Entity', 'Create', this.entityKey);
          }
          return this.toSaveStepResult(result);
        })
      )
    };
  }

  private stepLabel(step: EditorStep): string {
    switch (step.kind) {
      case 'record': return 'Creating record';
      case 'many_to_many': return `Adding ${step.property.display_name} (${step.addCount} to add)`;
      case 'gallery_link': return `Linking photo gallery`;
      case 'gallery_images': return 'Saving gallery images';
    }
  }

  private toSaveStepResult(result: EditorStepResult): SaveStepResult {
    const out: SaveStepResult = { success: result.success };
    if (result.failedCount !== undefined) out.failedCount = result.failedCount;
    if (result.totalCount !== undefined) out.totalCount = result.totalCount;
    const message = result.errorMessage ?? this.stepReasonMessage(result);
    if (message !== undefined) out.errorMessage = message;
    return out;
  }

  private stepReasonMessage(result: EditorStepResult): string | undefined {
    switch (result.reason) {
      case 'record_id_missing': return 'Record ID not available';
      case 'additions_failed': return `${result.failedCount} of ${result.totalCount} additions failed`;
      case 'gallery_link_failed': return 'Failed to link gallery';
      case 'gallery_images_failed': return 'Failed to save gallery images';
      default: return undefined;
    }
  }

  /** v0.47.0: Persist all buffered gallery changes across all edit-property instances */
  private async saveGalleryChanges(): Promise<boolean> {
    if (!this.editProperties) return true;
    const results = await Promise.all(
      this.editProperties
        .filter(ep => ep.galleryEditor)
        .map(ep => ep.saveGalleryChanges())
    );
    return results.every(r => r);
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
    this.navigation.goBack('/view/' + this.entityKey);
  }

  navToList(key?: string) {
    if(key) {
      this.router.navigate(['view', key], { replaceUrl: true });
    } else {
      this.router.navigate(['view', this.entityKey], { replaceUrl: true });
    }
  }

  navToDetail() {
    const createdId = this.snapshot()?.createdId;
    if (this.entityKey && createdId) {
      this.router.navigate(['view', this.entityKey, createdId], { replaceUrl: true });
    }
  }

  navToCreate(key?: string) {
    this.showSuccessModal.set(false);
    this.saveSteps.set(null);
    this.saveComplete.set(false);
    this.saveLocked.set(false);
    this.inFlight.set(null);

    // Reset the form to its defaults (boolean → false, others → null) and forget the pending changes. The editor
    // is not rebuilt: the inline M:M component keeps its selection.
    this.editor?.resetForAnother();

    // Defer scroll-to-top so it runs after the modal's unlockBodyScroll()
    // restores the previous scroll position (driven by signal effect).
    setTimeout(() => window.scrollTo({ top: 0 }));

    if (key) {
      this.router.navigate(['create', key]);
    } else {
      this.router.navigate(['create', this.entityKey]);
    }
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

  // ==========================================================================
  // GuidedForm support (v0-48-0)
  // ==========================================================================

  /**
   * Save & Continue for guided form mode.
   * Creates record, then the editor resolves the step/parent and completes the step.
   */
  public async saveAndContinue(event?: Event): Promise<void> {
    event?.preventDefault?.();

    const editor = this.editor;
    if (!editor || !this.createForm() || !this.entityKey || this.snapshot()?.saving) return;

    this.inFlight.set('continue');
    const result = await editor.saveAndContinue(() => this.refreshToken());

    this.inFlight.set(null);
    if (result.status === 'invalid') {
      this.showValidationError.set(true);
    } else if (result.status !== 'ignored') {
      this.showValidationError.set(false);
    }
    this.handleContinueResult(result);
  }

  private handleContinueResult(result: EditorContinueResult): void {
    switch (result.status) {
      case 'ignored':
        return;
      case 'invalid':
        this.scrollToFirstError();
        return;
      case 'transform_error':
        this.showTransformError(result);
        return;
      case 'aborted':
        this.showSessionExpired();
        return;
      case 'failed':
        this.currentError.set(result.error);
        this.showErrorModal.set(true);
        return;
      case 'created':
        // Non-guided-form fallback, or the context could not be loaded
        this.trackCreate();
        this.handleSaveSuccess();
        return;
      case 'step_failed': {
        this.trackCreate();
        const message = result.error.message;
        this.currentError.set({
          humanMessage: message || 'Failed to complete step.',
          message: message || 'Failed to complete step.',
          code: result.error.code,
          hint: result.error.hint
        });
        this.showErrorModal.set(true);
        return;
      }
      case 'continued': {
        this.trackCreate();
        this.analytics.trackEvent('GuidedForm', 'StepComplete', `${result.guidedFormKey}:${result.stepKey}`);
        // Completing the step makes the cached guided-form context stale
        this.guidedForm.invalidateContextForForm(result.guidedFormKey);
        const nav = result.navigation;
        if (nav.kind === 'url') {
          this.router.navigateByUrl(nav.url);
        } else if (nav.kind === 'view') {
          this.router.navigate(['/view', nav.table, nav.id]);
        } else if (nav.kind === 'edit') {
          this.router.navigate(['/edit', nav.table, nav.id]);
        }
        return;
      }
    }
  }

  private trackCreate(): void {
    if (this.entityKey) {
      this.analytics.trackEvent('Entity', 'Create', this.entityKey);
    }
  }
}
