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


import { Component, inject, ChangeDetectionStrategy, signal, ViewChildren, QueryList } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Observable, forkJoin, from, mergeMap, of, tap, map, take, catchError } from 'rxjs';
import {
  SchemaEntityProperty,
  SchemaEntityTable,
  EntityPropertyType,
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
import { SaveProgressComponent, SaveStep } from '../../components/save-progress/save-progress.component';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { DataService } from '../../services/data.service';
import { GalleryService } from '../../services/gallery.service';
import { AnalyticsService } from '../../services/analytics.service';
import { GuidedFormService } from '../../services/guided-form.service';
import { ProfileService } from '../../services/profile.service';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslationService } from '../../services/translation.service';
import { getAppTitle } from '../../config/runtime';
import { ApiError, ApiResponse } from '../../interfaces/api';
import { parseDatetimeLocal } from '../../utils/date.utils';

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
  private route = inject(ActivatedRoute);
  private schema = inject(SchemaService);
  private data = inject(DataService);
  private gallery = inject(GalleryService);
  private router = inject(Router);
  private keycloak = inject(Keycloak);
  private analytics = inject(AnalyticsService);
  private navigation = inject(NavigationService);
  private guidedForm = inject(GuidedFormService);
  private profileService = inject(ProfileService);
  private titleService = inject(Title);
  private translation = inject(TranslationService);
  public auth = inject(AuthService);

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  public entityKey?: string;
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
  public properties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(mergeMap(e => {
    if(e) {
      // Filter OUT M:M (unless inline) and File properties
      // Non-inline M:M can only be edited on Detail page after entity is created
      // v0.46.0: Inline M:M (show_inline=true) are included for buffered save
      let props = this.schema.getPropsForCreate(e)
        .pipe(
          map(props => props.filter(p =>
            (p.type !== EntityPropertyType.ManyToMany || p.show_inline === true) &&
            p.type !== EntityPropertyType.File &&
            p.type !== EntityPropertyType.FileImage &&
            p.type !== EntityPropertyType.FilePDF
          )),
          tap(props => {
            this.currentProps = props;
            this.inlineM2mProps = props.filter(p => p.type === EntityPropertyType.ManyToMany && p.show_inline === true);
            // Build form controls for non-M:M properties only
            this.createForm = new FormGroup(
              Object.fromEntries(
                props.filter(p => p.type !== EntityPropertyType.ManyToMany).map(p => {
                  const validators = SchemaService.getFormValidatorsForProperty(p);
                  const defaultValue = SchemaService.getDefaultValueForProperty(p);
                  return [
                    p.column_name,
                    new FormControl(
                      defaultValue,
                      validators
                    )
                  ];
                })
              )
            );

            // Subscribe to form status changes
            this.createForm.statusChanges.subscribe(status => {
              // Reactively hide error banner when form becomes valid
              if (status === 'VALID' && this.showValidationError) {
                this.showValidationError = false;
              }
            });

            // Apply query param defaults after form is ready
            this.route.queryParams.pipe(take(1)).subscribe(params => {
              this.applyQueryParamDefaults(params);
              this.detectGuidedFormMode(e, params);
              this.returnTo = params['returnTo'] || null;
            });
          })
        );
      return props;
    } else {
      return of([]);
    }
  }));

  /**
   * Combined renderables (properties + static text) for unified display.
   * Static text blocks are interspersed with properties based on sort_order.
   * Note: properties$ is still used for form building; this is for template display.
   * @since v0.17.0
   */
  public createRenderables$: Observable<RenderableItem[]> = this.entity$.pipe(
    mergeMap(e => e ? this.schema.getCreateRenderables(e) : of([]))
  );

  // Expose type guards to template
  protected readonly isStaticText = isStaticText;
  protected readonly isProperty = isProperty;

  public createForm?: FormGroup;
  public showValidationError = false;
  private currentProps: SchemaEntityProperty[] = [];

  // Signal-based modal state (replaces ViewChild DialogComponent)
  showSuccessModal = signal(false);
  showErrorModal = signal(false);
  currentError = signal<ApiError | undefined>(undefined);

  // Store the created record ID for navigation
  private createdRecordId?: number | string;

  // v0.46.0: Inline M:M support
  public inlineM2mProps: SchemaEntityProperty[] = [];
  public pendingM2mDiffs = signal<Map<string, { toAdd: (number|string)[], toRemove: (number|string)[] }>>(new Map());
  // v0.51.0: Rich junction diffs
  public pendingRichM2mDiffs = signal<Map<string, RichM2mDiff>>(new Map());
  public saveSteps = signal<SaveStep[] | null>(null);
  public saveComplete = signal(false);

  // v0.47.0: PhotoGallery draft tracking (column_name → gallery_id)
  public pendingGalleryDrafts = signal<Map<string, string>>(new Map());
  @ViewChildren(EditPropertyComponent) editProperties!: QueryList<EditPropertyComponent>;

  // v0.60.1: Double-submit guard
  public isSaving = signal(false);

  // v0.65.0: returnTo support — auto-navigate on success instead of showing modal
  private returnTo: string | null = null;

  // v0-48-0: Guided form mode
  public guidedFormKey = signal<string | null>(null);
  public isGuidedFormMode = signal(false);
  public savingAndContinuing = signal(false);

  submitForm(event: any) {
    event?.preventDefault?.();

    if (!this.createForm || this.isSaving()) return;

    // Check if form is valid
    if (this.createForm.invalid) {
      // Mark all fields as touched to trigger validation display
      Object.keys(this.createForm.controls).forEach(key => {
        this.createForm!.controls[key].markAsTouched();
      });

      // Show validation error banner
      this.showValidationError = true;

      // Scroll to first invalid field
      this.scrollToFirstError();

      return; // Stop submission
    }

    // Form is valid, hide error banner and proceed
    this.showValidationError = false;

    // Refresh token before submission (if expires in < 60 seconds)
    this.isSaving.set(true);
    this.keycloak.updateToken(60)
      .then(() => {
        // Token is fresh, proceed with submission
        if(this.entityKey && this.createForm) {
          const formData = this.createForm.value;

          // Transform values back to database format before submission
          const transformedData = this.transformValuesForApi(formData);

          // v0.46.0+: If there are pending M:M diffs or gallery drafts, use coordinated save pipeline
          if (this.pendingM2mDiffs().size > 0 || this.pendingRichM2mDiffs().size > 0 || this.pendingGalleryDrafts().size > 0) {
            this.executeCoordinatedCreate(transformedData);
            return;
          }

          // No M:M diffs — standard single-step create
          this.data.createData(this.entityKey, transformedData)
            .subscribe({
              next: (result) => {
                if(result.success === true) {
                  // Track successful record creation
                  if (this.entityKey) {
                    this.analytics.trackEvent('Entity', 'Create', this.entityKey);
                  }

                  // Store the created record ID for navigation
                  // PostgREST returns array with single object (Prefer: return=representation)
                  if (result.body && Array.isArray(result.body) && result.body.length > 0) {
                    this.createdRecordId = result.body[0].id;
                  }

                  this.handleSaveSuccess();
                } else {
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
                  this.isSaving.set(false);
                }
              },
              error: (err) => {
                console.error('Unexpected error during create:', err);
                this.currentError.set({
                  httpCode: 500,
                  message: 'An unexpected error occurred',
                  humanMessage: 'System Error'
                });
                this.showErrorModal.set(true);
                this.isSaving.set(false);
              }
            });
        }
      })
      .catch((error) => {
        // Token refresh failed - session expired
        this.currentError.set({
          httpCode: 401,
          message: "Session expired",
          humanMessage: "Session Expired",
          hint: "Your login session has expired. Please refresh the page to log in again."
        });
        this.showErrorModal.set(true);
        this.isSaving.set(false);
      });
  }

  // --- v0.46.0: Inline M:M methods ---

  onM2mDiffChanged(columnName: string, diff: { toAdd: (number | string)[], toRemove: (number | string)[] }) {
    this.pendingM2mDiffs.update(m => {
      const next = new Map(m);
      if (diff.toAdd.length === 0 && diff.toRemove.length === 0) {
        next.delete(columnName);
      } else {
        next.set(columnName, diff);
      }
      return next;
    });
  }

  // v0.51.0: Handle rich junction diff from inline editor
  onRichM2mDiffChanged(columnName: string, diff: RichM2mDiff) {
    this.pendingRichM2mDiffs.update(m => {
      const next = new Map(m);
      if (diff.toAdd.length === 0 && diff.toRemove.length === 0 && diff.toUpdate.length === 0) {
        next.delete(columnName);
      } else {
        next.set(columnName, diff);
      }
      return next;
    });
  }

  onSaveComplete() {
    this.saveComplete.set(true);
    this.isSaving.set(false);
    this.pendingM2mDiffs.set(new Map());
    this.pendingRichM2mDiffs.set(new Map());
    this.pendingGalleryDrafts.set(new Map());
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
    this.pendingGalleryDrafts.update(m => {
      const next = new Map(m);
      next.set(event.columnName, event.galleryId);
      return next;
    });
  }

  private executeCoordinatedCreate(transformedData: any): void {
    const steps: SaveStep[] = [];

    // Step 1: Entity POST — captures createdRecordId for M:M steps
    steps.push({
      label: 'Creating record',
      execute: () => this.data.createData(this.entityKey!, transformedData).pipe(
        map(result => {
          if (result.success === true && result.body?.[0]?.id) {
            this.createdRecordId = result.body[0].id;
            if (this.entityKey) {
              this.analytics.trackEvent('Entity', 'Create', this.entityKey);
            }
          }
          return {
            success: result.success === true,
            errorMessage: result.error?.humanMessage || result.error?.message
          };
        })
      )
    });

    // Step 2+: M:M mutations using createdRecordId
    const diffs = this.pendingM2mDiffs();
    for (const [columnName, diff] of diffs) {
      const prop = this.inlineM2mProps.find(p => p.column_name === columnName);
      if (!prop?.many_to_many_meta) continue;

      const meta = prop.many_to_many_meta;
      // On create, there are only additions (no existing relations to remove)
      const label = `Adding ${prop.display_name} (${diff.toAdd.length} to add)`;

      steps.push({
        label,
        execute: () => {
          if (!this.createdRecordId) return of({ success: false, errorMessage: 'Record ID not available' });
          const ops: Observable<ApiResponse>[] = diff.toAdd.map(id =>
            this.data.addManyToManyRelation(this.createdRecordId!, meta, id)
          );
          if (ops.length === 0) return of({ success: true });
          return forkJoin(ops).pipe(
            map(results => {
              const failed = results.filter(r => !r.success).length;
              return {
                success: failed === 0,
                failedCount: failed,
                totalCount: results.length,
                errorMessage: failed > 0 ? `${failed} of ${results.length} additions failed` : undefined
              };
            })
          );
        }
      });
    }

    // v0.51.0: Rich junction M:M mutations using createdRecordId
    const richDiffs = this.pendingRichM2mDiffs();
    for (const [columnName, diff] of richDiffs) {
      const prop = this.inlineM2mProps.find(p => p.column_name === columnName);
      if (!prop?.many_to_many_meta) continue;

      const meta = prop.many_to_many_meta;
      const label = `Adding ${prop.display_name} (${diff.toAdd.length} to add)`;

      steps.push({
        label,
        execute: () => {
          if (!this.createdRecordId) return of({ success: false, errorMessage: 'Record ID not available' });
          const ops: Observable<ApiResponse>[] = diff.toAdd.map(item =>
            this.data.addManyToManyRelation(this.createdRecordId!, meta, item.id, item.extraData)
          );
          if (ops.length === 0) return of({ success: true });
          return forkJoin(ops).pipe(
            map(results => {
              const failed = results.filter(r => !r.success).length;
              return {
                success: failed === 0,
                failedCount: failed,
                totalCount: results.length,
                errorMessage: failed > 0 ? `${failed} of ${results.length} additions failed` : undefined
              };
            })
          );
        }
      });
    }

    // v0.47.0: Gallery link steps — link draft galleries to newly created entity
    const galleryDrafts = this.pendingGalleryDrafts();
    for (const [columnName, galleryId] of galleryDrafts) {
      steps.push({
        label: `Linking photo gallery`,
        execute: () => {
          if (!this.createdRecordId) return of({ success: false, errorMessage: 'Record ID not available' });
          return this.gallery.linkGalleryToEntity(
            galleryId,
            this.entityKey!,
            String(this.createdRecordId),
            columnName
          ).pipe(
            map(() => ({ success: true })),
            catchError(err => of({
              success: false,
              errorMessage: err?.error?.message || 'Failed to link gallery'
            }))
          );
        }
      });
    }

    // v0.47.0: Persist buffered gallery junction rows (adds/removes/reorder)
    if (galleryDrafts.size > 0) {
      steps.push({
        label: 'Saving gallery images',
        execute: () => from(this.saveGalleryChanges()).pipe(
          map(allOk => ({
            success: allOk,
            errorMessage: allOk ? undefined : 'Failed to save gallery images'
          }))
        )
      });
    }

    this.saveSteps.set(steps);
    this.showSuccessModal.set(true);  // SaveProgressComponent auto-starts execution
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
    if (this.entityKey && this.createdRecordId) {
      this.router.navigate(['view', this.entityKey, this.createdRecordId], { replaceUrl: true });
    }
  }

  navToCreate(key?: string) {
    this.showSuccessModal.set(false);
    this.saveSteps.set(null);
    this.saveComplete.set(false);
    this.isSaving.set(false);
    this.pendingM2mDiffs.set(new Map());
    this.pendingRichM2mDiffs.set(new Map());
    this.pendingGalleryDrafts.set(new Map());

    // Reset form with proper defaults (boolean → false, others → null)
    // FormGroup.reset() without args sets all controls to null, which breaks
    // boolean fields (null instead of false) and hits NOT NULL constraints.
    if (this.createForm && this.currentProps.length > 0) {
      const defaults: Record<string, any> = {};
      this.currentProps.forEach(p => {
        defaults[p.column_name] = SchemaService.getDefaultValueForProperty(p);
      });
      this.createForm.reset(defaults);
    }

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

  /**
   * Apply query parameter values as defaults to form controls.
   * Only sets values for fields that are currently empty.
   *
   * Use Cases:
   * - Pre-fill foreign key when creating from Detail page: ?resource_id=5
   * - Pre-fill time slot from calendar selection: ?time_slot=[start,end)
   * - Pre-fill multiple fields: ?resource_id=5&status=pending
   *
   * Behavior:
   * - Fields remain editable (no special UI treatment)
   * - markAsTouched() triggers validation immediately
   * - Invalid param names are silently ignored
   * - Invalid param values are caught by standard validation
   */
  private applyQueryParamDefaults(params: Params): void {
    if (!this.createForm) return;

    Object.keys(params).forEach(paramKey => {
      const control = this.createForm!.get(paramKey);
      if (control && !control.value) {
        // Only set if field is currently empty
        control.setValue(params[paramKey]);
        control.markAsTouched(); // Trigger validation display
      }
    });
  }

  /**
   * TIMEZONE-SENSITIVE CODE: Submit-time transformation for datetime fields
   *
   * This method transforms form values back to PostgreSQL-compatible formats:
   *
   * 1. DateTime (timestamp without time zone):
   *    - User enters "wall clock" time (e.g., "10:30")
   *    - Transformation: Add ":00" seconds → "2025-01-15T10:30:00"
   *    - PostgreSQL stores exactly as-is (no timezone conversion)
   *    - Result: Same wall clock time in database as user entered
   *
   * 2. DateTimeLocal (timestamptz):
   *    - User enters time in THEIR local timezone (e.g., "17:30" in EST)
   *    - Transformation: Convert to UTC with "Z" suffix → "2025-01-15T22:30:00.000Z"
   *    - PostgreSQL stores in UTC (internally converts and strips the Z)
   *    - Result: Absolute point in time preserved regardless of user's timezone
   *
   * CRITICAL: DateTimeLocal MUST be converted to UTC before sending to PostgreSQL.
   * The datetime-local input gives us a string like "2025-01-15T17:30" which represents
   * the time in the user's local timezone. We must interpret this as local time and
   * convert to UTC. Do NOT just add seconds - that would send local time as if it were UTC.
   *
   * Example: User in EST creates record at "5:30 PM" on Jan 15, 2025
   * - Input string: "2025-01-15T17:30"
   * - Interpret as: 5:30 PM EST = 10:30 PM UTC
   * - Send to database: "2025-01-15T22:30:00.000Z"
   * - Database stores: 2025-01-15 22:30:00+00 (10:30 PM UTC)
   *
   * WARNING: Timezone bugs here affect data integrity. Test with multiple timezones.
   */
  private transformValuesForApi(formData: any): any {
    const transformed = { ...formData };

    // Transform values back to database format for each property
    this.currentProps.forEach(prop => {
      const value = transformed[prop.column_name];
      if (value === null || value === undefined) return;

      // DateTime (timestamp without time zone): Add seconds, no timezone conversion
      if (prop.type === EntityPropertyType.DateTime) {
        if (typeof value === 'string') {
          // Input gives us: "2025-01-15T10:30" (local wall clock time)
          // PostgreSQL expects: "2025-01-15T10:30:00" (with seconds, no timezone)
          if (value.length === 16) {
            transformed[prop.column_name] = value + ':00';
          }
        }
      }

      // DateTimeLocal (timestamptz): Convert local time to UTC ISO format
      if (prop.type === EntityPropertyType.DateTimeLocal) {
        if (typeof value === 'string') {
          // Input gives us: "2025-01-15T17:30" (time in user's local timezone)
          // PostgreSQL expects: ISO string with timezone (e.g., "2025-01-15T22:30:00.000Z")
          if (value.length === 16) {
            // Interpret input string as LOCAL time, then convert to UTC
            // Use Safari-safe parsing for datetime-local strings
            const localDate = parseDatetimeLocal(value);
            if (localDate) {
              const utcISO = localDate.toISOString(); // Converts to UTC with .000Z format
              transformed[prop.column_name] = utcISO;
            }
          }
        }
      }

      // Money: Keep as number, PostgREST accepts numeric values for money type

      // PhotoGallery: gallery FK is managed by link_gallery_to_entity RPC in coordinated save.
      // Remove from POST data — entity is created with FK=null, then gallery is linked via RPC.
      if (prop.type === EntityPropertyType.PhotoGallery) {
        delete transformed[prop.column_name];
      }
    });

    // Remove audit fields AFTER transformation (managed by database triggers)
    // BUT only if they're NOT in currentProps (i.e., they're read-only metadata, not user-editable fields)
    const editableColumns = new Set(this.currentProps.map(p => p.column_name));
    if (!editableColumns.has('created_at')) {
      delete transformed.created_at;
    }
    if (!editableColumns.has('updated_at')) {
      delete transformed.updated_at;
    }

    return transformed;
  }

  // ==========================================================================
  // GuidedForm support (v0-48-0)
  // ==========================================================================

  /**
   * Detect guided form mode from entity metadata.
   * Parent ID and step resolution are deferred to loadContext() after record creation.
   */
  private detectGuidedFormMode(entity: SchemaEntityTable, _params: Params): void {
    const key = entity.guided_form_key;
    if (!key) {
      this.guidedFormKey.set(null);
      this.isGuidedFormMode.set(false);
      return;
    }

    this.guidedFormKey.set(key);
    this.isGuidedFormMode.set(true);
  }

  /**
   * Save & Continue for guided form mode.
   * Creates record, loads context to resolve step/parent, then completes the step.
   */
  public saveAndContinue(event?: Event): void {
    event?.preventDefault?.();

    if (!this.createForm || !this.entityKey) return;

    if (this.createForm.invalid) {
      Object.keys(this.createForm.controls).forEach(key => {
        this.createForm!.controls[key].markAsTouched();
      });
      this.showValidationError = true;
      this.scrollToFirstError();
      return;
    }

    this.showValidationError = false;
    this.savingAndContinuing.set(true);

    const formData = this.createForm.value;
    const transformedData = this.transformValuesForApi(formData);

    this.keycloak.updateToken(60)
      .then(() => {
        this.data.createData(this.entityKey!, transformedData).subscribe({
          next: (result) => {
            if (!result.success) {
              this.savingAndContinuing.set(false);
              this.currentError.set(result.error);
              this.showErrorModal.set(true);
              return;
            }

            const recordId = result.body?.[0]?.id;
            if (this.entityKey) {
              this.analytics.trackEvent('Entity', 'Create', this.entityKey);
            }

            const wk = this.guidedFormKey();
            if (!wk || !recordId) {
              // Non-guided-form fallback
              this.savingAndContinuing.set(false);
              this.createdRecordId = recordId;
              this.handleSaveSuccess();
              return;
            }

            // Load context to resolve step_key and parent_id server-side
            this.guidedForm.loadContext(wk, this.entityKey!, recordId).subscribe({
              next: (ctx) => {
                const stepKey = ctx.step_key || '__parent__';
                const parentId = String(ctx.parent_id);

                this.guidedForm.completeStep(wk, parentId, stepKey).subscribe({
                  next: (completeResult) => {
                    this.analytics.trackEvent('GuidedForm', 'StepComplete', `${wk}:${stepKey}`);

                    // Backend auto-submitted (all non-parent steps were condition-skipped)
                    if (completeResult.auto_submitted) {
                      this.savingAndContinuing.set(false);
                      if (completeResult.navigate_to) {
                        this.router.navigateByUrl(completeResult.navigate_to);
                      } else {
                        this.router.navigate(['/view', ctx.definition.parent_table, parentId]);
                      }
                      return;
                    }

                    // RPC returns next step info directly
                    this.savingAndContinuing.set(false);
                    if (completeResult.next_record_id && completeResult.next_step_table) {
                      this.router.navigate(['/edit', completeResult.next_step_table, completeResult.next_record_id]);
                    } else if (completeResult.all_data_steps_complete) {
                      this.router.navigate(['/view', ctx.definition.parent_table, parentId]);
                    }
                  },
                  error: (err) => {
                    this.savingAndContinuing.set(false);
                    const apiError = err?.error || {};
                    this.currentError.set({
                      humanMessage: apiError.message || 'Failed to complete step.',
                      message: apiError.message || err.message,
                      code: apiError.code,
                      hint: apiError.hint
                    });
                    this.showErrorModal.set(true);
                  }
                });
              },
              error: () => {
                // Context load failed — fall back
                this.savingAndContinuing.set(false);
                this.createdRecordId = recordId;
                this.handleSaveSuccess();
              }
            });
          },
          error: (err) => {
            this.savingAndContinuing.set(false);
            console.error('Unexpected error during create:', err);
            this.currentError.set({
              httpCode: 500,
              message: 'An unexpected error occurred',
              humanMessage: 'System Error'
            });
            this.showErrorModal.set(true);
          }
        });
      })
      .catch(() => {
        this.savingAndContinuing.set(false);
        this.currentError.set({
          httpCode: 401,
          message: 'Session expired',
          humanMessage: 'Session Expired',
          hint: 'Your login session has expired. Please refresh the page to log in again.'
        });
        this.showErrorModal.set(true);
      });
  }
}
