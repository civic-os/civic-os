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


import { Component, inject, signal, computed, effect, ChangeDetectionStrategy, ViewChildren, QueryList, OnDestroy } from '@angular/core';
import { SchemaService } from '../../services/schema.service';
import { Observable, forkJoin, from, map, mergeMap, of, tap, take, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { DataService } from '../../services/data.service';
import { AuthService } from '../../services/auth.service';
import { NavigationService } from '../../services/navigation.service';
import { RecurringService } from '../../services/recurring.service';
import {
  SchemaEntityProperty,
  SchemaEntityTable,
  EntityPropertyType,
  RenderableItem,
  isStaticText,
  isProperty,
  SeriesMembership,
  SeriesEditScope
} from '../../interfaces/entity';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { GuidedFormNavComponent } from '../../components/guided-form-nav/guided-form-nav.component';
import { ApiError, ApiResponse } from '../../interfaces/api';
import Keycloak from 'keycloak-js';
import { GuidedFormService } from '../../services/guided-form.service';
import { GuidedFormContext } from '../../interfaces/guided-form';

import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { EditPropertyComponent } from '../../components/edit-property/edit-property.component';
import { EmptyStateComponent } from '../../components/empty-state/empty-state.component';
import { StaticTextComponent } from '../../components/static-text/static-text.component';
import { ExceptionEditorComponent, ExceptionEditorResult } from '../../components/exception-editor/exception-editor.component';
import { InlineM2mEditorComponent } from '../../components/inline-m2m-editor/inline-m2m-editor.component';
import { RichM2mDiff } from '../../components/fk-search-modal/fk-search-modal.component';
import { SaveProgressComponent, SaveStep } from '../../components/save-progress/save-progress.component';
import { AnalyticsService } from '../../services/analytics.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { CommonModule } from '@angular/common';
import { parseDatetimeLocal } from '../../utils/date.utils';

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
    TranslatePipe
],
    templateUrl: './edit.page.html',
    styleUrl: './edit.page.css'
})
export class EditPage implements OnDestroy {
  private route = inject(ActivatedRoute);
  private schema = inject(SchemaService);
  private data = inject(DataService);
  private router = inject(Router);
  private keycloak = inject(Keycloak);
  private analytics = inject(AnalyticsService);
  private recurringService = inject(RecurringService);
  private navigation = inject(NavigationService);
  public auth = inject(AuthService);

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  public entityKey?: string;
  public entityId?: string;
  public currentEntity?: SchemaEntityTable;
  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(mergeMap(p => {
    this.entityKey = p['entityKey'];
    this.entityId = p['entityId'];
    if(p['entityKey'] && p['entityId']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined);
    }
  }), tap(entity => {
    this.currentEntity = entity;
  }));
  public properties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(mergeMap(e => {
    if(e) {
      // Filter OUT M:M properties UNLESS they are inline (show_inline=true, v0.46.0)
      // Non-inline M:M can only be edited on Detail page
      return this.schema.getPropsForEdit(e)
        .pipe(
          map(props => props.filter(p => p.type !== EntityPropertyType.ManyToMany || p.show_inline === true)),
          tap(props => {
            // Properties loaded for edit form
            this.currentProps = props;
            // Track inline M:M properties separately for save pipeline
            this.inlineM2mProps = props.filter(p => p.type === EntityPropertyType.ManyToMany && p.show_inline === true);
          })
        );
    } else {
      return of([]);
    }
  }));
  public data$: Observable<any> = this.properties$.pipe(
    tap((props) => {
      this.dataLoading.set(true);
      this.loading.set(true);
    }),  // Set loading state at start
    mergeMap(props => {
      if(props && props.length > 0 && this.entityKey) {
        let columns = props
          .map(x => SchemaService.propertyToSelectStringForEdit(x));
        // status_id is silently added by ensureStructuralProps() for draft/complete detection
        // Note: parent FK column inclusion for child steps is no longer needed here —
        // get_guided_form_context() RPC resolves parent ID server-side.
        return this.data.getData({key: this.entityKey, entityId: this.entityId, fields: columns})
          .pipe(map(x => x[0]));
      } else {
        this.dataLoading.set(false);  // Clear loading if no data to fetch
        return of(undefined);
      }
    }),
    tap(data => {
      // Data loaded for edit form
      if (data && this.currentProps.length > 0) {
        // Cache entity data for inline M:M rendering.
        // Transform M:M junction data to flat arrays (same as Detail page).
        this.currentData = { ...data };
        this.inlineM2mProps.forEach(p => {
          if (p.many_to_many_meta) {
            const junctionData = (this.currentData as any)[p.column_name] || [];
            // v0.51.0: Pass extra column names for rich junction _junction data
            const extraColNames = p.many_to_many_meta.extraColumns.map(c => c.column_name);
            (this.currentData as any)[p.column_name] = DataService.transformManyToManyData(
              junctionData, p.many_to_many_meta.relatedTable,
              extraColNames.length > 0 ? extraColNames : undefined,
              p.many_to_many_meta.parentHops,
              p.many_to_many_meta.parentHops?.length ? p.many_to_many_meta.targetTable : undefined
            );
          }
        });

        // Create form with actual data values, not defaults
        // Inline M:M properties are in currentProps but excluded from form controls
        // (they use InlineM2mEditorComponent, not form inputs)
        const formConfig = Object.fromEntries(
          this.currentProps.filter(p => p.show_on_edit !== false && p.type !== EntityPropertyType.ManyToMany).map(p => [
            p.column_name,
            new FormControl(
              this.transformValueForControl(p, (data as any)[p.column_name]),
              SchemaService.getFormValidatorsForProperty(p)
            )
          ])
        );

        this.editForm = new FormGroup(formConfig);

        // Subscribe to form status changes to reactively hide error banner
        // Clean up previous subscription to prevent leaks when data reloads
        this.statusChangesSub?.unsubscribe();
        this.statusChangesSub = this.editForm.statusChanges.subscribe(status => {
          if (status === 'VALID' && this.showValidationError()) {
            this.showValidationError.set(false);
          }
        });

        // Check if this entity is part of a recurring series
        this.checkSeriesMembership();

        // Guided form mode: trigger context loading (handled by guidedFormContextEffect)
        this.initGuidedFormMode(this.currentEntity, data);
      }
      this.loading.set(false);  // Clear loading state after data loads
      this.dataLoading.set(false);  // Clear data loading state
    }),

  );

  /**
   * Combined renderables (properties + static text) for unified display.
   * Static text blocks are interspersed with properties based on sort_order.
   * Note: properties$ is still used for form building; this is for template display.
   * @since v0.17.0
   */
  public editRenderables$: Observable<RenderableItem[]> = this.entity$.pipe(
    mergeMap(e => e ? this.schema.getEditRenderables(e) : of([]))
  );

  // Expose type guards to template
  protected readonly isStaticText = isStaticText;
  protected readonly isProperty = isProperty;

  public editForm?: FormGroup;
  public loading = signal(true);
  public dataLoading = signal(true);  // Track data fetch state
  public showValidationError = signal(false);
  private currentProps: SchemaEntityProperty[] = [];

  // v0.47.0: Gallery editors for deferred reorder save
  @ViewChildren(EditPropertyComponent) editProperties!: QueryList<EditPropertyComponent>;

  // v0.46.0: Inline M:M support
  public inlineM2mProps: SchemaEntityProperty[] = [];
  public pendingM2mDiffs = signal<Map<string, { toAdd: (number|string)[], toRemove: (number|string)[] }>>(new Map());
  // v0.51.0: Rich junction diffs (with extraData for adds/updates)
  public pendingRichM2mDiffs = signal<Map<string, RichM2mDiff>>(new Map());
  public saveSteps = signal<SaveStep[] | null>(null);
  public saveComplete = signal(false);
  public currentData: any = null;  // Cached entity data for M:M rendering
  public displayData = signal<any>(null);  // Rich display data for completed step display mode

  private saveStartTime = 0;  // Timestamp for minimum display duration
  private statusChangesSub?: Subscription;  // Track statusChanges subscription for cleanup

  // v0.60.1: Double-submit guard
  public isSaving = signal(false);

  // Series membership (for recurring time slots)
  public seriesMembership = signal<SeriesMembership | undefined>(undefined);
  public showScopeDialog = signal(false);
  private pendingFormData: any = null;

  // Signal-based modal state (replaces ViewChild DialogComponent)
  showSuccessModal = signal(false);
  showErrorModal = signal(false);
  currentError = signal<ApiError | undefined>(undefined);

  ngOnDestroy(): void {
    this.cancelAutoSave();
    this.statusChangesSub?.unsubscribe();
  }

  submitForm(event: any) {
    event?.preventDefault?.();

    const form = this.editForm;
    if (!form || this.isSaving()) return;

    // Guided form drafts: save without required validation.
    // Database CHECK constraints enforce rules only when status transitions out of draft.
    if (this.isGuidedFormDraft()) {
      this.cancelAutoSave();
      this.showValidationError.set(false);
      const formData = form.value;
      const transformedData = this.transformValuesForApi(formData);
      this.performEdit(transformedData);
      return;
    }

    // Check if form is valid
    if (form.invalid) {
      // Mark all fields as touched to trigger validation display
      Object.keys(form.controls).forEach(key => {
        form.controls[key].markAsTouched();
      });

      // Show validation error banner
      this.showValidationError.set(true);

      // Scroll to first invalid field
      this.scrollToFirstError();

      return; // Stop submission
    }

    // Form is valid, hide error banner and proceed
    this.cancelAutoSave();
    this.showValidationError.set(false);

    // Transform values for API
    const formData = form.value;
    const transformedData = this.transformValuesForApi(formData);

    // Check if this is a series member - show scope dialog
    const membership = this.seriesMembership();
    if (membership?.is_member) {
      this.pendingFormData = transformedData;
      this.showScopeDialog.set(true);
      return;
    }

    // Not a series member - proceed with normal edit
    this.performEdit(transformedData);
  }

  /**
   * Handle scope selection from ExceptionEditorComponent.
   * Called when user selects scope for series member edit.
   */
  onScopeConfirm(result: ExceptionEditorResult): void {
    this.showScopeDialog.set(false);

    if (!this.pendingFormData || !this.entityKey || !this.entityId) return;

    const membership = this.seriesMembership();
    if (!membership) return;

    switch (result.scope) {
      case 'this_only':
        // Edit just this occurrence (normal edit - it becomes an exception)
        this.performEdit(this.pendingFormData);
        break;

      case 'this_and_future':
        // Split series and apply changes to new version
        this.performSeriesSplit(membership, this.pendingFormData);
        break;

      case 'all':
        // Update series template (propagate to all non-exception instances)
        this.performSeriesTemplateUpdate(membership, this.pendingFormData);
        break;
    }

    this.pendingFormData = null;
  }

  /**
   * Cancel scope selection.
   */
  onScopeCancel(): void {
    this.showScopeDialog.set(false);
    this.pendingFormData = null;
  }

  /**
   * Perform standard edit operation.
   */
  private performEdit(transformedData: any): void {
    // Refresh token before submission (if expires in < 60 seconds)
    this.isSaving.set(true);
    this.keycloak.updateToken(60)
      .then(() => {
        // Token is fresh, proceed with submission
        if(this.entityKey && this.entityId) {
          // v0.46.0+: If there are pending M:M diffs or gallery changes, use coordinated save
          if (this.hasM2mDiffs() || this.hasGalleryChanges()) {
            this.executeCoordinatedSave(transformedData);
            return;
          }

          // No multi-step changes — standard single-step edit
          this.data.editData(this.entityKey, this.entityId, transformedData)
            .subscribe({
              next: async (result) => {
                if(result.success === true) {
                  // Track successful record edit
                  if (this.entityKey) {
                    this.analytics.trackEvent('Entity', 'Edit', this.entityKey);
                  }

                  // Guided form draft: navigate to detail page instead of success modal
                  if (this.isGuidedFormDraft()) {
                    const ctx = this.guidedFormContext();
                    const pid = this.guidedFormParentId();
                    if (ctx && pid) {
                      this.isSaving.set(false);
                      this.router.navigate(['/view', ctx.definition.parent_table, pid]);
                      return;
                    }
                  }

                  // Completed step edit: switch back to display mode on successful save
                  if (this.isEditingCompletedStep()) {
                    this.isEditingCompletedStep.set(false);
                    this.isSaving.set(false);
                    // Re-fetch display data with embedded objects to show updated values
                    if (this.entityKey && this.currentProps.length > 0) {
                      const displayColumns = this.currentProps.map(p => SchemaService.propertyToSelectString(p));
                      this.data.getData({ key: this.entityKey, entityId: this.entityId, fields: displayColumns })
                        .pipe(take(1))
                        .subscribe(rows => {
                          if (rows?.[0]) this.displayData.set(rows[0]);
                        });
                    }
                    return;
                  }

                  this.isSaving.set(false);
                  this.showSuccessModal.set(true);
                } else {
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
                  this.isSaving.set(false);
                }
              },
              error: (err) => {
                console.error('Unexpected error during edit:', err);
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

  /**
   * Split series at current occurrence and apply changes to new version.
   * Used for "this and future" scope.
   */
  private performSeriesSplit(membership: SeriesMembership, formData: any): void {
    if (!membership.series_id || !membership.occurrence_date) {
      // Fall back to normal edit
      this.performEdit(formData);
      return;
    }

    // First, edit this occurrence
    this.performEdit(formData);

    // Then split the series (this happens async)
    this.recurringService.splitSeries({
      seriesId: membership.series_id,
      splitDate: membership.occurrence_date,
      newDtstart: formData.time_slot ? this.extractStartFromTimeSlot(formData.time_slot) : membership.occurrence_date,
      newTemplate: formData
    }).subscribe({
      next: (result) => {
        if (!result.success) {
          console.warn('Series split completed with warning:', result.message);
        }
      },
      error: (err) => {
        console.error('Error splitting series:', err);
      }
    });
  }

  /**
   * Update series template (propagate to all non-exception instances).
   * Used for "all" scope.
   */
  private performSeriesTemplateUpdate(membership: SeriesMembership, formData: any): void {
    if (!membership.series_id) {
      // Fall back to normal edit
      this.performEdit(formData);
      return;
    }

    this.keycloak.updateToken(60)
      .then(() => {
        this.recurringService.updateSeriesTemplate(membership.series_id!, formData)
          .subscribe({
            next: (result) => {
              if (result.success !== false) {
                // Track successful series edit
                if (this.entityKey) {
                  this.analytics.trackEvent('Entity', 'EditSeriesAll', this.entityKey);
                }

                this.showSuccessModal.set(true);
              } else {
                console.error('[SERIES UPDATE] API returned error:', result.message);
                this.currentError.set({
                  httpCode: 400,
                  message: result.message || 'Failed to update series',
                  humanMessage: 'Series Update Failed'
                });
                this.showErrorModal.set(true);
              }
            },
            error: (err) => {
              console.error('Error updating series template:', err);
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
        this.currentError.set({
          httpCode: 401,
          message: "Session expired",
          humanMessage: "Session Expired",
          hint: "Your login session has expired. Please refresh the page to log in again."
        });
        this.showErrorModal.set(true);
      });
  }

  /**
   * Check if this entity is part of a recurring series.
   */
  private checkSeriesMembership(): void {
    if (!this.entityKey || !this.entityId) return;

    // Check if entity has a time_slot property (could be recurring)
    const hasTimeSlot = this.currentProps.some(p =>
      p.type === EntityPropertyType.TimeSlot ||
      p.type === EntityPropertyType.RecurringTimeSlot
    );

    if (!hasTimeSlot) return;

    this.recurringService.getSeriesMembership(this.entityKey, this.entityId)
      .subscribe({
        next: (membership) => {
          this.seriesMembership.set(membership);
        },
        error: () => {
          // Silent fail - membership check is optional
          this.seriesMembership.set(undefined);
        }
      });
  }

  /**
   * Extract start timestamp from time_slot range.
   */
  private extractStartFromTimeSlot(timeSlot: string): string {
    const match = timeSlot.match(/[\[\(](.+?),/);
    if (match) {
      return match[1].trim();
    }
    return new Date().toISOString();
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
    if (this.entityKey) {
      this.analytics.trackEvent('Entity', 'Edit', this.entityKey);
    }
  }

  private hasM2mDiffs(): boolean {
    return this.pendingM2mDiffs().size > 0 || this.pendingRichM2mDiffs().size > 0;
  }

  private hasGalleryChanges(): boolean {
    if (!this.editProperties) return false;
    return this.editProperties.some(ep => ep.galleryEditor?.hasPendingChanges() === true);
  }

  private executeCoordinatedSave(transformedData: any): void {
    const steps: SaveStep[] = [];

    // Step 1: Entity PATCH
    steps.push({
      label: 'Saving record',
      execute: () => this.data.editData(this.entityKey!, this.entityId!, transformedData).pipe(
        map(result => ({
          success: result.success === true,
          errorMessage: result.error?.humanMessage || result.error?.message
        }))
      )
    });

    // Step 2+: One step per inline M:M with pending changes
    const diffs = this.pendingM2mDiffs();
    for (const [columnName, diff] of diffs) {
      const prop = this.inlineM2mProps.find(p => p.column_name === columnName);
      if (!prop?.many_to_many_meta) continue;

      const meta = prop.many_to_many_meta;
      const label = `Updating ${prop.display_name} (${diff.toAdd.length} to add, ${diff.toRemove.length} to remove)`;

      steps.push({
        label,
        execute: () => {
          const ops: Observable<ApiResponse>[] = [
            ...diff.toRemove.map(id => this.data.removeManyToManyRelation(this.entityId!, meta, id)),
            ...diff.toAdd.map(id => this.data.addManyToManyRelation(this.entityId!, meta, id))
          ];
          if (ops.length === 0) return of({ success: true });
          return forkJoin(ops).pipe(
            map(results => {
              const failed = results.filter(r => !r.success).length;
              return {
                success: failed === 0,
                failedCount: failed,
                totalCount: results.length,
                errorMessage: failed > 0 ? `${failed} of ${results.length} changes failed` : undefined
              };
            })
          );
        }
      });
    }

    // v0.51.0: Rich junction M:M diffs (with extraData for adds/updates)
    const richDiffs = this.pendingRichM2mDiffs();
    for (const [columnName, diff] of richDiffs) {
      const prop = this.inlineM2mProps.find(p => p.column_name === columnName);
      if (!prop?.many_to_many_meta) continue;

      const meta = prop.many_to_many_meta;
      const totalOps = diff.toAdd.length + diff.toRemove.length + diff.toUpdate.length;
      const label = `Updating ${prop.display_name} (${totalOps} changes)`;

      steps.push({
        label,
        execute: () => {
          const ops: Observable<ApiResponse>[] = [
            ...diff.toRemove.map(id => this.data.removeManyToManyRelation(this.entityId!, meta, id)),
            ...diff.toAdd.map(item => this.data.addManyToManyRelation(this.entityId!, meta, item.id, item.extraData)),
            ...diff.toUpdate.map(item => this.data.updateManyToManyRelation(this.entityId!, meta, item.id, item.extraData))
          ];
          if (ops.length === 0) return of({ success: true });
          return forkJoin(ops).pipe(
            map(results => {
              const failed = results.filter(r => !r.success).length;
              return {
                success: failed === 0,
                failedCount: failed,
                totalCount: results.length,
                errorMessage: failed > 0 ? `${failed} of ${results.length} changes failed` : undefined
              };
            })
          );
        }
      });
    }

    // v0.47.0: Add gallery save step if any editors have pending changes
    const galleryEditors = this.editProperties?.filter(ep => ep.galleryEditor) || [];
    if (galleryEditors.length > 0) {
      steps.push({
        label: 'Saving gallery changes',
        execute: () => from(this.saveGalleryChanges()).pipe(
          map(allOk => ({
            success: allOk,
            errorMessage: allOk ? undefined : 'Failed to save gallery changes'
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
   * TIMEZONE-SENSITIVE CODE: Load-time transformation for datetime fields
   *
   * This method handles two distinct timestamp types from PostgreSQL:
   *
   * 1. DateTime (timestamp without time zone):
   *    - Stores "wall clock" time without timezone context
   *    - Example: "2025-01-15T10:30:00" means 10:30 regardless of timezone
   *    - Transformation: Strip timezone suffix (if any), truncate to HH:MM format
   *    - User sees exactly what's stored in the database
   *
   * 2. DateTimeLocal (timestamptz):
   *    - Stores absolute point in time (always in UTC internally)
   *    - Example: "2025-01-15T10:30:00+00:00" = 10:30 UTC = 5:30 AM EST = 2:30 AM PST
   *    - Transformation: Convert UTC → User's local timezone for display
   *    - User sees the time in THEIR timezone, not UTC
   *
   * CRITICAL: The datetime-local input type expects a string like "2025-01-15T10:30"
   * in the USER'S LOCAL TIMEZONE. Do not just strip the timezone - that would show
   * UTC time as if it were local time, causing incorrect displays.
   *
   * WARNING: Modifying this code can cause timezone bugs. Always test with users
   * in different timezones (EST, PST, UTC) before deploying changes.
   */
  private transformValueForControl(prop: SchemaEntityProperty, rawValue: any): any {
    if (rawValue === null || rawValue === undefined) return rawValue;

    // DateTime (timestamp without time zone): Just format for input, no timezone conversion
    if (prop.type === EntityPropertyType.DateTime) {
      if (typeof rawValue === 'string') {
        // PostgreSQL may return: "2025-01-15T10:30:00" (no timezone)
        // datetime-local input needs: "2025-01-15T10:30"
        return rawValue.substring(0, 16);
      }
    }

    // DateTimeLocal (timestamptz): Convert UTC to user's local timezone
    if (prop.type === EntityPropertyType.DateTimeLocal) {
      if (typeof rawValue === 'string') {
        // PostgreSQL returns: "2025-01-15T10:30:00+00:00" or "2025-01-15T10:30:00.000Z" (UTC)
        // Parse as UTC, then convert to local time for display
        const utcDate = new Date(rawValue); // Parses as UTC
        // Format as local time for datetime-local input (YYYY-MM-DDTHH:MM)
        const year = utcDate.getFullYear();
        const month = String(utcDate.getMonth() + 1).padStart(2, '0');
        const day = String(utcDate.getDate()).padStart(2, '0');
        const hours = String(utcDate.getHours()).padStart(2, '0');
        const minutes = String(utcDate.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
      }
    }

    // Money: Parse formatted string to number for ngx-currency
    if (prop.type === EntityPropertyType.Money) {
      if (typeof rawValue === 'string') {
        // PostgreSQL returns: "$100.00"
        // ngx-currency needs: 100.00 (number)
        const numericValue = parseFloat(rawValue.replace(/[$,]/g, ''));
        if (!isNaN(numericValue)) {
          return numericValue;
        }
      }
    }

    return rawValue;
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
   * Example: User in EST enters "5:30 PM" on Jan 15, 2025
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

      // File types: Extract UUID from file object or uploaded file reference
      if ([EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
        if (typeof value === 'object' && value.id) {
          // Either embedded file object from initial load, or FileReference from upload
          transformed[prop.column_name] = value.id;
        }
        // If it's already a UUID string, leave it as-is
      }

      // PhotoGallery: Extract UUID from embedded gallery object (v0.47.0)
      if (prop.type === EntityPropertyType.PhotoGallery) {
        if (typeof value === 'object' && value.id) {
          transformed[prop.column_name] = value.id;
        }
      }

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
  // GUIDED FORM MODE (v0.48.0)
  // ==========================================================================

  private guidedFormService = inject(GuidedFormService);

  // v0.48.0: Guided form mode signals
  public guidedFormKey = signal<string | null>(null);
  public isGuidedFormMode = computed(() => !!this.guidedFormKey());
  // Guided form status comes directly from context (no separate status_id signal)
  public guidedFormStatus = computed(() => this.guidedFormContext()?.parent_status_key ?? null);
  public isGuidedFormDraft = computed(() => this.guidedFormStatus() === 'draft');
  public savingAndContinuing = signal(false);

  // v0.48.0: Auto-save for draft guided form steps
  public autoSaveStatus = signal<'idle' | 'saving' | 'saved'>('idle');
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSaveSub?: Subscription;
  private autoSaveInFlight = signal(false);
  private lastSavedValues: Record<string, any> = {};
  private autoSaveEnabled = false;
  private saveAndContinueRetries = 0;

  // v0.48.0: Lock condition fields when parent step is beyond draft
  // Users with RBAC update permission bypass field locks (matches backend trigger)
  private lockFieldsEffect = effect(() => {
    const ctx = this.guidedFormContext();
    if (!ctx || ctx.parent_status_key === 'draft' || !this.editForm) return;
    if (this.currentEntity?.update) return;

    if (ctx.steps.length === 0) return;

    const lockedFields = this.guidedFormService.getLockedFields(ctx.steps);
    for (const field of lockedFields) {
      const control = this.editForm.controls[field];
      if (control && control.enabled) {
        control.disable();
      }
    }
  });

  // v0.48.0: View/edit mode for completed guided form steps
  public isEditingCompletedStep = signal(false);

  // True when the guided form is submitted AND lock_on_submit is enabled
  // BUT users with RBAC update permission bypass the lock (matches backend behavior)
  public isGuidedFormLocked = computed(() => {
    const ctx = this.guidedFormContext();
    if (!ctx) return false;
    if (this.currentEntity?.update) return false;
    return ctx.definition.lock_on_submit === true && ctx.parent_status_key === 'submitted';
  });

  // True when showing completed step in read-only display mode (not actively editing).
  // Context-driven — no flash because status is available from first render.
  public showCompletedStepDisplayMode = computed(() =>
    this.isGuidedFormMode() && this.guidedFormStatus() !== null && !this.isGuidedFormDraft() && !this.isEditingCompletedStep()
  );

  // v0.48.0: Resolved parent ID for guided form (differs from entityId on child steps)
  public guidedFormParentId = signal<string | null>(null);

  // v0.48.0: Full guided form context from single RPC call
  public guidedFormContext = signal<GuidedFormContext | null>(null);

  // v0.48.0: Whether the current step can be skipped (can_skip=true AND not require_if-overridden)
  public isCurrentStepSkippable = computed(() => {
    const ctx = this.guidedFormContext();
    if (!ctx || !this.isGuidedFormDraft()) return false;
    const eKey = this.entityKey;
    const step = ctx.steps.find(s => s.step_table === eKey);
    if (!step || step.step_key === '__parent__') return false;
    const effective = this.guidedFormService.getEffectiveSteps(ctx.steps, undefined, ctx.progress);
    const eff = effective.find(s => s.step_key === step.step_key);
    return eff ? !eff.isRequired && !eff.isSkipped : false;
  });

  /**
   * Initialize guided form mode by triggering a context load.
   * All signals are set atomically when the context arrives — no race conditions.
   */
  private initGuidedFormMode(entity: SchemaEntityTable | undefined, data: any): void {
    const key = entity?.guided_form_key;
    if (!key || !data?.id) {
      this.guidedFormKey.set(null);
      this.guidedFormParentId.set(null);
      this.guidedFormContext.set(null);
      return;
    }

    this.guidedFormKey.set(key);
    this.isEditingCompletedStep.set(false);

    // Single RPC call resolves everything: parent/child detection, parent ID, status, progress
    this.guidedFormService.loadContext(key, entity.table_name, data.id)
      .subscribe({
        next: ctx => {
          if (!ctx) return;
          this.guidedFormContext.set(ctx);
          this.guidedFormParentId.set(String(ctx.parent_id));

          // Now that all state is resolved, set up display data and auto-save
          this.fetchDisplayDataIfNeeded();
          this.setupAutoSave();
        },
        error: err => console.error(`Failed to load guided form context:`, err)
      });
  }

  /** Fetch display data (with embedded FK/Status/Category objects) for display mode. */
  private fetchDisplayDataIfNeeded(): void {
    if (this.isGuidedFormMode() && !this.isGuidedFormDraft() && this.entityKey && this.currentProps.length > 0) {
      const displayColumns = this.currentProps.map(p => SchemaService.propertyToSelectString(p));
      this.data.getData({ key: this.entityKey, entityId: this.entityId, fields: displayColumns })
        .pipe(take(1))
        .subscribe(rows => {
          if (rows?.[0]) this.displayData.set(rows[0]);
        });
    }
  }

  /**
   * Set up auto-save for draft guided form steps.
   * Watches form value changes and debounces PATCH calls by 1500ms.
   */
  private setupAutoSave(): void {
    // Only auto-save for draft guided form steps
    if (!this.isGuidedFormDraft() || !this.editForm) {
      this.autoSaveEnabled = false;
      return;
    }

    this.autoSaveEnabled = true;
    this.lastSavedValues = { ...this.editForm.value };

    // Clean up previous subscription to prevent leaks in multi-step sessions
    this.autoSaveSub?.unsubscribe();

    this.autoSaveSub = this.editForm.valueChanges
      .pipe(debounceTime(1500), distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)))
      .subscribe(values => {
        if (!this.autoSaveEnabled || !this.isGuidedFormDraft()) return;
        this.performAutoSave(values);
      });
  }

  /**
   * Cancel any pending auto-save and disable auto-save.
   */
  private cancelAutoSave(): void {
    this.autoSaveEnabled = false;
    this.autoSaveSub?.unsubscribe();
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * Perform auto-save PATCH with only changed fields.
   */
  private performAutoSave(values: Record<string, any>): void {
    if (!this.entityKey || !this.entityId || !this.editForm) return;

    // Find only changed fields
    const changedFields: Record<string, any> = {};
    for (const key of Object.keys(values)) {
      if (JSON.stringify(values[key]) !== JSON.stringify(this.lastSavedValues[key])) {
        changedFields[key] = values[key];
      }
    }

    // Nothing changed — skip
    if (Object.keys(changedFields).length === 0) return;

    // Never touch status_id during auto-save (managed by framework RPCs)
    delete changedFields['status_id'];

    const transformedData = this.transformValuesForApi(changedFields);
    if (Object.keys(transformedData).length === 0) return;

    this.autoSaveStatus.set('saving');
    this.autoSaveInFlight.set(true);

    this.data.editData(this.entityKey, this.entityId, transformedData).subscribe({
      next: (result) => {
        this.autoSaveInFlight.set(false);
        if (result.success) {
          this.lastSavedValues = { ...values };
          this.autoSaveStatus.set('saved');
          this.autoSaveTimer = setTimeout(() => {
            if (this.autoSaveStatus() === 'saved') {
              this.autoSaveStatus.set('idle');
            }
          }, 2000);
        } else {
          this.autoSaveStatus.set('idle');
        }
      },
      error: () => {
        this.autoSaveInFlight.set(false);
        this.autoSaveStatus.set('idle');
      }
    });
  }

  /**
   * Enter edit mode for a completed guided form step.
   */
  public enterEditMode(): void {
    this.isEditingCompletedStep.set(true);
  }

  /**
   * Cancel editing a completed guided form step and revert form values.
   */
  public cancelEditMode(): void {
    this.isEditingCompletedStep.set(false);
    // Revert form to original data values
    if (this.editForm && this.currentData) {
      for (const key of Object.keys(this.editForm.controls)) {
        const prop = this.currentProps.find(p => p.column_name === key);
        if (prop) {
          const value = this.currentData[key];
          this.editForm.controls[key].setValue(
            this.transformValueForControl(prop, value),
            { emitEvent: false }
          );
        }
      }
      this.editForm.markAsPristine();
    }
  }

  /**
   * Navigate to a different guided form step from the nav overlay.
   */
  public onGuidedFormStepClick(stepKey: string): void {
    const ctx = this.guidedFormContext();
    const wk = this.guidedFormKey();
    const pid = this.guidedFormParentId() || this.entityId;
    if (!wk || !pid || !ctx) return;

    if (stepKey === '__parent__') {
      this.cancelAutoSave();
      this.router.navigate(['/edit', ctx.definition.parent_table, pid]);
      return;
    }

    if (stepKey === '__review__') {
      this.cancelAutoSave();
      this.router.navigate(['/view', ctx.definition.parent_table, pid]);
      return;
    }

    const clickedStep = ctx.steps.find(s => s.step_key === stepKey);
    if (!clickedStep) return;

    // If clicking the current step, do nothing
    if (clickedStep.step_table === this.entityKey) return;

    this.cancelAutoSave();

    if (clickedStep.parent_fk_column) {
      // Ensure draft record exists, then navigate to edit
      this.guidedFormService.ensureStepRecord(wk, pid, clickedStep.step_key).subscribe({
        next: (result) => {
          if (result.record_id) {
            this.router.navigate(['/edit', clickedStep.step_table, result.record_id]);
          }
        },
        error: (err) => {
          const apiError = err?.error || {};
          this.currentError.set({
            humanMessage: apiError.message || 'Failed to load step record.',
            message: apiError.message || err.message
          });
          this.showErrorModal.set(true);
        }
      });
    }
  }

  /**
   * Save current step and advance to next step in guided form.
   */
  public saveAndContinue(event?: Event): void {
    event?.preventDefault?.();

    const form = this.editForm;
    if (!form) return;

    if (form.invalid) {
      Object.keys(form.controls).forEach(key => {
        form.controls[key].markAsTouched();
      });
      this.showValidationError.set(true);
      this.scrollToFirstError();
      return;
    }

    this.cancelAutoSave();

    // If an auto-save PATCH is in flight, wait for it to complete before proceeding
    // Cap retries to prevent infinite loop (15 retries × 200ms = 3 seconds max wait)
    if (this.autoSaveInFlight()) {
      if (this.saveAndContinueRetries++ >= 15) {
        this.saveAndContinueRetries = 0;
        console.warn('[EditPage] Auto-save in-flight timeout exceeded, proceeding with save');
        // Fall through to save anyway
      } else {
        setTimeout(() => this.saveAndContinue(event), 200);
        return;
      }
    }
    this.saveAndContinueRetries = 0;

    this.showValidationError.set(false);
    this.savingAndContinuing.set(true);

    const formData = form.value;
    const transformedData = this.transformValuesForApi(formData);

    const ctx = this.guidedFormContext();
    const wk = this.guidedFormKey();
    const eKey = this.entityKey;
    const eId = this.entityId;
    const parentId = this.guidedFormParentId() || eId;
    if (!wk || !eKey || !eId || !parentId || !ctx) {
      this.savingAndContinuing.set(false);
      return;
    }

    const step = ctx.steps.find(s => s.step_table === eKey);
    const stepKey = step?.step_key || '__parent__';

    // Save data, then flush pending M:M diffs, then complete step
    this.data.editData(eKey, eId, transformedData).subscribe({
      next: (result) => {
        if (!result.success) {
          this.savingAndContinuing.set(false);
          this.currentError.set(result.error);
          this.showErrorModal.set(true);
          return;
        }

        // Flush any pending M:M changes before completing the step
        this.executePendingM2mForGuidedForm(eId).subscribe({
          next: (m2mResult) => {
            if (!m2mResult.success) {
              this.savingAndContinuing.set(false);
              this.currentError.set({ humanMessage: m2mResult.errorMessage || 'Failed to save related items.', message: m2mResult.errorMessage || '' });
              this.showErrorModal.set(true);
              return;
            }

            this.guidedFormService.completeStep(wk, parseInt(parentId), stepKey).subscribe({
              next: (completeResult) => {
                this.savingAndContinuing.set(false);
                this.analytics.trackEvent('GuidedForm', 'StepComplete', `${wk}:${stepKey}`);

                // Backend auto-submitted (all non-parent steps were condition-skipped)
                if (completeResult.auto_submitted) {
                  const navigateTo = completeResult.navigate_to;
                  if (navigateTo) {
                    this.router.navigateByUrl(navigateTo);
                  } else {
                    this.router.navigate(['/view', ctx.definition.parent_table, parentId]);
                  }
                  return;
                }

                // RPC returns next step info directly (no separate ensureStepRecord call needed)
                if (completeResult.next_record_id && completeResult.next_step_table) {
                  this.router.navigate(['/edit', completeResult.next_step_table, completeResult.next_record_id]);
                } else if (completeResult.all_data_steps_complete) {
                  // All steps done — go to detail page for review
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
          error: (err) => {
            this.savingAndContinuing.set(false);
            this.currentError.set({ humanMessage: 'Failed to save related items.', message: err.message || '' });
            this.showErrorModal.set(true);
          }
        });
      },
      error: (err) => {
        this.savingAndContinuing.set(false);
        const apiError = err?.error || {};
        this.currentError.set({
          humanMessage: apiError.message || 'An unexpected error occurred.',
          message: apiError.message || err.message
        });
        this.showErrorModal.set(true);
      }
    });
  }

  /**
   * Execute all pending M:M diffs (pure + rich) for a guided form step save.
   * Returns an observable that completes when all M:M operations finish.
   */
  private executePendingM2mForGuidedForm(entityId: string): Observable<{ success: boolean; errorMessage?: string }> {
    const ops: Observable<ApiResponse>[] = [];

    // Pure junction diffs
    const diffs = this.pendingM2mDiffs();
    for (const [columnName, diff] of diffs) {
      const prop = this.inlineM2mProps.find(p => p.column_name === columnName);
      if (!prop?.many_to_many_meta) continue;
      const meta = prop.many_to_many_meta;
      ops.push(...diff.toRemove.map(id => this.data.removeManyToManyRelation(entityId, meta, id)));
      ops.push(...diff.toAdd.map(id => this.data.addManyToManyRelation(entityId, meta, id)));
    }

    // Rich junction diffs (with extraData for adds/updates)
    const richDiffs = this.pendingRichM2mDiffs();
    for (const [columnName, diff] of richDiffs) {
      const prop = this.inlineM2mProps.find(p => p.column_name === columnName);
      if (!prop?.many_to_many_meta) continue;
      const meta = prop.many_to_many_meta;
      ops.push(...diff.toRemove.map(id => this.data.removeManyToManyRelation(entityId, meta, id)));
      ops.push(...diff.toAdd.map(item => this.data.addManyToManyRelation(entityId, meta, item.id, item.extraData)));
      ops.push(...diff.toUpdate.map(item => this.data.updateManyToManyRelation(entityId, meta, item.id, item.extraData)));
    }

    if (ops.length === 0) return of({ success: true });

    return forkJoin(ops).pipe(
      map(results => {
        const failed = results.filter(r => !r.success).length;
        return {
          success: failed === 0,
          errorMessage: failed > 0 ? `${failed} of ${results.length} related item changes failed` : undefined
        };
      })
    );
  }

  /**
   * Skip the current optional step without saving or validating.
   * Navigates to the next data step, or to the detail/review page if this is the last step.
   */
  public skipStep(): void {
    const ctx = this.guidedFormContext();
    const wk = this.guidedFormKey();
    if (!ctx || !wk) return;
    const parentId = ctx.parent_id;
    if (!parentId) return;

    // Cancel any pending auto-save
    this.cancelAutoSave();

    // Find current step and compute effective steps
    const eKey = this.entityKey;
    const currentStep = ctx.steps.find(s => s.step_table === eKey);
    if (!currentStep) return;

    const effective = this.guidedFormService.getEffectiveSteps(ctx.steps, undefined, ctx.progress);
    const sortedDataSteps = effective
      .filter(s => s.step_key !== '__parent__' && !s.isSkipped)
      .sort((a, b) => a.step_order - b.step_order);

    const currentIndex = sortedDataSteps.findIndex(s => s.step_key === currentStep.step_key);
    const nextStep = sortedDataSteps[currentIndex + 1];

    if (nextStep) {
      // Navigate to next data step — ensure its record exists
      this.guidedFormService.ensureStepRecord(wk, Number(parentId), nextStep.step_key)
        .subscribe({
          next: (result) => {
            this.router.navigate(['/edit', nextStep.step_table, result.record_id]);
          },
          error: () => {
            // Fallback: navigate to detail page
            this.router.navigate(['/view', ctx.definition.parent_table, parentId]);
          }
        });
    } else {
      // No more data steps — go to detail/review page
      this.router.navigate(['/view', ctx.definition.parent_table, parentId]);
    }
  }
}
