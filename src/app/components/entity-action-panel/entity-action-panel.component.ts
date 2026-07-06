/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  output,
  signal,
  effect,
  DestroyRef,
  ViewChildren,
  QueryList
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormGroup, FormControl, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { forkJoin, of, merge, Subscription } from 'rxjs';
import { catchError, debounceTime } from 'rxjs/operators';
import { Observable } from 'rxjs';

import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryService } from '../../services/gallery.service';
import {
  EntityAction,
  EntityActionResult,
  EntityActionParam,
  FileReference,
  PhotoGalleryConfig
} from '../../interfaces/entity';
import { evaluateCondition } from '../../utils/condition-evaluator';
import { ActionBarComponent, ActionButton } from '../action-bar/action-bar.component';
import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { PhotoGalleryEditorComponent } from '../photo-gallery-editor/photo-gallery-editor.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Reusable component that renders entity action buttons and handles the full
 * action lifecycle: button rendering, confirmation modals, parameter forms,
 * file/gallery uploads, and RPC execution.
 *
 * Follows the self-fetching pattern (like EntityNotesComponent): provide a
 * tableName and entityId, and the component loads and manages everything.
 *
 * Usage:
 * ```html
 * <app-entity-action-panel
 *   tableName="civic_os_users"
 *   [entityId]="user.id"
 *   [entityData]="user"
 *   (actionExecuted)="reloadData()">
 * </app-entity-action-panel>
 * ```
 */
@Component({
  selector: 'app-entity-action-panel',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    ActionBarComponent,
    CosModalComponent,
    PhotoGalleryEditorComponent,
    TranslatePipe
  ],
  templateUrl: './entity-action-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class EntityActionPanelComponent {
  // ─── Inputs ──────────────────────────────────────────────────────
  tableName = input.required<string>();
  entityId = input.required<string>();
  entityData = input.required<Record<string, any>>();

  // ─── Outputs ─────────────────────────────────────────────────────
  actionExecuted = output<void>();

  // ─── Services ────────────────────────────────────────────────────
  private schema = inject(SchemaService);
  private data = inject(DataService);
  private fileUpload = inject(FileUploadService);
  private galleryService = inject(GalleryService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  // ─── Action state signals ────────────────────────────────────────
  entityActions = signal<EntityAction[]>([]);
  actionButtons = signal<ActionButton[]>([]);
  showActionModal = signal(false);
  currentAction = signal<EntityAction | undefined>(undefined);
  actionLoading = signal(false);
  actionOverlayLoading = signal(false);
  actionError = signal<string | undefined>(undefined);
  actionSuccess = signal<string | undefined>(undefined);

  // ─── Action parameter state ──────────────────────────────────────
  actionParamForm = signal<FormGroup | undefined>(undefined);
  actionParamOptions = signal<Record<string, any[]>>({});
  actionFileUploading = signal(false);
  actionUploadedFile = signal<Record<string, FileReference>>({});
  actionUploadError = signal<string | undefined>(undefined);
  private paramDependencySubs: Subscription[] = [];

  // ─── Photo gallery action param state ────────────────────────────
  @ViewChildren('actionGalleryEditor') actionGalleryEditors!: QueryList<PhotoGalleryEditorComponent>;
  actionGalleryConfig = signal<Record<string, PhotoGalleryConfig>>({});
  actionGalleryIds = signal<Record<string, string | null>>({});

  constructor() {
    // Load actions when tableName changes
    effect(() => {
      const table = this.tableName();
      if (table) {
        this.schema.getEntityActions(table).pipe(
          takeUntilDestroyed(this.destroyRef)
        ).subscribe(actions => {
          this.entityActions.set(actions);
        });
      }
    });

    // Recompute visible actions + buttons when actions or entity data change
    effect(() => {
      const actions = this.entityActions();
      const data = this.entityData();
      if (!data || actions.length === 0) {
        this.actionButtons.set([]);
        return;
      }

      // Filter by can_execute and visibility_condition
      const visible = actions.filter(action =>
        action.can_execute &&
        evaluateCondition(action.visibility_condition, data)
      );

      // Build action buttons (entity actions only, no Edit/Delete/Payment)
      const buttons: ActionButton[] = visible.map(action => {
        const isEnabled = evaluateCondition(action.enabled_condition, data);
        return {
          id: `action:${action.action_name}`,
          label: action.display_name,
          icon: action.icon,
          style: `btn-${action.button_style}`,
          disabled: !isEnabled,
          tooltip: !isEnabled ? action.disabled_tooltip : action.description
        };
      });

      this.actionButtons.set(buttons);
    });
  }

  // ─── Action button click handler ─────────────────────────────────

  onActionButtonClick(buttonId: string): void {
    if (!buttonId.startsWith('action:')) return;

    const actionName = buttonId.substring(7);
    const actions = this.entityActions();
    const data = this.entityData();
    const visible = actions.filter(a =>
      a.can_execute && evaluateCondition(a.visibility_condition, data)
    );
    const action = visible.find(a => a.action_name === actionName);
    if (action) {
      this.onEntityActionClick(action);
    }
  }

  // ─── Entity action click handler ─────────────────────────────────

  onEntityActionClick(action: EntityAction): void {
    this.currentAction.set(action);
    this.actionError.set(undefined);
    this.actionSuccess.set(undefined);

    const hasParams = action.parameters && action.parameters.length > 0;

    if (hasParams || action.requires_confirmation) {
      if (hasParams) {
        this.buildActionParamForm(action.parameters);
        this.loadParamOptions(action.parameters);
        this.setupParamDependencyWatchers(action.parameters);
      }
      this.showActionModal.set(true);
    } else {
      this.actionOverlayLoading.set(true);
      this.executeEntityAction(action);
    }
  }

  // ─── Confirm action from modal ───────────────────────────────────

  async confirmEntityAction(): Promise<void> {
    const action = this.currentAction();
    if (!action) return;

    const form = this.actionParamForm();
    if (form) {
      if (form.invalid) {
        form.markAllAsTouched();
        return;
      }
    }

    this.actionLoading.set(true);

    // Save gallery uploads before executing RPC
    const gallerySaved = await this.saveActionGalleries();
    if (!gallerySaved) {
      this.actionLoading.set(false);
      this.actionError.set('Failed to save gallery photos. Please try again.');
      return;
    }

    const additionalParams = form ? this.collectParamValues(action.parameters, form) : {};
    this.executeEntityAction(action, additionalParams);
  }

  // ─── Close action modal ──────────────────────────────────────────

  closeActionModal(): void {
    this.showActionModal.set(false);
    this.currentAction.set(undefined);
    this.actionError.set(undefined);
    this.actionSuccess.set(undefined);
    this.actionParamForm.set(undefined);
    this.actionParamOptions.set({});
    this.paramDependencySubs.forEach(s => s.unsubscribe());
    this.paramDependencySubs = [];
    this.actionFileUploading.set(false);
    this.actionUploadedFile.set({});
    this.actionUploadError.set(undefined);
    this.actionGalleryConfig.set({});
    this.actionGalleryIds.set({});
  }

  // ─── Execute entity action RPC ───────────────────────────────────

  private executeEntityAction(action: EntityAction, additionalParams: Record<string, any> = {}): void {
    this.data.executeRpc(action.rpc_function, {
      p_entity_id: this.entityId(),
      ...additionalParams
    }).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (response) => {
        this.actionLoading.set(false);
        this.actionOverlayLoading.set(false);

        if (response.success) {
          const result = response.body as EntityActionResult | undefined;

          const message = result?.message || action.default_success_message || 'Action completed';
          const navigateTo = result?.navigate_to || action.default_navigate_to;
          const shouldRefresh = result?.refresh ?? action.refresh_after_action;

          this.actionSuccess.set(message);

          setTimeout(() => {
            this.closeActionModal();

            if (navigateTo) {
              this.router.navigate([navigateTo]);
            } else if (shouldRefresh) {
              this.actionExecuted.emit();
            }
          }, 1500);
        } else {
          this.actionError.set(response.error?.humanMessage || 'Action failed');
        }
      },
      error: () => {
        this.actionLoading.set(false);
        this.actionOverlayLoading.set(false);
        this.actionError.set('An unexpected error occurred');
      }
    });
  }

  // ─── Build action param form ─────────────────────────────────────

  buildActionParamForm(params: EntityActionParam[]): void {
    const controls: Record<string, FormControl> = {};

    for (const param of params) {
      const validators: any[] = [];
      if (param.required) {
        validators.push(Validators.required);
      }
      if (param.param_type === 'number' || param.param_type === 'money') {
        validators.push(Validators.pattern(/^-?\d+(\.\d+)?$/));
      } else if (param.param_type === 'email') {
        validators.push(Validators.email);
      }

      const defaultValue = param.default_value ?? null;
      controls[param.param_name] = new FormControl(defaultValue, validators);
    }

    this.actionParamForm.set(new FormGroup(controls));
  }

  // ─── Load param options ──────────────────────────────────────────

  loadParamOptions(params: EntityActionParam[]): void {
    const optionsToLoad: Record<string, Observable<any[]>> = {};

    for (const param of params) {
      if (param.param_type === 'status' && param.status_entity_type) {
        optionsToLoad[param.param_name] = this.data.getData({
          key: 'statuses',
          fields: ['id', 'display_name'],
          filters: [{ column: 'entity_type', operator: 'eq', value: param.status_entity_type }],
          orderField: 'sort_order',
          orderDirection: 'asc'
        });
      } else if (param.param_type === 'category' && param.category_entity_type) {
        optionsToLoad[param.param_name] = this.data.getData({
          key: 'categories',
          fields: ['id', 'display_name'],
          filters: [{ column: 'entity_type', operator: 'eq', value: param.category_entity_type }],
          orderField: 'sort_order',
          orderDirection: 'asc'
        });
      } else if (param.param_type === 'foreign_key' && param.options_source_rpc) {
        if (param.depends_on_params?.length) {
          const form = this.actionParamForm();
          const allDepsNull = param.depends_on_params.every(
            dep => form?.get(dep)?.value == null
          );
          if (allDepsNull) continue;
        }
        optionsToLoad[param.param_name] = this.loadParamOptionsFromRpc(param);
      } else if (param.param_type === 'foreign_key' && param.join_table && param.join_column) {
        const fields = [...new Set(['id', 'display_name', param.join_column])];
        optionsToLoad[param.param_name] = this.data.getData({
          key: param.join_table,
          fields,
          orderField: 'display_name',
          orderDirection: 'asc'
        });
      } else if (param.param_type === 'user') {
        optionsToLoad[param.param_name] = this.data.getData({
          key: 'civic_os_users',
          fields: ['id', 'display_name'],
          orderField: 'display_name',
          orderDirection: 'asc'
        });
      } else if (param.param_type === 'photo_gallery' && param.target_column) {
        this.galleryService.getConfig(this.tableName(), param.target_column).subscribe({
          next: (config) => {
            this.actionGalleryConfig.set({
              ...this.actionGalleryConfig(),
              [param.param_name]: config
            });
          },
          error: (err) => {
            console.error(`[EntityActionPanel] Failed to load gallery config for ${param.target_column}`, err);
          }
        });
      }
    }

    if (Object.keys(optionsToLoad).length === 0) return;

    forkJoin(optionsToLoad).subscribe({
      next: (results) => {
        this.actionParamOptions.set({ ...this.actionParamOptions(), ...results });
      },
      error: (err) => {
        console.error('[EntityActionPanel] Failed to load param options', err);
      }
    });
  }

  // ─── Load param options from RPC ─────────────────────────────────

  private loadParamOptionsFromRpc(param: EntityActionParam): Observable<any[]> {
    const dependsOn = this.buildParamDependsOn(param);
    return this.data.callRpc(param.options_source_rpc!, {
      p_id: this.entityId() ? Number(this.entityId()) || this.entityId() : null,
      p_depends_on: dependsOn
    }).pipe(
      catchError(err => {
        console.error(`[EntityActionPanel] options_source_rpc '${param.options_source_rpc}' failed:`, err);
        return of([]);
      })
    );
  }

  private buildParamDependsOn(param: EntityActionParam): Record<string, any> {
    if (!param.depends_on_params?.length) return {};
    const result: Record<string, any> = {};
    const form = this.actionParamForm();
    for (const dep of param.depends_on_params) {
      result[dep] = form?.get(dep)?.value ?? null;
    }
    return result;
  }

  // ─── Setup param dependency watchers ─────────────────────────────

  setupParamDependencyWatchers(params: EntityActionParam[]): void {
    const form = this.actionParamForm();
    if (!form) return;

    for (const param of params) {
      if (!param.depends_on_params?.length || !param.options_source_rpc) continue;

      const controls = param.depends_on_params
        .map(dep => form.get(dep))
        .filter((c): c is FormControl => c !== null);

      if (controls.length === 0) continue;

      const sub = merge(...controls.map(c => c.valueChanges)).pipe(
        debounceTime(300)
      ).subscribe(() => {
        const allNull = param.depends_on_params!.every(
          dep => form.get(dep)?.value == null
        );

        if (allNull) {
          this.actionParamOptions.set({
            ...this.actionParamOptions(),
            [param.param_name]: []
          });
          form.get(param.param_name)?.setValue(null);
          return;
        }

        this.loadParamOptionsFromRpc(param).subscribe(options => {
          this.actionParamOptions.set({
            ...this.actionParamOptions(),
            [param.param_name]: options
          });

          const currentValue = form.get(param.param_name)?.value;
          if (currentValue != null) {
            const validIds = new Set(options.map((o: any) => String(o.id)));
            if (!validIds.has(String(currentValue))) {
              form.get(param.param_name)?.setValue(null);
            }
          }
        });
      });

      this.paramDependencySubs.push(sub);
    }
  }

  // ─── Collect param values ────────────────────────────────────────

  private collectParamValues(params: EntityActionParam[], form: FormGroup): Record<string, any> {
    const values: Record<string, any> = {};

    for (const param of params) {
      let value = form.get(param.param_name)?.value;

      if (value === null || value === undefined || value === '') {
        if (!param.required) continue;
      }

      switch (param.param_type) {
        case 'number':
        case 'money':
          value = value !== null && value !== '' ? Number(value) : null;
          break;
        case 'boolean':
          value = !!value;
          break;
        case 'datetime_local':
          if (value) {
            const localDate = new Date(value);
            value = localDate.toISOString();
          }
          break;
      }

      values[param.param_name] = value;
    }

    return values;
  }

  // ─── File upload handler ─────────────────────────────────────────

  onActionFileSelected(event: Event, paramName: string): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const param = this.currentAction()?.parameters?.find(p => p.param_name === paramName);
    const allowedTypes = this.getFileAcceptForParam(param);

    const typeFilter = allowedTypes !== '*/*' ? allowedTypes : undefined;
    const validationError = this.fileUpload.validateFile(file, typeFilter, 10 * 1024 * 1024);
    if (validationError) {
      this.actionUploadError.set(validationError);
      input.value = '';
      return;
    }

    this.actionFileUploading.set(true);
    this.actionUploadError.set(undefined);

    this.fileUpload.uploadFile(file, this.tableName(), this.entityId(), false)
      .then(fileRef => {
        this.actionParamForm()?.get(paramName)?.setValue(fileRef.id);
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

  // ─── Photo gallery helpers ───────────────────────────────────────

  onActionGalleryDraftCreated(paramName: string, galleryId: string): void {
    this.actionGalleryIds.set({
      ...this.actionGalleryIds(),
      [paramName]: galleryId
    });
    this.actionParamForm()?.get(paramName)?.setValue(galleryId);
  }

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

  isAnyGalleryUploading(): boolean {
    if (!this.actionGalleryEditors?.length) return false;
    return this.actionGalleryEditors.some(editor => editor.uploading());
  }

  // ─── Utility helpers ─────────────────────────────────────────────

  getFileAcceptForParam(param?: EntityActionParam): string {
    if (!param) return '*/*';
    switch (param.file_type) {
      case 'image': return 'image/*';
      case 'pdf': return 'application/pdf';
      default: return '*/*';
    }
  }

  getParamDisplayColumn(_param: EntityActionParam): string {
    return 'display_name';
  }
}
